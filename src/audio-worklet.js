// AudioWorklet over the runtime's ScriptProcessorNode.
//
// The platform's WebAudioContext has no audioWorklet: its API reference names none, and createScriptProcessor is how it
// runs script on audio. A web game that uses a worklet stops at `ctx.audioWorklet.addModule` -- Godot 4's web export
// loads its position-reporting processor whatever its audio driver, and its default driver is a worklet.
//
// Here the processors run on the game's own thread, on a ScriptProcessorNode: each of its blocks is cut into the
// 128-frame render quanta a processor's process() is called with. What content sees is the AudioWorklet API --
// addModule, registerProcessor, AudioWorkletProcessor and its port, AudioWorkletNode with its port and parameters. What
// it costs is the ScriptProcessorNode's latency (two blocks of BLOCK frames) and that a processor shares the game's
// thread, which is where a single-threaded web export's audio is mixed anyway.
//
// Two of the audio thread's guarantees are kept even though nothing here is threaded. Each module's script has a scope
// of its own, so a second addModule cannot read or overwrite variables a first one left (in an AudioWorkletGlobalScope
// two modules share only the scope's own names); and a module's registrations land in the registry in one step after
// its script has run, so a script that throws registers nothing. A node's port is a channel: it closes, once, when the
// processor ends -- process() returning false, process() throwing -- or when the node is disconnected.

import { readScript } from "./worker.js";
import DOMException from "./dom-exception.js";

const QUANTUM = 128;
// Frames per ScriptProcessorNode block: four quanta. Smaller than a game's own output buffer (Godot's is about 1024
// frames), so a block never asks for more than the processor has been given; ~21 ms of latency at 48 kHz.
const BLOCK = 512;

// --- MessagePort, in-thread -------------------------------------------------------------------------------------------

/// A copy of `value` as postMessage would deliver it: a structured clone of the kinds a game posts to its processor.
function cloneMessage(value, seen = new Map()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  let copy;
  if (ArrayBuffer.isView(value)) {
    copy = value.slice();
  } else if (value instanceof ArrayBuffer) {
    copy = value.slice(0);
  } else if (Array.isArray(value)) {
    copy = [];
    seen.set(value, copy);
    for (const item of value) copy.push(cloneMessage(item, seen));
    return copy;
  } else if (value instanceof Map) {
    copy = new Map();
    seen.set(value, copy);
    for (const [k, v] of value) copy.set(cloneMessage(k, seen), cloneMessage(v, seen));
    return copy;
  } else if (value instanceof Set) {
    copy = new Set();
    seen.set(value, copy);
    for (const v of value) copy.add(cloneMessage(v, seen));
    return copy;
  } else if (value instanceof Date) {
    copy = new Date(value.getTime());
  } else {
    copy = {};
    seen.set(value, copy);
    for (const key of Object.keys(value)) copy[key] = cloneMessage(value[key], seen);
    return copy;
  }
  seen.set(value, copy);
  return copy;
}

class WorkletPort {
  constructor() {
    this._peer = null;
    this._listeners = [];
    this._closeListeners = [];
    this._closed = false;
    this.onmessage = null;
    this.onmessageerror = null;
    this.onclose = null;
  }

  /// Delivered to the other end on a later microtask, as a copy: after the caller's own code has run, before the next
  /// block -- what a message between the game and the audio thread amounts to here.
  postMessage(message) {
    const peer = this._peer;
    if (this._closed || peer === null || peer._closed) return;
    const data = cloneMessage(message);
    queueMicrotask(() => {
      if (!peer._closed) peer._deliver(data);
    });
  }

  _deliver(data) {
    if (this._closed) return;
    const event = { type: "message", data, target: this, currentTarget: this, ports: [] };
    for (const handler of [this.onmessage, ...this._listeners]) {
      if (typeof handler !== "function") continue;
      try {
        handler.call(this, event);
      } catch (error) {
        console.error("[migo-web-adapter] an AudioWorklet message handler threw:", error);
      }
    }
  }

