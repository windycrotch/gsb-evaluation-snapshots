import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { generateTimeline, type Mode } from '../timeline';
import { renderFrame } from './renderFrame';

// The renderer must work outside the browser (for future server-side rendering).
describe('renderFrame outside the DOM', () => {
  for (const mode of ['normal', 'grandpa', 'typos', 'manicure', 'breaks'] as Mode[]) {
    it(`renders ${mode} mode frames without errors`, () => {
      const tl = generateTimeline({ text: 'Hi! Привет, в 5:30 ок? 😅', mode, seed: 4, lang: 'en' });
      const canvas = createCanvas(240, 240);
      const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
      for (let t = 0; t <= tl.duration; t += 0.25) {
        renderFrame(ctx, tl, t, { width: 240, height: 240, watermark: 'test' });
      }
      // Frame is not empty: something other than the table colour is drawn in the centre.
      const px = ctx.getImageData(120, 120, 1, 1).data;
      expect([px[0], px[1], px[2]]).not.toEqual([0x3a, 0x2f, 0x27]);
    });
  }
});
