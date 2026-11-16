import { AudioBuffer } from '../core/buffer.js';
import { assertSampleRate, MAX_SAMPLE_RATE, MAX_SAMPLES_PER_BUFFER } from '../core/sample-rate.js';
import { asDataView, writeFourCC, type ByteSource } from './bytes.js';
import { scanRiff } from './riff.js';
import * as pcm from './pcm.js';

export type WavEncoding = 'pcm8' | 'pcm16' | 'pcm24' | 'pcm32' | 'float32' | 'float64';

export const MAX_WAV_CHANNELS = 32;

/**
 * Structural shape required from an audio source before WAV bytes are
 * produced. AudioBuffer satisfies it; passing a plain object lets callers
 * validate a candidate buffer that could not itself be constructed.
 */
export interface WavEncodeSource {
  readonly sampleRate: number;
  readonly numChannels: number;
  readonly numSamples: number;
  getChannel(channel: number): ArrayLike<number>;
}

/** Machine-readable reasons returned by {@link checkWavEncodable}. */
export type WavEncodeIssue =
  | 'invalid-sample-rate'
  | 'too-many-channels'
  | 'sample-count-exceeded'
  | 'non-finite-sample';

/** Location of the first sample that is NaN or Infinity. */
export interface WavNonFiniteSample {
  channel: number;
  index: number;
  value: number;
}

/** Structured pre-flight result suitable for surfacing in a UI. */
export type WavEncodeCheck =
  | {
      ok: true;
      sampleRate: number;
      channels: number;
      numSamples: number;
      totalSamples: number;
    }
  | {
      ok: false;
      reason: WavEncodeIssue;
      message: string;
      sampleRate: number;
      channels: number;
      numSamples: number;
      totalSamples: number;
      nonFiniteSample?: WavNonFiniteSample;
    };

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  format: 'pcm' | 'float';
  frames: number;
  blockAlign: number;
  dataOffset: number;
  dataBytes: number;
}

export function parseWav(input: ByteSource): WavInfo {
  const view = asDataView(input);
  const chunks = scanRiff(input);
  const formats = chunks.filter((chunk) => chunk.id === 'fmt ');
  const payloads = chunks.filter((chunk) => chunk.id === 'data');
  if (formats.length !== 1 || payloads.length !== 1)
    throw new RangeError('Expected one fmt chunk and one data chunk');
  const format = formats[0]!;
  const data = payloads[0]!;
  if (format.length < 16) throw new RangeError('Truncated WAVE format');
  const offset = format.offset;
  let tag = view.getUint16(offset, true);
  const channels = view.getUint16(offset + 2, true);
  const sampleRate = view.getUint32(offset + 4, true);
  const byteRate = view.getUint32(offset + 8, true);
  const blockAlign = view.getUint16(offset + 12, true);
  const bitsPerSample = view.getUint16(offset + 14, true);
  if (tag === 65534) {
    if (
      format.length < 40 ||
      view.getUint16(offset + 16, true) < 22 ||
      18 + view.getUint16(offset + 16, true) > format.length
    )
      throw new RangeError('Truncated extensible WAVE format');
    const validBits = view.getUint16(offset + 18, true);
    if (validBits !== 0 && validBits !== bitsPerSample)
      throw new RangeError('Packed extensible bit depths are unsupported');
    const suffix = [0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
    if (suffix.some((value, index) => view.getUint8(offset + 26 + index) !== value))
      throw new RangeError('Unknown extensible WAVE subformat');
    tag = view.getUint16(offset + 24, true);
  }
  assertSampleRate(sampleRate);
  if (channels < 1 || channels > MAX_WAV_CHANNELS)
    throw new RangeError(`WAVE channel count must be in [1, ${MAX_WAV_CHANNELS}]`);
  if (tag !== 1 && tag !== 3) throw new RangeError('Unsupported WAVE encoding');
  if (!(tag === 1 ? [8, 16, 24, 32] : [32, 64]).includes(bitsPerSample))
    throw new RangeError('Unsupported WAVE bit depth');
  if (blockAlign !== (channels * bitsPerSample) / 8 || byteRate !== sampleRate * blockAlign)
    throw new RangeError('Inconsistent WAVE alignment or byte rate');
  if (data.length % blockAlign !== 0) throw new RangeError('Truncated interleaved audio frame');
  const frames = data.length / blockAlign;
  const facts = chunks.filter((chunk) => chunk.id === 'fact');
  if (facts.length > 1) throw new RangeError('Duplicate WAVE fact chunks');
  if (facts[0] && (facts[0].length < 4 || view.getUint32(facts[0].offset, true) !== frames))
    throw new RangeError('WAVE fact sample count mismatch');
  if (frames * channels > MAX_SAMPLES_PER_BUFFER)
    throw new RangeError('WAVE sample count exceeds the memory limit');
  return {
    sampleRate,
    channels,
    bitsPerSample,
    format: tag === 1 ? 'pcm' : 'float',
    frames,
    blockAlign,
    dataOffset: data.offset,
    dataBytes: data.length,
  };
}

export function decodeWav(input: ByteSource): AudioBuffer {
  const info = parseWav(input);
  const view = asDataView(input);
  const output = new AudioBuffer(info.sampleRate, info.channels, info.frames);
  const read =
    info.format === 'float'
      ? info.bitsPerSample === 32
        ? pcm.readFloat32
        : pcm.readFloat64
      : (
          { 8: pcm.readPcm8, 16: pcm.readPcm16, 24: pcm.readPcm24, 32: pcm.readPcm32 } as Record<
            number,
            (view: DataView, offset: number) => number
          >
        )[info.bitsPerSample]!;
  for (let frame = 0; frame < info.frames; frame++) {
    for (let channel = 0; channel < info.channels; channel++) {
      output.getChannel(channel)[frame] = read(
        view,
        info.dataOffset + frame * info.blockAlign + (channel * info.bitsPerSample) / 8,
      );
    }
  }
  return output;
}

/**
 * Validates an audio source for WAV encoding without allocating a buffer or
 * writing any bytes. Every constraint is checked once and the outcome is a
 * plain structured object so the workbench can explain why an export is
 * blocked. On failure the reason is one of invalid-sample-rate,
 * too-many-channels, sample-count-exceeded or non-finite-sample; on success
 * the result reports the dimensions the encoder would use.
 */
export function checkWavEncodable(audio: WavEncodeSource): WavEncodeCheck {
  const { sampleRate, numChannels, numSamples } = audio;
  const totalSamples = numSamples * numChannels;
  const fail = (reason: WavEncodeIssue, message: string, extra?: WavNonFiniteSample) => ({
    ok: false as const,
    reason,
    message,
    sampleRate,
    channels: numChannels,
    numSamples,
    totalSamples,
    ...(extra ? { nonFiniteSample: extra } : {}),
  });
  if (
    typeof sampleRate !== 'number' ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 1 ||
    sampleRate > MAX_SAMPLE_RATE
  ) {
    return fail(
      'invalid-sample-rate',
      `WAVE sampleRate must be an integer in [1, ${MAX_SAMPLE_RATE}], got ${sampleRate}`,
    );
  }
  if (numChannels > MAX_WAV_CHANNELS) {
    return fail(
      'too-many-channels',
      `WAVE supports at most ${MAX_WAV_CHANNELS} channels, got ${numChannels}`,
    );
  }
  if (
    typeof numSamples !== 'number' ||
    !Number.isInteger(numSamples) ||
    numSamples < 0 ||
    totalSamples > MAX_SAMPLES_PER_BUFFER
  ) {
    return fail(
      'sample-count-exceeded',
      `WAVE total sample count ${totalSamples} exceeds the memory limit ${MAX_SAMPLES_PER_BUFFER}.`,
    );
  }
  for (let channel = 0; channel < numChannels; channel++) {
    const samples = audio.getChannel(channel);
    for (let index = 0; index < samples.length; index++) {
      const value = samples[index]!;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fail(
          'non-finite-sample',
          `WAVE sample at channel ${channel} index ${index} is not finite: ${value}`,
          { channel, index, value: typeof value === 'number' ? value : Number.NaN },
        );
      }
    }
  }
  return {
    ok: true,
    sampleRate,
    channels: numChannels,
    numSamples,
    totalSamples,
  };
}

