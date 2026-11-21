/**
 * Editing paths and path constraints through the store actions the UI calls: nodes (insert / delete / move / close), binding to
 * bones, animated deformation, and keying position / spacing / mixes. Every state must stay valid and loadable by the official runtime.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyAnimation } from '../src/core/animate';
import { pathCurveLengths, samplePath } from '../src/core/path';
import { meshWorldVertices } from '../src/core/skeleton';
import { validateProject } from '../src/core/validate';
import { getScene } from '../src/store/scene';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import * as M from '../src/store/meshActions';
import * as PA from '../src/store/pathActions';
import * as PC from '../src/store/pathConstraintActions';
import * as P from '../src/store/polygonActions';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';
import { exportAndLoad } from './official';
import { parityMismatch } from './fuzzkit';
import { addPathRig } from './pathrig';
import type { PathRig } from './pathrig';

let rig: PathRig;
const doc = () => docStore.get().skeleton;
const walk = () => doc().animations.find((a) => a.name === 'walk')!;

function load(mode: 'setup' | 'animate' = 'setup') {
  const f = buildFixture();
  rig = addPathRig(f.project);
  docStore.replace(f.project);
  uiStore.patch({
    mode,
    tool: 'select',
    animationId: walk().id,
    skinId: null,
    time: 0,
    selection: emptySelection,
    overrides: {},
    autoKey: true,
    playing: false,
    defaultCurve: 'bezier',
  });
}

function healthy(label: string) {
  const project = docStore.get();
  expect(validateProject(project), `${label}: validator`).toEqual([]);
  expect(() => exportAndLoad(project), `${label}: official loader`).not.toThrow();
  expect(parityMismatch(project), `${label}: parity`).toBeNull();
}

/** World points of the path shown by a slot, in the current scene. */
function worldPoints(slotId: string): number[] {
  const s = getScene().skeleton;
  const slot = s.slotById(slotId)!;
  const att = s.slotAttachment(slot);
  if (!att || att.kind !== 'path') throw new Error('no path in the slot');
  const out: number[] = [];
  meshWorldVertices(s, slot, att, slot.deform.length ? slot.deform : null, out);
  return out;
}
const pathOf = (name: string) => PA.getPath(rig.slotId[name], name === 'ropePath' ? 'ropeA' : name === 'loopPath' ? 'loopB' : 'wpath')!;

