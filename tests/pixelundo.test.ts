/** Undo and Redo of a replaced picture bring the old and the new pixels back, not only the size. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyProject } from '../src/core/model';
import { replaceImagePixels } from '../src/store/actions';
import { assets } from '../src/store/assets';
import type { ImageAsset } from '../src/store/assets';
import { docStore } from '../src/store/doc';

const fake = (name: string, width: number, height: number, version: number): ImageAsset => ({
  name,
  width,
  height,
  blob: new Blob([]),
  bitmap: { close() {}, width, height },
  version,
});

beforeEach(() => {
  const p = emptyProject('px');
  p.images.push({ id: 'i1', name: 'hand', width: 10, height: 10 });
  docStore.replace(p);
  assets.swap('hand', fake('hand', 10, 10, 1));
});

describe('replace image pixels', () => {
  it('undo puts the old pixels back, redo the new ones', async () => {
    const old = assets.get('hand')!;
    const fresh = fake('hand', 20, 12, 2);
    vi.spyOn(assets, 'decode').mockResolvedValue(fresh);
    await replaceImagePixels('hand', new Blob([]));
    expect(assets.get('hand')!.version).toBe(2);
    expect(docStore.get().images[0]).toMatchObject({ width: 20, height: 12, rev: 1 });
    docStore.undo();
    expect(assets.get('hand')).toBe(old);
    expect(docStore.get().images[0]).toMatchObject({ width: 10, height: 10 });
    docStore.redo();
    expect(assets.get('hand')!.version).toBe(2);
    expect(assets.get('hand')!.width).toBe(20);
  });

  it('a repaint of the same size is a step of its own, and a second one stacks', async () => {
    const spy = vi.spyOn(assets, 'decode');
    spy.mockResolvedValueOnce(fake('hand', 10, 10, 2));
    await replaceImagePixels('hand', new Blob([]));
    spy.mockResolvedValueOnce(fake('hand', 10, 10, 3));
    await replaceImagePixels('hand', new Blob([]));
    expect(docStore.history.past).toEqual(['Replace image', 'Replace image']);
    expect(assets.get('hand')!.version).toBe(3);
    docStore.undo();
    expect(assets.get('hand')!.version).toBe(2);
    docStore.undo();
    expect(assets.get('hand')!.version).toBe(1);
    docStore.redo();
    docStore.redo();
    expect(assets.get('hand')!.version).toBe(3);
  });

  it('jumping through the history swaps the pixels too', async () => {
    vi.spyOn(assets, 'decode').mockResolvedValue(fake('hand', 10, 10, 5));
    await replaceImagePixels('hand', new Blob([]));
    docStore.jumpTo(-1);
    expect(assets.get('hand')!.version).toBe(1);
    docStore.jumpTo(0);
    expect(assets.get('hand')!.version).toBe(5);
  });
});
