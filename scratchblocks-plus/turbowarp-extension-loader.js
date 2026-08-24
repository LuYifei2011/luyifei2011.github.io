(function (global) {
  "use strict";

  var MAX_SOURCE_BYTES = 5 * 1024 * 1024;
  var FETCH_TIMEOUT = 15000;
  var WORKER_TIMEOUT = 10000;
  var SAFE_ID = /^[A-Za-z0-9_-]+$/;
  var HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  var DATA_IMAGE = /^data:image\/(?:svg\+xml|png|jpe?g|gif|webp)(?:;[^,]*)?,/i;
  var loadedExtensionIds = Object.create(null);
  var nextInlineIconIndex = 0;

  var workerSource = String.raw`
    "use strict";

    var nativePostMessage = self.postMessage.bind(self);
    var registeredExtension = null;
    var resolveRegistration;
    var currentLanguage = "en";
    var translationCatalogs = Object.create(null);
    var registrationPromise = new Promise(function (resolve) {
      resolveRegistration = resolve;
    });

    function denyNetwork() {
      throw new Error("Network access is disabled while extracting extension metadata");
    }

    function denyDynamicCode() {
      throw new Error("Dynamic code evaluation is disabled while extracting extension metadata");
    }

    function hasDynamicImport(source) {
      var index = 0;
      var length = source.length;

      function skipComment(position) {
        if (source.charAt(position) !== "/") return position;
        if (source.charAt(position + 1) === "/") {
          position += 2;
          while (position < length && source.charAt(position) !== "\n") position += 1;
          return position;
        }
        if (source.charAt(position + 1) === "*") {
          var end = source.indexOf("*/", position + 2);
          return end === -1 ? length : end + 2;
        }
        return position;
      }

      while (index < length) {
        var character = source.charAt(index);
        if (character === "'" || character === '"') {
          var quote = character;
          index += 1;
          while (index < length) {
            character = source.charAt(index);
            if (character === "\\") index += 2;
            else if (character === quote) {
              index += 1;
              break;
            } else index += 1;
          }
          continue;
        }
        var afterComment = skipComment(index);
        if (afterComment !== index) {
          index = afterComment;
          continue;
        }
        if (!/[A-Za-z_$]/.test(character)) {
          index += 1;
          continue;
        }

        var identifierStart = index;
        index += 1;
        while (index < length && /[A-Za-z0-9_$]/.test(source.charAt(index))) index += 1;
        if (source.slice(identifierStart, index) !== "import") continue;

        var previous = identifierStart - 1;
        while (previous >= 0 && /\s/.test(source.charAt(previous))) previous -= 1;
        if (source.charAt(previous) === ".") continue;

        var next = index;
        while (next < length) {
          while (next < length && /\s/.test(source.charAt(next))) next += 1;
          afterComment = skipComment(next);
          if (afterComment === next) break;
          next = afterComment;
        }
        if (source.charAt(next) === "(") return true;
      }
      return false;
    }

    function replaceGlobal(name, value) {
      try {
        Object.defineProperty(self, name, {
          configurable: true,
          writable: false,
          value: value,
        });
      } catch (_error) {
        try { self[name] = value; } catch (_ignored) {}
      }
    }

    function describeError(error) {
      var message = error && error.message ? error.message : String(error);
      if (
        /Network access is disabled/i.test(message) ||
        /Dynamic code evaluation is disabled/i.test(message) ||
        /\b(?:document|window|localStorage|sessionStorage|HTMLElement|customElements|DOMParser|Image)\b.*(?:not defined|undefined)/i.test(message)
      ) {
        return "Extension is incompatible with metadata-only loading: " + message;
      }
      return message;
    }

    function makeInertProxy(properties) {
      var inert;
      var target = function () { return inert; };
      var values = properties || Object.create(null);
      inert = new Proxy(target, {
        get: function (_target, property) {
          if (Object.prototype.hasOwnProperty.call(values, property)) {
            return values[property];
          }
          if (property === "then") return undefined;
          if (property === Symbol.toPrimitive) return function () { return 0; };
          if (property === Symbol.iterator) return function* () {};
          return inert;
        },
        set: function () { return true; },
        apply: function () { return inert; },
        construct: function () { return inert; },
      });
      return inert;
    }

    function makeBrowserStubs() {
      var noop = function () {};
      var inert = makeInertProxy();
      var inertConstructor = makeInertProxy();
      var storage = {
        length: 0,
        clear: noop,
        getItem: function () { return null; },
        key: function () { return null; },
        removeItem: noop,
        setItem: noop,
      };
      var location = {
        hash: "",
        host: "",
        hostname: "",
        href: "about:blank",
        origin: "null",
        pathname: "",
        port: "",
        protocol: "about:",
        search: "",
        assign: noop,
        reload: noop,
        replace: noop,
        toString: function () { return "about:blank"; },
      };
      var element = makeInertProxy({
        children: [],
        childNodes: [],
        classList: makeInertProxy(),
        dataset: Object.create(null),
        style: Object.create(null),
      });
      var document = makeInertProxy({
        body: element,
        documentElement: element,
        head: element,
        hidden: false,
        readyState: "complete",
        visibilityState: "visible",
        addEventListener: noop,
        createElement: function () { return element; },
        createElementNS: function () { return element; },
        getElementById: function () { return element; },
        querySelector: function () { return element; },
        querySelectorAll: function () { return []; },
        removeEventListener: noop,
      });
      var navigator = makeInertProxy({
        getBattery: undefined,
        language: "en",
        languages: ["en"],
        onLine: false,
        platform: "",
        userAgent: "",
        xr: undefined,
      });
      var window = makeInertProxy({
        Audio: inertConstructor,
        AudioContext: inertConstructor,
        DOMParser: inertConstructor,
        FileReader: inertConstructor,
        Image: inertConstructor,
        MutationObserver: inertConstructor,
        ResizeObserver: undefined,
        ScratchBlocks: null,
        document: document,
        fetch: denyNetwork,
        isSecureContext: false,
        localStorage: storage,
        location: location,
        navigator: navigator,
        open: denyNetwork,
        sessionStorage: storage,
        webkitAudioContext: inertConstructor,
        XMLHttpRequest: denyNetwork,
        WebSocket: denyNetwork,
      });
      return {
        inert: inert,
        constructor: inertConstructor,
        document: document,
        location: location,
        navigator: navigator,
        storage: storage,
        window: window,
      };
    }

    function textValue(value) {
      if (typeof value === "string") return value;
      if (!value || typeof value !== "object") return "";
      if (typeof value.default === "string") return value.default;
      if (typeof value.defaultMessage === "string") return value.defaultMessage;
      if (typeof value.id === "string") return value.id;
      return "";
    }

    function interpolate(value, placeholders) {
      if (!placeholders || typeof placeholders !== "object") return value;
      return value.replace(/\{([^{}]+)\}/g, function (match, name) {
        return Object.prototype.hasOwnProperty.call(placeholders, name)
          ? String(placeholders[name])
          : match;
      });
    }

    function cleanArgument(argument) {
      if (!argument || typeof argument !== "object") return null;
      return {
        type: typeof argument.type === "string" ? argument.type : "string",
        menu: typeof argument.menu === "string" ? argument.menu : null,
        dataURI: typeof argument.dataURI === "string" ? argument.dataURI : null,
        alt: typeof argument.alt === "string" ? argument.alt : "",
      };
    }

    function cleanBlock(block) {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return null;
      var blockType = typeof block.blockType === "string" ? block.blockType : "";
      var args = {};
      if (block.arguments && typeof block.arguments === "object") {
        Object.keys(block.arguments).forEach(function (name) {
          args[name] = cleanArgument(block.arguments[name]);
        });
      }
      return {
        opcode: typeof block.opcode === "string" ? block.opcode : "",
        blockType: blockType,
        text: textValue(block.text),
        arguments: args,
        branchCount: Number.isFinite(block.branchCount) && block.branchCount !== 0
          ? block.branchCount
          : blockType.toLowerCase() === "conditional" || blockType.toLowerCase() === "loop" ? 1 : 0,
        isTerminal: Boolean(block.isTerminal || block.terminal),
      };
    }

    function cleanInfo(info) {
      if (!info || typeof info !== "object") {
        throw new Error("getInfo() did not return an object");
      }
      return {
        id: typeof info.id === "string" ? info.id : "",
        name: textValue(info.name),
        color1: typeof info.color1 === "string" ? info.color1 : null,
        color2: typeof info.color2 === "string" ? info.color2 : null,
        color3: typeof info.color3 === "string" ? info.color3 : null,
        blockIconURI: typeof info.blockIconURI === "string" ? info.blockIconURI : null,
        blocks: Array.isArray(info.blocks) ? info.blocks.map(cleanBlock) : [],
      };
    }

    self.onmessage = async function (event) {
      var source = event.data && event.data.source;
      if (typeof source !== "string") {
        nativePostMessage({ ok: false, error: "Missing extension source" });
        return;
      }

      var inert = makeInertProxy();
      var translate = function (message, placeholders) {
        var fallback = textValue(message);
        var id = message && typeof message === "object" && typeof message.id === "string"
          ? message.id
          : fallback;
        var catalog = translationCatalogs[currentLanguage];
        var translated = fallback;
        if (catalog) {
          if (typeof catalog[id] === "string") translated = catalog[id];
          else if (typeof catalog["_" + fallback] === "string") translated = catalog["_" + fallback];
        }
        return interpolate(translated, placeholders);
      };
      translate.setup = function (catalogs) {
        if (!catalogs || typeof catalogs !== "object") return;
        Object.keys(catalogs).forEach(function (language) {
          var catalog = catalogs[language];
          if (!catalog || typeof catalog !== "object") return;
          translationCatalogs[language] = Object.assign(
            translationCatalogs[language] || Object.create(null),
            catalog
          );
        });
      };
      Object.defineProperty(translate, "language", {
        get: function () { return currentLanguage; },
      });

      var inertRuntime = makeInertProxy({
        extensionStorage: Object.create(null),
      });
      var inertVM = makeInertProxy({
        audioEngine: inert,
        renderer: inert,
        runtime: inertRuntime,
      });
      var Scratch = {
        BlockType: {
          COMMAND: "command",
          REPORTER: "reporter",
          BOOLEAN: "Boolean",
          HAT: "hat",
          EVENT: "event",
          LOOP: "loop",
          CONDITIONAL: "conditional",
          BUTTON: "button",
          LABEL: "label",
          XML: "xml",
        },
        ArgumentType: {
          STRING: "string",
          NUMBER: "number",
          BOOLEAN: "Boolean",
          COLOR: "color",
          ANGLE: "angle",
          MATRIX: "matrix",
          NOTE: "note",
          IMAGE: "image",
          COSTUME: "costume",
          SOUND: "sound",
        },
        TargetType: { STAGE: "stage", SPRITE: "sprite" },
        extensions: {
          unsandboxed: true,
          register: function (extension) {
            if (registeredExtension) {
              throw new Error("The extension called Scratch.extensions.register() more than once");
            }
            registeredExtension = extension;
            resolveRegistration(extension);
          },
        },
        translate: translate,
        vm: inertVM,
        runtime: inertRuntime,
        renderer: inert,
        audioEngine: inert,
        Cast: {
          toString: function (value) { return String(value); },
          toNumber: function (value) { return Number(value) || 0; },
          toBoolean: function (value) { return Boolean(value); },
          compare: function (a, b) { return a === b ? 0 : a < b ? -1 : 1; },
          isWhiteSpace: function (value) { return /^\s*$/.test(String(value)); },
        },
        fetch: function () { return Promise.reject(new Error("Network access is disabled")); },
        canFetch: function () { return Promise.resolve(false); },
        canOpenWindow: function () { return Promise.resolve(false); },
        canRedirect: function () { return Promise.resolve(false); },
        canEmbed: function () { return Promise.resolve(false); },
        openWindow: function () {},
        redirect: function () {},
      };

      try {
        var NativeFunction = Function;
        var nativeSetTimeout = self.setTimeout.bind(self);
        var nativeSetInterval = self.setInterval.bind(self);
        var browserStubs = makeBrowserStubs();
        replaceGlobal("postMessage", undefined);
        [
          "fetch",
          "XMLHttpRequest",
          "WebSocket",
          "EventSource",
          "importScripts",
          "Worker",
          "SharedWorker",
          "WebTransport",
          "RTCPeerConnection",
          "webkitRTCPeerConnection",
          "mozRTCPeerConnection",
        ].forEach(function (name) {
          replaceGlobal(name, denyNetwork);
        });
        ["BroadcastChannel", "indexedDB", "caches"].forEach(function (name) {
          replaceGlobal(name, undefined);
        });
        replaceGlobal("Scratch", Scratch);
        replaceGlobal("window", browserStubs.window);
        replaceGlobal("document", browserStubs.document);
        replaceGlobal("localStorage", browserStubs.storage);
        replaceGlobal("sessionStorage", browserStubs.storage);
        replaceGlobal("location", browserStubs.location);
        replaceGlobal("navigator", browserStubs.navigator);
        [
          "Audio",
          "AudioContext",
          "DOMParser",
          "FileReader",
          "HTMLElement",
          "Image",
          "MutationObserver",
          "webkitAudioContext",
        ].forEach(function (name) {
          replaceGlobal(name, browserStubs.constructor);
        });
        replaceGlobal("customElements", browserStubs.inert);

        if (hasDynamicImport(source)) {
          throw new Error("Network access is disabled while extracting extension metadata: dynamic import() is not supported");
        }
        replaceGlobal("eval", denyDynamicCode);
        replaceGlobal("Function", denyDynamicCode);
        replaceGlobal("setTimeout", function (handler) {
          if (typeof handler !== "function") return denyDynamicCode();
          return nativeSetTimeout.apply(self, arguments);
        });
        replaceGlobal("setInterval", function (handler) {
          if (typeof handler !== "function") return denyDynamicCode();
          return nativeSetInterval.apply(self, arguments);
        });
        [
          Object.getPrototypeOf(function () {}),
          Object.getPrototypeOf(async function () {}),
          Object.getPrototypeOf(function* () {}),
          Object.getPrototypeOf(async function* () {}),
        ].forEach(function (prototype) {
          try {
            Object.defineProperty(prototype, "constructor", {
              configurable: true,
              writable: false,
              value: denyDynamicCode,
            });
          } catch (_error) {}
        });

        NativeFunction("Scratch", source)(Scratch);
        if (!registeredExtension) {
          await registrationPromise;
        }
        if (typeof registeredExtension.getInfo !== "function") {
          throw new Error("The source did not register an extension with getInfo()");
        }
        currentLanguage = "en";
        var info = registeredExtension.getInfo();
        if (info && typeof info.then === "function") {
          throw new Error("Asynchronous getInfo() is not supported");
        }
        var cleanedInfo = cleanInfo(info);
        var translations = {};
        Object.keys(translationCatalogs).forEach(function (language) {
          currentLanguage = language;
          var localizedInfo = registeredExtension.getInfo();
          if (localizedInfo && typeof localizedInfo.then === "function") {
            throw new Error("Asynchronous getInfo() is not supported");
          }
          translations[language] = cleanInfo(localizedInfo);
        });
        cleanedInfo.translations = translations;
        nativePostMessage({ ok: true, info: cleanedInfo });
      } catch (error) {
        nativePostMessage({
          ok: false,
          error: describeError(error),
        });
      }
    };
  `;

  function byteLength(value) {
    return new Blob([value]).size;
  }

  function assertSourceSize(source) {
    if (byteLength(source) > MAX_SOURCE_BYTES) {
      throw new Error("Extension source exceeds the 5 MiB limit");
    }
  }

  function fetchSource(url) {
    var parsed;
    try {
      parsed = new URL(url, global.location.href);
    } catch (_error) {
      return Promise.reject(new Error("Invalid extension URL"));
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return Promise.reject(new Error("Extension URL must use HTTP or HTTPS"));
    }

    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, FETCH_TIMEOUT);

    return fetch(parsed.href, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("Extension request failed with HTTP " + response.status);
        }
        var length = Number(response.headers.get("content-length"));
        if (length && length > MAX_SOURCE_BYTES) {
          throw new Error("Extension source exceeds the 5 MiB limit");
        }
        if (!response.body || typeof response.body.getReader !== "function") {
          return response.text();
        }

        var reader = response.body.getReader();
        var chunks = [];
        var receivedBytes = 0;
        function readNextChunk() {
          return reader.read().then(function (result) {
            if (result.done) return new Blob(chunks).text();
            receivedBytes += result.value.byteLength;
            if (receivedBytes > MAX_SOURCE_BYTES) {
              return Promise.resolve(reader.cancel()).then(function () {
                throw new Error("Extension source exceeds the 5 MiB limit");
              });
            }
            chunks.push(result.value);
            return readNextChunk();
          });
        }
        return readNextChunk();
      })
      .then(function (source) {
        assertSourceSize(source);
        return source;
      })
      .catch(function (error) {
        if (error && error.name === "AbortError") {
          throw new Error("Extension request timed out after 15 seconds");
        }
        throw error;
      })
      .finally(function () {
        clearTimeout(timer);
      });
  }

  function extractInfo(source) {
    assertSourceSize(source);
    return new Promise(function (resolve, reject) {
      var blob = new Blob([workerSource], { type: "text/javascript" });
      var workerURL = URL.createObjectURL(blob);
      var worker = new Worker(workerURL);
      var settled = false;
      var timer = setTimeout(function () {
        finish(new Error("Extension metadata extraction timed out after 10 seconds"));
      }, WORKER_TIMEOUT);

      function finish(error, info) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        URL.revokeObjectURL(workerURL);
        if (error) reject(error);
        else resolve(info);
      }

      worker.onmessage = function (event) {
        var result = event.data;
        if (!result || result.ok !== true) {
          finish(new Error((result && result.error) || "Extension metadata extraction failed"));
          return;
        }
        finish(null, result.info);
      };
      worker.onerror = function (event) {
        finish(new Error(event.message || "Extension metadata worker failed"));
      };
      worker.postMessage({ source: source });
    });
  }

  function safeColor(value, fallback, label, warnings) {
    if (value == null) return fallback;
    if (HEX_COLOR.test(value)) return value;
    warnings.push(label + " is not a valid hex color; using " + fallback);
    return fallback;
  }

  function normalizeHexColor(value) {
    if (value.length === 4) {
      return (
        "#" +
        value.charAt(1) + value.charAt(1) +
        value.charAt(2) + value.charAt(2) +
        value.charAt(3) + value.charAt(3)
      ).toLowerCase();
    }
    return value.toLowerCase();
  }

  function clamp(value, lower, upper) {
    return Math.max(lower, Math.min(upper, value));
  }

  function hexToHsv(hex) {
    var value = Number.parseInt(normalizeHexColor(hex).substring(1), 16);
    var red = ((value >> 16) & 255) / 255;
    var green = ((value >> 8) & 255) / 255;
    var blue = (value & 255) / 255;
    var brightness = Math.max(red, green, blue);
    var difference = brightness - Math.min(red, green, blue);
    var hue = 0;
    var saturation = 0;

    if (difference !== 0) {
      saturation = difference / brightness;
      var differenceFromMax = function (component) {
        return (((brightness - component) / 6) / difference) + 0.5;
      };
      var redDifference = differenceFromMax(red);
      var greenDifference = differenceFromMax(green);
      var blueDifference = differenceFromMax(blue);
      if (red === brightness) hue = blueDifference - greenDifference;
      else if (green === brightness) hue = (1 / 3) + redDifference - blueDifference;
      else hue = (2 / 3) + greenDifference - redDifference;
      if (hue < 0) hue += 1;
      else if (hue > 1) hue -= 1;
    }

    return [hue * 360, saturation * 100, brightness * 100];
  }

  function hsvToHex(hsv) {
    var hue = hsv[0] / 60;
    var saturation = hsv[1] / 100;
    var brightness = hsv[2] / 100;
    var segment = Math.floor(hue) % 6;
    var fraction = hue - Math.floor(hue);
    var low = 255 * brightness * (1 - saturation);
    var falling = 255 * brightness * (1 - (saturation * fraction));
    var rising = 255 * brightness * (1 - (saturation * (1 - fraction)));
    var high = brightness * 255;
    var rgb;
    if (segment === 0) rgb = [high, rising, low];
    else if (segment === 1) rgb = [falling, high, low];
    else if (segment === 2) rgb = [low, high, rising];
    else if (segment === 3) rgb = [low, falling, high];
    else if (segment === 4) rgb = [rising, low, high];
    else rgb = [high, low, falling];
    var number = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    return "#" + number.toString(16).padStart(6, "0");
  }

  function usesDefaultExtensionColors(colors) {
    return (
      normalizeHexColor(colors.primary) === "#0fbd8c" &&
      normalizeHexColor(colors.secondary) === "#0da57a" &&
      normalizeHexColor(colors.tertiary) === "#0b8e69"
    );
  }

  function highContrastColors(colors) {
    if (usesDefaultExtensionColors(colors)) {
      return {
        primary: "#13ECAF",
        secondary: "#75F0CD",
        tertiary: "#0B8E69",
      };
    }

    var source = hexToHsv(colors.primary);
    var primary = source.slice();
    primary[1] = clamp(primary[1] - 20, 0, 50);
    primary[2] = clamp(primary[2] + 20, 80, 100);
    var secondary = source.slice();
    secondary[1] = clamp(secondary[1] - 40, 0, 50);
    secondary[2] = clamp(secondary[2] + 20, 80, 100);
    var tertiary = source.slice();
    tertiary[2] = clamp(tertiary[2] - 20, 0, 100);
    return {
      primary: hsvToHex(primary),
      secondary: hsvToHex(secondary),
      tertiary: hsvToHex(tertiary),
    };
  }

  function mixWithWhite(color, colorWeight) {
    var value = Number.parseInt(normalizeHexColor(color).substring(1), 16);
    var components = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
    var mixed = components.map(function (component) {
      return Math.round(255 + ((component - 255) * colorWeight));
    });
    var number = (mixed[0] << 16) | (mixed[1] << 8) | mixed[2];
    return "#" + number.toString(16).padStart(6, "0");
  }

  function outlineColors(colors) {
    if (usesDefaultExtensionColors(colors)) {
      return {
        primary: "#fff",
        secondary: "#f2fcf9",
        tertiary: "#0b8e69",
      };
    }
    return {
      primary: "#fff",
      secondary: mixWithWhite(colors.primary, 0.05),
      tertiary: colors.tertiary,
    };
  }

  function imageSource(value, label, warnings) {
    if (!value) return null;
    if (!DATA_IMAGE.test(value)) {
      warnings.push(label + " is not a supported inline image data URI");
      return null;
    }
    return value;
  }

  function letters(number) {
    var result = "";
    do {
      result = String.fromCharCode(97 + (number % 26)) + result;
      number = Math.floor(number / 26) - 1;
    } while (number >= 0);
    return result;
  }

  function addInlineIcon(data, iconDefinitions, iconNamesByData) {
    if (iconNamesByData[data]) return iconNamesByData[data];
    var iconName = "twInlineIcon" + letters(nextInlineIconIndex++);
    iconNamesByData[data] = iconName;
    iconDefinitions.push({ name: iconName, inline: true, data: data });
    return iconName;
  }

  function mapShape(block, warnings, label) {
    var type = String(block.blockType || "").toLowerCase();
    if (type === "command") return block.isTerminal ? "cap" : "stack";
    if (type === "reporter") return "reporter";
    if (type === "boolean") return "boolean";
    if (type === "hat" || type === "event") return "hat";
    if (type === "loop" || type === "conditional") {
      if (block.branchCount == null || block.branchCount === 0 || block.branchCount === 1) {
        return block.isTerminal ? "c-block cap" : "c-block";
      }
      warnings.push(label + " was skipped because only one-branch control blocks are supported");
      return null;
    }
    if (type === "button" || type === "label" || type === "xml") {
      return null;
    }
    warnings.push(label + " was skipped because block type '" + (block.blockType || "missing") + "' is unsupported");
    return null;
  }

  function mapInput(argument, warnings, label) {
    if (argument.menu) {
      return "%m";
    }
    var type = String(argument.type || "string").toLowerCase();
    if (type === "string") return "%s";
    if (type === "number" || type === "angle") return "%n";
    if (type === "note") return "%d.note";
    if (type === "boolean") return "%b";
    if (type === "color") return "%c";
    if (type === "matrix" || type === "costume" || type === "sound") return "%m";
    warnings.push(label + " uses unknown argument type '" + type + "'; treating it as text");
    return "%s";
  }

  function normalizeAliasSpec(spec) {
    return spec.replace(/\s+/g, " ").trim();
  }

  function aliasSpecForText(text, tokens, imageFallback) {
    return normalizeAliasSpec(text.replace(/\[([A-Za-z0-9_]+)\]/g, function (match, name) {
      if (!tokens[name]) return match;
      if (tokens[name].isImage && !tokens[name].aliasToken) {
        return imageFallback;
      }
      return tokens[name].aliasToken;
    }));
  }

  function convertInfo(info) {
    var warnings = [];
    if (!info || typeof info !== "object") throw new Error("Missing extension metadata");
    if (!SAFE_ID.test(info.id || "")) {
      throw new Error("Extension id must contain only letters, numbers, underscores, or hyphens");
    }
    if (!Array.isArray(info.blocks)) throw new Error("Extension blocks must be an array");

    var colors = {
      primary: safeColor(info.color1, "#0fbd8c", "color1", warnings),
      secondary: safeColor(info.color2, "#0da57a", "color2", warnings),
      tertiary: safeColor(info.color3, "#0b8e69", "color3", warnings),
    };
    var categoryIcon = imageSource(info.blockIconURI, "blockIconURI", warnings);
    var iconDefinitions = [];
    var iconNamesByData = Object.create(null);
    var blockDefinitions = [];
    var opcodes = Object.create(null);
    var placeholderTokens = Object.create(null);

    info.blocks.forEach(function (block, index) {
      var entryLabel = "Block " + (index + 1);
      if (typeof block === "string") {
        return;
      }
      if (!block || typeof block !== "object") {
        warnings.push(entryLabel + " was skipped because its definition is invalid");
        return;
      }
      var blockType = String(block.blockType || "").toLowerCase();
      if (blockType === "button" || blockType === "label" || blockType === "xml") {
        return;
      }
      if (!SAFE_ID.test(block.opcode || "")) {
        warnings.push(entryLabel + " was skipped because its opcode is missing or invalid");
        return;
      }
      if (opcodes[block.opcode]) {
        throw new Error("Duplicate opcode: " + block.opcode);
      }
      opcodes[block.opcode] = true;

      var label = info.id + "." + block.opcode;
      var shape = mapShape(block, warnings, label);
      if (!shape) return;
      if (!block.text) {
        warnings.push(label + " was skipped because it has no default block text");
        return;
      }
      var inputs = [];
      var tokens = Object.create(null);
      var invalidPlaceholder = null;
      var spec = block.text.replace(/\[([A-Za-z0-9_]+)\]/g, function (_match, name) {
        var argument = block.arguments && block.arguments[name];
        if (!argument) {
          invalidPlaceholder = name;
          return _match;
        }
        if (String(argument.type).toLowerCase() === "image") {
          var image = imageSource(argument.dataURI, label + " image " + name, warnings);
          if (!image) {
            tokens[name] = {
              token: argument.alt || "",
              aliasToken: argument.alt || "",
              isImage: false,
              repeatable: true,
              required: false,
            };
            return tokens[name].token;
          }
          tokens[name] = {
            token: "@" + addInlineIcon(image, iconDefinitions, iconNamesByData),
            aliasToken: argument.alt || "",
            isImage: true,
            repeatable: true,
            required: false,
          };
          return tokens[name].token;
        }
        if (!tokens[name]) {
          inputs.push(mapInput(argument, warnings, label + " argument " + name));
          tokens[name] = {
            token: "%" + inputs.length,
            aliasToken: "%" + inputs.length,
            isImage: false,
            repeatable: false,
            required: true,
          };
        }
        return tokens[name].token;
      });

      if (invalidPlaceholder) {
        warnings.push(label + " was skipped because [" + invalidPlaceholder + "] has no argument definition");
        return;
      }
      var blockDefinition = {
        id: label,
        shape: shape,
        category: info.id,
        inputs: inputs,
        hasLoopArrow: String(block.blockType).toLowerCase() === "loop",
        spec: spec,
      };
      var aliasSpec = aliasSpecForText(block.text, tokens, info.name || info.id);
      if (aliasSpec && aliasSpec !== spec) {
        blockDefinition.aliases = [aliasSpec];
      }
      blockDefinitions.push(blockDefinition);
      placeholderTokens[block.opcode] = tokens;
    });

    if (blockDefinitions.length === 0) {
      throw new Error("The extension contains no supported script blocks");
    }

    var translations = Object.create(null);
    Object.keys(info.translations || {}).forEach(function (language) {
      var localizedInfo = info.translations[language];
      if (!localizedInfo || localizedInfo.id !== info.id || !Array.isArray(localizedInfo.blocks)) return;
      var localizedBlocks = Object.create(null);
      var localizedAliases = Object.create(null);
      localizedInfo.blocks.forEach(function (block) {
        if (!block || typeof block !== "object" || !opcodes[block.opcode] || !block.text) return;
        var tokens = placeholderTokens[block.opcode];
        if (!tokens) return;
        var used = Object.create(null);
        var invalid = false;
        var spec = block.text.replace(/\[([A-Za-z0-9_]+)\]/g, function (match, name) {
          var tokenInfo = tokens[name];
          if (!tokenInfo || (used[name] && !tokenInfo.repeatable)) {
            invalid = true;
            return match;
          }
          used[name] = true;
          return tokenInfo.token;
        });
        Object.keys(tokens).forEach(function (name) {
          if (tokens[name].required && !used[name]) invalid = true;
        });
        if (invalid) {
          warnings.push(info.id + "." + block.opcode + " has an invalid " + language + " translation; using English");
          return;
        }
        var blockId = info.id + "." + block.opcode;
        localizedBlocks[blockId] = spec;
        var aliasSpec = aliasSpecForText(
          block.text,
          tokens,
          localizedInfo.name || info.name || info.id
        );
        if (aliasSpec && aliasSpec !== spec) {
          localizedAliases[blockId] = [aliasSpec];
        }
      });
      translations[language] = {
        name: localizedInfo.name || info.name || info.id,
        blocks: localizedBlocks,
        aliases: localizedAliases,
      };
    });

    return {
      id: info.id,
      name: info.name || info.id,
      colors: colors,
      highContrastColors: highContrastColors(colors),
      outlineColors: outlineColors(colors),
      categoryIcon: categoryIcon,
      inlineIcons: iconDefinitions,
      blocks: blockDefinitions,
      translations: translations,
      warnings: warnings,
    };
  }

  function normalizeLanguageCode(code) {
    return String(code || "").toLowerCase().replace(/_/g, "-");
  }

  function findScratchblocksLanguage(language, scratchblocks) {
    var normalized = normalizeLanguageCode(language);
    return Object.keys(scratchblocks.allLanguages || {}).find(function (candidate) {
      return normalizeLanguageCode(candidate) === normalized;
    });
  }

  function registerConverted(converted, scratchblocks) {
    if (!scratchblocks) throw new Error("scratchblocks is not available");
    if (loadedExtensionIds[converted.id]) {
      throw new Error("Extension id '" + converted.id + "' is already loaded");
    }

    var categoryIconName;
    if (converted.categoryIcon) {
      categoryIconName = "twCategoryIcon" + letters(Object.keys(loadedExtensionIds).length);
      scratchblocks.registerIcon({
        name: categoryIconName,
        inline: false,
        scratch3: {
          width: 40,
          height: 40,
          source: { type: "image", data: converted.categoryIcon },
        },
      });
    }
    converted.inlineIcons.forEach(function (icon) {
      scratchblocks.registerIcon({
        name: icon.name,
        inline: true,
        scratch3: {
          width: 40,
          height: 40,
          source: { type: "image", data: icon.data },
        },
      });
    });
    scratchblocks.registerCategory({
      name: converted.id,
      icon: categoryIconName,
      styles: {
        scratch2: converted.colors.primary,
        scratch3: converted.colors,
        scratch3HighContrast: converted.highContrastColors,
        scratch3Outline: converted.outlineColors,
      },
    });
    function aliasesFor(inlineAliases) {
      var aliases = (inlineAliases || []).slice();
      return aliases.filter(function (alias, index) {
        return alias && aliases.indexOf(alias) === index;
      });
    }
    converted.blocks.forEach(function (block) {
      scratchblocks.registerBlock({
        id: block.id,
        spec: block.spec,
        shape: block.shape,
        category: block.category,
        inputs: block.inputs,
        hasLoopArrow: block.hasLoopArrow,
      });
      scratchblocks.registerBlockTranslation(
        "en",
        block.id,
        block.spec,
        aliasesFor(block.aliases)
      );
    });

    var localizedNames = Object.create(null);
    var translationCount = 0;
    Object.keys(converted.translations || {}).forEach(function (language) {
      var scratchblocksLanguage = findScratchblocksLanguage(language, scratchblocks);
      if (!scratchblocksLanguage || scratchblocksLanguage === "en") return;
      var translation = converted.translations[language];
      localizedNames[scratchblocksLanguage] = translation.name;
      Object.keys(translation.blocks).forEach(function (blockId) {
        var englishBlock = converted.blocks.find(function (block) { return block.id === blockId; });
        var spec = translation.blocks[blockId];
        if (!englishBlock) return;
        scratchblocks.registerBlockTranslation(
          scratchblocksLanguage,
          blockId,
          spec,
          aliasesFor(translation.aliases && translation.aliases[blockId])
        );
        translationCount += 1;
      });
    });

    loadedExtensionIds[converted.id] = true;
    scratchblocks.updateStyles();
    return {
      id: converted.id,
      name: converted.name,
      localizedNames: localizedNames,
      blockCount: converted.blocks.length,
      translationCount: translationCount,
      warnings: converted.warnings,
    };
  }

  function loadSource(source, scratchblocks) {
    return extractInfo(source)
      .then(convertInfo)
      .then(function (converted) {
        return registerConverted(converted, scratchblocks);
      });
  }

  function loadURL(url, scratchblocks) {
    return fetchSource(url).then(function (source) {
      return loadSource(source, scratchblocks);
    });
  }

  global.TurboWarpExtensionLoader = {
    MAX_SOURCE_BYTES: MAX_SOURCE_BYTES,
    fetchSource: fetchSource,
    extractInfo: extractInfo,
    convertInfo: convertInfo,
    registerConverted: registerConverted,
    loadSource: loadSource,
    loadURL: loadURL,
  };
})(window);