export function encodeWav(audio: AudioBuffer, encoding: WavEncoding = 'pcm16'): Uint8Array {
  const encodings = ['pcm8', 'pcm16', 'pcm24', 'pcm32', 'float32', 'float64'];
  if (!encodings.includes(encoding)) throw new RangeError('Unsupported WAVE encoding');
  // Run every precondition before any allocation: a rejected source must never
  // leave a half-written buffer behind, especially for NaN/Infinity samples.
  const check = checkWavEncodable(audio);
  if (!check.ok) throw new RangeError(check.message);
  const floating = encoding.startsWith('float');
  const bits = Number(encoding.replace(/[^0-9]/g, ''));
  const align = (audio.numChannels * bits) / 8;
  const bytes = audio.numSamples * align;
  const header = floating ? 58 : 44;
  const view = new DataView(new ArrayBuffer(header + bytes + (bytes % 2)));
  writeFourCC(view, 0, 'RIFF');
  view.setUint32(4, view.byteLength - 8, true);
  writeFourCC(view, 8, 'WAVE');
  writeFourCC(view, 12, 'fmt ');
  view.setUint32(16, floating ? 18 : 16, true);
  view.setUint16(20, floating ? 3 : 1, true);
  view.setUint16(22, audio.numChannels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * align, true);
  view.setUint16(32, align, true);
  view.setUint16(34, bits, true);
  if (floating) {
    view.setUint16(36, 0, true);
    writeFourCC(view, 38, 'fact');
    view.setUint32(42, 4, true);
    view.setUint32(46, audio.numSamples, true);
  }
  writeFourCC(view, header - 8, 'data');
  view.setUint32(header - 4, bytes, true);
  const writers = {
    pcm8: pcm.writePcm8,
    pcm16: pcm.writePcm16,
    pcm24: pcm.writePcm24,
    pcm32: pcm.writePcm32,
    float32: pcm.writeFloat32,
    float64: pcm.writeFloat64,
  };
  for (let frame = 0; frame < audio.numSamples; frame++) {
    for (let channel = 0; channel < audio.numChannels; channel++) {
      writers[encoding](
        view,
        header + frame * align + (channel * bits) / 8,
        audio.getChannel(channel)[frame]!,
      );
    }
  }
  return new Uint8Array(view.buffer);
}
