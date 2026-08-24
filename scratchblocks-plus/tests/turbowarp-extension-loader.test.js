const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const loaderPath = path.join(__dirname, "..", "turbowarp-extension-loader.js");
const loaderSource = fs.readFileSync(loaderPath, "utf8");
const window = {};
vm.runInNewContext(loaderSource, { window });
const convertInfo = window.TurboWarpExtensionLoader.convertInfo;
const registerConverted = window.TurboWarpExtensionLoader.registerConverted;

test("converts TurboWarp shapes and arguments", () => {
  const result = convertInfo({
    id: "demo",
    name: "Demo",
    color1: "#123456",
    color2: "#234567",
    color3: "#345678",
    blocks: [
      {
        opcode: "command",
        blockType: "command",
        text: "set [VALUE] to [CHOICE]",
        arguments: {
          VALUE: { type: "number", menu: null },
          CHOICE: { type: "string", menu: "choices" },
        },
      },
      {
        opcode: "predicate",
        blockType: "Boolean",
        text: "is [VALUE] ready?",
        arguments: { VALUE: { type: "Boolean", menu: null } },
      },
      {
        opcode: "loop",
        blockType: "loop",
        text: "repeat [COUNT]",
        arguments: { COUNT: { type: "number", menu: null } },
      },
    ],
    menus: { choices: { dynamic: true } },
  });

  assert.equal(result.id, "demo");
  assert.deepEqual(JSON.parse(JSON.stringify(result.highContrastColors)), {
    primary: "#6699cc",
    secondary: "#7ca4cc",
    tertiary: "#071523",
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.blocks)),
    [
      {
        id: "demo.command",
        shape: "stack",
        category: "demo",
        inputs: ["%n", "%m"],
        hasLoopArrow: false,
        spec: "set %1 to %2",
      },
      {
        id: "demo.predicate",
        shape: "boolean",
        category: "demo",
        inputs: ["%b"],
        hasLoopArrow: false,
        spec: "is %1 ready?",
      },
      {
        id: "demo.loop",
        shape: "c-block",
        category: "demo",
        inputs: ["%n"],
        hasLoopArrow: true,
        spec: "repeat %1",
      },
    ],
  );
  assert.equal(result.warnings.length, 0);
});

test("creates high-contrast and outline colors for default and custom extensions", () => {
  const block = { opcode: "run", blockType: "command", text: "run", arguments: {} };
  const defaults = convertInfo({ id: "defaultcolors", blocks: [block] });
  assert.deepEqual(JSON.parse(JSON.stringify(defaults.highContrastColors)), {
    primary: "#13ECAF",
    secondary: "#75F0CD",
    tertiary: "#0B8E69",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(defaults.outlineColors)), {
    primary: "#fff",
    secondary: "#f2fcf9",
    tertiary: "#0b8e69",
  });

  const custom = convertInfo({
    id: "customcolors",
    color1: "#336699",
    color2: "#123456",
    color3: "#000000",
    blocks: [block],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(custom.highContrastColors)), {
    primary: "#6c9ccc",
    secondary: "#95b0cc",
    tertiary: "#224466",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(custom.outlineColors)), {
    primary: "#fff",
    secondary: "#f5f7fa",
    tertiary: "#000000",
  });
});

test("keeps supported blocks and silently ignores palette-only entries", () => {
  const result = convertInfo({
    id: "partial",
    name: "Partial",
    blocks: [
      "---",
      { opcode: "button", blockType: "button", text: "click", arguments: {} },
      { blockType: "label", text: "heading", arguments: {} },
      { blockType: "xml", arguments: {} },
      { opcode: "report", blockType: "reporter", text: "value", arguments: {} },
    ],
    menus: {},
  });

  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].id, "partial.report");
  assert.equal(result.warnings.length, 0);
});

test("rejects duplicate opcodes before registration", () => {
  assert.throws(
    () =>
      convertInfo({
        id: "duplicate",
        blocks: [
          { opcode: "same", blockType: "command", text: "one", arguments: {} },
          { opcode: "same", blockType: "reporter", text: "two", arguments: {} },
        ],
        menus: {},
      }),
    /Duplicate opcode/,
  );
});

