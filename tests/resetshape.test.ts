/** Reset shape: a clipping polygon or bounding box goes back to a square around its bone. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_BOUNDING_BOX_COLOR, polygonVertexCount } from '../src/core/model';
import type { BoundingBoxAttachment } from '../src/core/model';
import { docStore } from '../src/store/doc';
import { getPolygon, resetPolygonShape } from '../src/store/polygonActions';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

function setup(weighted: boolean) {
  const f = buildFixture();
  const doc = f.project.skeleton;
  const slot = doc.slots[0];
  const box: BoundingBoxAttachment = {
    type: 'boundingbox',
    name: 'hit',
    color: [...DEFAULT_BOUNDING_BOX_COLOR],
    vertices: weighted ? [] : [0, 0, 30, 0, 30, 20, 10, 40, 0, 20],
    weights: weighted ? [[[doc.bones[0].id, 5, 5, 1]], [[doc.bones[0].id, 9, 5, 1]], [[doc.bones[0].id, 9, 9, 1]]] : null,
  };
  doc.skins[0].attachments[slot.id] = { ...doc.skins[0].attachments[slot.id], hit: box };
  // a deform timeline for the old shape
  const anim = doc.animations[0];
  ((anim.deform[doc.skins[0].id] ??= {})[slot.id] ??= {}).hit = [{ time: 0, value: [1, 2, 3, 4, 5, 6] }] as never;
  docStore.replace(f.project);
  uiStore.patch({ mode: 'setup', selection: { ...emptySelection, vertices: [1, 2] } });
  return { slotId: slot.id, animId: anim.id };
}

describe('resetPolygonShape', () => {
  it('makes a square of the default size around the bone origin and drops the deform keys', () => {
    const { slotId, animId } = setup(false);
    resetPolygonShape(slotId, 'hit');
    const p = getPolygon(slotId, 'hit')!;
    expect(p.vertices).toEqual([-50, -50, 50, -50, 50, 50, -50, 50]);
    expect(polygonVertexCount(p)).toBe(4);
    const doc = docStore.get().skeleton;
    const anim = doc.animations.find((a) => a.id === animId)!;
    expect(anim.deform[doc.skins[0].id]?.[slotId]?.hit).toBeUndefined();
    expect(uiStore.get().selection.vertices).toEqual([]);
  });

  it('takes a weighted polygon back to plain vertices', () => {
    const { slotId } = setup(true);
    resetPolygonShape(slotId, 'hit', 20);
    const p = getPolygon(slotId, 'hit')!;
    expect(p.weights).toBeNull();
    expect(p.vertices).toEqual([-10, -10, 10, -10, 10, 10, -10, 10]);
  });

  it('is one step of the history and ignores what is not a polygon', () => {
    const { slotId } = setup(false);
    resetPolygonShape(slotId, 'hit');
    docStore.undo();
    expect(getPolygon(slotId, 'hit')!.vertices).toHaveLength(10);
    const before = JSON.stringify(docStore.get().skeleton);
    resetPolygonShape(slotId, 'no such attachment');
    expect(JSON.stringify(docStore.get().skeleton)).toBe(before);
  });
});
