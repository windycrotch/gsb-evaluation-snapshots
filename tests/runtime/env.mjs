// Headless browser environment for the real Tone.js (r11) engine.
// Import this FIRST in every test file, before any app module.

import * as webaudio from 'node-web-audio-api'

globalThis.window = globalThis
globalThis.self = globalThis

for (const key of Object.keys(webaudio)) {
  if (key !== 'default' && typeof webaudio[key] === 'function') globalThis[key] = webaudio[key]
}

// Tone.js only checks that Worker exists; its clock falls back to
// setTimeout when construction fails (same as unsupported browsers)
globalThis.Worker = class { constructor() { throw new Error('no workers in node') } }

globalThis.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 16)
globalThis.cancelAnimationFrame = id => clearTimeout(id)

// minimal DOM surface so UI libraries (hammerjs, styled-components v2) can
// be imported and instantiated; their rendering is not exercised by the tests
const makeElement = () => ({
  style: {},
  setAttribute: () => {},
  getAttribute: () => null,
  appendChild: () => {},
  replaceChild: () => {},
  insertBefore: () => {},
  getElementsByTagName: () => [],
  parentNode: { replaceChild: () => {} },
  innerHTML: '',
})
globalThis.document = {
  createElement: makeElement,
  createTextNode: data => ({ data: data || '', appendData(d) { this.data += d } }),
  querySelectorAll: () => [],
  documentElement: { style: {} },
  head: { appendChild: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  body: {},
}
globalThis.addEventListener = globalThis.addEventListener || (() => {})
globalThis.removeEventListener = globalThis.removeEventListener || (() => {})