test("rejects a duplicate extension id before making registry calls", () => {
  const converted = convertInfo({
    id: "duplicateId",
    blocks: [
      { opcode: "run", blockType: "command", text: "run", arguments: {} },
    ],
    menus: {},
  });
  let calls = 0;
  const scratchblocks = {
    registerCategory() { calls += 1; },
    registerBlock() { calls += 1; },
    registerBlockTranslation() { calls += 1; },
    updateStyles() { calls += 1; },
  };

  registerConverted(converted, scratchblocks);
  calls = 0;
  assert.throws(() => registerConverted(converted, scratchblocks), /already loaded/);
  assert.equal(calls, 0);
});

test("turns image arguments into inline icons", () => {
  const result = convertInfo({
    id: "images",
    blocks: [
      {
        opcode: "show",
        blockType: "command",
        text: "show [ICON]",
        arguments: {
          ICON: {
            type: "image",
            dataURI: "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E",
            alt: "icon",
          },
        },
      },
    ],
    menus: {},
  });

  assert.equal(result.inlineIcons.length, 1);
  assert.match(result.blocks[0].spec, /^show @twInlineIcon[a-z]+$/);
  assert.deepEqual(Array.from(result.blocks[0].aliases), ["show icon"]);
  assert.deepEqual(Array.from(result.blocks[0].inputs), []);
});

test("registers inline image specs with plain-text aliases", () => {
  const icon = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E";
  const converted = convertInfo({
    id: "inlinealiases",
    blocks: [{
      opcode: "run",
      blockType: "command",
      text: "run [IMAGE] [VALUE]",
      arguments: {
        IMAGE: { type: "image", dataURI: icon, alt: "icon" },
        VALUE: { type: "string" },
      },
    }],
    menus: {},
    translations: {
      "zh-cn": {
        id: "inlinealiases",
        name: "图标别名",
        blocks: [{
          opcode: "run",
          blockType: "command",
          text: "运行 [IMAGE] [VALUE]",
          arguments: {},
        }],
      },
    },
  });
  const blocks = [];
  const specs = [];
  const categories = [];
  const scratchblocks = {
    allLanguages: { en: {}, zh_CN: {} },
    registerIcon() {},
    registerCategory(category) { categories.push(category); },
    registerBlock(block) { blocks.push(block); },
    registerBlockTranslation(language, blockId, spec, aliases) {
      specs.push({ language, blockId, spec, aliases });
    },
    updateStyles() {},
  };

  registerConverted(converted, scratchblocks);
  assert.match(blocks[0].spec, /^run @twInlineIcon[a-z]+ %1$/);
  assert.deepEqual(
    JSON.parse(JSON.stringify(categories[0].styles.scratch3HighContrast)),
    {
      primary: "#13ECAF",
      secondary: "#75F0CD",
      tertiary: "#0B8E69",
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(categories[0].styles.scratch3Outline)),
    {
      primary: "#fff",
      secondary: "#f2fcf9",
      tertiary: "#0b8e69",
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(specs.map(item => [item.language, item.spec, item.aliases]))),
    [
      ["en", blocks[0].spec, ["run icon %1"]],
      ["zh_CN", blocks[0].spec.replace(/^run /, "运行 "), ["运行 icon %1"]],
    ],
  );
});

