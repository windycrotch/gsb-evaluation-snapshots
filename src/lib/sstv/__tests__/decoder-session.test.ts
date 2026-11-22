/**
 * Session-boundary tests for the SSTV decoder.
 *
 * These drive the decoder deterministically through injected sync detector and
 * line decoder seams, so we can assert on session isolation (image buffer, line
 * count, sync anchor, frequency calibration) without synthesising real SSTV
 * audio in real time.
 */

import { SSTVDecoder, DecoderState, DecoderDeps, LineDecoderLike } from '../decoder';
import { SyncDetectorLike } from '../decoder';
import { SyncPulseWidth, SyncPulseDetection } from '../sync-detector';
import { SSTV_MODES } from '../constants';

const SAMPLE_RATE = 8000;
// 0.25s per chunk: larger than the decoder's 0.1s "too close" sync threshold.
const CHUNK = Math.floor(SAMPLE_RATE * 0.25);
// Robot36 has 240 rows and each scripted line produces one row.
const ROBOT36_LINES = SSTV_MODES.ROBOT36.height;

/**
 * Emits exactly one 9ms sync pulse per process() call, at the start of the
 * chunk. Every chunk after the first therefore completes exactly one scan line.
 */
class ScriptedSyncDetector implements SyncDetectorLike {
  public resets = 0;
  public calls = 0;
  constructor(private frequencyOffset: number = 0) {}

  process(_samples: Float32Array, demodulated: Float32Array): SyncPulseDetection {
    this.calls++;
    demodulated.fill(0);
    return {
      detected: true,
      width: SyncPulseWidth.NineMilliSeconds,
      offset: 0,
      frequencyOffset: this.frequencyOffset,
    };
  }

  reset(): void {
    this.resets++;
  }
}

/** Produces one row of a solid colour per scan line. */
class SolidColourLineDecoder implements LineDecoderLike {
  public resets = 0;
  public decodes = 0;
  public lastFrequencyOffset: number | null = null;

  constructor(
    private colour: { r: number; g: number; b: number },
    private width: number,
    private rowsPerLine: number = 1
  ) {}

  decodeScanLine(
    _buffer: Float32Array,
    _syncPulseIndex: number,
    frequencyOffset: number
  ): { pixels: Uint8ClampedArray; width: number; height: number; isOddLine: boolean } | null {
    this.decodes++;
    this.lastFrequencyOffset = frequencyOffset;
    const pixels = new Uint8ClampedArray(this.width * this.rowsPerLine * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = this.colour.r;
      pixels[i + 1] = this.colour.g;
      pixels[i + 2] = this.colour.b;
      pixels[i + 3] = 255;
    }
    return {
      pixels,
      width: this.width,
      height: this.rowsPerLine,
      isOddLine: false,
    };
  }

  reset(): void {
    this.resets++;
  }
}

interface Harness {
  decoder: SSTVDecoder;
  sync: ScriptedSyncDetector;
  lineDecoders: Map<string, SolidColourLineDecoder>;
  feedChunks: (count: number) => void;
}

function makeHarness(
  mode: keyof typeof SSTV_MODES = 'ROBOT36',
  colours: Partial<Record<keyof typeof SSTV_MODES, { r: number; g: number; b: number }>> = {}
): Harness {
  const lineDecoders = new Map<string, SolidColourLineDecoder>();
  const defaultColour = { r: 10, g: 20, b: 30 };

  const deps: DecoderDeps = {
    createSyncDetector: () => new ScriptedSyncDetector(42),
    createLineDecoder: (sampleRate, modeName) => {
      const dims = SSTV_MODES[modeName];
      const decoder = new SolidColourLineDecoder(
        colours[modeName] ?? defaultColour,
        dims.width,
        1
      );
      lineDecoders.set(modeName as string, decoder);
      return decoder;
    },
  };

  const decoder = new SSTVDecoder(SAMPLE_RATE, mode, deps);

  const feedChunks = (count: number) => {
    for (let i = 0; i < count; i++) {
      decoder.processSamples(new Float32Array(CHUNK));
    }
  };

  return {
    decoder,
    sync: (decoder as unknown as { syncDetector: ScriptedSyncDetector }).syncDetector,
    lineDecoders,
    feedChunks,
  };
}

