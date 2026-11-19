/**
 * Mock Web Audio implementation used by the test-suite.
 *
 * Nothing here touches a real audio device. MockAudioNode records every
 * connect/disconnect call so tests can assert on the graph wiring, and
 * MockAudioParam simulates the real AudioParam failure modes
 * (e.g. starting an exponential ramp at a non-positive value throws).
 */

class MockAudioParam {
  constructor(name, initialValue = 0) {
    this.name = name;
    this.value = initialValue;
    this.automationEvents = [];
  }

  setValueAtTime(value, time) {
    this.automationEvents.push({ type: 'setValueAtTime', value, time });
    this.value = value;
  }

  linearRampToValueAtTime(value, time) {
    this.automationEvents.push({ type: 'linearRampToValueAtTime', value, time });
    this.value = value;
  }

  exponentialRampToValueAtTime(value, time) {
    // real AudioParams reject non-positive values on exponential ramps
    if (!(value > 0)) {
      throw new RangeError(
        `exponentialRampToValueAtTime requires a strictly positive value, got ${value}`);
    }

    this.automationEvents.push({ type: 'exponentialRampToValueAtTime', value, time });
    this.value = value;
  }

  setTargetAtTime(value, time, constant) {
    this.automationEvents.push({ type: 'setTargetAtTime', value, time, constant });
  }

  cancelScheduledValues(time) {
    this.automationEvents = this.automationEvents.filter(e => e.time < time);
  }
}

// make the production `x instanceof AudioParam` check work against the mock
global.AudioParam = MockAudioParam;

class MockAudioNode {
  constructor(context, options = {}) {
    this.context = context;
    this.options = options;

    // list of { target, output, input } connections currently active
    this.connections = [];
    this.eventListeners = {};
    this.startCalls = [];
    this.stopCalls = [];
    this.disconnectCalls = 0;
  }

  connect(target, output = 0, input = 0) {
    const connection = { target, output, input };
    const alreadyConnected = this.connections.some(c =>
      c.target === target && c.output === output && c.input === input);

    if (!alreadyConnected) this.connections.push(connection);

    return target;
  }

  disconnect(destination) {
    this.disconnectCalls += 1;

    if (destination === undefined) {
      this.connections = [];
    } else {
      this.connections = this.connections.filter(c => c.target !== destination);
    }
  }

  addEventListener(type, listener) {
    if (!this.eventListeners[type]) this.eventListeners[type] = [];
    this.eventListeners[type].push(listener);
  }

  removeEventListener(type, listener) {
    const listeners = this.eventListeners[type];
    if (!listeners) return;

    this.eventListeners[type] = listeners.filter(l => l !== listener);
  }

  dispatchEvent(event) {
    const listeners = this.eventListeners[event.type] || [];
    listeners.forEach(listener => listener(event));
  }

  // source-node helpers -----------------------------------------------------

  start(when = 0, offset = 0, duration) {
    if (this.startCalls.length > 0) {
      throw new Error('InvalidStateError: the source node has already been started');
    }

    this.startCalls.push({ when, offset, duration });
  }

  stop(when = 0) {
    if (this.startCalls.length === 0) {
      throw new Error('InvalidStateError: cannot stop a source node that has not been started');
    }

    this.stopCalls.push({ when });
  }
}

class MockBufferSourceNode extends MockAudioNode {
  constructor(context, options) {
    super(context, options);
    this.buffer = options && options.buffer ? options.buffer : null;
    this.detune = new MockAudioParam('detune', 0);
    this.playbackRate = new MockAudioParam('playbackRate', 1);
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
  }
}

class MockOscillatorNode extends MockAudioNode {
  constructor(context, options) {
    super(context, options);
    this.frequency = new MockAudioParam('frequency', 440);
    this.detune = new MockAudioParam('detune', 0);
    this.type = 'sine';
  }

  setPeriodicWave(wave) {
    this.periodicWave = wave;
  }
}

class MockConstantSourceNode extends MockAudioNode {
  constructor(context, options) {
    super(context, options);
    this.offset = new MockAudioParam('offset', 1);
  }
}

class MockGainNode extends MockAudioNode {
  constructor(context, options) {
    super(context, options);
    this.gain = new MockAudioParam('gain', 1);
  }
}

class MockAudioContext extends (global.AudioContext || Object) {
  constructor() {
    super();
    this.currentTime = 0;
    this.destination = new MockAudioNode(this);
    this.createdNodes = [];
  }

  register(node) {
    this.createdNodes.push(node);
    return node;
  }

  createBufferSource(options) {
    return this.register(new MockBufferSourceNode(this, options));
  }

  createOscillator(options) {
    return this.register(new MockOscillatorNode(this, options));
  }

  createConstantSource(options) {
    return this.register(new MockConstantSourceNode(this, options));
  }

  createGain(options) {
    return this.register(new MockGainNode(this, options));
  }

  resume() {}

  suspend() {}
}

module.exports = {
  MockAudioParam,
  MockAudioNode,
  MockAudioContext,
  MockBufferSourceNode,
  MockOscillatorNode,
  MockConstantSourceNode,
  MockGainNode
};