test("allows repeated or omitted decorative image placeholders in translations", () => {
  const icon = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E";
  const result = convertInfo({
    id: "translatedimages",
    name: "Translated Images",
    blocks: [{
      opcode: "compare",
      blockType: "Boolean",
      text: "[IMAGE] [A] = [IMAGE] [B]",
      arguments: {
        IMAGE: { type: "image", dataURI: icon },
        A: { type: "string" },
        B: { type: "string" },
      },
    }],
    menus: {},
    translations: {
      fi: {
        id: "translatedimages",
        name: "Käännetyt kuvat",
        blocks: [{
          opcode: "compare",
          blockType: "Boolean",
          text: "[IMAGE] [A] = [IMAGE] [B]",
          arguments: {},
        }],
      },
      ko: {
        id: "translatedimages",
        name: "Translated Images",
        blocks: [{
          opcode: "compare",
          blockType: "Boolean",
          text: "[A] = [B]",
          arguments: {},
        }],
      },
    },
  });

  assert.equal(result.warnings.length, 0);
  assert.deepEqual(
    Array.from(result.blocks[0].aliases),
    ["Translated Images %1 = Translated Images %2"],
  );
  assert.match(result.translations.fi.blocks["translatedimages.compare"], /@twInlineIcon[a-z]+ %1 = @twInlineIcon[a-z]+ %2/);
  assert.deepEqual(
    Array.from(result.translations.fi.aliases["translatedimages.compare"]),
    ["Käännetyt kuvat %1 = Käännetyt kuvat %2"],
  );
  assert.equal(result.translations.ko.blocks["translatedimages.compare"], "%1 = %2");
  assert.equal(result.translations.ko.aliases["translatedimages.compare"], undefined);

  const registeredTranslations = [];
  registerConverted(result, {
    allLanguages: { en: {}, fi: {}, ko: {} },
    registerIcon() {},
    registerCategory() {},
    registerBlock() {},
    registerBlockTranslation(language, blockId, spec, aliases) {
      registeredTranslations.push({ language, blockId, spec, aliases });
    },
    updateStyles() {},
  });
  assert.deepEqual(
    Array.from(
      registeredTranslations.find(item => item.language === "fi").aliases,
    ),
    ["Käännetyt kuvat %1 = Käännetyt kuvat %2"],
  );
});

test("maps hats, terminal commands, conditionals, and specialized inputs", () => {
  const result = convertInfo({
    id: "shapes",
    blocks: [
      { opcode: "start", blockType: "event", text: "when ready", arguments: {} },
      {
        opcode: "stop",
        blockType: "command",
        text: "stop now",
        arguments: {},
        isTerminal: true,
      },
      {
        opcode: "branch",
        blockType: "conditional",
        text: "with [COLOR]",
        arguments: { COLOR: { type: "color", menu: null } },
      },
      {
        opcode: "values",
        blockType: "reporter",
        text: "[NOTE] [MATRIX] [ANGLE]",
        arguments: {
          NOTE: { type: "note", menu: null },
          MATRIX: { type: "matrix", menu: null },
          ANGLE: { type: "angle", menu: null },
        },
      },
    ],
    menus: {},
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(result.blocks.map(block => ({
      shape: block.shape,
      inputs: block.inputs,
    })))),
    [
      { shape: "hat", inputs: [] },
      { shape: "cap", inputs: [] },
      { shape: "c-block", inputs: ["%c"] },
      { shape: "reporter", inputs: ["%d.note", "%m", "%n"] },
    ],
  );
});

test("defaults control blocks to one branch and skips multi-branch controls", () => {
  const result = convertInfo({
    id: "branches",
    blocks: [
      { opcode: "loop", blockType: "loop", branchCount: 0, text: "loop", arguments: {} },
      { opcode: "conditional", blockType: "conditional", text: "if", arguments: {} },
      { opcode: "twoLoops", blockType: "loop", branchCount: 2, text: "two loops", arguments: {} },
      { opcode: "twoBranches", blockType: "conditional", branchCount: 2, text: "two branches", arguments: {} },
    ],
    menus: {},
  });

  assert.deepEqual(Array.from(result.blocks, block => block.id), [
    "branches.loop",
    "branches.conditional",
  ]);
  assert.equal(result.blocks[0].shape, "c-block");
  assert.equal(result.blocks[1].shape, "c-block");
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings.join("\n"), /only one-branch control blocks are supported/);
});