  addEventListener(type, listener) {
    if (typeof listener !== "function") return;
    const listeners = type === "message" ? this._listeners : type === "close" ? this._closeListeners : null;
    if (listeners !== null && !listeners.includes(listener)) listeners.push(listener);
  }

  removeEventListener(type, listener) {
    const listeners = type === "message" ? this._listeners : type === "close" ? this._closeListeners : null;
    if (listeners === null) return;
    const at = listeners.indexOf(listener);
    if (at !== -1) listeners.splice(at, 1);
  }

  start() {}

  /// Closes the channel: this end stops delivering and receiving, the peer is told it was closed, and both ends get a
  /// `close` event. Closing twice is a no-op, so every lifecycle path that ends a node can call it without
  /// coordinating.
  close() {
    if (this._closed) return;
    this._closed = true;
    const peer = this._peer;
    // Both ends are shut before either is told: a close handler cannot get one more message out through the pair.
    const peerWasOpen = peer !== null && !peer._closed;
    if (peerWasOpen) peer._closed = true;
    this._notifyClosed();
    if (peerWasOpen) peer._notifyClosed();
  }

  _notifyClosed() {
    const event = { type: "close", target: this, currentTarget: this };
    for (const handler of [this.onclose, ...this._closeListeners]) {
      if (typeof handler !== "function") continue;
      try {
        handler.call(this, event);
      } catch (error) {
        console.error("[migo-web-adapter] an AudioWorklet close handler threw:", error);
      }
    }
  }
}

function portPair() {
  const a = new WorkletPort();
  const b = new WorkletPort();
  a._peer = b;
  b._peer = a;
  return [a, b];
}

// --- AudioParam for a processor's parameterDescriptors ---------------------------------------------------------------

/// A parameter as a processor sees it: one value per quantum (k-rate), taken from the events scheduled on it.
class WorkletParam {
  constructor(descriptor, initial) {
    this.defaultValue = descriptor.defaultValue ?? 0;
    this.minValue = descriptor.minValue ?? -3.4028234663852886e38;
    this.maxValue = descriptor.maxValue ?? 3.4028234663852886e38;
    this.automationRate = descriptor.automationRate ?? "a-rate";
    this._value = initial ?? this.defaultValue;
    this._events = [];
  }

  get value() {
    return this._value;
  }

  set value(v) {
    this._events.length = 0;
    this._value = Number(v);
  }

  setValueAtTime(value, time) {
    this._events.push({ time: Number(time), value: Number(value) });
    this._events.sort((x, y) => x.time - y.time);
    return this;
  }

  // Ramps arrive at their value at their end time: a k-rate approximation.
  linearRampToValueAtTime(value, time) {
    return this.setValueAtTime(value, time);
  }

  exponentialRampToValueAtTime(value, time) {
    return this.setValueAtTime(value, time);
  }

  setTargetAtTime(value, time) {
    return this.setValueAtTime(value, time);
  }

  cancelScheduledValues(time) {
    this._events = this._events.filter((event) => event.time < Number(time));
    return this;
  }

  _at(time) {
    while (this._events.length > 0 && this._events[0].time <= time) this._value = this._events.shift().value;
    return Math.min(this.maxValue, Math.max(this.minValue, this._value));
  }
}

// --- AudioWorklet, one per context ----------------------------------------------------------------------------------

let constructingPort = null;

/// The base of the processors content registers. Its port is the one the node being constructed holds the other end of.
class AudioWorkletProcessor {
  constructor() {
    if (constructingPort === null) throw new TypeError("AudioWorkletProcessor is constructed by an AudioWorkletNode");
    this.port = constructingPort;
  }
}

class AudioWorklet {
  constructor(context) {
    this._context = context;
    this._processors = new Map();
    // AudioWorkletGlobalScope's own values -- the ones a processor script reads before the game's globals. They are
    // shared by every module on this context, as the audio thread's globals are; a module's own variables are not.
    this._globals = {
      AudioWorkletProcessor,
      sampleRate: context.sampleRate,
      currentFrame: 0,
      currentTime: 0,
    };
  }

