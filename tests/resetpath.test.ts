/** Reset path: a path goes back to a straight line of two nodes around its bone. */
import { describe, expect, it } from 'vitest';
import { defaultPathVertices } from '../src/core/path';
import { pathNodeCount } from '../src/core/model';
import type { PathAttachment } from '../src/core/model';
import { createPath, getPath, resetPathShape } from '../src/store/pathActions';
import { docStore } from '../src/store/doc';
import { emptySelection, uiStore } from '../src/store/ui';
import { repairProject } from '../src/core/validate';
import { buildFixture } from './fixture';

function setup() {
  const f = buildFixture();
  docStore.replace(f.project);
  uiStore.patch({ mode: 'setup', selection: { ...emptySelection, bones: [f.project.skeleton.bones[0].id] } });
  const made = createPath(
    [
      { x: 0, y: 0, inX: -10, inY: 0, outX: 10, outY: 5 },
      { x: 50, y: 20, inX: 40, inY: 20, outX: 60, outY: 20 },
      { x: 90, y: 0, inX: 80, inY: 10, outX: 100, outY: 0 },
    ],
    true,
  )!;
  return made;
}

describe('resetPathShape', () => {
  it('makes an open path of two nodes along the x axis, centred on the origin', () => {
    const { slotId, name } = setup();
    expect(pathNodeCount(getPath(slotId, name)!)).toBe(3);
    resetPathShape(slotId, name);
    const p = getPath(slotId, name) as PathAttachment;
    expect(p.vertices).toEqual(defaultPathVertices());
    expect(pathNodeCount(p)).toBe(2);
    expect(p.closed).toBe(false);
    expect(p.weights).toBeNull();
    expect(repairProject(structuredClone(docStore.get()))).toEqual([]);
  });

  it('drops the deform keys of the old points and goes back with undo', () => {
    const { slotId, name } = setup();
    const doc = docStore.get().skeleton;
    const skinId = doc.skins[0].id;
    const anim = doc.animations[0];
    docStore.update('keys', (d) => {
      const a = d.skeleton.animations.find((x) => x.id === anim.id)!;
      ((a.deform[skinId] ??= {})[slotId] ??= {})[name] = [{ time: 0, value: new Array(18).fill(0) }] as never;
    });
    resetPathShape(slotId, name);
    expect(docStore.get().skeleton.animations.find((x) => x.id === anim.id)!.deform[skinId]?.[slotId]?.[name]).toBeUndefined();
    docStore.undo();
    expect(pathNodeCount(getPath(slotId, name)!)).toBe(3);
  });

  it('does nothing for what is not a path', () => {
    setup();
    const before = JSON.stringify(docStore.get());
    resetPathShape('nope', 'nope');
    expect(JSON.stringify(docStore.get())).toBe(before);
  });
});
