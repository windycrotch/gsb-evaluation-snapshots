/* Minimal, deterministic browser stand-ins so js/engine.js can run under Node without
   real audio, workers, network or DOM. Nothing here reproduces sound: it reproduces the
   shape of the Web Audio graph (nodes, params, connect/disconnect/close) and the message
   plumbing the engine uses, so the share-restore transaction and its rollback paths can
   be driven end to end with controllable failure injection. */

let currentTime = 100;

class AudioParam {
  constructor(value) { this.value = value; }
  setValueAtTime(v) { this.value = v; }
  linearRampToValueAtTime(v) { this.value = v; }
  setTargetAtTime(v) { this.value = v; }
  exponentialRampToValueAtTime(v) { this.value = v; }
  cancelScheduledValues() {}
  cancelAndHoldAtTime() {}
}

class AudioNode {
  constructor(c) {
    this.context = c;
    this.numberOfInputs = 1; this.numberOfOutputs = 1;
    this.channelCount = 2; this.channelCountMode = 'max'; this.channelInterpretation = 'speakers';
    this.connections = new Set();
  }
  connect(node) { (node.connections ?? (node.connections = new Set())).add(this); this.connections.add(node); return node; }
  disconnect(node) { if (node) this.connections.delete(node); else this.connections.clear(); }
  addEventListener() {}
  removeEventListener() {}
}

class GainNode extends AudioNode {
  constructor(c) { super(c); this.gain = new AudioParam(1); }
}
class BiquadFilterNode extends AudioNode {
  constructor(c) { super(c); this.type = 'lowpass'; this.frequency = new AudioParam(350); this.detune = new AudioParam(0); this.Q = new AudioParam(1); }
}
class AnalyserNode extends AudioNode {
  constructor(c) { super(c); this.fftSize = 2048; this.smoothingTimeConstant = 0.8; }
  getByteFrequencyData() {} getByteTimeDomainData() {} getFloatFrequencyData() {}
}
class DelayNode extends AudioNode {
  constructor(c, _max = 1) { super(c); this.delayTime = new AudioParam(0); }
}
class DynamicsCompressorNode extends AudioNode {
  constructor(c) {
    super(c);
    this.threshold = new AudioParam(-24); this.knee = new AudioParam(30); this.ratio = new AudioParam(12);
    this.attack = new AudioParam(0.003); this.release = new AudioParam(0.25);
  }
}
class ConstantSourceNode extends AudioNode {
  constructor(c) { super(c); this.offset = new AudioParam(0); }
  start() {} stop() {}
}
class BufferSourceNode extends AudioNode {
  constructor(c) { super(c); this.playbackRate = new AudioParam(1); this.loop = false; this.loopEnd = 0; this.onended = null; }
  start() {} stop() {}
}
class AudioWorkletNode extends AudioNode {
  constructor(c, name, opts = {}) {
    super(c);
    this.name = name; this.processorOptions = opts.processorOptions || {};
    this.port = { postMessage() {}, onmessage: null, start() {} };
    if (globalThis.__workletCtorError) throw new Error(globalThis.__workletCtorError);
  }
}
class MediaStreamAudioDestinationNode extends AudioNode {
  constructor(c) { super(c); this.stream = { getTracks: () => [] }; }
}
class AudioBuffer {
  constructor({ numberOfChannels = 2, length = 1024, sampleRate = 44100 } = {}) {
    this.numberOfChannels = numberOfChannels; this.length = length; this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(c) { return this.channels[Math.min(c, this.numberOfChannels - 1)]; }
  copyFromChannel(d, c) { d.set(this.channels[c].subarray(0, d.length)); }
  copyToChannel(s, c) { this.channels[c].set(s); }
}

class AudioWorklet {
  async addModule() {
    if (globalThis.__limiterFail) throw new Error('injected limiter worklet failure');
  }
}

class AudioContext {
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate || 44100;
    this.state = 'running';
    this.currentTime = currentTime;
    this.baseLatency = 0.005; this.outputLatency = 0.005;
    this.destination = new AudioNode(this);
    this.audioWorklet = new AudioWorklet();
    this.onstatechange = null;
    this.closed = false;
  }
  createGain() { return new GainNode(this); }
  createBiquadFilter() { return new BiquadFilterNode(this); }
  createAnalyser() { return new AnalyserNode(this); }
  createDelay(m) { return new DelayNode(this, m); }
  createDynamicsCompressor() { return new DynamicsCompressorNode(this); }
  createConstantSource() { return new ConstantSourceNode(this); }
  createBufferSource() { return new BufferSourceNode(this); }
  createBuffer(ch, len, sr) { return new AudioBuffer({ numberOfChannels: ch, length: len, sampleRate: sr }); }
  createMediaStreamDestination() { return new MediaStreamAudioDestinationNode(this); }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  async close() { this.closed = true; this.state = 'closed'; }
}
class OfflineAudioContext extends AudioContext {
  constructor(channels, length, sampleRate) { super({ sampleRate }); this.length = length; this.numberOfChannels = channels; }
  async startRendering() { return new AudioBuffer({ numberOfChannels: this.numberOfChannels, length: this.length, sampleRate: this.sampleRate }); }
}