  /// The lexical scope one module's script runs in. A `with` block whose target answers every name sends every free
  /// read and write through this object: a script's undeclared variables (`leaked = 1`, the sloppy-mode way a processor
  /// script would create a global) live in `locals`, so the next module on the same context cannot see them -- in an
  /// AudioWorkletGlobalScope each module gets its own. Names this module does not define fall through to the worklet's
  /// globals and then to the game's, which is how `console`, `Float32Array` and `setTimeout` remain reachable.
  _moduleScope(staging) {
    const worklet = this;
    const locals = Object.create(null);
    // A module registers while its script runs, into `staging`, so that its registrations commit together. A call
    // after the script returned (a processor registering another processor from process(), say) has no module to
    // belong to: it goes straight into the context's registry. A script that failed leaves its scope dead instead:
    // a registration held over from a failed module must not slip in after its rollback.
    let open = true;
    let dead = false;
    function registerProcessor(name, processor) {
      if (dead) throw new DOMException("this module's script failed; its registrations were rolled back", "InvalidStateError");
      name = String(name);
      if (name === "") throw new DOMException("a processor needs a name", "NotSupportedError");
      if (staging.has(name) || worklet._processors.has(name)) {
        throw new DOMException(`a processor "${name}" is already registered`, "NotSupportedError");
      }
      if (typeof processor !== "function" || !(processor.prototype instanceof AudioWorkletProcessor || processor === AudioWorkletProcessor)) {
        throw new TypeError("registerProcessor takes a class extending AudioWorkletProcessor");
      }
      const descriptors = processor.parameterDescriptors;
      const definition = { processor, descriptors: Array.isArray(descriptors) ? descriptors : [] };
      if (open) staging.set(name, definition);
      else worklet._processors.set(name, definition);
    }
    return {
      proxy: new Proxy(Object.create(null), {
        has(_target, key) {
          return key !== Symbol.unscopables;
        },
        get(_target, key) {
          if (key === Symbol.unscopables) return undefined;
          if (key === "registerProcessor") return registerProcessor;
          if (Object.prototype.hasOwnProperty.call(locals, key)) return locals[key];
          if (Object.prototype.hasOwnProperty.call(worklet._globals, key)) return worklet._globals[key];
          return globalThis[key];
        },
        set(_target, key, value) {
          locals[key] = value;
          return true;
        },
        deleteProperty(_target, key) {
          delete locals[key];
          return true;
        },
      }),
      close() { open = false; },
      fail() { open = false; dead = true; },
    };
  }

  /// Evaluates the processor script at `url` (a path in the game's package, a blob: or data: URL) in a scope of its
  /// own. Rejects with what stopped it.
  ///
  /// The script's registrations are collected in `staging` and enter the context's registry only once the whole script
  /// has run: a script that throws part-way leaves no processor behind, and a registry read during an evaluation (a
  /// second addModule from the same task, a node constructed from a getter) never sees a half-loaded module.
  addModule(url) {
    let source;
    try {
      source = readScript(url);
    } catch (error) {
      return Promise.reject(error);
    }
    const staging = new Map();
    const scope = this._moduleScope(staging);
    try {
      const run = new Function("__migoWorkletScope", "with (__migoWorkletScope) {\n" + source + "\n}");
      run.call(scope.proxy, scope.proxy);
    } catch (error) {
      // `staging` is dropped: every processor this script registered is rolled back with it.
      scope.fail();
      return Promise.reject(error);
    }
    scope.close();
    // Commit as one step: a name another module took while this one ran (a re-entrant addModule) rejects the whole
    // module rather than leaving it partly applied.
    for (const name of staging.keys()) {
      if (this._processors.has(name)) {
        scope.fail();
        return Promise.reject(new DOMException(`a processor "${name}" is already registered`, "NotSupportedError"));
      }
    }
    for (const [name, definition] of staging) this._processors.set(name, definition);
    return Promise.resolve();
  }
}

