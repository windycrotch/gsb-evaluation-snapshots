import { SyncDetector, SyncPulseWidth, SyncPulseEvent } from '../sync-detector';
import {
  SYNC_FREQ,
  BLACK_FREQ,
  Tone,
  renderTones,
  leadIn,
  syncEndIndices,
} from '../test-support/synthetic-audio';

/** Run a buffer through a detector in fixed-size chunks, collecting events. */
function processInChunks(
  detector: SyncDetector,
  samples: Float32Array,
  chunkSize: number
): { chunkStart: number; event: SyncPulseEvent }[] {
  const events: { chunkStart: number; event: SyncPulseEvent }[] = [];
  for (let offset = 0; offset < samples.length; offset += chunkSize) {
    const chunk = samples.subarray(offset, Math.min(offset + chunkSize, samples.length));
    const demodulated = new Float32Array(chunk.length);
    const result = detector.process(chunk, demodulated);
    for (const event of result.detections) {
      events.push({ chunkStart: offset, event });
    }
  }
  return events;
}

describe('SyncDetector', () => {
  const sampleRate = 48000;

  describe('Initialization', () => {
    test('creates instance with valid sample rate', () => {
      const detector = new SyncDetector(sampleRate);
      expect(detector).toBeDefined();
      expect(detector).toBeInstanceOf(SyncDetector);
    });

    test('accepts different sample rates', () => {
      expect(() => new SyncDetector(44100)).not.toThrow();
      expect(() => new SyncDetector(48000)).not.toThrow();
    });
  });

  describe('Sync Pulse Processing', () => {
    test('processes samples without crashing', () => {
      const detector = new SyncDetector(sampleRate);
      const inputSamples = new Float32Array(1024);
      const demodulated = new Float32Array(1024);

      // Fill with some test data
      for (let i = 0; i < 1024; i++) {
        inputSamples[i] = Math.sin(i * 0.01);
        demodulated[i] = 0.0;
      }

      expect(() => {
        detector.process(inputSamples, demodulated);
      }).not.toThrow();
    });

    test('returns valid detection result', () => {
      const detector = new SyncDetector(sampleRate);
      const inputSamples = new Float32Array(1024);
      const demodulated = new Float32Array(1024);

      inputSamples.fill(0.5);

      const result = detector.process(inputSamples, demodulated);

      expect(result).toBeDefined();
      expect(result.detected).toBeDefined();
      expect(typeof result.detected).toBe('boolean');
      expect(result.width).toBeDefined();
      expect(result.offset).toBeDefined();
      expect(result.frequencyOffset).toBeDefined();
    });

    test('no sync detected in pure noise', () => {
      const detector = new SyncDetector(sampleRate);
      const inputSamples = new Float32Array(1024);
      const demodulated = new Float32Array(1024);

      // Random noise
      for (let i = 0; i < 1024; i++) {
        inputSamples[i] = (Math.random() - 0.5) * 2;
      }

      const result = detector.process(inputSamples, demodulated);

      // In pure noise, detection should typically be false or None
      expect(result.width === SyncPulseWidth.None || !result.detected).toBe(true);
    });

    test('handles empty input gracefully', () => {
      const detector = new SyncDetector(sampleRate);
      const inputSamples = new Float32Array(0);
      const demodulated = new Float32Array(0);

      expect(() => {
        detector.process(inputSamples, demodulated);
      }).not.toThrow();
    });

    test('handles large buffers', () => {
      const detector = new SyncDetector(sampleRate);
      const inputSamples = new Float32Array(10000);
      const demodulated = new Float32Array(10000);

      inputSamples.fill(0.3);

      expect(() => {
        detector.process(inputSamples, demodulated);
      }).not.toThrow();
    });
  });

  describe('Demodulated Buffer Output', () => {
    test('writes to demodulated buffer', () => {
      const detector = new SyncDetector(sampleRate);
      const inputSamples = new Float32Array(1024);
      const demodulated = new Float32Array(1024);

      inputSamples.fill(0.5);
      demodulated.fill(0); // Start with zeros

      detector.process(inputSamples, demodulated);

      // Check that some values were written
      let hasNonZero = false;
      for (let i = 0; i < demodulated.length; i++) {
        if (demodulated[i] !== 0) {
          hasNonZero = true;
          break;
        }
      }

      expect(hasNonZero).toBe(true);
    });

    test('demodulated values are finite', () => {
      const detector = new SyncDetector(sampleRate);
      const inputSamples = new Float32Array(1024);
      const demodulated = new Float32Array(1024);

      for (let i = 0; i < 1024; i++) {
        inputSamples[i] = Math.sin(i * 0.1);
      }

      detector.process(inputSamples, demodulated);

      // All values should be finite
      for (let i = 0; i < demodulated.length; i++) {
        expect(isFinite(demodulated[i])).toBe(true);
      }
    });
  });

  describe('Multiple Sample Rates', () => {
    test('works with 44.1kHz sample rate', () => {
      const detector = new SyncDetector(44100);
      const inputSamples = new Float32Array(1024);
      const demodulated = new Float32Array(1024);

      inputSamples.fill(0.5);

      expect(() => {
        detector.process(inputSamples, demodulated);
      }).not.toThrow();
    });

    test('processes correctly at different rates', () => {
      const detector48k = new SyncDetector(48000);
      const detector44k = new SyncDetector(44100);

      const input48k = new Float32Array(1024);
      const demod48k = new Float32Array(1024);
      const input44k = new Float32Array(1024);
      const demod44k = new Float32Array(1024);

      input48k.fill(0.5);
      input44k.fill(0.5);

      const result48k = detector48k.process(input48k, demod48k);
      const result44k = detector44k.process(input44k, demod44k);

      // Both should produce valid results
      expect(result48k).toBeDefined();
      expect(result44k).toBeDefined();
    });
  });

  describe('Edge Cases', () => {
    test('handles all zero input', () => {
      const detector = new SyncDetector(sampleRate);
      const inputSamples = new Float32Array(1024);
      const demodulated = new Float32Array(1024);

      inputSamples.fill(0);

      expect(() => {
        detector.process(inputSamples, demodulated);
      }).not.toThrow();
    });

    test('handles extreme positive values', () => {
      const detector = new SyncDetector(sampleRate);
      const inputSamples = new Float32Array(1024);
      const demodulated = new Float32Array(1024);

      inputSamples.fill(100);

      const result = detector.process(inputSamples, demodulated);

      expect(result).toBeDefined();
      expect(isFinite(result.frequencyOffset)).toBe(true);
    });

    test('handles extreme negative values', () => {
      const detector = new SyncDetector(sampleRate);
      const inputSamples = new Float32Array(1024);
      const demodulated = new Float32Array(1024);

      inputSamples.fill(-100);

      const result = detector.process(inputSamples, demodulated);

      expect(result).toBeDefined();
      expect(isFinite(result.frequencyOffset)).toBe(true);
    });
  });

  describe('Consecutive Processing', () => {
    test('processes multiple buffers in sequence', () => {
      const detector = new SyncDetector(sampleRate);

      for (let iteration = 0; iteration < 10; iteration++) {
        const inputSamples = new Float32Array(1024);
        const demodulated = new Float32Array(1024);

        inputSamples.fill(Math.sin(iteration));

        expect(() => {
          detector.process(inputSamples, demodulated);
        }).not.toThrow();
      }
    });

    test('maintains state across buffers', () => {
      const detector = new SyncDetector(sampleRate);
      const input1 = new Float32Array(512);
      const demod1 = new Float32Array(512);
      const input2 = new Float32Array(512);
      const demod2 = new Float32Array(512);

      input1.fill(0.5);
      input2.fill(0.6);

      const result1 = detector.process(input1, demod1);
      const result2 = detector.process(input2, demod2);

      // Both should produce valid results
      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
    });
  });

  describe('SyncPulseWidth Enum', () => {
    test('enum values are defined', () => {
      expect(SyncPulseWidth.FiveMilliSeconds).toBeDefined();
      expect(SyncPulseWidth.NineMilliSeconds).toBeDefined();
      expect(SyncPulseWidth.TwentyMilliSeconds).toBeDefined();
      expect(SyncPulseWidth.None).toBeDefined();
    });

    test('enum values are distinct', () => {
      const values = new Set([
        SyncPulseWidth.FiveMilliSeconds,
        SyncPulseWidth.NineMilliSeconds,
        SyncPulseWidth.TwentyMilliSeconds,
        SyncPulseWidth.None,
      ]);

      expect(values.size).toBe(4);
    });
  });

  describe('Pulse width across process() calls', () => {
    /** 9ms and 20ms pulses separated by black level, with a lead-in. */
    const pulses: Tone[] = [
      leadIn(100),
      { freq: SYNC_FREQ, ms: 9 },
      { freq: BLACK_FREQ, ms: 100 },
      { freq: SYNC_FREQ, ms: 20 },
      { freq: BLACK_FREQ, ms: 100 },
    ];

    test('measures an unsplit 9ms pulse as NineMilliSeconds', () => {
      const detector = new SyncDetector(sampleRate);
      const audio = renderTones(pulses, sampleRate);

      const events = processInChunks(detector, audio, audio.length);

      expect(events.map(e => e.event.width)).toEqual([
        SyncPulseWidth.NineMilliSeconds,
        SyncPulseWidth.TwentyMilliSeconds,
      ]);
    });

    test('recognises a 9ms pulse split across two process() calls', () => {
      const audio = renderTones(pulses, sampleRate);
      const truth = syncEndIndices(pulses, sampleRate);
      // Place the chunk boundary inside the first pulse so the pulse straddles
      // the two calls. The detector never sees a whole pulse in either call.
      const chunkSize = truth[0] - Math.round(0.003 * sampleRate);

      const events = processInChunks(new SyncDetector(sampleRate), audio, chunkSize);

      expect(events.length).toBe(2);
      expect(events[0].event.width).toBe(SyncPulseWidth.NineMilliSeconds);
    });

    test('recognises a 20ms pulse split across two process() calls', () => {
      const audio = renderTones(pulses, sampleRate);
      const truth = syncEndIndices(pulses, sampleRate);
      const chunkSize = truth[1] - Math.round(0.005 * sampleRate);

      const events = processInChunks(new SyncDetector(sampleRate), audio, chunkSize);

      expect(events.map(e => e.event.width)).toContain(SyncPulseWidth.TwentyMilliSeconds);
    });

    test('reports every pulse that ends inside a single large call', () => {
      const audio = renderTones(pulses, sampleRate);

      // One call containing both pulses: the result must not collapse to the
      // last pulse only.
      const events = processInChunks(new SyncDetector(sampleRate), audio, audio.length);

      expect(events.map(e => e.event.width)).toEqual([
        SyncPulseWidth.NineMilliSeconds,
        SyncPulseWidth.TwentyMilliSeconds,
      ]);
      // Ordered by position within the chunk.
      expect(events[0].event.offset).toBeLessThan(events[1].event.offset);
    });

    test('keeps the single-result fields consistent with the detection list', () => {
      const audio = renderTones(pulses, sampleRate);
      const detector = new SyncDetector(sampleRate);

      const result = detector.process(audio, new Float32Array(audio.length));

      expect(result.detections.length).toBe(2);
      const last = result.detections[result.detections.length - 1];
      expect(result.detected).toBe(true);
      expect(result.width).toBe(last.width);
      expect(result.offset).toBe(last.offset);
      expect(result.frequencyOffset).toBe(last.frequencyOffset);
    });

    test.each([32, 100, 251, 512, 1024, 4096])(
      'reports every pulse at chunk size %i, independent of chunking',
      chunkSize => {
        const audio = renderTones(pulses, sampleRate);

        const events = processInChunks(new SyncDetector(sampleRate), audio, chunkSize);

        expect(events.map(e => e.event.width)).toEqual([
          SyncPulseWidth.NineMilliSeconds,
          SyncPulseWidth.TwentyMilliSeconds,
        ]);
      }
    );

    test('reports pulse width as 5ms for a VIS-style short pulse', () => {
      const audio = renderTones(
        [leadIn(100), { freq: SYNC_FREQ, ms: 5 }, { freq: BLACK_FREQ, ms: 100 }],
        sampleRate
      );

      const events = processInChunks(new SyncDetector(sampleRate), audio, 512);

      expect(events.length).toBe(1);
      expect(events[0].event.width).toBe(SyncPulseWidth.FiveMilliSeconds);
    });
  });

  describe('Pulse-end offset contract', () => {
    const tones: Tone[] = [
      leadIn(100),
      { freq: SYNC_FREQ, ms: 9 },
      { freq: BLACK_FREQ, ms: 150 },
      { freq: SYNC_FREQ, ms: 9 },
      { freq: BLACK_FREQ, ms: 150 },
    ];

    test.each([64, 100, 512, 1024, 4096, 24000])(
      'offset addresses a sample inside the current chunk at chunk size %i',
      chunkSize => {
        const audio = renderTones(tones, sampleRate);

        const events = processInChunks(new SyncDetector(sampleRate), audio, chunkSize);

        expect(events.length).toBe(2);
        for (const { event } of events) {
          expect(Number.isInteger(event.offset)).toBe(true);
          expect(event.offset).toBeGreaterThanOrEqual(0);
          expect(event.offset).toBeLessThan(chunkSize);
        }
      }
    );

    test.each([64, 256, 1024, 4096])(
      'chunkStart + offset lands within a few ms of the true pulse end (chunk %i)',
      chunkSize => {
        const audio = renderTones(tones, sampleRate);
        const truth = syncEndIndices(tones, sampleRate);

        const events = processInChunks(new SyncDetector(sampleRate), audio, chunkSize);

        expect(events.length).toBe(2);
        events.forEach(({ chunkStart, event }, index) => {
          const absolute = chunkStart + event.offset;
          // The detector's smoothing chain delays the observed edge; tolerate
          // that fixed lag but nothing larger.
          expect(Math.abs(absolute - truth[index])).toBeLessThan(
            Math.round(0.006 * sampleRate)
          );
        });
      }
    );
  });

  describe('Reset clears cross-buffer state', () => {
    test('drops the in-progress pulse counter on reset', () => {
      const detector = new SyncDetector(sampleRate);
      const preSync = renderTones([leadIn(100), { freq: SYNC_FREQ, ms: 6 }], sampleRate);
      const restOfPulse = renderTones(
        [{ freq: SYNC_FREQ, ms: 3 }, { freq: BLACK_FREQ, ms: 100 }],
        sampleRate
      );

      // Six of the nine sync milliseconds go through first; without a reset the
      // remaining three would complete a valid 9ms pulse.
      const demodulated = new Float32Array(preSync.length);
      detector.process(preSync, demodulated);

      detector.reset();

      const restDemodulated = new Float32Array(restOfPulse.length);
      const afterReset = detector.process(restOfPulse, restDemodulated);

      // A full 9ms/20ms pulse must not be reported. (Filter transients right
      // after a reset can register as a short 5ms pulse, which is not a line
      // sync and is ignored by the decoder.)
      expect(
        afterReset.detections.some(
          d => d.width === SyncPulseWidth.NineMilliSeconds ||
               d.width === SyncPulseWidth.TwentyMilliSeconds
        )
      ).toBe(false);
    });

    test('detects reliably again after reset, including split pulses', () => {
      const detector = new SyncDetector(sampleRate);
      const tones: Tone[] = [
        leadIn(100),
        { freq: SYNC_FREQ, ms: 9 },
        { freq: BLACK_FREQ, ms: 100 },
      ];
      const audio = renderTones(tones, sampleRate);

      // Warm the detector up, then reset so all filters start clean.
      const warmupDemod = new Float32Array(1024);
      detector.process(audio.subarray(0, 1024), warmupDemod);
      detector.reset();

      const truth = syncEndIndices(tones, sampleRate);
      const chunkSize = truth[0] - Math.round(0.004 * sampleRate);
      const events = processInChunks(detector, audio, chunkSize);

      expect(events.map(e => e.event.width)).toEqual([SyncPulseWidth.NineMilliSeconds]);
    });

    test('reset() during a pulse does not leak the partial width into the next pulse', () => {
      const detector = new SyncDetector(sampleRate);
      const firstHalf = renderTones(
        [leadIn(50), { freq: SYNC_FREQ, ms: 7 }],
        sampleRate
      );
      detector.process(firstHalf, new Float32Array(firstHalf.length));

      detector.reset();

      const fresh = new SyncDetector(sampleRate);
      const probe = renderTones(
        [leadIn(50), { freq: SYNC_FREQ, ms: 14 }],
        sampleRate
      );
      const events = processInChunks(detector, probe, 512);
      const referenceEvents = processInChunks(fresh, probe, 512);

      expect(events.map(e => e.event.width)).toEqual(
        referenceEvents.map(e => e.event.width)
      );
    });
  });
});
