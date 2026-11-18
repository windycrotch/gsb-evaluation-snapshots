// FSK frame recovery tests - re-synchronisation after corrupted frames
//
// Every sample stream here is built locally from the modulator output; there
// are no external fixtures. A valid frame (preamble + SFD + data) is followed
// by a corrupted region (noise burst / bad stop bit / bad start bit / silence)
// and then by a second valid frame. The demodulator must recover the bytes of
// the second frame within the same demodulateData call.
import { describe, test, expect } from 'vitest';
import { FSKCore, FSKConfig, DEFAULT_FSK_CONFIG } from '../../src/modems/fsk';

const config = { ...DEFAULT_FSK_CONFIG } as FSKConfig;
const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
const bitsPerByte = 8 + config.startBits + config.stopBits +
  (config.parity !== 'none' ? 1 : 0);
const paddingSamples = samplesPerBit * 2;
const silenceSamples = bitsPerByte * samplesPerBit;

function createCore(overrides: Partial<FSKConfig> = {}): FSKCore {
  const core = new FSKCore();
  core.configure({ ...config, ...overrides });
  return core;
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Strip the leading padding and trailing end-of-data silence from a frame, so
 * frames can be spliced back to back without a gap.
 */
function pureFrame(signal: Float32Array): Float32Array {
  return signal.slice(paddingSamples, signal.length - silenceSamples);
}

/** Deterministic pseudo-random noise (LCG) so the tests are reproducible. */
function noise(length: number, amplitude: number, seed = 12345): Float32Array {
  const out = new Float32Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = ((state / 0xffffffff) * 2 - 1) * amplitude;
  }
  return out;
}

/** A constant-frequency burst, used to force a specific wrong bit value. */
function tone(length: number, frequency: number, sampleRate = config.sampleRate): Float32Array {
  const out = new Float32Array(length);
  const omega = 2 * Math.PI * frequency / sampleRate;
  for (let i = 0; i < length; i++) out[i] = Math.sin(omega * i);
  return out;
}

/** Overwrite one bit of a pure frame with a tone representing `bit`. */
function corruptBit(
  frame: Float32Array,
  bitIndex: number,
  bit: number,
  cfg: FSKConfig = config
): Float32Array {
  const spb = Math.floor(cfg.sampleRate / cfg.baudRate);
  const out = new Float32Array(frame);
  const frequency = bit === 1 ? cfg.markFrequency : cfg.spaceFrequency;
  out.set(tone(spb, frequency, cfg.sampleRate), bitIndex * spb);
  return out;
}