const worklets = new WeakMap();
function workletOf(context) {
  let worklet = worklets.get(context);
  if (worklet === undefined) {
    worklet = new AudioWorklet(context);
    worklets.set(context, worklet);
  }
  return worklet;
}

// --- AudioWorkletNode -----------------------------------------------------------------------------------------------

const nodeState = new WeakMap();
// The worklet nodes something is connected into: only those hand their processor an input with channels, as a node
// with nothing connected gets an input of none.
const fed = new WeakSet();

/// Ends a node's processor: process() is not called again, and its port -- both ends -- stops delivering and tells the
/// far end it closed. Every way a node's life ends goes through here (process() returning false, process() throwing,
/// the node disconnecting), so it is idempotent: the first call ends it, later ones do nothing.
function stopNode(state) {
  if (!state.active) return;
  state.active = false;
  state.port.close();
}

function runBlock(node, event) {
  const state = nodeState.get(node);
  if (!state || !state.active) return;
  const { worklet, processor, parameters, inputChannels, outputChannels } = state;
  const scope = worklet._globals;
  const rate = scope.sampleRate;
  const inputData = [];
  for (let c = 0; c < inputChannels; c++) inputData.push(event.inputBuffer.getChannelData(c));
  const outputData = [];
  for (let c = 0; c < outputChannels; c++) outputData.push(event.outputBuffer.getChannelData(c));
  const values = {};
  for (let at = 0; at + QUANTUM <= event.outputBuffer.length; at += QUANTUM) {
    scope.currentTime = event.playbackTime + at / rate;
    scope.currentFrame = Math.round(scope.currentTime * rate);
    const inputs = state.numberOfInputs === 0 ? [] : [fed.has(node) ? inputData.map((d) => d.subarray(at, at + QUANTUM)) : []];
    const outputs = state.numberOfOutputs === 0 ? [] : [outputData.map((d) => d.subarray(at, at + QUANTUM))];
    for (const [name, param] of parameters) {
      const block = values[name] || (values[name] = new Float32Array(1));
      block[0] = param._at(scope.currentTime);
    }
    let keepGoing;
    try {
      keepGoing = processor.process(inputs, outputs, values);
    } catch (error) {
      stopNode(state);
      console.error("[migo-web-adapter] AudioWorkletProcessor.process threw:", error);
      const handler = node.onprocessorerror;
      if (typeof handler === "function") {
        try {
          handler.call(node, { type: "processorerror", error, target: node, currentTarget: node });
        } catch (e) {
          console.error("[migo-web-adapter] onprocessorerror threw:", e);
        }
      }
      return;
    }
    if (!keepGoing) {
      stopNode(state);
      return;
    }
  }
}