describe('path nodes', () => {
  beforeEach(() => load());

  it('inserting a node splits the curve without changing its shape', () => {
    const before = worldPoints(rig.slotId.ropePath);
    const nodes = pathOf('ropePath').vertices.length / 6;
    const total = (pts: number[], n: number) => pathCurveLengths(pts, n, false).at(-1)!;
    const at = [before[8], before[9]]; // the second anchor: a point that is certainly on the curve
    const index = PA.insertPathNode(rig.slotId.ropePath, 'ropeA', at[0] + 3, at[1] - 2);
    expect(index).not.toBeNull();
    const after = worldPoints(rig.slotId.ropePath);
    expect(pathOf('ropePath').vertices.length / 6).toBe(nodes + 1);
    expect(total(after, nodes + 1)).toBeCloseTo(total(before, nodes), 3);
    // the new anchor lies on the old curve
    const poly = samplePath(before, nodes, false, 200);
    const p = [after[(index! * 3 + 1) * 2], after[(index! * 3 + 1) * 2 + 1]];
    let best = Infinity;
    for (let i = 0; i < poly.length; i += 2) best = Math.min(best, Math.hypot(poly[i] - p[0], poly[i + 1] - p[1]));
    expect(best).toBeLessThan(0.5);
    healthy('inserted node');
  });

  it('an inserted node or a deleted one drops the deform keys of that path (their size no longer fits)', () => {
    expect(doc().animations[0].deform[doc().skins[0].id]?.[rig.slotId.ropePath]).toBeDefined();
    PA.insertPathNode(rig.slotId.ropePath, 'ropeA', 100, 40);
    expect(doc().animations[0].deform[doc().skins[0].id]?.[rig.slotId.ropePath]).toBeUndefined();
    expect(doc().animations[0].deform[doc().skins[0].id]?.[rig.slotId.wPath]).toBeDefined(); // another path is untouched
    healthy('after insert');
    PA.deletePathNodes(rig.slotId.loopPath, 'loopB', [0]);
    expect(pathOf('loopPath').vertices.length / 6).toBe(2);
    healthy('after delete');
  });

  it('a path keeps at least two nodes', () => {
    expect(PA.deletePathNodes(rig.slotId.ropePath, 'ropeA', [0, 1, 2])).toBe(false);
    expect(pathOf('ropePath').vertices.length / 6).toBe(4);
  });

  it('moving a point moves exactly that point in world space (also for a weighted path)', () => {
    for (const [slot, name] of [
      ['ropePath', 'ropeA'],
      ['wPath', 'wpath'],
    ] as const) {
      const before = worldPoints(rig.slotId[slot]);
      P.movePolygonVertices(rig.slotId[slot], name, [{ index: 4, x: 11, y: -22 }]);
      const after = worldPoints(rig.slotId[slot]);
      expect(after[8]).toBeCloseTo(11, 3);
      expect(after[9]).toBeCloseTo(-22, 3);
      for (let i = 0; i < before.length; i++) if (i !== 8 && i !== 9) expect(after[i], `${slot} value ${i}`).toBeCloseTo(before[i], 3);
    }
    healthy('moved points');
  });

  it('closing a path and opening it again', () => {
    PA.setPathClosed(rig.slotId.ropePath, 'ropeA', true);
    expect(pathOf('ropePath').closed).toBe(true);
    healthy('closed');
    PA.setPathClosed(rig.slotId.ropePath, 'ropeA', false);
    expect(pathOf('ropePath').closed).toBe(false);
    healthy('open again');
  });

  it("the path tool's result: a path created from world nodes becomes a slot with a path and keeps its shape", () => {
    A.selectBone(doc().bones[0].id);
    const nodes = [
      { x: -100, y: 0, inX: -100, inY: 0, outX: -60, outY: 40 },
      { x: 0, y: 80, inX: -30, inY: 80, outX: 30, outY: 80 },
      { x: 100, y: 0, inX: 60, inY: 40, outX: 100, outY: 0 },
    ];
    const made = PA.createPath(nodes, false)!;
    expect(made).not.toBeNull();
    const world = worldPoints(made.slotId);
    expect([world[2], world[3]]).toEqual([-100, 0].map((v) => expect.closeTo(v, 4)));
    expect(world[8]).toBeCloseTo(0, 3);
    expect(world[9]).toBeCloseTo(80, 3);
    healthy('created');
    docStore.undo();
    expect(doc().slots.some((s) => s.id === made.slotId)).toBe(false);
  });
});

describe('binding a path to bones', () => {
  beforeEach(() => load());

  it('binds with weights, keeps every point where it was, and the official runtime agrees', () => {
    const before = worldPoints(rig.slotId.ropePath);
    PA.bindPathToBones(rig.slotId.ropePath, 'ropeA', [rig.boneId.pathHolder, rig.boneId.wA, rig.boneId.wB]);
    const p = pathOf('ropePath');
    expect(p.weights).not.toBeNull();
    expect(p.weights!.length).toBe(12);
    expect(p.weights!.every((l) => l.length >= 1 && Math.abs(l.reduce((s, i) => s + i[3], 0) - 1) < 1e-9)).toBe(true);
    const after = worldPoints(rig.slotId.ropePath);
    for (let i = 0; i < before.length; i++) expect(after[i], `value ${i}`).toBeCloseTo(before[i], 3);
    // the three points of a node share their weights
    expect(p.weights![3].map((i) => [i[0], i[3]])).toEqual(p.weights![4].map((i) => [i[0], i[3]]));
    healthy('bound');
    PA.unbindPath(rig.slotId.ropePath, 'ropeA');
    expect(pathOf('ropePath').weights).toBeNull();
    const back = worldPoints(rig.slotId.ropePath);
    for (let i = 0; i < before.length; i++) expect(back[i], `value ${i}`).toBeCloseTo(before[i], 3);
    healthy('unbound');
  });

  it('a bound path follows its bones in an animation (and so do the constrained bones)', () => {
    PA.bindPathToBones(rig.slotId.ropePath, 'ropeA', [rig.boneId.wA, rig.boneId.wB]);
    const s = getScene().skeleton;
    const setup = worldPoints(rig.slotId.ropePath);
    applyAnimation(s, walk(), 0.6);
    s.updateWorldTransform();
    const moved = worldPoints(rig.slotId.ropePath);
    expect(Math.hypot(moved[2] - setup[2], moved[3] - setup[3])).toBeGreaterThan(1);
    healthy('bound path in animation');
  });
});