function nonBlackPixelCount(image: Uint8ClampedArray): number {
  let count = 0;
  for (let i = 0; i < image.length; i += 4) {
    if (image[i] !== 0 || image[i + 1] !== 0 || image[i + 2] !== 0) count++;
  }
  return count;
}

function allPixelsAre(image: Uint8ClampedArray, r: number, g: number, b: number): boolean {
  for (let i = 0; i < image.length; i += 4) {
    if (image[i] !== r || image[i + 1] !== g || image[i + 2] !== b || image[i + 3] !== 255) {
      return false;
    }
  }
  return true;
}

/** Assert that only the first `decodedRows` rows carry the expected colour. */
function decodedRowsAre(
  image: Uint8ClampedArray,
  width: number,
  decodedRows: number,
  r: number,
  g: number,
  b: number
): boolean {
  const decodedPixels = decodedRows * width * 4;
  for (let i = 0; i < decodedPixels; i += 4) {
    if (image[i] !== r || image[i + 1] !== g || image[i + 2] !== b || image[i + 3] !== 255) {
      return false;
    }
  }
  // Everything past the decoded rows must still be black.
  for (let i = decodedPixels; i < image.length; i += 4) {
    if (image[i] !== 0 || image[i + 1] !== 0 || image[i + 2] !== 0) {
      return false;
    }
  }
  return true;
}

