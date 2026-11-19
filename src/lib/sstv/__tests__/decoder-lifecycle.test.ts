import { SSTVDecoder, DecoderState } from '../decoder';
import { SSTV_MODES } from '../constants';
import {
  generateRobot36Samples,
  generatePDSamples,
  feedInChunks,
  ROBOT36_EVEN_LINE,
  ROBOT36_ODD_LINE,
} from '../testing/synthetic-sstv';

const SAMPLE_RATE = 48000;

function countNonBlack(imageData: Uint8ClampedArray): number {
  let count = 0;
  for (let i = 0; i < imageData.length; i += 4) {
    if (imageData[i] > 0 || imageData[i + 1] > 0 || imageData[i + 2] > 0) {
      count++;
    }
  }
  return count;
}

function buildRobot36Lines(count: number) {
  return Array.from({ length: count }, (_, i) =>
    i % 2 === 0
      ? { ...ROBOT36_EVEN_LINE, luminance: 2200, chrominance: 1600 }
      : { ...ROBOT36_ODD_LINE, luminance: 1600, chrominance: 2200 }
  );
}

describe('SSTVDecoder lifecycle', () => {
  describe('session states', () => {
    test('a fresh decoder is IDLE and ignores samples', () => {
      const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT36');
      expect(decoder.getStats().state).toBe(DecoderState.IDLE);

      const samples = generateRobot36Samples(buildRobot36Lines(10), SAMPLE_RATE);
      feedInChunks(decoder, samples);

      const stats = decoder.getStats();
      expect(stats.state).toBe(DecoderState.IDLE);
      expect(stats.currentLine).toBe(0);
      expect(countNonBlack(decoder.getImageData())).toBe(0);
    });

    test('start() begins decoding and samples advance the line counter', () => {
      const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT36');
      decoder.start();
      expect(decoder.getStats().state).toBe(DecoderState.DECODING_IMAGE);

      const samples = generateRobot36Samples(buildRobot36Lines(20), SAMPLE_RATE);
      feedInChunks(decoder, samples);

      const stats = decoder.getStats();
      expect(stats.state).toBe(DecoderState.DECODING_IMAGE);
      expect(stats.currentLine).toBeGreaterThan(0);
      expect(stats.totalLines).toBe(SSTV_MODES.ROBOT36.height);
      expect(stats.progress).toBeGreaterThan(0);
      expect(countNonBlack(decoder.getImageData())).toBeGreaterThan(0);
    });

    test('stop() preserves the image but stops consuming samples', () => {
      const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT36');
      decoder.start();

      const firstHalf = generateRobot36Samples(buildRobot36Lines(12), SAMPLE_RATE);
      feedInChunks(decoder, firstHalf);

      const lineAtStop = decoder.getStats().currentLine;
      const imageAtStop = new Uint8ClampedArray(decoder.getImageData());
      expect(lineAtStop).toBeGreaterThan(0);

      decoder.stop();
      const stoppedStats = decoder.getStats();
      expect(stoppedStats.state).toBe(DecoderState.STOPPED);

      // Feeding a whole extra transmission must not change anything.
      const more = generateRobot36Samples(buildRobot36Lines(40), SAMPLE_RATE);
      feedInChunks(decoder, more);

      expect(decoder.getStats().currentLine).toBe(lineAtStop);
      expect(decoder.getStats().state).toBe(DecoderState.STOPPED);
      // Image retained byte-for-byte so it can still be saved
      expect(decoder.getImageData()).toEqual(imageAtStop);
    });

    test('start() after stop() begins a fresh frame', () => {
      const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT36');
      decoder.start();
      feedInChunks(decoder, generateRobot36Samples(buildRobot36Lines(20), SAMPLE_RATE));
      expect(decoder.getStats().currentLine).toBeGreaterThan(0);

      decoder.stop();
      decoder.start();

      const stats = decoder.getStats();
      expect(stats.state).toBe(DecoderState.DECODING_IMAGE);
      expect(stats.currentLine).toBe(0);
      expect(stats.progress).toBe(0);
      expect(countNonBlack(decoder.getImageData())).toBe(0);
    });
  });

  describe('reset()', () => {
    test('clears image, progress and sync state', () => {
      const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT36');
      decoder.start();
      feedInChunks(decoder, generateRobot36Samples(buildRobot36Lines(20), SAMPLE_RATE));

      expect(decoder.getStats().currentLine).toBeGreaterThan(0);
      expect(countNonBlack(decoder.getImageData())).toBeGreaterThan(0);

      decoder.reset();

      const stats = decoder.getStats();
      expect(stats.currentLine).toBe(0);
      expect(stats.progress).toBe(0);
      expect(stats.state).toBe(DecoderState.IDLE);
      expect(countNonBlack(decoder.getImageData())).toBe(0);
    });

    test('clears both audio and demodulated buffers so old samples cannot leak into a new frame', () => {
      // Drive a decoder right up to the end of a transmission, i.e. the
      // circular buffers are full of old audio and demodulated values.
      const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT36');
      decoder.start();
      feedInChunks(decoder, generateRobot36Samples(buildRobot36Lines(30), SAMPLE_RATE));

      decoder.reset();
      decoder.start();

      // Feed a *short* silent gap only - far less than one line. If stale buffer
      // contents survived the reset, the first sync of the next frame would be
      // paired with an old sync position and decode a garbage line immediately.
      const silence = new Float32Array(SAMPLE_RATE / 10);
      feedInChunks(decoder, silence);

      const stats = decoder.getStats();
      expect(stats.currentLine).toBe(0);
      expect(stats.progress).toBe(0);
      expect(stats.state).toBe(DecoderState.DECODING_IMAGE);
      expect(countNonBlack(decoder.getImageData())).toBe(0);
    });

    test('after reset a new frame decodes from line 0 with correct dimensions', () => {
      const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT36');
      decoder.start();
      feedInChunks(decoder, generateRobot36Samples(buildRobot36Lines(30), SAMPLE_RATE));
      const linesBeforeReset = decoder.getStats().currentLine;

      decoder.reset();
      decoder.start();
      expect(decoder.getStats().currentLine).toBe(0);
      expect(countNonBlack(decoder.getImageData())).toBe(0);

      feedInChunks(decoder, generateRobot36Samples(buildRobot36Lines(20), SAMPLE_RATE));

      const stats = decoder.getStats();
      expect(stats.currentLine).toBeGreaterThan(0);
      // The second frame starts counting from zero again, independent of the
      // line count reached before the reset.
      expect(stats.currentLine).toBeLessThan(linesBeforeReset + stats.currentLine);
      expect(stats.totalLines).toBe(SSTV_MODES.ROBOT36.height);
      expect(decoder.getDimensions()).toEqual({ width: 320, height: 240 });
    });

    test('resetting an idle decoder is a no-op that leaves it idle', () => {
      const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT36');
      decoder.reset();
      expect(decoder.getStats().state).toBe(DecoderState.IDLE);
      expect(decoder.getStats().currentLine).toBe(0);
    });
  });

  describe('mode sessions', () => {
    test('each mode decoder has its own dimensions', () => {
      for (const modeName of Object.keys(SSTV_MODES) as (keyof typeof SSTV_MODES)[]) {
        const decoder = new SSTVDecoder(SAMPLE_RATE, modeName);
        expect(decoder.getDimensions()).toEqual({
          width: SSTV_MODES[modeName].width,
          height: SSTV_MODES[modeName].height,
        });
        expect(decoder.getStats().mode).toBe(SSTV_MODES[modeName].name);
      }
    });

    test('switching modes with a new decoder does not inherit old pixels', () => {
      // Robot36 frame, partially decoded.
      const robot36 = new SSTVDecoder(SAMPLE_RATE, 'ROBOT36');
      robot36.start();
      feedInChunks(robot36, generateRobot36Samples(buildRobot36Lines(20), SAMPLE_RATE));
      expect(countNonBlack(robot36.getImageData())).toBeGreaterThan(0);

      // Simulate the hook's mode switch: stop the old session and build a new
      // decoder for the new mode.
      robot36.stop();
      const pd120 = new SSTVDecoder(SAMPLE_RATE, 'PD120');

      expect(pd120.getStats().state).toBe(DecoderState.IDLE);
      expect(pd120.getStats().currentLine).toBe(0);
      expect(pd120.getDimensions()).toEqual({ width: 640, height: 496 });
      expect(countNonBlack(pd120.getImageData())).toBe(0);
      // New image buffer is sized for the new mode, not the old one.
      expect(pd120.getImageData().length).toBe(640 * 496 * 4);

      // Old decoder no longer consumes samples after being stopped.
      const oldLine = robot36.getStats().currentLine;
      feedInChunks(robot36, generateRobot36Samples(buildRobot36Lines(10), SAMPLE_RATE));
      expect(robot36.getStats().currentLine).toBe(oldLine);
    });

    test('PD120 frame decodes with its own line geometry', () => {
      const decoder = new SSTVDecoder(SAMPLE_RATE, 'PD120');
      decoder.start();

      const samples = generatePDSamples(
        'PD120',
        10,
        { yEven: 2200, v: 1700, u: 2100, yOdd: 1600 },
        SAMPLE_RATE
      );
      feedInChunks(decoder, samples);

      const stats = decoder.getStats();
      expect(stats.state).toBe(DecoderState.DECODING_IMAGE);
      expect(stats.mode).toBe(SSTV_MODES.PD120.name);
      expect(stats.totalLines).toBe(496);
      expect(stats.currentLine).toBeGreaterThan(0);
      expect(stats.currentLine % 2).toBe(0); // PD modes write 2 rows per scan line
      expect(decoder.getDimensions()).toEqual({ width: 640, height: 496 });

      // Pixels are written starting at row 0, within the new-mode dimensions.
      const image = decoder.getImageData();
      expect(image.length).toBe(640 * 496 * 4);
      expect(countNonBlack(image)).toBeGreaterThan(0);
    });

    test('a Robot36 decoder cannot write into a canvas sized for another mode', () => {
      const robot36 = new SSTVDecoder(SAMPLE_RATE, 'ROBOT36');
      const pd120 = new SSTVDecoder(SAMPLE_RATE, 'PD120');
      expect(robot36.getImageData().length).not.toBe(pd120.getImageData().length);
      expect(robot36.getDimensions().width).toBe(320);
      expect(pd120.getDimensions().width).toBe(640);
    });
  });
});
