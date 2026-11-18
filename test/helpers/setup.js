// Test environment setup. This module must be imported before any source
// module: source code relies on browser globals (window, AudioContext,
// requestAnimationFrame, ...) and on the build-time `__DEV__` flag that Rollup
// normally replaces.
//
// Keep this file free of source imports so the order below is guaranteed.

global.__DEV__ = false;

if (typeof global.window === 'undefined') {
  global.window = global;
}

if (typeof global.requestAnimationFrame === 'undefined') {
  // Tests drive playback manually through the `currentTime` getter, so the
  // progress `frame()` loop does not need to actually run.
  global.requestAnimationFrame = () => 0;
  global.cancelAnimationFrame = () => {};
}

if (typeof global.URL === 'undefined') {
  global.URL = { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} };
}

// Tests replace `window.AudioContext` with a controllable fake before
// constructing clips. `getContext()` caches the first instance, so tests reset
// that cache through the helper in test/helpers/fakes.js.
if (typeof global.AudioContext === 'undefined') {
  global.AudioContext = function AudioContextStub() {
    throw new Error('AudioContext stub must be replaced by the test before use');
  };
  global.window.AudioContext = global.AudioContext;
}