test("falls back from invalid colors and external icons", () => {
  const result = convertInfo({
    id: "fallbacks",
    color1: "green",
    color2: "#12345g",
    color3: "#abc",
    blockIconURI: "https://example.com/icon.svg",
    blocks: [
      { opcode: "run", blockType: "command", text: "run", arguments: {} },
    ],
    menus: {},
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result.colors)), {
    primary: "#0fbd8c",
    secondary: "#0da57a",
    tertiary: "#abc",
  });
  assert.equal(result.categoryIcon, null);
  assert.match(result.warnings.join("\n"), /color1/);
  assert.match(result.warnings.join("\n"), /color2/);
  assert.match(result.warnings.join("\n"), /blockIconURI/);
});

test("registers translated specs with locale-code normalization", () => {
  const converted = convertInfo({
    id: "localized",
    name: "Localized",
    blocks: [
      {
        opcode: "move",
        blockType: "command",
        text: "move [STEPS] steps",
        arguments: { STEPS: { type: "number", menu: null } },
      },
    ],
    menus: {},
    translations: {
      "zh-cn": {
        id: "localized",
        name: "本地化扩展",
        blocks: [
          {
            opcode: "move",
            blockType: "command",
            text: "移动 [STEPS] 步",
            arguments: { STEPS: { type: "number", menu: null } },
          },
        ],
      },
    },
  });
  const registeredTranslations = [];
  const scratchblocks = {
    allLanguages: { en: {}, zh_CN: {} },
    registerCategory() {},
    registerBlock() {},
    registerBlockTranslation(language, blockId, spec) {
      registeredTranslations.push({ language, blockId, spec });
    },
    updateStyles() {},
  };

  const result = registerConverted(converted, scratchblocks);
  assert.deepEqual(registeredTranslations, [
    { language: "en", blockId: "localized.move", spec: "move %1 steps" },
    { language: "zh_CN", blockId: "localized.move", spec: "移动 %1 步" },
  ]);
  assert.equal(result.localizedNames.zh_CN, "本地化扩展");
  assert.equal(result.translationCount, 1);
});

test("stops reading URL sources as soon as the 5 MiB limit is exceeded", async () => {
  let canceled = false;
  let chunkIndex = 0;
  const chunks = [
    new Uint8Array(4 * 1024 * 1024),
    new Uint8Array(2 * 1024 * 1024),
  ];
  const testWindow = { location: { href: "https://example.com/" } };
  vm.runInNewContext(loaderSource, {
    window: testWindow,
    Blob,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async () => ({
      ok: true,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => chunkIndex < chunks.length
            ? { done: false, value: chunks[chunkIndex++] }
            : { done: true },
          cancel: async () => { canceled = true; },
        }),
      },
      text: async () => { throw new Error("streaming reader was not used"); },
    }),
  });

  await assert.rejects(
    testWindow.TurboWarpExtensionLoader.fetchSource("https://example.com/large.js"),
    /exceeds the 5 MiB limit/,
  );
  assert.equal(canceled, true);
  assert.equal(chunkIndex, 2);
});

function createExtractionTestWindow() {
  const workerBlobs = new Map();
  let nextWorkerUrl = 0;
  const MockURL = {
    createObjectURL(blob) {
      const url = `blob:test-${nextWorkerUrl++}`;
      workerBlobs.set(url, blob);
      return url;
    },
    revokeObjectURL(url) {
      workerBlobs.delete(url);
    },
  };

  class MockWorker {
    constructor(url) {
      this.blob = workerBlobs.get(url);
    }

    postMessage(data) {
      this.blob.text().then(workerCode => {
        const workerGlobal = {
          postMessage: result => this.onmessage({ data: result }),
          setInterval,
          setTimeout,
        };
        workerGlobal.self = workerGlobal;
        vm.runInNewContext(workerCode, workerGlobal);
        return workerGlobal.onmessage({ data });
      }).catch(error => this.onerror({ message: error.message }));
    }

    terminate() {}
  }

  const testWindow = {};
  vm.runInNewContext(loaderSource, {
    window: testWindow,
    Blob,
    URL: MockURL,
    Worker: MockWorker,
    setTimeout,
    clearTimeout,
  });
  return testWindow;
}

