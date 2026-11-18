import {
  SSTV_MODES,
  lineTimingToleranceMs,
  isLineSpacingWithinTolerance,
  DEFAULT_LINE_TIMING_RELATIVE_TOLERANCE,
  DEFAULT_LINE_TIMING_MARGIN_MS,
} from '../constants';

describe('SSTV Mode Constants', () => {
  describe('Robot36 Mode', () => {
    test('has correct basic specifications', () => {
      expect(SSTV_MODES.ROBOT36.name).toBe('Robot 36');
      expect(SSTV_MODES.ROBOT36.width).toBe(320);
      expect(SSTV_MODES.ROBOT36.height).toBe(240);
      expect(SSTV_MODES.ROBOT36.visCode).toBe(8);
    });

    test('has correct timing specifications', () => {
      expect(SSTV_MODES.ROBOT36.scanTime).toBe(150);
      expect(SSTV_MODES.ROBOT36.syncPulse).toBe(9);
      expect(SSTV_MODES.ROBOT36.syncPorch).toBe(3);
      expect(SSTV_MODES.ROBOT36.separatorPulse).toBe(4.5);
    });

    test('has correct color specifications', () => {
      expect(SSTV_MODES.ROBOT36.colorScanTime).toBe(88);
      expect(SSTV_MODES.ROBOT36.colorScanTimes).toEqual([88, 44]);
      expect(SSTV_MODES.ROBOT36.separatorPulses).toEqual([4.5]);
    });
  });

  describe('PD120 Mode', () => {
    test('has correct basic specifications', () => {
      expect(SSTV_MODES.PD120.name).toBe('PD 120');
      expect(SSTV_MODES.PD120.width).toBe(640);
      expect(SSTV_MODES.PD120.height).toBe(496);
      expect(SSTV_MODES.PD120.visCode).toBe(95);
    });

    test('has correct timing specifications', () => {
      expect(SSTV_MODES.PD120.scanTime).toBeCloseTo(496.628, 2);
      expect(SSTV_MODES.PD120.syncPulse).toBe(20);
      expect(SSTV_MODES.PD120.syncPorch).toBe(2.08);
    });

    test('has correct channel timing', () => {
      expect(SSTV_MODES.PD120.colorScanTime).toBe(121.6);
      expect(SSTV_MODES.PD120.colorScanTimes).toEqual([121.6, 121.6, 121.6]);
    });

    test('pixel dwell time is approximately 190µs', () => {
      const pixelTime = SSTV_MODES.PD120.colorScanTime / SSTV_MODES.PD120.width;
      expect(pixelTime).toBeCloseTo(0.190, 3); // 121.6ms / 640 = 0.190ms = 190µs
    });
  });

  describe('PD160 Mode', () => {
    test('has correct basic specifications', () => {
      expect(SSTV_MODES.PD160.name).toBe('PD 160');
      expect(SSTV_MODES.PD160.width).toBe(512);
      expect(SSTV_MODES.PD160.height).toBe(400);
      expect(SSTV_MODES.PD160.visCode).toBe(98);
    });

    test('has correct timing specifications', () => {
      expect(SSTV_MODES.PD160.scanTime).toBeCloseTo(804.416, 2);
      expect(SSTV_MODES.PD160.syncPulse).toBe(20);
      expect(SSTV_MODES.PD160.syncPorch).toBe(2.08);
    });

    test('has correct channel timing', () => {
      expect(SSTV_MODES.PD160.colorScanTime).toBeCloseTo(195.584, 2);
      expect(SSTV_MODES.PD160.colorScanTimes).toHaveLength(4);
      expect(SSTV_MODES.PD160.colorScanTimes?.[0]).toBeCloseTo(195.584, 2);
    });

    test('pixel dwell time is approximately 382µs', () => {
      const pixelTime = SSTV_MODES.PD160.colorScanTime / SSTV_MODES.PD160.width;
      expect(pixelTime).toBeCloseTo(0.382, 3); // 195.584ms / 512 = 0.382ms = 382µs
    });
  });

  describe('PD180 Mode', () => {
    test('has correct basic specifications', () => {
      expect(SSTV_MODES.PD180.name).toBe('PD 180');
      expect(SSTV_MODES.PD180.width).toBe(640);
      expect(SSTV_MODES.PD180.height).toBe(496);
      expect(SSTV_MODES.PD180.visCode).toBe(96);
    });

    test('has correct timing specifications', () => {
      expect(SSTV_MODES.PD180.scanTime).toBe(751.68);
      expect(SSTV_MODES.PD180.syncPulse).toBe(20);
      expect(SSTV_MODES.PD180.syncPorch).toBe(2.08);
    });

    test('has correct channel timing', () => {
      expect(SSTV_MODES.PD180.colorScanTime).toBe(182.4);
      expect(SSTV_MODES.PD180.colorScanTimes).toEqual([182.4, 182.4, 182.4, 182.4]);
    });

    test('pixel dwell time is approximately 286µs', () => {
      const pixelTime = SSTV_MODES.PD180.colorScanTime / SSTV_MODES.PD180.width;
      expect(pixelTime).toBeCloseTo(0.285, 3); // 182.4ms / 640 = 0.285ms = 285µs
    });

    test('has 50% longer pixel time than PD120', () => {
      const pd120PixelTime = SSTV_MODES.PD120.colorScanTime / SSTV_MODES.PD120.width;
      const pd180PixelTime = SSTV_MODES.PD180.colorScanTime / SSTV_MODES.PD180.width;
      const ratio = pd180PixelTime / pd120PixelTime;
      expect(ratio).toBeCloseTo(1.5, 2); // 50% longer
    });
  });

  describe('Frequency Constants', () => {
    test('sync frequency is 1200 Hz', () => {
      const { FREQ_SYNC } = require('../constants');
      expect(FREQ_SYNC).toBe(1200);
    });

    test('black level is 1500 Hz', () => {
      const { FREQ_BLACK } = require('../constants');
      expect(FREQ_BLACK).toBe(1500);
    });

    test('white level is 2300 Hz', () => {
      const { FREQ_WHITE } = require('../constants');
      expect(FREQ_WHITE).toBe(2300);
    });
  });

  describe('Mode Comparison', () => {
    test('PD modes have longer sync pulses than Robot36', () => {
      expect(SSTV_MODES.PD120.syncPulse).toBeGreaterThan(SSTV_MODES.ROBOT36.syncPulse);
      expect(SSTV_MODES.PD160.syncPulse).toBeGreaterThan(SSTV_MODES.ROBOT36.syncPulse);
      expect(SSTV_MODES.PD180.syncPulse).toBeGreaterThan(SSTV_MODES.ROBOT36.syncPulse);
      expect(SSTV_MODES.PD120.syncPulse).toBe(SSTV_MODES.PD180.syncPulse);
      expect(SSTV_MODES.PD160.syncPulse).toBe(SSTV_MODES.PD180.syncPulse);
    });

    test('PD modes have higher resolution than Robot36', () => {
      const robot36Pixels = SSTV_MODES.ROBOT36.width * SSTV_MODES.ROBOT36.height;
      const pd120Pixels = SSTV_MODES.PD120.width * SSTV_MODES.PD120.height;
      const pd160Pixels = SSTV_MODES.PD160.width * SSTV_MODES.PD160.height;
      const pd180Pixels = SSTV_MODES.PD180.width * SSTV_MODES.PD180.height;

      expect(pd120Pixels).toBeGreaterThan(robot36Pixels);
      expect(pd160Pixels).toBeGreaterThan(robot36Pixels);
      expect(pd180Pixels).toBeGreaterThan(robot36Pixels);
      expect(pd120Pixels).toBe(pd180Pixels); // Same resolution
    });

    test('transmission times increase: Robot36 < PD120 < PD160 < PD180', () => {
      const robot36Time = SSTV_MODES.ROBOT36.scanTime * SSTV_MODES.ROBOT36.height;
      const pd120Time = SSTV_MODES.PD120.scanTime * (SSTV_MODES.PD120.height / 2); // 2 rows per scan
      const pd160Time = SSTV_MODES.PD160.scanTime * (SSTV_MODES.PD160.height / 2); // 2 rows per scan
      const pd180Time = SSTV_MODES.PD180.scanTime * (SSTV_MODES.PD180.height / 2); // 2 rows per scan

      expect(pd120Time).toBeGreaterThan(robot36Time);
      expect(pd160Time).toBeGreaterThan(pd120Time);
      expect(pd180Time).toBeGreaterThan(pd160Time);
    });

    test('PD160 has longest scan time and pixel dwell', () => {
      // PD160 scan time is longest
      expect(SSTV_MODES.PD160.scanTime).toBeGreaterThan(SSTV_MODES.PD120.scanTime);
      expect(SSTV_MODES.PD160.scanTime).toBeGreaterThan(SSTV_MODES.PD180.scanTime);

      // PD160 pixel dwell time is longest (best SNR)
      const pd120Dwell = SSTV_MODES.PD120.colorScanTime / SSTV_MODES.PD120.width;
      const pd160Dwell = SSTV_MODES.PD160.colorScanTime / SSTV_MODES.PD160.width;
      const pd180Dwell = SSTV_MODES.PD180.colorScanTime / SSTV_MODES.PD180.width;

      expect(pd160Dwell).toBeGreaterThan(pd120Dwell);
      expect(pd160Dwell).toBeGreaterThan(pd180Dwell);
    });
  });
});

