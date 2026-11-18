// Minimal fakes for the slice of Web Audio that AudioEngine touches, so the
// engine can be driven on a hand-advanced clock with tiny manufactured buffers.

export class FakeAudioParam {
	value = 1;
}

export class FakeAudioBuffer {
	readonly numberOfChannels: number;
	readonly length: number;
	readonly sampleRate: number;
	private readonly channels: Float32Array[];

	constructor(numberOfChannels: number, length: number, sampleRate: number) {
		this.numberOfChannels = numberOfChannels;
		this.length = length;
		this.sampleRate = sampleRate;
		this.channels = Array.from({length: numberOfChannels}, () => new Float32Array(length));
	}

	get duration() {
		return this.length / this.sampleRate;
	}

	getChannelData(channel: number) {
		return this.channels[channel];
	}
}

export interface StartCall {
	when: number;
	offset: number;
}

export class FakeBufferSource {
	buffer: FakeAudioBuffer | null = null;
	readonly playbackRate = new FakeAudioParam();
	onended: (() => void) | null = null;
	started: StartCall | null = null;
	stopped = false;
	disconnected = false;

	connect() {
		return this;
	}

	disconnect() {
		this.disconnected = true;
	}

	start(when = 0, offset = 0) {
		this.started = {when, offset};
	}

	stop() {
		this.stopped = true;
	}
}

export class FakeGainNode {
	readonly gain = new FakeAudioParam();
	connected = false;
	disconnected = false;

	connect() {
		this.connected = true;
		return this;
	}

	disconnect() {
		this.disconnected = true;
	}
}

export class FakeAudioContext {
	state: AudioContextState = "running";
	currentTime = 0;
	readonly destination = {};
	readonly sources: FakeBufferSource[] = [];
	readonly gains: FakeGainNode[] = [];
	readonly buffers: FakeAudioBuffer[] = [];
	resumeCalls = 0;

	resume() {
		this.resumeCalls++;
		this.state = "running";
		return Promise.resolve();
	}

	suspend() {
		this.state = "suspended";
		return Promise.resolve();
	}

	createGain() {
		const gain = new FakeGainNode();
		this.gains.push(gain);
		return gain;
	}

	createBufferSource() {
		const source = new FakeBufferSource();
		this.sources.push(source);
		return source;
	}

	createBuffer(numberOfChannels: number, length: number, sampleRate: number) {
		const buffer = new FakeAudioBuffer(numberOfChannels, length, sampleRate);
		this.buffers.push(buffer);
		return buffer;
	}

	// the source most recently handed out, whether or not it has since been stopped
	lastSource() {
		return this.sources[this.sources.length - 1];
	}

	// sources that are still running (started and not stopped)
	liveSources() {
		return this.sources.filter((source) => !!source.started && !source.stopped);
	}
}

// narrow casts: the engine only depends on the members above, and faking the
// full DOM interfaces would bury the test in noise
export const asAudioContext = (ctx: FakeAudioContext) => ctx as unknown as AudioContext;
export const asAudioBuffer = <T>(buffer: T) => buffer as unknown as AudioBuffer;