describe('animating a path', () => {
  beforeEach(() => load('animate'));

  it('dragging a node in Animate mode keys a deform (one undo step) and the setup path is untouched', () => {
    const setupVertices = pathOf('ropePath').vertices.slice();
    A.setTime(0.5, false);
    const base = M.currentDeform(rig.slotId.ropePath)!;
    expect(base.length).toBe(24);
    docStore.beginGesture('Deform path');
    M.setDeformKey(rig.slotId.ropePath, 'ropeA', base, [{ index: 7, dx: 5, dy: 7 }]);
    M.setDeformKey(rig.slotId.ropePath, 'ropeA', base, [{ index: 7, dx: 9, dy: 12 }]);
    docStore.endGesture();
    expect(pathOf('ropePath').vertices).toEqual(setupVertices);
    const keys = walk().deform[doc().skins[0].id][rig.slotId.ropePath].ropeA;
    const k = keys.find((x) => Math.abs(x.time - 0.5) < 1e-6)!;
    // the drag offset is a WORLD offset: the key stores it in the slot bone's space (that bone is scaled, rotated and animated)
    const bone = getScene().skeleton.boneById(rig.boneId.pathHolder)!;
    const det = bone.a * bone.d - bone.b * bone.c;
    expect(k.value[14] - base[14]).toBeCloseTo((bone.d * 9 - bone.b * 12) / det, 3);
    expect(k.value[15] - base[15]).toBeCloseTo((-bone.c * 9 + bone.a * 12) / det, 3);
    healthy('deformed path');
    docStore.undo();
    expect(walk().deform[doc().skins[0].id][rig.slotId.ropePath].ropeA.some((x) => Math.abs(x.time - 0.5) < 1e-6)).toBe(false);
  });
});

describe('keying path constraints', () => {
  beforeEach(() => load('animate'));

  it('in Setup mode edits the setup values and keys nothing', () => {
    uiStore.patch({ mode: 'setup' });
    PC.setPathValues(rig.constraintId.scale, { position: 0.4, mix: { y: 0.3 } });
    const c = doc().constraints.find((x) => x.id === rig.constraintId.scale)!;
    expect(c.type === 'path' && [c.position, c.mix.y]).toEqual([0.4, 0.3]);
    healthy('setup edit');
  });

  it('in Animate mode keys the channel that was edited (mix keys all three mixes)', () => {
    const id = rig.constraintId.partial;
    const before = Object.keys(walk().path[id] ?? {});
    expect(before).toEqual(['mix']);
    A.setTime(0.3, false);
    PC.setPathValues(id, { position: 0.55 });
    expect(Object.keys(walk().path[id]).sort()).toEqual(['mix', 'position']);
    expect(walk().path[id].position).toHaveLength(1);
    PC.setPathValues(id, { mix: { x: 0.25 } });
    const key = walk().path[id].mix!.find((k) => Math.abs(k.time - 0.3) < 1e-6)!;
    expect(key.value).toHaveLength(3);
    expect(key.value[1]).toBe(0.25);
    healthy('keyed');
  });

  it('keys are addressable like every other key: delete, copy and paste work on path timelines', () => {
    const id = rig.constraintId.rope;
    A.deleteKeys([{ kind: 'path', target: id, prop: 'spacing', time: 0 }]);
    expect(walk().path[id].spacing).toHaveLength(1);
    A.copyKeys([{ kind: 'path', target: id, prop: 'position', time: 0.6 }]);
    A.setTime(1.0, false);
    const pasted = A.pasteKeys(1.0);
    expect(pasted).toHaveLength(1);
    expect(walk().path[id].position!.some((k) => Math.abs(k.time - 1.0) < 1e-6)).toBe(true);
    A.deleteKeys(walk().path[id].spacing!.map((k) => ({ kind: 'path' as const, target: id, prop: 'spacing', time: k.time })));
    expect(walk().path[id].spacing).toBeUndefined();
    healthy('copy / delete');
  });

  it('creating a constraint from the selection', () => {
    uiStore.patch({ mode: 'setup' });
    A.setSelection({ slot: rig.slotId.loopPath, attachment: 'loopB', bones: [rig.boneId.pr2, rig.boneId.pr1] });
    const id = PC.createPathConstraint()!;
    const c = doc().constraints.find((x) => x.id === id)!;
    expect(c.type === 'path' && c.bones).toEqual([rig.boneId.pr1, rig.boneId.pr2]); // hierarchy order
    expect(c.type === 'path' && c.target).toBe(rig.slotId.loopPath);
    healthy('created constraint');
    // nothing to follow: no path in the document
    A.setSelection({ bones: [] });
    expect(PC.createPathConstraint()).toBeNull();
  });
});