describe('Line timing tolerance', () => {
  test('uses the documented default margins', () => {
    const scanTime = 400;
    expect(lineTimingToleranceMs(scanTime)).toBeCloseTo(
      scanTime * DEFAULT_LINE_TIMING_RELATIVE_TOLERANCE + DEFAULT_LINE_TIMING_MARGIN_MS,
      6
    );
  });

  test('scales with scanTime', () => {
    const robot36 = lineTimingToleranceMs(SSTV_MODES.ROBOT36.scanTime);
    const pd120 = lineTimingToleranceMs(SSTV_MODES.PD120.scanTime);
    expect(pd120).toBeGreaterThan(robot36);
  });

  test('stays below the spacing produced by a missing sync', () => {
    // A missed sync yields ~2x scanTime; the band must not stretch that far.
    for (const mode of Object.values(SSTV_MODES)) {
      expect(lineTimingToleranceMs(mode.scanTime)).toBeLessThan(mode.scanTime);
    }
  });

  test('accepts an exact scanTime spacing', () => {
    for (const mode of Object.values(SSTV_MODES)) {
      expect(isLineSpacingWithinTolerance(mode.scanTime, mode.scanTime)).toBe(true);
    }
  });

  test('accepts realistic jitter and rejects gross deviations', () => {
    const scanTime = SSTV_MODES.PD120.scanTime;
    const tolerance = lineTimingToleranceMs(scanTime);

    // A few percent of jitter must pass.
    expect(isLineSpacingWithinTolerance(scanTime * 1.03, scanTime)).toBe(true);
    expect(isLineSpacingWithinTolerance(scanTime * 0.97, scanTime)).toBe(true);

    // Clearly wrong spacings must fail.
    expect(isLineSpacingWithinTolerance(scanTime - tolerance - 1, scanTime)).toBe(false);
    expect(isLineSpacingWithinTolerance(scanTime * 2, scanTime)).toBe(false);
    expect(isLineSpacingWithinTolerance(scanTime * 0.25, scanTime)).toBe(false);
  });

  test('honours explicit overrides', () => {
    const scanTime = 300;
    expect(lineTimingToleranceMs(scanTime, { relative: 0, marginMs: 0 })).toBe(0);
    expect(lineTimingToleranceMs(scanTime, { relative: 0.5, marginMs: 0 })).toBeCloseTo(150, 6);

    expect(isLineSpacingWithinTolerance(scanTime + 20, scanTime, { relative: 0, marginMs: 10 })).toBe(false);
    expect(isLineSpacingWithinTolerance(scanTime + 20, scanTime, { relative: 0, marginMs: 25 })).toBe(true);
  });

  test('never returns a negative tolerance', () => {
    expect(lineTimingToleranceMs(100, { relative: -1, marginMs: -50 })).toBe(0);
  });
});
