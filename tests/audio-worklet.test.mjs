// AudioWorklet over the runtime's ScriptProcessorNode (src/audio-worklet.js). The platform has no audioWorklet; Godot 4's
// web export loads a processor whatever its audio driver. A fake context stands in for the runtime: its
// ScriptProcessorNode records its handler, and the test hands it blocks as the audio thread would.

import assert from "node:assert/strict";

const files = new Map();
globalThis.migo = {
  getFileSystemManager: () => ({
    readFileSync(path) {
      if (!files.has(path)) throw new Error(`readFileSync:fail no such file or directory ${path}`);
      return files.get(path);
    },
  }),
};

class AudioNode {
  constructor(context) { this.context = context; this.connections = []; }
  connect(destination) { this.connections.push(destination); return destination; }
  disconnect() {}
}
class ScriptProcessorNode extends AudioNode {
  constructor(context, bufferSize, inputs, outputs) {
    super(context);
    this.bufferSize = bufferSize;
    this.inputs = inputs;
    this.outputs = outputs;
    this.handlers = [];
  }
  addEventListener(type, handler) { if (type === "audioprocess") this.handlers.push(handler); }
}
class GainNode extends AudioNode {
  constructor(context) { super(context); this.gain = { value: 1 }; }
}
class Buffer {
  constructor(channels, length) { this.channels = Array.from({ length: channels }, () => new Float32Array(length)); this.length = length; }
  getChannelData(c) { return this.channels[c]; }
}
class BaseAudioContext {
  constructor() { this.sampleRate = 48000; this.destination = new AudioNode(this); }
  createScriptProcessor(bufferSize, inputs, outputs) { return new ScriptProcessorNode(this, bufferSize, inputs, outputs); }
  createGain() { return new GainNode(this); }
}
class AudioContext extends BaseAudioContext {}

const fake = { AudioContext, ScriptProcessorNode, AudioNode };
const { installAudioWorklet } = await import("../src/audio-worklet.js");
const { AudioWorkletNode } = installAudioWorklet(fake);

