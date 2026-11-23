/**
 * Global environment shim loaded before the library modules are imported.
 * r-audio references `window.AudioContext` at module-evaluation time
 * (React context propTypes), so the mock has to be in place up front.
 */

const {
  MockAudioContext,
  MockAudioParam,
  MockAudioBuffer,
  DOMException
} = require('./web-audio-mock');

global.AudioContext = MockAudioContext;
// library code uses `instanceof AudioParam` and tests construct AudioBuffers
global.AudioParam = MockAudioParam;
global.AudioBuffer = MockAudioBuffer;
global.DOMException = DOMException;

global.window = global.window || {};
global.window.AudioContext = MockAudioContext;
global.window.webkitAudioContext = undefined;

if (typeof global.window.addEventListener !== 'function') {
  global.window.addEventListener = () => {};
  global.window.removeEventListener = () => {};
}
