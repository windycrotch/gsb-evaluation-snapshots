/**
 * Minimal, observable Web Audio mock for Node tests.
 *
 * Every connection is recorded so tests can assert graph topology, and
 * `dispatchEvent` lets us simulate an Oscillator/BufferSource `ended` event
 * synchronously. Only the surface used by r-audio is implemented.
 */

let nodeCounter = 0;

class MockAudioParam {
  constructor(name, defaultValue = 0) {
    this.name = name;
    this.value = defaultValue;
    this.defaultValue = defaultValue;
  }

  setValueAtTime(value) { this.value = value; }
  linearRampToValueAtTime(value) { this.value = value; }
  exponentialRampToValueAtTime(value) { this.value = value; }
  setTargetAtTime(value) { this.value = value; }
  cancelScheduledValues() {}
}

class MockAudioNode {
  constructor(context, type) {
    this.context = context;
    // immutable label used by tests; distinct from Web Audio properties such
    // as OscillatorNode.type ('sine', ...) which may overwrite `this.type`
    this.nodeType = type;
    this.type = type;
    this.id = `${type}-${++nodeCounter}`;
    this._connected = [];
    this._listeners = {};
    this.parameters = new Map();
    this.numberOfInputs = 1;
    this.numberOfOutputs = 1;
    this.channelCount = 2;
    this.channelCountMode = 'max';
    this.channelInterpretation = 'speakers';
  }

  addEventListener(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
  }

  removeEventListener(event, handler) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter(fn => fn !== handler);
  }

  dispatchEvent(event) {
    const listeners = this._listeners[event.type] || [];
    listeners.forEach(handler => handler.call(this, event));
    return true;
  }

  connect(target, output = 0, input = 0) {
    const destination = (target && target instanceof MockAudioNode) ? target : target;
    this._connected.push({ destination, output, input });
    return destination;
  }

  disconnect(destination) {
    if (destination === undefined) {
      this._connected.length = 0;
      return;
    }
    const before = this._connected.length;
    this._connected = this._connected.filter(c => c.destination !== destination);
    // mimic the browser throwing when the requested connection does not exist
    if (this._connected.length === before) {
      throw new DOMException(
        `cannot disconnect a node that is not connected to the given destination`,
        'InvalidAccessError');
    }
  }

  // test helpers
  get connections() {
    return this._connected.map(c => c.destination);
  }

  hasConnectionTo(node) {
    return this.connections.includes(node);
  }

  start() {}
  stop() {}
}

class MockSourceNode extends MockAudioNode {
  constructor(context, type) {
    super(context, type);
    // the mock never removes the node from the graph on stop; tests drive
    // the `ended` event explicitly
  }
}

class MockAudioDestinationNode extends MockAudioNode {
  constructor(context) {
    super(context, 'AudioDestinationNode');
  }
}

class MockAudioBuffer {
  constructor({ numberOfChannels = 1, length = 128, sampleRate = 44100 } = {}) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel = 0) {
    return this._channels[channel];
  }
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 44100;
    this.state = 'suspended';
    this.destination = new MockAudioDestinationNode(this);
    this.createdNodes = [];
  }

  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { return Promise.resolve(); }

  _track(node) {
    this.createdNodes.push(node);
    return node;
  }

  createOscillator() {
    const node = new MockSourceNode(this, 'OscillatorNode');
    node.frequency = new MockAudioParam('frequency', 440);
    node.detune = new MockAudioParam('detune', 0);
    node.type = 'sine';
    node.setPeriodicWave = () => {};
    return this._track(node);
  }

  createBufferSource() {
    const node = new MockSourceNode(this, 'AudioBufferSourceNode');
    node.buffer = null;
    node.playbackRate = new MockAudioParam('playbackRate', 1);
    node.detune = new MockAudioParam('detune', 0);
    node.loop = false;
    return this._track(node);
  }

  createConstantSource() {
    const node = new MockSourceNode(this, 'ConstantSourceNode');
    node.offset = new MockAudioParam('offset', 1);
    return this._track(node);
  }

  createGain() {
    const node = new MockAudioNode(this, 'GainNode');
    node.gain = new MockAudioParam('gain', 1);
    return this._track(node);
  }

  createBiquadFilter() {
    const node = new MockAudioNode(this, 'BiquadFilterNode');
    node.frequency = new MockAudioParam('frequency', 350);
    return this._track(node);
  }

  createDynamicsCompressor() {
    return this._track(new MockAudioNode(this, 'DynamicsCompressorNode'));
  }

  createDelay() {
    const node = new MockAudioNode(this, 'DelayNode');
    node.delayTime = new MockAudioParam('delayTime', 0);
    return this._track(node);
  }

  createConvolver() {
    return this._track(new MockAudioNode(this, 'ConvolverNode'));
  }

  createWaveShaper() {
    return this._track(new MockAudioNode(this, 'WaveShaperNode'));
  }

  createAnalyser() {
    return this._track(new MockAudioNode(this, 'AnalyserNode'));
  }

  createPanner() {
    return this._track(new MockAudioNode(this, 'PannerNode'));
  }

  createStereoPanner() {
    const node = new MockAudioNode(this, 'StereoPannerNode');
    node.pan = new MockAudioParam('pan', 0);
    return this._track(node);
  }

  createChannelSplitter(channelCount = 6) {
    const node = new MockAudioNode(this, 'ChannelSplitterNode');
    node.channelCount = channelCount;
    return this._track(node);
  }

  createChannelMerger(channelCount = 6) {
    const node = new MockAudioNode(this, 'ChannelMergerNode');
    node.channelCount = channelCount;
    return this._track(node);
  }

  createIIRFilter() {
    return this._track(new MockAudioNode(this, 'IIRFilterNode'));
  }

  createBuffer(options) {
    return new MockAudioBuffer(options);
  }
}

// Jest's node environment does not define DOMException as a global constructor
class DOMException extends Error {
  constructor(message, name) {
    super(message);
    this.name = name;
  }
}

module.exports = {
  MockAudioContext,
  MockAudioNode,
  MockSourceNode,
  MockAudioParam,
  MockAudioBuffer,
  MockAudioDestinationNode,
  DOMException
};
