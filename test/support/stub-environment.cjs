// Test support: loads glvis-js's `src/index.js` into an isolated VM context
// with a minimal fake DOM and a replaceable renderer stub, so the display
// lifecycle can be exercised without Emscripten/WebGL.
//
// The real `src/glvis.js` is a git-lfs pointer in this checkout, so the UMD
// factory's `require("./glvis")` is answered with the stub factory instead.

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const INDEX_JS = path.resolve(__dirname, "..", "..", "src", "index.js");

// ---------------------------------------------------------------------------
// Renderer stub: models just enough of the GLVis Emscripten bindings.
// ---------------------------------------------------------------------------
class RendererStub {
  constructor(opts = {}) {
    this.dpr = opts.dpr === undefined ? 1 : opts.dpr;
    this.drawableW = 0;
    this.drawableH = 0;
    this.logicalW = 0;
    this.logicalH = 0;

    // identifies the frame currently on screen; screenshots expose it
    this.frameId = null;
    this.state = "empty"; // "empty" | "displayed"

    // failure / blocking behaviour knobs
    this.failDisplay = null; // Error|string -> displayStream/Parallel throws
    this.failUpdate = false; // update returns 1
    this.throwUpdate = null; // Error|string -> update throws
    this.holdDisplay = false; // block display until .releaseDisplay()
    this._held = null;

    this.calls = {
      displayStream: [],
      displayParallelStreams: [],
      updateStream: [],
      updateParallelStreams: [],
      resizeWindow: [],
      sendExposeEvent: 0,
      iterVisualization: 0,
      getScreenBuffer: [],
      getPNGByteArray: 0,
      setCanvasId: [],
    };

    this.StringArray = class StringArray {
      constructor() {
        this._items = [];
      }
      push_back(s) {
        this._items.push(s);
      }
      delete() {
        this._items = null;
      }
    };

    // Emscripten bindings do not depend on their receiver, and the library
    // deliberately extracts them into local variables before calling. Bind
    // them so the stub behaves the same way.
    for (const name of [
      "setCanvasId",
      "setKeyboardListeningElementId",
      "processKey",
      "processKeys",
      "getHelpString",
      "resizeWindow",
      "sendExposeEvent",
      "iterVisualization",
      "displayStream",
      "displayParallelStreams",
      "updateStream",
      "updateParallelStreams",
      "getScreenBuffer",
      "getPNGByteArray",
    ]) {
      this[name] = this[name].bind(this);
    }
  }

  // --- lifecycle -----------------------------------------------------------
  setCanvasId(id) {
    this.calls.setCanvasId.push(id);
  }
  setKeyboardListeningElementId() {}
  processKey() {}
  processKeys() {}
  getHelpString() {
    return "help";
  }

  resizeWindow(w, h) {
    this.calls.resizeWindow.push([w, h]);
    this.logicalW = w;
    this.logicalH = h;
    // same convention as the canvas element: floor(logical * dpr)
    this.drawableW = Math.floor(w * this.dpr);
    this.drawableH = Math.floor(h * this.dpr);
  }

  sendExposeEvent() {
    this.calls.sendExposeEvent++;
  }

  iterVisualization() {
    this.calls.iterVisualization++;
  }

  // --- streams -------------------------------------------------------------
  _applyStream(stream, w, h) {
    const text = typeof stream === "string" ? stream : String(stream);
    // simulate a stream that asks GLVis to change the window resolution
    const m = /window_size\s+(\d+)\s+(\d+)/.exec(text);
    if (m) {
      this.resizeWindow(parseInt(m[1], 10), parseInt(m[2], 10));
    } else {
      this.resizeWindow(w, h);
    }
    // for a parallel stream list the last stream wins, like the rank that ends
    // up owning the rendered frame
    const ids = text.match(/stream_id=(\d+)/g) || [];
    const last = ids.length
      ? /stream_id=(\d+)/.exec(ids[ids.length - 1])
      : null;
    this.frameId = last ? parseInt(last[1], 10) : null;
    this.state = "displayed";
  }

  _display(stream, w, h) {
    if (this.failDisplay) {
      const err = this.failDisplay;
      this.failDisplay = null;
      this.state = "empty";
      throw err;
    }
    if (this.holdDisplay) {
      // deferred until the test calls releaseDisplay()
      return new Promise((resolve) => {
        this._held = () => {
          this._applyStream(stream, w, h);
          resolve(undefined);
        };
      });
    }
    this._applyStream(stream, w, h);
    return undefined;
  }

  releaseDisplay() {
    const held = this._held;
    this._held = null;
    this.holdDisplay = false;
    if (held) {
      held();
    }
  }

  displayStream(stream, w, h) {
    this.calls.displayStream.push([stream, w, h]);
    return this._display(stream, w, h);
  }

  displayParallelStreams(streams, w, h) {
    const items = streams._items.slice();
    this.calls.displayParallelStreams.push([items, w, h]);
    return this._display(items.join("\n"), w, h);
  }

  updateStream(stream) {
    this.calls.updateStream.push(stream);
    if (this.throwUpdate) {
      const err = this.throwUpdate;
      this.throwUpdate = null;
      throw err;
    }
    if (this.failUpdate) {
      return 1;
    }
    if (this.state !== "displayed") {
      return 1;
    }
    const id = /stream_id=(\d+)/.exec(stream);
    this.frameId = id ? parseInt(id[1], 10) : this.frameId;
    return 0;
  }

  updateParallelStreams(streams) {
    const items = streams._items.slice();
    this.calls.updateParallelStreams.push(items);
    if (this.throwUpdate) {
      const err = this.throwUpdate;
      this.throwUpdate = null;
      throw err;
    }
    if (this.failUpdate || this.state !== "displayed") {
      return 1;
    }
    const m = /stream_id=(\d+)/.exec(items.join("\n"));
    this.frameId = m ? parseInt(m[1], 10) : this.frameId;
    return 0;
  }

