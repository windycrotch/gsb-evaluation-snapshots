import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/presets/index';
import { GraphRuntime } from '../src/worklet/GraphRuntime';
import { BLOCK, renderBlocks } from './patchFixtures';

describe('shipped presets', () => {
  for (const preset of PRESETS) {
    it(`renders the whole "${preset.name}" patch without dropping a feedback voice`, () => {
      const runtime = new GraphRuntime();
      runtime.loadGraph(preset.graph);

      // Every module is scheduled exactly once per block.
      expect(new Set(runtime.processingOrder).size).toBe(preset.graph.modules.length);

      // Some presets open silent by design (a square LFO starts in its
      // negative half-cycle, and the envelope follower takes a while to
      // open the VCA), so warm up before judging that the patch sounds.
      renderBlocks(runtime, 400);

      let peak = 0;
      for (let round = 0; round < 40; round += 1) {
        const { left, right } = renderBlocks(runtime, 20);
        // A hard-panned block can leave one channel at exactly zero, so judge
        // the patch's total energy rather than a single channel.
        let energy = 0;
        for (let i = 0; i < BLOCK; i += 1) {
          energy += left[i] * left[i] + right[i] * right[i];
          expect(Number.isFinite(left[i])).toBe(true);
          expect(Number.isFinite(right[i])).toBe(true);
          peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
        }
        expect(energy).toBeGreaterThan(0);
      }

      // The Output module soft-clips to ±1, and the patch actually sounds.
      expect(peak).toBeLessThanOrEqual(1);
      expect(peak).toBeGreaterThan(0.01);
    });
  }
});
