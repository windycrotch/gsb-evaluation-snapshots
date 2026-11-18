// Test doubles for the HTML5 audio APIs that `Clip` depends on. No real audio
// decoding or network access happens here: chunks are plain objects carrying a
// fixed fake duration, and the AudioContext is a controllable clock.
import EventEmitter from '../../src/EventEmitter';

export class FakeAudioParam {
  constructor(value = 1) {
    this.value = value;
  }

  setValueAtTime() {
    return this;
  }
}

export class FakeGainNode {
  constructor(context) {
    this.context = context;
    this.gain = new FakeAudioParam(1);
    this.connected = [];
  }

  connect(destination) {
    this.connected.push(destination);
    return destination;
  }

  disconnect() {
    this.connected = [];
  }
}

export class FakeBufferSource {
  constructor(context) {
    this.context = context;
    this.loop = false;
    this.startedAt = null;
    this.stopped = false;
  }

  connect(node) {
    return node;
  }

  start(when) {
    this.startedAt = when;
  }

  stop() {
    this.stopped = true;
  }
}

export class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.destination = { name: 'fake-destination' };
    this.state = 'running';
    this.resumed = false;
  }

  createGain() {
    return new FakeGainNode(this);
  }

  createBufferSource() {
    return new FakeBufferSource(this);
  }

  createBuffer() {
    return {};
  }

  resume() {
    this.resumed = true;
    this.state = 'running';
    return Promise.resolve();
  }

  // Decode synchronously by default so tests stay deterministic. The returned
  // "decoded" buffer is only used as an opaque payload.
  decodeAudioData(buffer, successCallback) {
    if (successCallback) {
      successCallback({ sampleRate: 44100, numberOfChannels: 2, length: 100 });
    }
    return Promise.resolve({ sampleRate: 44100, numberOfChannels: 2, length: 100 });
  }
}

// Minimal stand-in for `Loader`: it exposes the duration used by `currentTime`
// and records the chunk indices it is asked to (re)buffer after seeks.
export class FakeLoader extends EventEmitter {
  constructor(averageChunkDuration = 1) {
    super();
    this.averageChunkDuration = averageChunkDuration;
    this.rebufferedIndices = [];
    this.cancelled = 0;
  }

  cancel() {
    this.cancelled += 1;
  }

  // Called by the Loader's own `chunkIndexManuallyChanged` listener in
  // production; the Clip test wires this up manually to assert re-buffering.
  onManualChunkChange(index) {
    this.rebufferedIndices.push(index);
  }
}

// Advance the fake context clock by the given number of seconds.
export const tickClock = (context, seconds) => {
  context.currentTime += seconds;
};

// Wait for any pending Promise/microtask work (e.g. the stubbed
// decodeAudioData callback) to run.
export const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

// `getContext()` memoizes the AudioContext in a module-level variable. Each
// test needs a fresh controllable clock, so point the global constructor at
// the fake and clear the cache.
export const installFakeAudioContext = (FakeAudioContextClass = FakeAudioContext) => {
  global.window.AudioContext = FakeAudioContextClass;
  global.AudioContext = FakeAudioContextClass;
  // eslint-disable-next-line global-require
  const getContextModule = require('../../src/getContext');
  // The memoized value is a module-private `let`; reach it through the module
  // registry's compiled export is not possible, so re-require after busting the
  // cache via the dedicated reset hook instead.
  getContextModule.__resetForTests();
  return getContextModule.default();
};

// Build a `Clip` without running its constructor (which is tightly coupled to
// fetching and HTML5 APIs). Callers then attach the fields the methods under
// test touch.
export const createBareClip = (Clip) => {
  const clip = Object.create(Clip.prototype);
  EventEmitter.call(clip);
  return clip;
};