describe('SSTVDecoder session lifecycle', () => {
  test('normal decoding advances line count and progress', () => {
    const h = makeHarness('ROBOT36');
    h.decoder.start();

    expect(h.decoder.getStats().state).toBe(DecoderState.DECODING_IMAGE);
    expect(h.decoder.getStats().currentLine).toBe(0);
    expect(h.decoder.getStats().progress).toBe(0);

    // First chunk only anchors the sync.
    h.feedChunks(1);
    expect(h.decoder.getStats().currentLine).toBe(0);

    // Each subsequent chunk decodes one line.
    h.feedChunks(3);
    const stats = h.decoder.getStats();
    expect(stats.currentLine).toBe(3);
    expect(stats.totalLines).toBe(SSTV_MODES.ROBOT36.height);
    expect(stats.progress).toBeCloseTo((3 / SSTV_MODES.ROBOT36.height) * 100, 5);
    expect(nonBlackPixelCount(h.decoder.getImageData())).toBeGreaterThan(0);
  });

  test('line count never exceeds the mode height', () => {
    const h = makeHarness('ROBOT36');
    h.decoder.start();
    h.feedChunks(ROBOT36_LINES + 50);

    const stats = h.decoder.getStats();
    expect(stats.currentLine).toBe(SSTV_MODES.ROBOT36.height);
    expect(stats.progress).toBe(100);
  });

  describe('mode switching', () => {
    test('rebuilds dimensions, progress ceiling and image buffer with no old pixels', () => {
      const h = makeHarness('ROBOT36', {
        ROBOT36: { r: 200, g: 1, b: 1 },
        PD120: { r: 1, g: 1, b: 200 },
      });
      h.decoder.start();
      h.feedChunks(4);

      const beforeImage = h.decoder.getImageData().slice();
      expect(decodedRowsAre(beforeImage, SSTV_MODES.ROBOT36.width, 3, 200, 1, 1)).toBe(true);

      const changed = h.decoder.setMode('PD120');
      expect(changed).toBe(true);

      // Dimensions and progress ceiling follow the new mode.
      expect(h.decoder.getDimensions()).toEqual({
        width: SSTV_MODES.PD120.width,
        height: SSTV_MODES.PD120.height,
      });
      const statsAfterSwitch = h.decoder.getStats();
      expect(statsAfterSwitch.modeKey).toBe('PD120');
      expect(statsAfterSwitch.totalLines).toBe(SSTV_MODES.PD120.height);
      expect(statsAfterSwitch.currentLine).toBe(0);
      expect(statsAfterSwitch.progress).toBe(0);
      // Decoding continues in the new session.
      expect(statsAfterSwitch.state).toBe(DecoderState.DECODING_IMAGE);

      // New image buffer: correct size, fully black, zero old-mode pixels.
      const image = h.decoder.getImageData();
      expect(image.length).toBe(SSTV_MODES.PD120.width * SSTV_MODES.PD120.height * 4);
      expect(allPixelsAre(image, 0, 0, 0)).toBe(true);
      expect(nonBlackPixelCount(image)).toBe(0);

      // A fresh session id.
      expect(statsAfterSwitch.sessionId).toBeGreaterThan(1);

      // Decoding into the new mode only paints the new mode colour.
      h.feedChunks(3);
      const afterDecode = h.decoder.getImageData();
      const stats = h.decoder.getStats();
      expect(stats.currentLine).toBe(2);
      expect(decodedRowsAre(afterDecode, SSTV_MODES.PD120.width, 2, 1, 1, 200)).toBe(true);
      // No ROBOT36 pixel survived — the old red channel is gone entirely.
      for (let i = 0; i < afterDecode.length; i += 4) {
        expect(afterDecode[i]).not.toBe(200);
      }
    });

    test('switching while stopped updates stats but stays idle', () => {
      const h = makeHarness('ROBOT36');
      // Never started.
      expect(h.decoder.getStats().state).toBe(DecoderState.IDLE);

      expect(h.decoder.setMode('SCOTTIE_S1')).toBe(true);
      const stats = h.decoder.getStats();
      expect(stats.state).toBe(DecoderState.IDLE);
      expect(stats.modeKey).toBe('SCOTTIE_S1');
      expect(stats.totalLines).toBe(SSTV_MODES.SCOTTIE_S1.height);
      expect(h.decoder.getDimensions().width).toBe(SSTV_MODES.SCOTTIE_S1.width);
    });

    test('switching to the same mode is a no-op that keeps the session', () => {
      const h = makeHarness('ROBOT36');
      h.decoder.start();
      h.feedChunks(3);
      const sessionBefore = h.decoder.getSessionId();
      const lineBefore = h.decoder.getStats().currentLine;

      expect(h.decoder.setMode('ROBOT36')).toBe(false);
      expect(h.decoder.getSessionId()).toBe(sessionBefore);
      expect(h.decoder.getStats().currentLine).toBe(lineBefore);
    });
  });

  describe('reset', () => {
    test('clears image and statistics while continuing to decode', () => {
      const h = makeHarness('ROBOT36', { ROBOT36: { r: 120, g: 60, b: 30 } });
      h.decoder.start();
      h.feedChunks(5);
      expect(h.decoder.getStats().currentLine).toBeGreaterThan(0);
      expect(nonBlackPixelCount(h.decoder.getImageData())).toBeGreaterThan(0);

      const sessionBefore = h.decoder.getSessionId();
      h.decoder.reset();

      // All black, counters cleared, still decoding, new session.
      expect(nonBlackPixelCount(h.decoder.getImageData())).toBe(0);
      const stats = h.decoder.getStats();
      expect(stats.currentLine).toBe(0);
      expect(stats.progress).toBe(0);
      expect(stats.state).toBe(DecoderState.DECODING_IMAGE);
      expect(stats.frequency).toBe(1900); // calibration cleared
      expect(stats.sessionId).toBeGreaterThan(sessionBefore);

      // Audio keeps being decoded after the reset.
      h.feedChunks(1); // anchor
      h.feedChunks(2); // two lines
      expect(h.decoder.getStats().currentLine).toBe(2);
      expect(nonBlackPixelCount(h.decoder.getImageData())).toBeGreaterThan(0);
    });

    test('clears image and statistics when stopped, without resuming', () => {
      const h = makeHarness('ROBOT36');
      h.decoder.start();
      h.feedChunks(4);
      h.decoder.stop();
      // Stop retains the decoded image for saving.
      expect(nonBlackPixelCount(h.decoder.getImageData())).toBeGreaterThan(0);

      h.decoder.reset();
      const stats = h.decoder.getStats();
      expect(stats.state).toBe(DecoderState.IDLE);
      expect(stats.currentLine).toBe(0);
      expect(nonBlackPixelCount(h.decoder.getImageData())).toBe(0);

      // Feeding audio while stopped must not decode.
      h.feedChunks(3);
      expect(h.decoder.getStats().currentLine).toBe(0);
    });
  });

  describe('stop / restart isolation', () => {
    test('restart does not reuse the previous sync anchor, calibration or line count', () => {
      const h = makeHarness('ROBOT36');
      h.decoder.start();
      h.feedChunks(6);

      const firstSession = h.decoder.getSessionId();
      const firstLine = h.decoder.getStats().currentLine;
      expect(firstLine).toBeGreaterThan(0);
      // The scripted detector supplied a non-zero calibration.
      expect(h.decoder.getStats().frequency).not.toBe(1900);
      expect(nonBlackPixelCount(h.decoder.getImageData())).toBeGreaterThan(0);

      h.decoder.stop();
      // Image survives a stop so it can be saved.
      expect(nonBlackPixelCount(h.decoder.getImageData())).toBeGreaterThan(0);
      expect(h.decoder.getStats().state).toBe(DecoderState.IDLE);

      h.decoder.start();

      // Fresh session: line count, calibration and image all reset.
      const restarted = h.decoder.getStats();
      expect(restarted.sessionId).toBeGreaterThan(firstSession);
      expect(restarted.currentLine).toBe(0);
      expect(restarted.frequency).toBe(1900);
      expect(nonBlackPixelCount(h.decoder.getImageData())).toBe(0);

      // The very next chunk re-anchors instead of decoding against the old
      // session's last sync position.
      h.feedChunks(1);
      expect(h.decoder.getStats().currentLine).toBe(0);
      h.feedChunks(1);
      expect(h.decoder.getStats().currentLine).toBe(1);
    });

    test('restart uses the currently selected mode', () => {
      const h = makeHarness('ROBOT36');
      h.decoder.start();
      h.feedChunks(3);
      h.decoder.stop();
      h.decoder.setMode('PD180');

      h.decoder.start();
      const stats = h.decoder.getStats();
      expect(stats.modeKey).toBe('PD180');
      expect(stats.totalLines).toBe(SSTV_MODES.PD180.height);
      expect(h.decoder.getDimensions()).toEqual({
        width: SSTV_MODES.PD180.width,
        height: SSTV_MODES.PD180.height,
      });
    });
  });

  describe('concurrent mode switch + reset', () => {
    test('switch then reset yields a single consistent session with no rollback', () => {
      const h = makeHarness('ROBOT36', {
        ROBOT36: { r: 200, g: 0, b: 0 },
        PD120: { r: 0, g: 0, b: 200 },
      });
      h.decoder.start();
      h.feedChunks(5);

      h.decoder.setMode('PD120');
      h.decoder.reset();

      const stats = h.decoder.getStats();
      expect(stats.modeKey).toBe('PD120');
      expect(stats.totalLines).toBe(SSTV_MODES.PD120.height);
      expect(stats.currentLine).toBe(0);
      expect(nonBlackPixelCount(h.decoder.getImageData())).toBe(0);

      h.feedChunks(1);
      h.feedChunks(2);
      const after = h.decoder.getStats();
      expect(after.modeKey).toBe('PD120');
      expect(after.currentLine).toBe(2);
      // Only the PD120 colour is present, and no old ROBOT36 red.
      expect(decodedRowsAre(h.decoder.getImageData(), SSTV_MODES.PD120.width, 2, 0, 0, 200)).toBe(true);
    });

    test('reset then switch yields a single consistent session', () => {
      const h = makeHarness('ROBOT36', {
        ROBOT36: { r: 200, g: 0, b: 0 },
        PD120: { r: 0, g: 0, b: 200 },
      });
      h.decoder.start();
      h.feedChunks(5);

      h.decoder.reset();
      h.decoder.setMode('PD120');

      const stats = h.decoder.getStats();
      expect(stats.modeKey).toBe('PD120');
      expect(stats.currentLine).toBe(0);
      expect(stats.state).toBe(DecoderState.DECODING_IMAGE);
      expect(nonBlackPixelCount(h.decoder.getImageData())).toBe(0);

      h.feedChunks(1);
      h.feedChunks(1);
      expect(h.decoder.getStats().currentLine).toBe(1);
      expect(decodedRowsAre(h.decoder.getImageData(), SSTV_MODES.PD120.width, 1, 0, 0, 200)).toBe(true);
    });

    test('line count is monotonic within a session', () => {
      const h = makeHarness('PD120');
      h.decoder.start();
      let previous = h.decoder.getStats().currentLine;
      for (let i = 0; i < 20; i++) {
        h.feedChunks(1);
        const current = h.decoder.getStats().currentLine;
        expect(current).toBeGreaterThanOrEqual(previous);
        previous = current;
      }
    });
  });

  test('start() always opens a new session', () => {
    const h = makeHarness('ROBOT36');
    const before = h.decoder.getSessionId();
    h.decoder.start();
    const after = h.decoder.getSessionId();
    expect(after).toBeGreaterThan(before);
  });
});