test("extracts generated underscore-key translations used by CloudLink", async () => {
  const testWindow = createExtractionTestWindow();
  const source = `
    Scratch.translate.setup({
      "zh-cn": {"_connect to [IP]": "连接到[IP]"}
    });
    Scratch.extensions.register({
      getInfo() {
        return {
          id: "cloudlinktest",
          name: "CloudLink Test",
          blocks: [{
            opcode: "connect",
            blockType: Scratch.BlockType.COMMAND,
            text: Scratch.translate("connect to [IP]"),
            arguments: {IP: {type: Scratch.ArgumentType.STRING}}
          }]
        };
      }
    });
  `;

  const info = await testWindow.TurboWarpExtensionLoader.extractInfo(source);
  assert.equal(info.blocks[0].text, "connect to [IP]");
  assert.equal(info.translations["zh-cn"].blocks[0].text, "连接到[IP]");
});

test("exposes Scratch globally for extensions that use globalThis.Scratch", async () => {
  const testWindow = createExtractionTestWindow();
  const source = `
    (function (Scratch) {
      Scratch.extensions.register({
        getInfo() {
          return {
            id: "globalscratch",
            name: "Global Scratch",
            blocks: [{opcode: "run", blockType: Scratch.BlockType.COMMAND, text: "run"}]
          };
        }
      });
    })(globalThis.Scratch);
  `;

  const info = await testWindow.TurboWarpExtensionLoader.extractInfo(source);
  assert.equal(info.id, "globalscratch");
  assert.equal(info.blocks[0].text, "run");
});

test("uses inert browser stubs without exposing the page environment", async () => {
  const testWindow = createExtractionTestWindow();
  const source = `
    if (window.ResizeObserver) throw new Error("ResizeObserver should be unavailable");
    if (navigator.getBattery) throw new Error("Battery API should be unavailable");
    if (navigator.xr) throw new Error("WebXR should be unavailable");
    window.addEventListener("keydown", function () {});
    document.addEventListener("visibilitychange", function () {});
    document.body.appendChild(document.createElement("canvas"));
    localStorage.setItem("metadata-test", "not persisted");
    new MutationObserver(function () {}).observe(document.body);
    new AudioContext();
    Scratch.vm.runtime.extensionStorage.test = {value: 42};
    const stored = JSON.parse(JSON.stringify(Scratch.vm.runtime.extensionStorage.test));
    Scratch.extensions.register({
      getInfo() {
        return {
          id: "browserstubs",
          name: window.location.href + " " + stored.value,
          blocks: [{opcode: "run", blockType: Scratch.BlockType.COMMAND, text: "run"}]
        };
      }
    });
  `;

  const info = await testWindow.TurboWarpExtensionLoader.extractInfo(source);
  assert.equal(info.id, "browserstubs");
  assert.equal(info.name, "about:blank 42");
});

test("blocks dynamic imports but permits import types in comments", async () => {
  const testWindow = createExtractionTestWindow();
  const safeSource = `
    /** @type {import("scratch-vm").Runtime} */
    const runtime = Scratch.vm.runtime;
    Scratch.extensions.register({
      getInfo() {
        return {
          id: "importcomment",
          name: "Import Comment",
          blocks: [{opcode: "run", blockType: Scratch.BlockType.COMMAND, text: "run"}]
        };
      }
    });
  `;
  const info = await testWindow.TurboWarpExtensionLoader.extractInfo(safeSource);
  assert.equal(info.id, "importcomment");

  await assert.rejects(
    testWindow.TurboWarpExtensionLoader.extractInfo(`
      import /* no network from metadata workers */ ("https://example.com/module.js");
    `),
    /dynamic import\(\) is not supported/,
  );
});

test("blocks string-generated code from recovering dynamic import", async () => {
  const testWindow = createExtractionTestWindow();
  await assert.rejects(
    testWindow.TurboWarpExtensionLoader.extractInfo(`
      (function () {}).constructor("return import('https://example.com/module.js')")();
    `),
    /Dynamic code evaluation is disabled/,
  );
  await assert.rejects(
    testWindow.TurboWarpExtensionLoader.extractInfo(`
      setTimeout("import('https://example.com/module.js')", 0);
    `),
    /Dynamic code evaluation is disabled/,
  );
});
