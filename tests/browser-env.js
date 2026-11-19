/*
 * browser-env.js
 *
 * Minimal browser-environment stubs used to load script.js inside a
 * Node vm context. Only the APIs the player actually touches are
 * implemented; everything else is intentionally absent so accidental
 * dependencies surface as test failures.
 */
"use strict";

const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");

function createElementStub(tagName) {
  const el = {
    tagName: String(tagName || "div").toUpperCase(),
    style: {},
    children: [],
    attributes: {},
    files: [],
    value: "",
    textContent: "",
    disabled: false,
    hidden: false,
    offsetWidth: 800,
    currentTime: 0,
    duration: 0,
    paused: true,
    ended: false,
    muted: false,
    volume: 1,
    textTracks: [{ mode: "" }],
    _src: "",
    get src() {
      return this._src;
    },
    set src(value) {
      this._src = value;
    },
    _innerHTML: "",
    get innerHTML() {
      return this._innerHTML;
    },
    // Rendering resets the list via innerHTML = "", which must drop the
    // previously rendered child elements.
    set innerHTML(value) {
      this._innerHTML = value;
      if (value === "") this.children = [];
    },
    listeners: {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter(c => c !== child);
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    addEventListener(type, handler) {
      (this.listeners[type] ||= []).push(handler);
    },
    removeEventListener(type, handler) {
      this.listeners[type] = (this.listeners[type] || []).filter(h => h !== handler);
    },
    dispatchEvent(event) {
      for (const handler of this.listeners[event.type] || []) {
        handler.call(this, event);
      }
      return true;
    },
    click() {
      this.dispatchEvent({ type: "click", target: this, preventDefault() {} });
    },
    requestSubmit() {
      this.dispatchEvent({ type: "submit", target: this, preventDefault() {} });
    },
    scrollIntoView() {},
    load() {},
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    requestFullscreen() {
      return Promise.resolve();
    },
    exitFullscreen() {
      return Promise.resolve();
    },
    requestPictureInPicture() {
      return Promise.resolve();
    }
  };
  return el;
}

function createBrowserEnv() {
  const elements = new Map();

  const documentStub = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, createElementStub("element"));
      }
      return elements.get(id);
    },
    createElement(tagName) {
      return createElementStub(tagName);
    },
    addEventListener() {},
    fullscreenElement: null,
    exitFullscreen() {
      return Promise.resolve();
    }
  };

  const windowListeners = {};
  const reloadCalls = { count: 0 };

  const windowStub = {
    location: {
      search: "",
      href: "http://localhost/",
      reload() {
        reloadCalls.count += 1;
      },
      replace() {}
    },
    addEventListener(type, handler) {
      (windowListeners[type] ||= []).push(handler);
    },
    removeEventListener() {},
    dispatchEvent(event) {
      for (const handler of windowListeners[event.type] || []) {
        handler(event);
      }
    }
  };

  const storage = {};
  const localStorageStub = {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null;
    },
    setItem(key, value) {
      storage[key] = String(value);
    },
    removeItem(key) {
      delete storage[key];
    },
    clear() {
      for (const key of Object.keys(storage)) delete storage[key];
    }
  };

  // ObjectURL registry: tests can assert creation/revocation behavior.
  const objectUrls = new Map();
  let urlSequence = 0;
  const URLStub = {
    createObjectURL(blob) {
      const url = "blob:stub-" + (++urlSequence);
      objectUrls.set(url, blob);
      return url;
    },
    revokeObjectURL(url) {
      objectUrls.delete(url);
    }
  };

  // SweetAlert stand-in: confirms by default, tests can override.
  const SwalStub = {
    confirmResponse: { isConfirmed: true },
    fire() {
      return Promise.resolve(this.confirmResponse);
    }
  };

  function FileReaderStub() {
    this.result = null;
    this.onload = null;
    this.readAsText = function (file) {
      this.result = file.contents;
      if (this.onload) this.onload({ target: this });
    };
  }

  function EventStub(type) {
    return { type, preventDefault() {}, target: null };
  }

  // Service-worker controller stubs.
  const swListeners = {};
  const navigatorStub = {
    serviceWorker: {
      controller: null,
      waiting: null,
      installing: null,
      addEventListener(type, handler) {
        (swListeners[type] ||= []).push(handler);
      },
      dispatchEvent(event) {
        for (const handler of swListeners[event.type] || []) handler(event);
      },
      register() {
        return Promise.resolve(registrationStub);
      }
    }
  };

  const regListeners = {};
  const registrationStub = {
    waiting: null,
    installing: null,
    addEventListener(type, handler) {
      (regListeners[type] ||= []).push(handler);
    },
    dispatchEvent(event) {
      for (const handler of regListeners[event.type] || []) handler(event);
    }
  };

  const context = {
    console,
    document: documentStub,
    window: windowStub,
    localStorage: localStorageStub,
    URL: URLStub,
    Blob: class Blob {
      constructor(parts, options) {
        this.parts = parts;
        this.options = options;
      }
    },
    Swal: SwalStub,
    FileReader: FileReaderStub,
    Event: EventStub,
    URLSearchParams,
    navigator: navigatorStub,
    setTimeout,
    clearTimeout,
    Promise
  };
  context.globalThis = context;
  context.self = context;

  vm.createContext(context);

  // recent-store.js attaches RecentStore onto globalThis.
  const storeSource = fs.readFileSync(
    path.join(REPO_ROOT, "recent-store.js"),
    "utf8"
  );
  vm.runInContext(storeSource, context, { filename: "recent-store.js" });

  const scriptSource = fs.readFileSync(
    path.join(REPO_ROOT, "script.js"),
    "utf8"
  );
  vm.runInContext(scriptSource, context, { filename: "script.js" });

  // Run the DOMContentLoaded initialization the page would fire.
  windowStub.dispatchEvent({ type: "DOMContentLoaded" });

  return {
    context,
    elements,
    storage,
    objectUrls,
    windowListeners,
    swListeners,
    regListeners,
    registration: registrationStub,
    navigator: navigatorStub,
    reloadCalls,
    repoRoot: REPO_ROOT
  };
}

module.exports = { createBrowserEnv, createElementStub, REPO_ROOT };