function containsBytes(data: Uint8Array, expected: number[]): boolean {
  for (let start = 0; start + expected.length <= data.length; start++) {
    let ok = true;
    for (let i = 0; i < expected.length; i++) {
      if (data[start + i] !== expected[i]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

async function modulate(core: FSKCore, bytes: number[]): Promise<Float32Array> {
  return core.modulateData(new Uint8Array(bytes));
}

const GOOD = [0x41, 0x42, 0x43];

describe('FSK frame recovery after corruption', () => {
  describe('stop bit errors', () => {
    test('recovers the frame that follows a bad stop bit', async () => {
      const core = createCore();
      const first = pureFrame(await modulate(core, [0x11, 0x22]));
      // Last bit of the first frame is the stop bit of 0x22: force it to space.
      const corrupted = corruptBit(first, first.length / samplesPerBit - 1, 0);
      const stream = concat(corrupted, await modulate(core, GOOD));

      const result = await core.demodulateData(stream);
      expect(containsBytes(result, GOOD)).toBe(true);
    });

    test('keeps the bytes received before a bad stop bit', async () => {
      const core = createCore();
      const first = pureFrame(await modulate(core, [0x11, 0x22]));
      const corrupted = corruptBit(first, first.length / samplesPerBit - 1, 0);
      const stream = concat(corrupted, await modulate(core, GOOD));

      const result = await core.demodulateData(stream);
      // 0x11 completed before the framing error and must not be discarded.
      expect(Array.from(result)).toContain(0x11);
      expect(containsBytes(result, GOOD)).toBe(true);
    });

    test('recovers from a bad stop bit in the middle of a frame', async () => {
      const core = createCore();
      const first = pureFrame(await modulate(core, [0x11, 0x22, 0x33]));
      // First data byte follows the preamble and SFD; its stop bit is bit 9.
      const firstDataByteBit = (config.preamblePattern.length + config.sfdPattern.length) * bitsPerByte;
      const corrupted = corruptBit(first, firstDataByteBit + 9, 0);
      const stream = concat(corrupted, await modulate(core, GOOD));

      const result = await core.demodulateData(stream);
      expect(containsBytes(result, GOOD)).toBe(true);
    });

    test('recovers after repeated bad frames', async () => {
      const core = createCore();
      const bad = pureFrame(await modulate(core, [0x11]));
      const corrupted = corruptBit(bad, bad.length / samplesPerBit - 1, 0);
      const stream = concat(corrupted, corrupted, corrupted, await modulate(core, GOOD));

      const result = await core.demodulateData(stream);
      expect(containsBytes(result, GOOD)).toBe(true);
    });
  });

  describe('start bit errors', () => {
    test('recovers the frame that follows a bad start bit', async () => {
      const core = createCore();
      const first = pureFrame(await modulate(core, [0x11, 0x22]));
      const firstDataByteBit = (config.preamblePattern.length + config.sfdPattern.length) * bitsPerByte;
      const corrupted = corruptBit(first, firstDataByteBit, 1); // start bit must be 0
      const stream = concat(corrupted, await modulate(core, GOOD));

      const result = await core.demodulateData(stream);
      expect(containsBytes(result, GOOD)).toBe(true);
    });

    test('a bad start bit does not leave the frame started', async () => {
      const core = createCore();
      const first = pureFrame(await modulate(core, [0x11, 0x22]));
      const firstDataByteBit = (config.preamblePattern.length + config.sfdPattern.length) * bitsPerByte;
      const corrupted = corruptBit(first, firstDataByteBit, 1);
      // Trailing silence lets the frame state settle.
      await core.demodulateData(concat(corrupted, new Float32Array(silenceSamples * 4)));

      expect(core.getStatus().frameStarted).toBe(false);
    });
  });

  describe('noise and silence', () => {
    test('recovers the frame after a noise burst', async () => {
      const core = createCore();
      const first = pureFrame(await modulate(core, [0x11, 0x22]));
      const truncated = first.slice(0, first.length - samplesPerBit * 4);
      const burst = noise(bitsPerByte * samplesPerBit, 0.6);
      const stream = concat(truncated, burst, await modulate(core, GOOD));

      const result = await core.demodulateData(stream);
      expect(containsBytes(result, GOOD)).toBe(true);
    });

    test('recovers the frame after a silence gap', async () => {
      const core = createCore();
      const first = pureFrame(await modulate(core, [0x11, 0x22]));
      const truncated = first.slice(0, first.length - samplesPerBit * 4);
      const gap = new Float32Array(samplesPerBit * bitsPerByte * 4);
      const stream = concat(truncated, gap, await modulate(core, GOOD));

      const result = await core.demodulateData(stream);
      expect(containsBytes(result, GOOD)).toBe(true);
    });

    test('silence clears the frame state', async () => {
      const core = createCore();
      const first = pureFrame(await modulate(core, [0x11, 0x22]));
      const truncated = first.slice(0, first.length - samplesPerBit * 4);
      let eodCount = 0;
      core.on('eod', () => { eodCount++; });
      await core.demodulateData(concat(truncated, new Float32Array(silenceSamples * 6)));

      expect(eodCount).toBeGreaterThan(0);
      expect(core.getStatus().frameStarted).toBe(false);
    });

    test('pure silence produces no bytes', async () => {
      const core = createCore();
      const result = await core.demodulateData(new Float32Array(48000));
      expect(result.length).toBe(0);
    });

    test('silence following a bad frame produces no bytes', async () => {
      const core = createCore();
      const first = pureFrame(await modulate(core, [0x11, 0x22]));
      const corrupted = corruptBit(first, first.length / samplesPerBit - 1, 0);
      await core.demodulateData(concat(corrupted, new Float32Array(silenceSamples * 6)));

      const result = await core.demodulateData(new Float32Array(48000));
      expect(result.length).toBe(0);
    });
  });

  describe('silence threshold recovery', () => {
    test('a loud frame does not raise the threshold against later quiet frames', async () => {
      // AGC is disabled so the amplitude difference reaches the detector
      // unchanged: this is the case where a stale threshold used to lock out
      // every following, quieter transmission.
      const core = createCore({ agcEnabled: false });
      const loud = await modulate(core, [0x11, 0x22]);
      const quiet = (await modulate(core, GOOD)).map(sample => sample * 0.05) as Float32Array;
      const stream = concat(loud, quiet);

      const result = await core.demodulateData(stream);
      expect(containsBytes(result, GOOD)).toBe(true);
    });

    test('the threshold is recomputed from the new sync window', async () => {
      const core = createCore({ agcEnabled: false });
      // No trailing silence, so the loud frame is still open when inspected and
      // its sync-window threshold is the one in effect.
      const loud = pureFrame(
        (await modulate(core, [0x11, 0x22])).map(sample => sample * 8) as Float32Array
      );
      await core.demodulateData(loud);
      const loudThreshold = core.getStatus().silenceThreshold;

      const quiet = (await modulate(core, GOOD)).map(sample => sample * 0.05) as Float32Array;
      // Silence first closes the loud frame (EOD); the quiet frame then syncs
      // and must derive its own, lower threshold from its own window.
      const result = await core.demodulateData(concat(new Float32Array(silenceSamples * 4), quiet));
      const quietThreshold = core.getStatus().silenceThreshold;

      expect(loudThreshold).toBeGreaterThan(0.01);
      expect(quietThreshold).toBeLessThan(loudThreshold);
      expect(quietThreshold).toBeGreaterThan(0);
      expect(containsBytes(result, GOOD)).toBe(true);
    });

    test('recovery still works after an end-of-data reset', async () => {
      const core = createCore();
      await core.demodulateData(await modulate(core, [0x11, 0x22]));
      // Long silence triggers EOD, which resets frame and silence state.
      await core.demodulateData(new Float32Array(48000));

      const result = await core.demodulateData(await modulate(core, GOOD));
      expect(Array.from(result)).toEqual(GOOD);
    });
  });

  describe('multiple consecutive frames', () => {
    test('two valid frames are both decoded', async () => {
      const core = createCore();
      const stream = concat(
        await modulate(core, [0x41, 0x42]),
        await modulate(core, [0x43, 0x44])
      );

      const result = await core.demodulateData(stream);
      expect(containsBytes(result, [0x41, 0x42])).toBe(true);
      expect(containsBytes(result, [0x43, 0x44])).toBe(true);
    });

    test('a bad frame between two good frames only loses the bad one', async () => {
      const core = createCore();
      const bad = pureFrame(await modulate(core, [0x01, 0x02]));
      const corrupted = corruptBit(bad, bad.length / samplesPerBit - 1, 0);
      const stream = concat(
        corrupted,
        await modulate(core, [0x41, 0x42]),
        await modulate(core, [0x43, 0x44])
      );

      const result = await core.demodulateData(stream);
      expect(containsBytes(result, [0x41, 0x42])).toBe(true);
      expect(containsBytes(result, [0x43, 0x44])).toBe(true);
    });
  });

  describe('reset()', () => {
    test('allows a new frame to be received', async () => {
      const core = createCore();
      await core.demodulateData(await modulate(core, [0x31, 0x32]));

      core.reset();
      const status = core.getStatus();
      expect(status.frameStarted).toBe(false);
      expect(status.byteBufferLength).toBe(0);
      expect(status.receivedBitsLength).toBe(0);
      expect(status.globalSampleCounter).toBe(0);

      const result = await core.demodulateData(await modulate(core, [0x41, 0x42]));
      expect(Array.from(result)).toEqual([0x41, 0x42]);
    });

    test('clears a partially assembled byte', async () => {
      const core = createCore();
      await core.demodulateData(await modulate(core, [0x31, 0x32]));
      core.reset();

      // Bytes completed after the reset must not be contaminated by the
      // partial byte/frame state that was live when reset() was called.
      const result = await core.demodulateData(await modulate(core, [0x41]));
      expect(Array.from(result)).toEqual([0x41]);
    });

    test('preserves the configured sample rate, baud rate, frequencies and parity', async () => {
      const core = createCore();
      const before = core.getConfig();
      core.reset();
      const after = core.getConfig();

      expect(after.sampleRate).toBe(before.sampleRate);
      expect(after.baudRate).toBe(before.baudRate);
      expect(after.markFrequency).toBe(before.markFrequency);
      expect(after.spaceFrequency).toBe(before.spaceFrequency);
      expect(after.parity).toBe(before.parity);
      expect(after.preamblePattern).toEqual(before.preamblePattern);
      expect(after.sfdPattern).toEqual(before.sfdPattern);
      expect(after.syncThreshold).toBe(before.syncThreshold);
    });

    test('the demodulator is still ready after reset()', async () => {
      const core = createCore();
      core.reset();
      expect(core.isReady()).toBe(true);
    });
  });

  describe('chunked (streaming) input', () => {
    test('recovers the following frame when processed in 128-sample chunks', async () => {
      const core = createCore();
      const first = pureFrame(await modulate(core, [0x11, 0x22]));
      const corrupted = corruptBit(first, first.length / samplesPerBit - 1, 0);
      const stream = concat(corrupted, await modulate(core, GOOD));

      const result: number[] = [];
      for (let i = 0; i < stream.length; i += 128) {
        result.push(...await core.demodulateData(stream.slice(i, i + 128)));
      }
      expect(containsBytes(new Uint8Array(result), GOOD)).toBe(true);
    });
  });

  describe('re-sync across non-default frame geometry', () => {
    // The sync ring buffer is sized from the bit geometry. Fractional sizes
    // used to make the ring buffer permanently unreadable once it filled up,
    // so these configurations could never re-sync at all.
    const geometries: Array<[string, Partial<FSKConfig>]> = [
      ['two stop bits', { stopBits: 2 }],
      ['even parity', { parity: 'even' }],
      ['odd parity + two stop bits', { parity: 'odd', stopBits: 2 }],
      ['44.1 kHz sample rate', { sampleRate: 44100 }],
    ];

    for (const [label, overrides] of geometries) {
      test(`decodes consecutive frames with ${label}`, async () => {
        const core = createCore(overrides as Partial<FSKConfig>);
        const stream = concat(
          await modulate(core, [0x41, 0x42]),
          await modulate(core, [0x43, 0x44])
        );

        const result = await core.demodulateData(stream);
        expect(containsBytes(result, [0x41, 0x42])).toBe(true);
        expect(containsBytes(result, [0x43, 0x44])).toBe(true);
      });

      test(`recovers after a bad stop bit with ${label}`, async () => {
        const core = createCore(overrides as Partial<FSKConfig>);
        const cfg = core.getConfig();
        const spb = Math.floor(cfg.sampleRate / cfg.baudRate);

        const first = pureFrame(await modulate(core, [0x11, 0x22]));
        const corrupted = corruptBit(first, first.length / spb - 1, 0, cfg);
        const stream = concat(corrupted, await modulate(core, GOOD));

        const result = await core.demodulateData(stream);
        expect(containsBytes(result, GOOD)).toBe(true);
      });
    }
  });
});