export function installAudioWorklet(global) {
  const AudioContextClass = global.AudioContext;
  const ScriptProcessorNode = global.ScriptProcessorNode;
  const AudioNode = global.AudioNode;
  if (typeof AudioContextClass !== "function" || typeof ScriptProcessorNode !== "function") return {};
  const base = Object.getPrototypeOf(AudioContextClass.prototype) && "createScriptProcessor" in Object.getPrototypeOf(AudioContextClass.prototype)
    ? Object.getPrototypeOf(AudioContextClass.prototype)
    : AudioContextClass.prototype;
  if ("audioWorklet" in base) return {};

  Object.defineProperty(base, "audioWorklet", {
    get() {
      return workletOf(this);
    },
    enumerable: true,
    configurable: true,
  });

  // A connection into a worklet node is what gives its processor an input.
  if (AudioNode && typeof AudioNode.prototype.connect === "function" && !AudioNode.prototype.connect._migoWorkletAware) {
    const connect = AudioNode.prototype.connect;
    const wrapped = function (destination, ...rest) {
      if (destination && nodeState.has(destination)) fed.add(destination);
      return connect.call(this, destination, ...rest);
    };
    wrapped._migoWorkletAware = true;
    AudioNode.prototype.connect = wrapped;
  }

  function AudioWorkletNode(context, name, options = {}) {
    if (!new.target) throw new TypeError("AudioWorkletNode must be constructed with new");
    const worklet = workletOf(context);
    const definition = worklet._processors.get(String(name));
    if (!definition) throw new DOMException(`no processor "${name}" is registered: addModule first`, "InvalidStateError");
    const numberOfInputs = options.numberOfInputs ?? 1;
    const numberOfOutputs = options.numberOfOutputs ?? 1;
    if (numberOfInputs > 1 || numberOfOutputs > 1) {
      throw new DOMException("an AudioWorkletNode here has at most one input and one output", "NotSupportedError");
    }
    if (numberOfInputs === 0 && numberOfOutputs === 0) {
      throw new DOMException("an AudioWorkletNode needs an input or an output", "NotSupportedError");
    }
    const inputChannels = numberOfInputs === 0 ? 0 : (options.channelCount ?? 2);
    const outputChannels = numberOfOutputs === 0
      ? 0
      : (Array.isArray(options.outputChannelCount) && options.outputChannelCount.length > 0 ? options.outputChannelCount[0] : inputChannels || 1);

    const node = context.createScriptProcessor(BLOCK, inputChannels, outputChannels);
    Object.setPrototypeOf(node, new.target.prototype);

    const [nodePort, processorPort] = portPair();
    const parameters = new Map();
    const initial = options.parameterData || {};
    for (const descriptor of definition.descriptors) {
      parameters.set(descriptor.name, new WorkletParam(descriptor, initial[descriptor.name]));
    }
    // Save and restore rather than clear: a processor's constructor may construct another AudioWorkletNode (on this
    // context or another), and the outer construction must find its own port waiting when the inner one returns.
    const outerPort = constructingPort;
    constructingPort = processorPort;
    let processor;
    try {
      processor = new definition.processor({
        numberOfInputs,
        numberOfOutputs,
        outputChannelCount: [outputChannels],
        parameterData: initial,
        processorOptions: cloneMessage(options.processorOptions),
      });
    } catch (error) {
      // A processor that cannot be constructed leaves no channel behind: neither end may keep delivering.
      nodePort.close();
      throw error;
    } finally {
      constructingPort = outerPort;
    }
    nodeState.set(node, {
      worklet, processor, parameters, inputChannels, outputChannels, numberOfInputs, numberOfOutputs,
      port: nodePort, active: true, onprocessorerror: null,
    });
    node.addEventListener("audioprocess", (event) => runBlock(node, event));
    // An AudioWorkletNode is processed whether or not anything downstream reads it (a node that only reports, like
    // Godot's position processor, is connected to nothing): a silent path to the destination keeps it in the graph.
    const keepAlive = context.createGain();
    keepAlive.gain.value = 0;
    ScriptProcessorNode.prototype.connect.call(node, keepAlive);
    keepAlive.connect(context.destination);
    return node;
  }
  const baseDisconnect = ScriptProcessorNode.prototype.disconnect || (AudioNode && AudioNode.prototype.disconnect);
  AudioWorkletNode.prototype = Object.create(ScriptProcessorNode.prototype, {
    constructor: { value: AudioWorkletNode, writable: true, configurable: true },
    port: { get() { return nodeState.get(this)?.port; }, enumerable: true, configurable: true },
    parameters: { get() { return nodeState.get(this)?.parameters; }, enumerable: true, configurable: true },
    onprocessorerror: {
      get() { return nodeState.get(this)?.onprocessorerror ?? null; },
      set(handler) { const state = nodeState.get(this); if (state) state.onprocessorerror = typeof handler === "function" ? handler : null; },
      enumerable: true,
      configurable: true,
    },
    // A node taken out of the graph is done: its processor stops and its port closes, as in a browser where the node
    // and its processor are torn down together.
    disconnect: {
      value: function (...args) {
        const state = nodeState.get(this);
        if (state) stopNode(state);
        if (typeof baseDisconnect === "function") return baseDisconnect.apply(this, args);
      },
      writable: true,
      configurable: true,
    },
  });

  return { AudioWorkletNode, AudioWorkletProcessor };
}

export { AudioWorkletProcessor };
