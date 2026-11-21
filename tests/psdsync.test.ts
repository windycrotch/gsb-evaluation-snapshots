/** "Update from PSD": layers are matched to pictures by name, regions follow the new size and the move of the layer. */
import { describe, expect, it } from 'vitest';
import { fitRegion, planPsdSync } from '@/core/import/psdSync';
import type { PsdLayer } from '@/core/import/psd';
import { emptyProject } from '@/core/model';
import type { ImageRef } from '@/core/model';
import { repairProject } from '@/core/validate';

function layer(name: string): PsdLayer {
  return {
    name,
    left: 0,
    top: 0,
    width: 2,
    height: 2,
    opacity: 1,
    blend: 'normal',
    pixels: { width: 2, height: 2, data: new Uint8ClampedArray(16) },
  };
}
const image = (name: string, psd?: [number, number]): ImageRef => ({
  id: `id-${name}`,
  name,
  width: 2,
  height: 2,
  ...(psd ? { psd } : {}),
});

describe('PSD sync plan', () => {
  it('matches layers to pictures by name, lists new layers and the pictures whose layer is gone', () => {
    const plan = planPsdSync(
      [layer('back'), layer('arm/upper'), layer('hat')],
      [image('back', [0, 0]), image('arm/upper', [1, 1]), image('old', [2, 2]), image('hand-drawn')],
    );
    expect(plan.updates.map((u) => u.image.name)).toEqual(['back', 'arm/upper']);
    expect(plan.added.map((l) => l.name)).toEqual(['hat']);
    // "hand-drawn" never came from a PSD, so a file that lacks it says nothing about it
    expect(plan.gone).toEqual(['old']);
  });

  it('an empty project makes every layer new; an empty file changes nothing', () => {
    expect(planPsdSync([layer('a'), layer('b')], []).added).toHaveLength(2);
    const none = planPsdSync([], [image('a', [0, 0])]);
    expect(none.updates).toHaveLength(0);
    expect(none.gone).toEqual(['a']);
  });
});

describe('fitRegion', () => {
  it('keeps the scale, follows the pixel size and shifts by the move of the layer', () => {
    const att = { x: 5, y: -3, width: 20, height: 30 };
    expect(fitRegion(att, { width: 20, height: 30 }, { width: 20, height: 30 }, [0, 0])).toEqual(att);
    expect(fitRegion(att, { width: 20, height: 30 }, { width: 40, height: 15 }, [2, 4])).toEqual({ x: 7, y: 1, width: 40, height: 15 });
    // an attachment the user had scaled to half stays at half of the new pixels
    expect(fitRegion({ x: 0, y: 0, width: 10, height: 10 }, { width: 20, height: 20 }, { width: 30, height: 20 }, [0, 0])).toEqual({
      x: 0,
      y: 0,
      width: 15,
      height: 10,
    });
  });
});

describe('PSD position of a picture', () => {
  it('survives validation when it is a pair of numbers and is dropped otherwise', () => {
    const p = emptyProject();
    p.images.push(image('ok', [1, 2]), image('bad', [1, 2]), image('plain'));
    (p.images[1] as unknown as { psd: unknown }).psd = [1, 'x'];
    const notes = repairProject(p);
    expect(p.images[0].psd).toEqual([1, 2]);
    expect(p.images[1].psd).toBeUndefined();
    expect(p.images[2].psd).toBeUndefined();
    expect(notes.some((n) => n.includes('PSD position'))).toBe(true);
  });
});
