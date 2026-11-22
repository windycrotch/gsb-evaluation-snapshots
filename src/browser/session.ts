import type { AudioBuffer } from '../core/buffer.js';
import { isPow2 } from '../core/pow2.js';
import { assertFiniteSamples, assertInRange } from '../core/validation.js';

export type SessionState = 'idle' | 'playing' | 'paused' | 'microphone' | 'closed';

export interface AudioSessionOptions {
  fftSize?: number;
  volume?: number;
}

/**
 * Owns its audio graph. Construction never opens a device or audio context.
 *
 * Every public operation runs through one entry point: {@link beginOperation}
 * advances a generation counter, which invalidates any operation still waiting
 * on an async boundary. A stale continuation must never write state or touch
 * the graph, and any resource it acquired is released immediately.
 */
export class AudioSession {
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private gain?: GainNode;
  private source?: AudioBufferSourceNode | MediaStreamAudioSourceNode;
  private stream?: MediaStream;
  private generation = 0;
  private status: SessionState = 'idle';
  private readonly fftSize: number;
  private volume: number;

  constructor(options: AudioSessionOptions = {}) {
    this.fftSize = options.fftSize ?? 2048;
    if (!isPow2(this.fftSize) || this.fftSize < 32 || this.fftSize > 32768)
      throw new RangeError('Web Audio FFT size must be a power of two from 32 to 32768');
    this.volume = options.volume ?? 0.2;
    assertInRange(this.volume, 0, 1, 'volume');
  }

  get state(): SessionState {
    return this.status;
  }

  get sampleRate(): number | undefined {
    return this.context?.sampleRate;
  }

  /**
   * Marks every operation still awaiting an async boundary as stale. Every
   * state-changing public method goes through here or through
   * {@link beginOperation}.
   */
  private invalidate(): number {
    if (this.status === 'closed') throw new Error('Session is closed');
    this.generation++;
    return this.generation;
  }

  /**
   * The entry point for operations that replace the running graph (play,
   * microphone, stop). Closing the previous source happens synchronously
   * before the returned generation is allowed to resume.
   */
  private beginOperation(): number {
    const generation = this.invalidate();
    this.teardownSource();
    return generation;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && this.status !== 'closed';
  }

  private ensureContext(): AudioContext {
    if (this.status === 'closed') throw new Error('Session is closed');
    if (!this.context) {
      if (typeof globalThis.AudioContext !== 'function')
        throw new Error('Web Audio is unavailable');
      this.context = new AudioContext();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = this.fftSize;
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.analyser.connect(this.gain);
      this.gain.connect(this.context.destination);
    }
    return this.context;
  }

  /** Stops and disconnects the active source and releases any owned tracks. */
  private teardownSource(): void {
    if (this.source) {
      const source = this.source;
      if ('stop' in source) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          /* already ended */
        }
      }
      source.disconnect();
      this.source = undefined;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = undefined;
    }
    if (this.status !== 'closed') this.status = 'idle';
  }

  /** Public stop: behaves like every other operation and invalidates waits. */
  stop(): void {
    if (this.status === 'closed') return;
    this.beginOperation();
  }

  async play(audio: AudioBuffer): Promise<void> {
    if (audio.numSamples === 0) throw new RangeError('Cannot play empty audio');
    for (const channel of audio.data) assertFiniteSamples(channel);
    const context = this.ensureContext();
    const generation = this.beginOperation();
    try {
      await context.resume();
      if (!this.isCurrent(generation)) return;
      const buffer = context.createBuffer(audio.numChannels, audio.numSamples, audio.sampleRate);
      for (let c = 0; c < audio.numChannels; c++)
        buffer.copyToChannel(new Float32Array(audio.getChannel(c)), c);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.analyser!);
      // Restoring playback always restores the user's configured gain.
      this.gain!.gain.value = this.volume;
      this.source = source;
      source.onended = () => {
        if (this.source === source) this.stop();
      };
      source.start();
      this.status = 'playing';
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.teardownSource();
        this.status = 'idle';
        throw error;
      }
      // A newer operation (or close) won; its teardown owns the graph now.
    }
  }

  async microphone(): Promise<void> {
    if (!globalThis.navigator?.mediaDevices?.getUserMedia)
      throw new Error('Microphone capture needs a secure context and permission');
    const context = this.ensureContext();
    const generation = this.beginOperation();
    let stream: MediaStream | undefined;
    try {
      await context.resume();
      if (!this.isCurrent(generation)) return;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      if (!this.isCurrent(generation)) {
        // Permission arrived after a newer operation or close: never connect it.
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const source = context.createMediaStreamSource(stream);
      source.connect(this.analyser!);
      // Monitoring is forced silent while capturing; setVolume cannot raise it.
      this.gain!.gain.value = 0;
      this.stream = stream;
      this.source = source;
      this.status = 'microphone';
    } catch (error) {
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (this.isCurrent(generation)) {
        // Rejection or user cancellation: leave no half-connected graph behind
        // and return to idle so the caller can try again.
        this.teardownSource();
        this.status = 'idle';
        throw error;
      }
      // The operation was superseded while awaiting permission; swallow the
      // failure because the session now belongs to a different operation.
    }
  }

  setVolume(volume: number): void {
    assertInRange(volume, 0, 1, 'volume');
    this.volume = volume;
    if (this.gain && this.status !== 'microphone' && this.status !== 'closed')
      this.gain.gain.value = volume;
  }

  readTimeDomain(): Float32Array {
    const out = new Float32Array(this.fftSize);
    this.analyser?.getFloatTimeDomainData(out);
    return out;
  }

  readSpectrum(): Float32Array {
    const out = new Float32Array(this.fftSize / 2).fill(-Infinity);
    this.analyser?.getFloatFrequencyData(out);
    return out;
  }

  async pause(): Promise<void> {
    if (this.status === 'closed') throw new Error('Session is closed');
    if (this.status !== 'playing') return;
    const context = this.context!;
    // Pause invalidates earlier waits but keeps the source connected.
    const generation = this.invalidate();
    try {
      await context.suspend();
      if (this.isCurrent(generation)) this.status = 'paused';
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.status = 'playing';
        throw error;
      }
    }
  }

  async resume(): Promise<void> {
    if (this.status === 'closed') throw new Error('Session is closed');
    if (this.status !== 'paused') return;
    const context = this.context!;
    // Resume invalidates earlier waits but keeps the source connected.
    const generation = this.invalidate();
    try {
      await context.resume();
      if (this.isCurrent(generation)) this.status = 'playing';
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.status = 'paused';
        throw error;
      }
    }
  }

  async close(): Promise<void> {
    if (this.status === 'closed') return;
    // Invalidates every outstanding operation before releasing the graph.
    this.teardownSource();
    this.generation++;
    this.status = 'closed';
    const context = this.context;
    this.context = undefined;
    this.analyser?.disconnect();
    this.gain?.disconnect();
    this.analyser = undefined;
    this.gain = undefined;
    await context?.close();
  }
}