// Deterministic fake Worker: instead of running stretch-worker.js, it replies with a
// short silent buffer sized to the requested target length, so renders "succeed" and
// produce real AudioBuffers the engine can loop. Failures are injected per test.
const workers = [];
class FakeWorker {
  constructor() {
    this.onmessage = null; this.onerror = null;
    this.terminated = false;
    workers.push(this);
  }
  postMessage(msg) {
    if (this.terminated) return;
    const fail = globalThis.__stretchFail; // null | '*' | song name (set by the harness per render)
    queueMicrotask(() => {
      if (this.terminated || !this.onmessage) return;
      if (fail === '*' || (fail && msg && msg.targetLen && globalThis.__stretchFailSong === fail)) {
        this.onmessage({ data: { id: msg.id, error: `injected stretch failure (${fail})` } });
      } else {
        this.onmessage({ data: { id: msg.id, channels: [new Float32Array(msg.targetLen), new Float32Array(msg.targetLen)], quality: 'fast' } });
      }
    });
  }
  terminate() { this.terminated = true; }
  addEventListener() {} removeEventListener() {}
}

// The engine hands long work back between tasks via a MessageChannel relay
// (relay.port1.onmessage = ...; relay.port2.postMessage(0)).
class FakePort {
  constructor() { this.onmessage = null; }
  postMessage() {}
  start() {}
  addEventListener() {} removeEventListener() {}
}
class FakeMessageChannel {
  constructor() {
    this.port1 = new FakePort();
    this.port2 = new FakePort();
    // A post on port2 is delivered (async) to port1's handler, and vice versa.
    const p1 = this.port1, p2 = this.port2;
    this.port2.postMessage = (msg) => queueMicrotask(() => p1.onmessage && p1.onmessage({ data: msg }));
    this.port1.postMessage = (msg) => queueMicrotask(() => p2.onmessage && p2.onmessage({ data: msg }));
  }
}

function install() {
  const g = globalThis;
  g.AudioContext = AudioContext;
  g.webkitAudioContext = AudioContext;
  g.OfflineAudioContext = OfflineAudioContext;
  g.webkitOfflineAudioContext = OfflineAudioContext;
  g.AudioWorkletNode = AudioWorkletNode;
  g.Worker = FakeWorker;
  g.MessageChannel = FakeMessageChannel;
  const navigatorStub = Object.assign({}, g.navigator, {
    userAgent: 'node-test', vendor: '', maxTouchPoints: 0, hardwareConcurrency: 8, deviceMemory: 8,
  });
  Object.defineProperty(g, 'navigator', { value: navigatorStub, configurable: true, writable: true });
  g.matchMedia = g.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  g.performance = g.performance || { now: () => Date.now() };
  g.Audio = class { canPlayType() { return 'maybe'; } };
  g.MediaRecorder = class { static isTypeSupported() { return true; } };
  // Unavailable IndexedDB: the engine treats a rejected/open-less DB as "nothing kept".
  g.indexedDB = {
    open() {
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null, error: new Error('indexedDB disabled in tests') };
      queueMicrotask(() => req.onerror && req.onerror({ target: req }));
      return req;
    },
  };
  g.window = g;
  g.document = g.document || { addEventListener() {}, removeEventListener() {}, hidden: false, fonts: { ready: Promise.resolve() }, createElement: () => ({ getContext: () => null, cloneNode() { return {}; } }) };
  g.Blob = g.Blob || class { constructor(parts = []) { this.parts = parts; } };
  g.fetch = g.fetch || (async () => { throw new Error('network disabled in tests'); });
  return { workers };
}

function resetFaults() {
  globalThis.__limiterFail = false;
  globalThis.__workletCtorError = null;
  globalThis.__stretchFail = null;
  globalThis.__stretchFailSong = null;
}

export { install, resetFaults, AudioContext, AudioBuffer, FakeWorker };
