// Microtonal Fabric
//
// Local verification support for the Sound Builder FM/AM switch path.
//
// Fake Web Audio context and nodes. No sound is produced; every write to an
// AudioParam (.value = ...), every scheduled-value call and every connect() is
// recorded so tests can assert on the behaviour of the real sound classes
// without a browser audio device. Works both in a browser (plain <script>) and
// under Node (the Node runner installs these names as globals before loading
// the sound sources).

"use strict";

const fakeAudio = (() => {

    let nextId = 1;
    const nodeRegistry = [];
    const connections = []; // { source, target, output, input }
    const events = [];      // ordered record of every gain write / param call

    class FakeAudioParam {
        #owner;
        #name;
        #value;
        constructor(owner, name, initialValue) {
            this.#owner = owner;
            this.#name = name;
            this.#value = initialValue == undefined ? 0 : initialValue;
            this.inputs = []; // nodes connected into this parameter
        } //constructor
        get owner() { return this.#owner; }
        get name() { return this.#name; }
        set value(newValue) {
            this.#value = newValue;
            events.push({ node: this.#owner, parameter: this.#name, kind: "value", value: newValue });
        } //set value
        get value() { return this.#value; }
        #record(method, args) {
            events.push({ node: this.#owner, parameter: this.#name, kind: method, args: Array.from(args) });
        } //record
        cancelScheduledValues(...args) { this.#record("cancelScheduledValues", args); }
        setValueAtTime(...args) { this.#record("setValueAtTime", args); }
        setTargetAtTime(...args) { this.#record("setTargetAtTime", args); }
        linearRampToValueAtTime(...args) { this.#record("linearRampToValueAtTime", args); }
        exponentialRampToValueAtTime(...args) { this.#record("exponentialRampToValueAtTime", args); }
    } //class FakeAudioParam

    class FakeAudioNode {
        constructor(context, options) {
            this.id = `node-${nextId++}`;
            this.nodeName = this.constructor.name;
            this.context = context;
            this.options = options || {};
            this.inputs = [];   // nodes connected into this node (or into one of its params)
            this.outputs = [];  // nodes / params this node connects to
            nodeRegistry.push(this);
        } //constructor
        connect(target, output, input) {
            this.outputs.push(target);
            // Web Audio keeps one logical input edge per connected source; a
            // repeated connect() to the same target does not stack inputs.
            if (target && target.inputs && !target.inputs.includes(this))
                target.inputs.push(this);
            connections.push({ source: this, target: target, output: output, input: input });
            return target;
        } //connect
        disconnect() {
            // Web Audio's disconnect() removes only the edges leaving THIS node.
            // Snapshot first: several nodes are torn down in sequence during
            // populate(), and each call mutates the shared connection list.
            const ownConnections = connections.filter(c => c.source === this);
            for (const entry of ownConnections) {
                if (entry.target && entry.target.inputs) {
                    const targetIndex = entry.target.inputs.indexOf(this);
                    if (targetIndex >= 0) entry.target.inputs.splice(targetIndex, 1);
                } //if
            } //loop
            for (let index = connections.length - 1; index >= 0; --index)
                if (connections[index].source === this) connections.splice(index, 1);
            this.outputs = [];
        } //disconnect
    } //class FakeAudioNode

    class FakeGainNode extends FakeAudioNode {
        constructor(context, options) {
            super(context, options);
            this.gain = new FakeAudioParam(this, "gain", options ? options.gain : 0);
        } //constructor
    } //class FakeGainNode

    class FakeOscillatorNode extends FakeAudioNode {
        constructor(context, options) {
            super(context, options);
            this.frequency = new FakeAudioParam(this, "frequency", options && options.frequency != undefined ? options.frequency : 440);
            this.detune = new FakeAudioParam(this, "detune", options && options.detune != undefined ? options.detune : 0);
            this.type = options && options.type ? options.type : "sine";
            this.started = false;
        } //constructor
        start() { this.started = true; }
        stop() { this.started = false; }
        setPeriodicWave(wave) { this.periodicWave = wave; }
    } //class FakeOscillatorNode

    class FakeBiquadFilterNode extends FakeAudioNode {
        constructor(context, options) {
            super(context, options);
            this.frequency = new FakeAudioParam(this, "frequency", 350);
            this.Q = new FakeAudioParam(this, "Q", 1);
            this.gain = new FakeAudioParam(this, "gain", 0);
            this.type = "lowpass";
        } //constructor
    } //class FakeBiquadFilterNode

    class FakePeriodicWave {
        constructor(real, imaginary) { this.real = real; this.imaginary = imaginary; }
    } //class FakePeriodicWave

    class FakeAudioContext {
        constructor() { this.currentTime = 0; this.destination = new FakeGainNode(this, { gain: 1 }); }
        createPeriodicWave(real, imaginary) { return new FakePeriodicWave(real, imaginary); }
    } //class FakeAudioContext

    const installGlobals = () => {
        const names = {
            AudioContext: FakeAudioContext,
            GainNode: FakeGainNode,
            OscillatorNode: FakeOscillatorNode,
            BiquadFilterNode: FakeBiquadFilterNode,
            PeriodicWave: FakePeriodicWave,
        };
        for (const [name, ctor] of Object.entries(names)) {
            if (typeof window !== "undefined") window[name] = ctor;
            if (typeof globalThis !== "undefined") globalThis[name] = ctor;
        } //loop
    }; //installGlobals

    // Find the (most recently connected) node feeding an audio parameter or a
    // plain node, e.g. the FM master depth gain node feeding the FM envelope node.
    const sourceNodeOf = target => target && target.inputs && target.inputs.length
        ? target.inputs[target.inputs.length - 1]
        : undefined;

    const writesOf = node => events
        .filter(e => e.node === node && e.parameter === "gain" && e.kind === "value")
        .map(e => e.value);

    const reset = () => {
        nextId = 1;
        nodeRegistry.splice(0);
        connections.splice(0);
        events.splice(0);
    }; //reset

    return {
        FakeAudioContext, FakeAudioNode, FakeGainNode, FakeOscillatorNode,
        FakeBiquadFilterNode, FakeAudioParam,
        installGlobals, sourceNodeOf, writesOf, reset,
        get connections() { return connections; },
        get events() { return events; },
        get parameterWrites() { return events.filter(e => e.kind === "value"); },
        get nodeRegistry() { return nodeRegistry; },
    };

})(); //fakeAudio