  // --- captures ------------------------------------------------------------
  _buffer() {
    const n = this.drawableW * this.drawableH * 4;
    const buf = new Uint8Array(n);
    if (this.frameId !== null) {
      buf.fill(this.frameId & 0xff);
    }
    return buf;
  }

  getScreenBuffer(flipY) {
    this.calls.getScreenBuffer.push(!!flipY);
    return this._buffer();
  }

  getPNGByteArray() {
    this.calls.getPNGByteArray++;
    if (this.frameId === null) {
      return null;
    }
    return new Uint8Array([this.frameId & 0xff, 1, 2, 3]);
  }
}

// ---------------------------------------------------------------------------
// Fake DOM / browser globals
// ---------------------------------------------------------------------------
function createFakeCanvas() {
  const canvas = {
    id: "",
    style: {},
    width: 0,
    height: 0,
    innerHTML: "",
    oncontextmenu: null,
    _listeners: {},
    addEventListener(name, fn) {
      (this._listeners[name] = this._listeners[name] || []).push(fn);
    },
    getContext() {
      // one persistent 2d context per canvas, like a real canvas
      if (!this._ctx) {
        this._ctx = {
          _put: null,
          putImageData(imdata) {
            this._put = imdata;
          },
        };
      }
      return this._ctx;
    },
  };
  return canvas;
}

class FakeImageData {
  constructor(data, width, height) {
    if (data.length !== width * height * 4) {
      throw new Error("ImageData size mismatch");
    }
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

function createEnvironment(opts = {}) {
  const frames = [];
  const links = [];
  const createdCanvases = [];

  const canvas = opts.canvas || createFakeCanvas();
  const div = {
    id: opts.divId || "glvis-div",
    focused: false,
    children: [],
    append(child) {
      this.children.push(child);
    },
    focus() {
      this.focused = true;
    },
  };

  const document = {
    createElement(tag) {
      if (tag === "canvas") {
        const c = createFakeCanvas();
        createdCanvases.push(c);
        return c;
      }
      if (tag === "a") {
        const a = {
          download: null,
          href: null,
          clicked: 0,
          click() {
            this.clicked++;
            links.push(this);
          },
        };
        return a;
      }
      return {};
    },
  };

  const win = {
    devicePixelRatio: opts.dpr === undefined ? 1 : opts.dpr,
    crypto: {
      getRandomValues(arr) {
        for (let i = 0; i < arr.length; i++) {
          arr[i] = (i * 37 + 11) & 0xff;
        }
        return arr;
      },
    },
    requestAnimationFrame(cb) {
      frames.push(cb);
      return frames.length;
    },
    cancelAnimationFrame(id) {
      void id;
    },
  };

  const logs = [];
  const quietConsole = {
    log: (...a) => logs.push(["log", a.join(" ")]),
    warn: (...a) => logs.push(["warn", a.join(" ")]),
    error: (...a) => logs.push(["error", a.join(" ")]),
    info: (...a) => logs.push(["info", a.join(" ")]),
  };

  const sandbox = {
    window: win,
    document,
    console: quietConsole,
    ImageData: FakeImageData,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    setTimeout,
    clearTimeout,
    queueMicrotask,
    fetch: undefined,
    alert: (m) => logs.push(["alert", String(m)]),
    Promise,
    Uint8Array,
    Uint8ClampedArray,
    Array,
    Math,
    JSON,
    Object,
    Error,
    module: { exports: {} },
  };
  sandbox.exports = sandbox.module.exports;
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;
  sandbox.module.exports = {};
  sandbox.exports = sandbox.module.exports;

  const context = vm.createContext(sandbox);

  // load a source file with `require("./glvis")` answered by the given stub
  // factory (the real glvis.js is a git-lfs pointer in this checkout)
  function loadModule(sourceFile, rendererFactory) {
    const source = fs.readFileSync(sourceFile, "utf8");
    const factory = rendererFactory || opts.rendererFactory;
    if (typeof factory !== "function") {
      throw new Error("a renderer factory is required to load " + sourceFile);
    }
    const requireStub = (spec) => {
      if (spec === "./glvis") {
        return () => factory();
      }
      throw new Error("unexpected require: " + spec);
    };
    sandbox.require = requireStub;
    vm.runInContext(source, context, { filename: sourceFile });
    return sandbox.module.exports;
  }

  // frame pump: run pending animation-frame callbacks
  function tick(n = 1) {
    for (let i = 0; i < n; i++) {
      const batch = frames.splice(0, frames.length);
      batch.forEach((cb) => cb(i));
    }
  }

  return {
    sandbox,
    div,
    canvas,
    win,
    links,
    createdCanvases,
    logs,
    frames,
    tick,
    pendingFrames: () => frames.length,
    loadIndex: (rendererFactory) => loadModule(INDEX_JS, rendererFactory),
    loadSource: (file, rendererFactory) => loadModule(file, rendererFactory),
  };
}

async function flushMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

// Build a State around a stub renderer. `renderer` may be a RendererStub or a
// promise-like gate that resolves later (to test "renderer not ready").
function makeState(env, glvis, options = {}) {
  const width = options.width === undefined ? 640 : options.width;
  const height = options.height === undefined ? 480 : options.height;
  return new glvis.State(env.div, width, height, env.canvas);
}

module.exports = {
  RendererStub,
  createEnvironment,
  createFakeCanvas,
  FakeImageData,
  flushMicrotasks,
  makeState,
  INDEX_JS,
};
