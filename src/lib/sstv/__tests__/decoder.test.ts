import { SSTVDecoder } from '../decoder';
import { SSTV_MODES, lineTimingToleranceMs } from '../constants';
import {
  Tone,
  concatTones,
  leadIn,
  renderTones,
  robot36Line,
  robot72Line,
  pd120Line,
  pd160Line,
  pd180Line,
  scottieS1Line,
  scottieS2Line,
  chunkBuffer,
  BLACK_FREQ,
  WHITE_FREQ,
  SYNC_FREQ,
} from '../test-support/synthetic-audio';

const SAMPLE_RATE = 48000;

/** Feed a whole buffer to a started decoder in fixed-size chunks. */
function feed(decoder: SSTVDecoder, audio: Float32Array, chunkSize: number): void {
  for (const chunk of chunkBuffer(audio, chunkSize)) {
    decoder.processSamples(chunk);
  }
}

describe('SSTVDecoder sync-to-sync line gating', () => {
  describe('Normal path: consecutive syncs near scanTime decode a line', () => {
    test('Robot72 decodes one row and advances currentLine', () => {
      const audio = renderTones(
        concatTones([leadIn(100)], robot72Line(), robot72Line(), [{ freq: BLACK_FREQ, ms: 100 }]),
        SAMPLE_RATE
      );

      const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT72');
      decoder.start();
      feed(decoder, audio, 4096);

      // Two 300ms lines -> the interval between their sync pulses is one line.
      expect(decoder.getStats().currentLine).toBe(1);
    });

    test('PD120 decodes one scan line as two pixel rows', () => {
      const audio = renderTones(
        concatTones([leadIn(100)], pd120Line(), pd120Line(), [{ freq: BLACK_FREQ, ms: 100 }]),
        SAMPLE_RATE
      );

      const decoder = new SSTVDecoder(SAMPLE_RATE, 'PD120');
      decoder.start();
      feed(decoder, audio, 4096);

      expect(decoder.getStats().currentLine).toBe(2);
    });

    test('Robot36 decodes a complete even/odd line pair', () => {
      const audio = renderTones(
        concatTones(
          [leadIn(100)],
          robot36Line(BLACK_FREQ, WHITE_FREQ), // even
          robot36Line(WHITE_FREQ, BLACK_FREQ), // odd
          robot36Line(BLACK_FREQ, WHITE_FREQ), // even
          [{ freq: BLACK_FREQ, ms: 100 }]
        ),
        SAMPLE_RATE
      );

      const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT36');
      decoder.start();
      feed(decoder, audio, 4096);

      // The odd line emits both rows of the interlaced pair.
      expect(decoder.getStats().currentLine).toBe(2);
    });

    test.each([777, 1024, 2048, 4096, 20000])(
      'line count is independent of chunk size (%i)',
      chunkSize => {
        const audio = renderTones(
          concatTones([leadIn(100)], robot72Line(), robot72Line(), robot72Line(), [
            { freq: BLACK_FREQ, ms: 100 },
          ]),
          SAMPLE_RATE
        );

        const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT72');
        decoder.start();
        feed(decoder, audio, chunkSize);

        expect(decoder.getStats().currentLine).toBe(2);
      }
    );

    test('tolerates realistic inter-sync jitter without dropping lines', () => {
      const scanTime = SSTV_MODES.ROBOT72.scanTime;
      const tolerance = lineTimingToleranceMs(scanTime);
      // ±5% of scanTime (15ms) must stay inside the tolerance band.
      const jitterMs = scanTime * 0.05;
      expect(jitterMs).toBeLessThan(tolerance);

      // Grow/shrink the inter-line gap. Growth is always decodable; shrink is
      // kept small enough that the line still contains its full payload.
      const withTail = (deltaMs: number): Tone[] => {
        const line = robot72Line();
        return line.map((tone, index) =>
          index === line.length - 1 ? { ...tone, ms: tone.ms + deltaMs } : tone
        );
      };

      const audio = renderTones(
        concatTones(
          [leadIn(100)],
          withTail(jitterMs),
          withTail(jitterMs),
          withTail(-4),
          withTail(-4),
          [{ freq: BLACK_FREQ, ms: 150 }]
        ),
        SAMPLE_RATE
      );

      const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT72');
      decoder.start();
      feed(decoder, audio, 2048);

      // Four syncs -> three intervals, all within tolerance -> three rows.
      const stats = decoder.getStats();
      expect(stats.currentLine).toBe(3);
      expect(stats.linesDropped).toBe(0);
    });

    test.each([
      { mode: 'PD160' as const, line: pd160Line, rowsPerLine: 2 },
      { mode: 'PD180' as const, line: pd180Line, rowsPerLine: 2 },
      { mode: 'SCOTTIE_S1' as const, line: scottieS1Line, rowsPerLine: 1 },
      { mode: 'SCOTTIE_S2' as const, line: scottieS2Line, rowsPerLine: 1 },
    ])(
      '$mode decodes one line with the mode-specific scanTime',
      ({ mode, line, rowsPerLine }) => {
        const audio = renderTones(
          concatTones([leadIn(100)], line(), line(), [{ freq: BLACK_FREQ, ms: 200 }]),
          SAMPLE_RATE
        );

        const decoder = new SSTVDecoder(SAMPLE_RATE, mode);
        decoder.start();
        feed(decoder, audio, 4096);

        const stats = decoder.getStats();
        expect(stats.currentLine).toBe(rowsPerLine);
        expect(stats.linesDropped).toBe(0);
      }
    );
  });

  describe('Boundary path: a pulse straddling processSamples() calls is still detected', () => {
    test('detects both pulses when the boundary lands mid-pulse', () => {
      // Second pulse starts at 100ms lead-in + 300ms line -> its 9ms body
      // begins at 400ms. Use a chunk size that puts the boundary 4ms into it.
      const chunkSize = Math.round(0.404 * SAMPLE_RATE);
      const audio = renderTones(
        concatTones([leadIn(100)], robot72Line(), robot72Line(), [
          { freq: BLACK_FREQ, ms: 100 },
        ]),
        SAMPLE_RATE
      );

      const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT72');
      decoder.start();
      feed(decoder, audio, chunkSize);

      // If the split pulse were missed, the distance between the remaining
      // anchors would be 600ms (2x scanTime) and the line would be dropped.
      expect(decoder.getStats().currentLine).toBe(1);
    });

    test('a 20ms PD120 pulse split across two chunks still decodes', () => {
      const chunkSize = Math.round(0.524 * SAMPLE_RATE); // 4ms into the 2nd sync (20ms)
      const audio = renderTones(
        concatTones([leadIn(120)], pd120Line(), pd120Line(), [
          { freq: BLACK_FREQ, ms: 120 },
        ]),
        SAMPLE_RATE
      );

      const decoder = new SSTVDecoder(SAMPLE_RATE, 'PD120');
      decoder.start();
      feed(decoder, audio, chunkSize);

      expect(decoder.getStats().currentLine).toBe(2);
    });
  });

  describe('Negative path: out-of-tolerance spacing drops the line', () => {
    function lineWithTail(tailMs: number): Tone[] {
      const line = robot72Line();
      // The final U channel carries the inter-line gap, so extend/shrink it.
      return line.map((tone, index) =>
        index === line.length - 1 ? { ...tone, ms: tone.ms + tailMs } : tone
      );
    }

    test('drops a line that is far too long and keeps currentLine unchanged', () => {
      const tolerance = lineTimingToleranceMs(SSTV_MODES.ROBOT72.scanTime);
      // One missing sync doubles the observed interval to ~600ms.
      const audio = renderTones(
        concatTones(
          [leadIn(100)],
          lineWithTail(tolerance + 50),
          robot72Line(),
          [{ freq: BLACK_FREQ, ms: 100 }]
        ),
        SAMPLE_RATE
      );

      const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT72');
      decoder.start();
      feed(decoder, audio, 4096);

      const stats = decoder.getStats();
      expect(stats.currentLine).toBe(0);
      expect(stats.linesDropped).toBe(1);
    });

    test('drops a line that is far too short and keeps currentLine unchanged', () => {
      // A spurious sync 150ms after the real one. 150ms is a valid *Robot36*
      // line, but half of Robot72's 300ms scanTime, so it must be rejected.
      const audio = renderTones(
        [
          leadIn(100),
          { freq: SYNC_FREQ, ms: 9 },
          { freq: BLACK_FREQ, ms: 141 },
          { freq: SYNC_FREQ, ms: 9 },
          { freq: BLACK_FREQ, ms: 141 },
          { freq: SYNC_FREQ, ms: 9 },
          { freq: BLACK_FREQ, ms: 200 },
        ],
        SAMPLE_RATE
      );

      const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT72');
      decoder.start();
      feed(decoder, audio, 4096);

      const stats = decoder.getStats();
      expect(stats.currentLine).toBe(0);
      expect(stats.linesDropped).toBe(2);
    });

    test('re-anchors after a dropped line so the following interval decodes', () => {
      const tolerance = lineTimingToleranceMs(SSTV_MODES.ROBOT72.scanTime);
      const audio = renderTones(
        concatTones(
          [leadIn(100)],
          lineWithTail(tolerance + 50), // bad interval -> dropped
          robot72Line(),                // good interval -> decoded
          robot72Line(),                // good interval -> decoded
          robot72Line(),                // good interval -> decoded
          robot72Line(),                // good interval -> decoded
          [{ freq: BLACK_FREQ, ms: 100 }]
        ),
        SAMPLE_RATE
      );

      const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT72');
      decoder.start();
      feed(decoder, audio, 4096);

      // Of the four intervals, the first is rejected and the remaining three
      // decode because the dropped pulse re-establishes the baseline.
      const stats = decoder.getStats();
      expect(stats.currentLine).toBe(3);
      expect(stats.linesDropped).toBe(1);
    });

    test('PD120 rejects a Robot72-length interval (wrong mode / missed sync)', () => {
      const audio = renderTones(
        concatTones([leadIn(100)], robot72Line(), robot72Line(), [
          { freq: BLACK_FREQ, ms: 100 },
        ]),
        SAMPLE_RATE
      );

      const decoder = new SSTVDecoder(SAMPLE_RATE, 'PD120');
      decoder.start();
      feed(decoder, audio, 4096);

      const stats = decoder.getStats();
      expect(stats.currentLine).toBe(0);
      expect(stats.linesDropped).toBe(1);
    });

    test('tolerance scales with the mode scanTime', () => {
      // PD120's tolerance must be far wider than Robot36's absolute margin,
      // while still rejecting a doubled interval.
      const robot36 = lineTimingToleranceMs(SSTV_MODES.ROBOT36.scanTime);
      const pd120 = lineTimingToleranceMs(SSTV_MODES.PD120.scanTime);

      expect(pd120).toBeGreaterThan(robot36);
      expect(pd120).toBeLessThan(SSTV_MODES.PD120.scanTime);
    });

    test('a custom tolerance can be tightened to reject a line the default accepts', () => {
      // 8% short of scanTime: inside the default 10% band, outside a 5% band.
      // Only the trailing gap is shortened so the payload still fits.
      const offsetMs = SSTV_MODES.ROBOT72.scanTime * 0.08;
      const audio = renderTones(
        concatTones(
          [leadIn(100)],
          (() => {
            const line = robot72Line();
            return line.map((tone, index) =>
              index === line.length - 1 ? { ...tone, ms: tone.ms - offsetMs } : tone
            );
          })(),
          robot72Line(),
          [{ freq: BLACK_FREQ, ms: 100 }]
        ),
        SAMPLE_RATE
      );

      const lenient = new SSTVDecoder(SAMPLE_RATE, 'ROBOT72');
      lenient.start();
      feed(lenient, audio, 4096);

      const strict = new SSTVDecoder(SAMPLE_RATE, 'ROBOT72', { relative: 0.05, marginMs: 0 });
      strict.start();
      feed(strict, audio, 4096);

      // Default tolerance accepts the interval; the tightened one rejects it.
      expect(lenient.getStats().linesDropped).toBe(0);
      expect(strict.getStats().linesDropped).toBe(1);
    });
  });

  describe('Reset clears cross-buffer state', () => {
    test('clears the last sync anchor so stale spacing cannot decode after reset', () => {
      const audio = renderTones(
        concatTones([leadIn(100)], robot72Line(), robot72Line(), [
          { freq: BLACK_FREQ, ms: 100 },
        ]),
        SAMPLE_RATE
      );

      const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT72');
      decoder.start();
      // Feed only up to the second sync so exactly one anchor is stored.
      feed(decoder, audio.subarray(0, Math.round(0.41 * SAMPLE_RATE)), 4096);

      decoder.reset();
      decoder.start();
      expect(decoder.getStats().currentLine).toBe(0);

      // Feed the tail. The pre-reset anchor must be gone; the first pulse seen
      // after reset can only establish a new baseline, never complete a line.
      decoder.processSamples(audio.subarray(Math.round(0.41 * SAMPLE_RATE)));

      expect(decoder.getStats().currentLine).toBe(0);
    });

    test('clears the sync detector and decodes normally from a clean state', () => {
      const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT72');
      decoder.start();

      // Garbage input while started, then reset.
      const noise = new Float32Array(SAMPLE_RATE);
      for (let i = 0; i < noise.length; i++) {
        noise[i] = (Math.sin(i * 0.37) + Math.sin(i * 1.11)) * 0.3;
      }
      feed(decoder, noise, 4096);

      decoder.reset();
      decoder.start();
      expect(decoder.getStats().currentLine).toBe(0);

      const clean = renderTones(
        concatTones([leadIn(100)], robot72Line(), robot72Line(), [
          { freq: BLACK_FREQ, ms: 100 },
        ]),
        SAMPLE_RATE
      );
      feed(decoder, clean, 4096);

      expect(decoder.getStats().currentLine).toBe(1);
    });

    test('a pulse split across a reset boundary is not completed', () => {
      const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT72');
      decoder.start();

      // 6 of the 9 sync milliseconds before the reset...
      const head = renderTones(
        [leadIn(100), { freq: SYNC_FREQ, ms: 6 }],
        SAMPLE_RATE
      );
      feed(decoder, head, 4096);

      decoder.reset();
      decoder.start();

      // ...and the remaining 3ms plus a full line afterwards. If the partial
      // counter leaked, this would look like a complete pulse followed by a
      // short interval and no line would decode.
      const tail = renderTones(
        concatTones(
          [{ freq: SYNC_FREQ, ms: 3 }, { freq: BLACK_FREQ, ms: 100 }],
          robot72Line(),
          robot72Line(),
          [{ freq: BLACK_FREQ, ms: 100 }]
        ),
        SAMPLE_RATE
      );
      feed(decoder, tail, 4096);

      // The first sync of the tail arrives after 100ms of black, so it cannot
      // form a line with anything before it; the two full lines decode from
      // the subsequent intervals.
      expect(decoder.getStats().currentLine).toBe(1);
    });
  });
});
