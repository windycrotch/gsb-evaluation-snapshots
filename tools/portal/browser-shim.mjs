// Minimal browser-environment shim for exercising the portal protocol modules
// under Node's built-in test runner. It implements only the DOM surface the
// modules touch (elements, dialog, canvas 2d, Image, storage, navigation);
// it is intentionally tiny and shared by every portal test.
import { EventEmitter } from 'node:events';
import * as zlib from 'node:zlib';

export class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.className = '';
    this.textContent = '';
    this.innerHTML = '';
    this._listeners = new EventEmitter();
    this._listeners.setMaxListeners(0);
  }
  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'string') { this.textContent += node; continue; }
      node.parentNode?.removeChild(node);
      node.parentNode = this;
      this.children.push(node);
    }
  }
  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    node.parentNode = null;
  }
  replaceChildren(...nodes) {
    for (const node of [...this.children]) node.parentNode = null;
    this.children = [];
    this.textContent = '';
    this.append(...nodes);
  }
  remove() { this.parentNode?.removeChild(this); }
  prepend(...nodes) {
    for (const node of nodes.reverse()) {
      node.parentNode = this;
      this.children.unshift(node);
    }
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name.startsWith('data-')) this.dataset[name.slice(5)] = String(value); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, fn) { this._listeners.on(type, fn); }
  removeEventListener(type, fn) { this._listeners.off(type, fn); }
  dispatchEvent(event) { this._listeners.emit(event.type, event); return true; }
  click() { this._listeners.emit('click', { target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() { document.activeElement = this; }
  closest(selector) {
    const tag = selector.replace(/[.[\]#]/g, '').split(' ')[0];
    let node = this;
    while (node) { if (node.tagName?.toLowerCase() === tag || node.className?.split(' ').includes(tag)) return node; node = node.parentNode; }
    return null;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get classList() {
    const self = this;
    return {
      add(...names) { for (const n of names) if (!self.className.split(' ').includes(n)) self.className = `${self.className} ${n}`.trim(); },
      remove(...names) { self.className = self.className.split(' ').filter(c => !names.includes(c)).join(' '); },
      toggle(name, force) {
        const has = this.contains(name);
        if (force === undefined) { has ? this.remove(name) : this.add(name); return !has; }
        force ? this.add(name) : this.remove(name); return force;
      },
      contains(name) { return self.className.split(' ').includes(name); },
    };
  }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get childElementCount() { return this.children.length; }
  get open() { return this.hasAttribute('open'); }
  showModal() { this.setAttribute('open', ''); }
  close() { this.removeAttribute('open'); this.dispatchEvent({ type: 'close' }); }
}

class FakeCanvas extends FakeElement {
  constructor(width = 300, height = 150) {
    super('canvas');
    this.width = width; this.height = height;
    this._drawn = [];
  }
  getContext() {
    const record = (name, args) => { this._drawn.push([name, args]); };
    return {
      clearRect: (...a) => record('clearRect', a),
      fillRect: (...a) => record('fillRect', a),
      drawImage: (...a) => record('drawImage', a),
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: (...a) => record('putImageData', a),
      set fillStyle(v) { record('fillStyle', [v]); },
    };
  }
  // Models the browser's repaint-and-re-encode: the output is a canonical PNG
  // with fixed pixels, deliberately different from any fixture's input bytes,
  // so tests can prove metadata/input encoding is discarded before reuse.
  toDataURL() {
    const canonical = makePNG(this.width, this.height, () => [17, 34, 51, 255]);
    return `data:image/png;base64,${b64urlPng(canonical)}`;
  }
}

const b64urlPng = bytes => bytes.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// A deterministic 64x64 RGBA PNG (and any size the shim is asked for). The
// bytes are real PNG output so the protocol's signature and IHDR checks run.
function crc32Table() {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}
const CRC_TABLE = crc32Table();
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
export function makePNG(width = 64, height = 64, pixel) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel ? pixel(x, y) : [(x * 4) & 255, (y * 4) & 255, 128, 255];
      const p = y * (stride + 1) + 1 + x * 4;
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; raw[p + 3] = a;
    }
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Image stub: decode() resolves for the fixtures the test registers; natural
// dimensions come from the parsed PNG IHDR so dimension checks stay real.
const imageFixtures = new Map();
export function registerImageData(url, bytes) { imageFixtures.set(url, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)); }
export function clearImageData() { imageFixtures.clear(); }
class FakeImage {
  constructor(width, height) { this.width = width; this.height = height; this._listeners = {}; }
  set src(value) {
    this._src = value;
    const bytes = imageFixtures.get(value) || imageFixtures.get('*');
    queueMicrotask(() => {
      if (!bytes) { this.onerror?.(new Error('image failed')); return; }
      this.naturalWidth = bytes.readUInt32BE(16);
      this.naturalHeight = bytes.readUInt32BE(20);
      this._bytes = bytes;
      this.onload?.();
    });
  }
  get src() { return this._src; }
  addEventListener(type, fn) { (this[`on${type}`] = fn); }
  remove() { this.parentNode?.removeChild(this); }
  decode() {
    const bytes = imageFixtures.get(this._src) || imageFixtures.get('*');
    if (!bytes) return Promise.reject(new Error('undecodable image'));
    this.naturalWidth = bytes.readUInt32BE(16);
    this.naturalHeight = bytes.readUInt32BE(20);
    this._bytes = bytes;
    return Promise.resolve();
  }
}

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}

export function installBrowser({ url = 'http://127.0.0.1:8080/world/', referrer = '', reset = false } = {}) {
  const elements = new Map();
  const documentElement = new FakeElement('html');
  const body = new FakeElement('body');
  const doc = {
    documentElement,
    body,
    title: 'Fixture World',
    referrer,
    activeElement: null,
    createElement(tag) {
      if (tag === 'canvas') return new FakeCanvas();
      return new FakeElement(tag);
    },
    createElementNS(_ns, tag) { return new FakeElement(tag); },
    getElementById(id) { return elements.get(id) || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const register = (id, el) => { elements.set(id, el); return el; };
  register('hud', new FakeElement('div'));
  register('loading', new FakeElement('div'));
  register('panel', Object.assign(new FakeElement('dialog'), { querySelector: () => new FakeElement('span') }));

  // Reinstalling models an in-tab navigation: sessionStorage must survive, so
  // reuse the existing instances unless the test explicitly asks to reset.
  if (reset || !(globalThis.sessionStorage instanceof FakeStorage)) {
    globalThis.sessionStorage = new FakeStorage();
    globalThis.localStorage = new FakeStorage();
  }
  const sessionStorage = globalThis.sessionStorage;
  const localStorage = globalThis.localStorage;
  let current = new URL(url);
  let historyState = null;
  const history = {
    get state() { return historyState; },
    replaceState(state, _title, href) {
      historyState = state;
      if (href !== undefined) current = new URL(href, current.href);
    },
    pushState(state, _title, href) {
      historyState = state;
      if (href !== undefined) current = new URL(href, current.href);
    },
  };
  const navigationEntries = [{ type: 'navigate' }];
  const locationProxy = {
    get href() { return current.href; },
    set href(value) { current = new URL(value, current.href); },
    get origin() { return current.origin; },
    get pathname() { return current.pathname; },
    set pathname(v) { current.pathname = v; },
    get search() { return current.search; },
    set search(v) { current.search = v; },
    get hash() { return current.hash; },
    set hash(v) { current.hash = v; },
    reload() {},
    replace(href) { current = new URL(href, current.href); },
  };
  const globals = {
    document: doc,
    window: {},
    location: locationProxy,
    history,
    sessionStorage,
    localStorage,
    navigator: { language: 'en-US', languages: ['en-US'] },
    matchMedia: () => ({ matches: false }),
    Image: FakeImage,
    btoa: text => Buffer.from(text, 'binary').toString('base64'),
    atob: text => Buffer.from(text, 'base64').toString('binary'),
    performance: {
      now: () => Number(process.hrtime.bigint() / 1000n) / 1000,
      markResourceTiming() {},
      getEntriesByType: type => type === 'navigation' ? navigationEntries : [],
    },
    requestAnimationFrame: fn => queueMicrotask(() => fn(16)),
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    PageTransitionEvent: class PageTransitionEvent {
      constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
    },
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
    },
    URLSearchParams,
    AbortController,
    customElements: {
      get: () => undefined,
      define() {},
    },
    HTMLElement: class HTMLElement extends FakeElement {
      constructor() { super(); this.shadowRoot = null; }
      attachShadow() { this.shadowRoot = new FakeElement('shadow-root'); return this.shadowRoot; }
    },
    MutationObserver: class MutationObserver {
      observe() {} disconnect() {}
    },
    setTimeout, clearTimeout,
  };
  globals.window = globals;
  for (const [key, value] of Object.entries(globals)) {
    // Some Node globals (navigator, performance, btoa) exist as read-only
    // getters; redefine them so the shim can be reinstalled between tests.
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  globalThis.window = globalThis;
  return {
    location: locationProxy,
    history,
    sessionStorage,
    localStorage,
    document: doc,
    register,
    elements,
    setNavigationType(type) { navigationEntries[0] = { type }; },
    setReferrer(value) { doc.referrer = value; },
    reset() { clearImageData(); sessionStorage.clear(); localStorage.clear(); historyState = null; navigationEntries[0] = { type: 'navigate' }; },
  };
}
