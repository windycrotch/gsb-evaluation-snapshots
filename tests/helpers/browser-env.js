// Minimal browser-environment stubs so the DSP Playground App can run under
// Node's built-in test runner. Install BEFORE constructing `new App()`.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export class FakeAudioParam {
    constructor(value = 0) {
        this.value = value;
    }
    setValueAtTime(v) { this.value = v; return this; }
    setTargetAtTime(v) { this.value = v; return this; }
    linearRampToValueAtTime(v) { this.value = v; return this; }
    exponentialRampToValueAtTime(v) { this.value = v; return this; }
    cancelScheduledValues() { return this; }
    cancelAndHoldAtTime() { return this; }
}

// Base class installed as globalThis.AudioNode. The App constructor patches
// AudioNode.prototype.connect/disconnect for debug tracing, so every fake
// node must inherit from it.
class AudioNodeBase {
    connect(dest) { return dest; }
    disconnect() { }
}

function makeNode(extra = {}) {
    return Object.assign(new AudioNodeBase(), extra);
}

export class FakeAudioContext {
    static instances = [];

    constructor(options) {
        FakeAudioContext.instances.push(this);
        this.options = options;
        this.state = 'suspended';
        this.currentTime = 0;
        this.sampleRate = 48000;
        this.baseLatency = 0.005;
        this.outputLatency = 0.01;
        this.destination = makeNode();
    }

    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }

    createGain() { return makeNode({ gain: new FakeAudioParam(1) }); }
    createOscillator() {
        return makeNode({
            type: 'sine',
            frequency: new FakeAudioParam(440),
            detune: new FakeAudioParam(0),
            start() { }, stop() { }
        });
    }
    createConstantSource() {
        return makeNode({ offset: new FakeAudioParam(0), start() { }, stop() { } });
    }
    createAnalyser() {
        const node = makeNode({
            fftSize: 2048,
            getByteTimeDomainData() { },
            getByteFrequencyData() { }
        });
        Object.defineProperty(node, 'frequencyBinCount', { get: () => node.fftSize / 2 });
        return node;
    }
    createDynamicsCompressor() {
        return makeNode({
            threshold: new FakeAudioParam(-24),
            knee: new FakeAudioParam(30),
            ratio: new FakeAudioParam(12),
            attack: new FakeAudioParam(0.003),
            release: new FakeAudioParam(0.25)
        });
    }
    createBiquadFilter() {
        return makeNode({
            type: 'lowpass',
            frequency: new FakeAudioParam(350),
            Q: new FakeAudioParam(1),
            gain: new FakeAudioParam(0),
            detune: new FakeAudioParam(0)
        });
    }
    createDelay() { return makeNode({ delayTime: new FakeAudioParam(0) }); }
    createWaveShaper() { return makeNode({ curve: null, oversample: 'none' }); }
    createStereoPanner() { return makeNode({ pan: new FakeAudioParam(0) }); }
    createPanner() { return makeNode({ panningModel: 'equalpower' }); }
    createChannelMerger() { return makeNode(); }
    createChannelSplitter() { return makeNode(); }
    createConvolver() { return makeNode({ buffer: null }); }
    createBufferSource() {
        return makeNode({
            buffer: null,
            loop: false,
            playbackRate: new FakeAudioParam(1),
            start() { }, stop() { }
        });
    }
    createBuffer(numberOfChannels, length, sampleRate) {
        return {
            numberOfChannels,
            length,
            sampleRate,
            getChannelData: () => new Float32Array(length)
        };
    }
    createPeriodicWave() { return {}; }
    createMediaStreamSource() { return makeNode(); }
    decodeAudioData(_data, onSuccess) {
        const buffer = this.createBuffer(1, 1, this.sampleRate);
        if (typeof onSuccess === 'function') onSuccess(buffer);
        return Promise.resolve(buffer);
    }
}

export const alerts = [];

function createCanvasContextStub() {
    // Any method call is a no-op; any property assignment is accepted.
    return new Proxy({}, {
        get(target, prop) {
            if (prop in target) return target[prop];
            return () => undefined;
        },
        set(target, prop, value) {
            target[prop] = value;
            return true;
        }
    });
}

function createElementStub(tag = 'div') {
    return {
        tagName: String(tag).toUpperCase(),
        style: {},
        textContent: '',
        value: '',
        files: [],
        width: 0,
        height: 0,
        listeners: {},
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        removeEventListener() { },
        click() { },
        getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 800 }; },
        getContext() { return createCanvasContextStub(); }
    };
}

export function installBrowserGlobals() {
    FakeAudioContext.instances.length = 0;
    alerts.length = 0;

    globalThis.AudioNode = AudioNodeBase;
    globalThis.AudioContext = FakeAudioContext;

    const elements = new Map();
    globalThis.document = {
        getElementById(id) {
            if (!elements.has(id)) {
                elements.set(id, createElementStub(id === 'nodeCanvas' ? 'canvas' : 'div'));
            }
            return elements.get(id);
        },
        createElement(tag) { return createElementStub(tag); },
        body: createElementStub('body')
    };

    globalThis.window = globalThis;
    window.innerWidth = 1280;
    window.innerHeight = 800;
    window.devicePixelRatio = 1;
    window.addEventListener = () => { };
    window.removeEventListener = () => { };
    window.location = { protocol: 'http:' };
    // Not a secure context -> worklet paths stay disabled, matching the
    // fallback behaviour the app already implements.
    window.isSecureContext = false;
    window.AudioContext = FakeAudioContext;

    // Run one animation frame per loop() call, then stop.
    globalThis.requestAnimationFrame = () => 0;
    globalThis.alert = (msg) => { alerts.push(String(msg)); };
}

// Fetch stub that serves the real preset files from disk. Per-name gates
// (promises) let tests control resolution order; per-name overrides let tests
// inject failures or malformed content.
export function makePresetFetch({ gates = {}, overrides = {} } = {}) {
    return async (url) => {
        const match = /presets\/([^/]+)\.json/.exec(String(url));
        const name = match ? decodeURIComponent(match[1]) : '';
        if (gates[name]) await gates[name];
        if (overrides[name]) return overrides[name]();
        let text;
        try {
            text = await readFile(path.join(repoRoot, 'presets', `${name}.json`), 'utf8');
        } catch {
            return {
                ok: false,
                status: 404,
                statusText: 'Not Found',
                json: async () => { throw new Error('not found'); }
            };
        }
        return {
            ok: true,
            status: 200,
            json: async () => JSON.parse(text)
        };
    };
}

export async function loadPresetData(name) {
    const text = await readFile(path.join(repoRoot, 'presets', `${name}.json`), 'utf8');
    return JSON.parse(text);
}