/// Hand the node one block, as the audio thread would, and return the event's output.
function block(node, playbackTime, fill = () => 0) {
  const input = new Buffer(Math.max(1, node.inputs), node.bufferSize);
  input.channels.forEach((data, c) => data.forEach((_, i) => { data[i] = fill(c, i); }));
  const output = new Buffer(Math.max(1, node.outputs), node.bufferSize);
  for (const handler of node.handlers) handler({ type: "audioprocess", playbackTime, inputBuffer: input, outputBuffer: output });
  return output;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const ctx = new AudioContext();
assert.equal(typeof ctx.audioWorklet.addModule, "function", "contexts have an audioWorklet");
assert.equal(ctx.audioWorklet, ctx.audioWorklet, "one per context");

// 1. addModule evaluates the script in the worklet's scope: registerProcessor, AudioWorkletProcessor, sampleRate.
files.set("worklets/tone.js", `
  class Tone extends AudioWorkletProcessor {
    static get parameterDescriptors() { return [{ name: "gain", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" }]; }
    constructor(options) {
      super();
      this.calls = [];
      this.rate = sampleRate;
      this.options = options.processorOptions;
      this.port.onmessage = (event) => { this.port.postMessage({ echo: event.data }); };
    }
    process(inputs, outputs, parameters) {
      this.calls.push([inputs.length, inputs[0].length, outputs[0][0].length, currentFrame]);
      for (const channel of outputs[0]) channel.fill(parameters.gain[0]);
      globalThis.__lastTone = this;
      return true;
    }
  }
  registerProcessor("tone", Tone);
`);
await ctx.audioWorklet.addModule("worklets/tone.js");
await assert.rejects(ctx.audioWorklet.addModule("worklets/missing.js"), /no such file/, "a missing module rejects");
assert.throws(() => new AudioWorkletNode(ctx, "nope"), { name: "InvalidStateError" }, "an unregistered processor is refused");

// 2. A node runs its processor on a ScriptProcessorNode: each block is four quanta of 128 frames.
const node = new AudioWorkletNode(ctx, "tone", { outputChannelCount: [2], processorOptions: { voice: "a" } });
assert.ok(node instanceof AudioWorkletNode && node instanceof ScriptProcessorNode && node instanceof AudioNode);
assert.equal(node.bufferSize, 512);
assert.equal(node.outputs, 2);
assert.equal(node.connections[0] instanceof GainNode && node.connections[0].gain.value, 0, "kept in the graph by a silent path");
const out = block(node, 2.0);
const tone = globalThis.__lastTone;
assert.equal(tone.rate, 48000);
assert.deepEqual(tone.options, { voice: "a" });
assert.equal(tone.calls.length, 4);
assert.deepEqual(tone.calls.map((c) => c.slice(0, 3)), Array(4).fill([1, 0, 128]), "nothing connected in: an input of no channels");
assert.deepEqual(tone.calls.map((c) => c[3]), [96000, 96128, 96256, 96384], "currentFrame advances a quantum at a time");
assert.ok(out.channels.every((data) => data.every((s) => s === 0.5)), "the processor's output is the block's output");

// 3. Parameters: setValueAtTime takes effect at the quantum it falls in.
node.parameters.get("gain").setValueAtTime(0.25, 3.0 + 256 / 48000);
const later = block(node, 3.0);
assert.equal(later.channels[0][0], 0.5);
assert.equal(later.channels[0][256], 0.25);

// 4. Ports: messages cross as copies, after the sender's code has run.
const received = [];
node.port.onmessage = (event) => received.push(event.data);
const payload = { cmd: "chunk", data: new Float32Array([1, 2]) };
node.port.postMessage(payload);
payload.data[0] = 9;
assert.deepEqual(received, [], "not delivered synchronously");
await settle();
assert.equal(received.length, 1);
assert.deepEqual([...received[0].echo.data], [1, 2], "a copy: the sender's later write is not seen");

// 5. An input with channels once something is connected into the node.
const source = new AudioNode(ctx);
source.connect(node);
block(node, 4.0, (c, i) => i);
assert.equal(tone.calls.at(-1)[1], 2, "two input channels");

// 6. process() returning false ends it; a throw ends it and reports processorerror.
files.set("worklets/once.js", `
  registerProcessor("once", class extends AudioWorkletProcessor { process() { globalThis.__once = (globalThis.__once || 0) + 1; return false; } });
  registerProcessor("broken", class extends AudioWorkletProcessor { process() { throw new Error("boom"); } });
`);
await ctx.audioWorklet.addModule("worklets/once.js");
const once = new AudioWorkletNode(ctx, "once");
block(once, 0);
block(once, 0);
assert.equal(globalThis.__once, 1, "not called again after returning false");
const broken = new AudioWorkletNode(ctx, "broken");
let reported = null;
broken.onprocessorerror = (event) => { reported = event.type; };
const originalError = console.error;
console.error = () => {};
block(broken, 0);
console.error = originalError;
assert.equal(reported, "processorerror");

// 7. What this cannot be is refused, not half-done.
assert.throws(() => new AudioWorkletNode(ctx, "tone", { numberOfOutputs: 2 }), { name: "NotSupportedError" });
assert.throws(() => new AudioWorkletNode(ctx, "tone", { numberOfInputs: 0, numberOfOutputs: 0 }), { name: "NotSupportedError" });
files.set("worklets/dup.js", 'registerProcessor("tone", class extends AudioWorkletProcessor {})');
await assert.rejects(ctx.audioWorklet.addModule("worklets/dup.js"), { name: "NotSupportedError" }, "a name is registered once");

// 8. Each addModule's script has a scope of its own: no global variable carries state from one module to the next,
//    while a registered processor is still usable by a node on the same context.
files.set("worklets/first.js", `
  sharedState = "left by first";
  var moduleVar = "first-var";
  function moduleFn() { return "first-fn"; }
  class First extends AudioWorkletProcessor {
    process() { globalThis.__first = [sharedState, moduleVar, moduleFn()]; return true; }
  }
  registerProcessor("first", First);
`);
await ctx.audioWorklet.addModule("worklets/first.js");
files.set("worklets/second.js", `
  registerProcessor("second", class extends AudioWorkletProcessor {
    process() {
      globalThis.__second = [
        typeof sharedState,
        typeof moduleVar,
        typeof moduleFn,
        typeof registerProcessor,
        typeof sampleRate,
      ];
      return true;
    }
  });
`);
await ctx.audioWorklet.addModule("worklets/second.js");
block(new AudioWorkletNode(ctx, "first"), 0);
block(new AudioWorkletNode(ctx, "second"), 0);
assert.deepEqual(globalThis.__first, ["left by first", "first-var", "first-fn"], "a module's own globals are visible to it");
assert.deepEqual(globalThis.__second, ["undefined", "undefined", "undefined", "function", "number"],
  "a later module does not see an earlier module's variables, but does see the worklet's own names");
assert.equal("sharedState" in globalThis, false, "an implicitly declared variable does not leak onto the game's globals");

// 9. A module that throws part-way registers nothing: every processor it registered is rolled back with it.
files.set("worklets/partial.js", `
  registerProcessor("halfA", class extends AudioWorkletProcessor {});
  registerProcessor("halfB", class extends AudioWorkletProcessor {});
  throw new Error("module failed half-way");
`);
await assert.rejects(ctx.audioWorklet.addModule("worklets/partial.js"), /half-way/);
assert.throws(() => new AudioWorkletNode(ctx, "halfA"), { name: "InvalidStateError" }, "no processor from the failed module");
assert.throws(() => new AudioWorkletNode(ctx, "halfB"), { name: "InvalidStateError" }, "no processor from the failed module");
files.set("worklets/reuse-name.js", 'registerProcessor("halfA", class extends AudioWorkletProcessor { process() { return true; } })');
await ctx.audioWorklet.addModule("worklets/reuse-name.js");
assert.ok(new AudioWorkletNode(ctx, "halfA"), "a rolled-back name can be registered by a later module");

// 10. Concurrent addModule calls on one context: no module's registrations are visible while its script is still
//     running, and a module that collides with one that committed first is rolled back whole.
files.set("worklets/inner.js", `
  // Runs while the outer module is mid-script: the outer module's first registration must not be visible here.
  globalThis.__innerSawOuter = typeof outerFirst;
  registerProcessor("inner", class extends AudioWorkletProcessor { process() { return true; } });
`);
files.set("worklets/outer.js", `
  registerProcessor("outerFirst", class extends AudioWorkletProcessor { process() { return true; } });
  globalThis.__reenter();
  registerProcessor("outerSecond", class extends AudioWorkletProcessor { process() { return true; } });
`);
files.set("worklets/other.js", `registerProcessor("other", class extends AudioWorkletProcessor { process() { return true; } })`);
globalThis.__reenter = () => ctx.audioWorklet.addModule("worklets/inner.js");
// Two calls kicked off before either settles: the outer one re-enters addModule for the inner one at its midpoint,
// and a second module loads alongside.
const outer = ctx.audioWorklet.addModule("worklets/outer.js");
const parallel = ctx.audioWorklet.addModule("worklets/other.js");
assert.equal(globalThis.__innerSawOuter, "undefined", "a mid-script module shows no half registration");
await outer;
await parallel;
assert.ok(new AudioWorkletNode(ctx, "outerFirst") && new AudioWorkletNode(ctx, "outerSecond"), "the outer module committed whole");
assert.ok(new AudioWorkletNode(ctx, "inner") && new AudioWorkletNode(ctx, "other"), "the concurrent modules registered");
// A collision between two modules' names rejects the later whole module: neither of its names lands.
files.set("worklets/collide.js", `
  registerProcessor("collide", class extends AudioWorkletProcessor { process() { return true; } });
  registerProcessor("outerFirst", class extends AudioWorkletProcessor { process() { return true; } });
`);
await assert.rejects(ctx.audioWorklet.addModule("worklets/collide.js"), { name: "NotSupportedError" });
assert.throws(() => new AudioWorkletNode(ctx, "collide"), { name: "InvalidStateError" }, "the colliding module rolled back whole");

// 11. A node that stops -- process() returns false, process() throws, or it is disconnected -- closes its port: no
//     more messages cross, both ends get a close event, and closing again changes nothing.
function closeable(name, stopOn) {
  files.set(`worklets/${name}.js`, `
    registerProcessor("${name}", class extends AudioWorkletProcessor {
      constructor() {
        super();
        this.port.onclose = () => { globalThis.__${name}Closes = (globalThis.__${name}Closes || 0) + 1; };
      }
      process() {
        this.port.postMessage({ tick: true });
        ${stopOn}
      }
    });
  `);
  return ctx.audioWorklet.addModule(`worklets/${name}.js`);
}
await closeable("stopper", "return false;");
await closeable("thrower", "throw new Error('boom2');");
await closeable("disconnector", "return true;");

for (const [name, stop] of [
  ["stopper", (n) => block(n, 0)],
  ["thrower", (n) => { const log = console.error; console.error = () => {}; block(n, 0); console.error = log; }],
  ["disconnector", (n) => n.disconnect()],
]) {
  const n = new AudioWorkletNode(ctx, name);
  const port = n.port;
  let closes = 0;
  port.addEventListener("close", () => { closes++; });
  const messages = [];
  port.addEventListener("message", (event) => messages.push(event.data));
  stop(n);
  await settle();
  const delivered = messages.length;
  port.postMessage({ after: true });
  await settle();
  assert.equal(messages.length, delivered, `${name}: nothing delivered after the node stopped`);
  assert.equal(closes, 1, `${name}: the node's port reports one close`);
  assert.equal(globalThis[`__${name}Closes`], 1, `${name}: the processor's port reports the close too`);
  port.close();
  assert.equal(closes, 1, `${name}: a repeated close is idempotent`);
  assert.equal(globalThis[`__${name}Closes`], 1, `${name}: the far end is not told twice`);
}

// 12. A processor that throws in its constructor does not leave a live channel behind, and the node is not created.
files.set("worklets/badctor.js", `
  registerProcessor("badctor", class extends AudioWorkletProcessor {
    constructor() { super(); throw new Error("ctor failed"); }
  });
`);
await ctx.audioWorklet.addModule("worklets/badctor.js");
assert.throws(() => new AudioWorkletNode(ctx, "badctor"), /ctor failed/);

// 13. Installing twice changes nothing; a runtime without ScriptProcessorNode gets no worklet.
assert.deepEqual(installAudioWorklet(fake), {});
assert.deepEqual(installAudioWorklet({ AudioContext: class {} }), {});

console.log("AUDIO WORKLET TEST PASSED");
