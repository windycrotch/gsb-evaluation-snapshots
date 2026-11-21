import { describe, expect, it } from 'vitest';
import { curveFromAbsolute, curveToAbsolute, presetCurve, sampleKeys, CURVE_PRESETS } from '../src/core/curve';
import { decompose, descendantsOf, normalizeBoneOrder, removeBones, upsertKey } from '../src/core/edit';
import { moveKeys, removeKeys } from '../src/core/keyrefs';
import { DEG2RAD, parseNumberExpr } from '../src/core/math';
import { emptyProject, newAnimation, newBone, newSlot } from '../src/core/model';
import { DocStore } from '../src/store/doc';
import { buildFixture } from './fixture';

describe('curves', () => {
  const keys = [
    { time: 0, value: [0] },
    { time: 1, value: [10], curve: 'stepped' as const },
    { time: 2, value: [20], curve: presetCurve(CURVE_PRESETS.easeInOut, 1) },
    { time: 3, value: [30] },
  ];
  const out = [0];
  it('is undefined before the first key and holds after the last', () => {
    expect(sampleKeys(keys, -0.1, out)).toBe(false);
    sampleKeys(keys, 9, out);
    expect(out[0]).toBe(30);
  });
  it('linear / stepped / bezier segments', () => {
    sampleKeys(keys, 0.5, out);
    expect(out[0]).toBeCloseTo(5, 6);
    sampleKeys(keys, 1.9, out);
    expect(out[0]).toBe(10);
    sampleKeys(keys, 2.5, out);
    expect(out[0]).toBeCloseTo(25, 1); // symmetric ease: midpoint stays at the midpoint
    sampleKeys(keys, 2.1, out);
    expect(out[0]).toBeLessThan(21); // eased in: slower than linear at first
  });
  it('absolute <-> normalized control points round trip', () => {
    const n = [0.3, 0.1, 0.7, 0.9];
    const abs = curveToAbsolute(n, 0, 2, 5, 4, 25);
    const back = curveFromAbsolute(abs, 2, 5, 4, 25);
    n.forEach((v, i) => expect(back[i]).toBeCloseTo(v, 9));
  });
});

describe('document edits', () => {
  it('removing a bone cleans slots, constraints, weights and timelines', () => {
    const { project } = buildFixture();
    const doc = structuredClone(project.skeleton);
    const arm = doc.bones.find((b) => b.name === 'armLower')!;
    const hand = doc.bones.find((b) => b.name === 'hand')!;
    const gone = removeBones(doc, [arm.id]);
    expect(gone.has(arm.id) && gone.has(hand.id)).toBe(true);
    expect(doc.bones.some((b) => gone.has(b.id))).toBe(false);
    expect(doc.slots.some((s) => s.name === 'flag')).toBe(false); // slot on the removed `hand` bone
    expect(doc.constraints.some((c) => c.name === 'arm ik')).toBe(false);
    for (const a of doc.animations) {
      expect(Object.keys(a.bones).some((id) => gone.has(id))).toBe(false);
      expect(Object.keys(a.slots).every((id) => doc.slots.some((s) => s.id === id))).toBe(true);
    }
    const armMesh = doc.skins[0].attachments[doc.slots.find((s) => s.name === 'arm')!.id].arm;
    expect(armMesh.type === 'mesh' && armMesh.weights!.every((l) => l.every((i) => !gone.has(i[0])))).toBe(true);
  });

  it('keeps parents before children', () => {
    const doc = emptyProject().skeleton;
    const a = newBone({ name: 'a', parent: doc.bones[0].id });
    const b = newBone({ name: 'b', parent: a.id });
    doc.bones.push(b, a); // wrong order on purpose
    normalizeBoneOrder(doc);
    expect(doc.bones.map((x) => x.name)).toEqual(['root', 'a', 'b']);
    expect(descendantsOf(doc, [a.id]).has(b.id)).toBe(true);
  });

  it('upsertKey keeps keys sorted and replaces equal times', () => {
    const keys: { time: number; value: number[] }[] = [];
    upsertKey(keys, { time: 1, value: [1] });
    upsertKey(keys, { time: 0.5, value: [2] });
    upsertKey(keys, { time: 1, value: [3] });
    expect(keys.map((k) => [k.time, k.value[0]])).toEqual([
      [0.5, 2],
      [1, 3],
    ]);
  });

  it('decompose recovers rotation and scale', () => {
    const r = 30 * DEG2RAD; // the runtime's own degree conversion (Spine uses a float32 pi)
    const d = decompose(Math.cos(r) * 2, -Math.sin(r) * 3, Math.sin(r) * 2, Math.cos(r) * 3);
    expect(d.rotation).toBeCloseTo(30, 5);
    expect(d.scaleX).toBeCloseTo(2, 6);
    expect(d.scaleY).toBeCloseTo(3, 6);
    // Math.atan2 returns exact radians while Spine converts with a float32 pi, so a 90° offset comes out ~1e-6° off
    expect(d.shearY).toBeCloseTo(0, 4);
  });
});

describe('key references', () => {
  it('moves keys and drops collisions, removes and prunes empty timelines', () => {
    const anim = newAnimation('t', 2);
    anim.bones.b = {
      rotate: [
        { time: 0, value: [0] },
        { time: 0.5, value: [1] },
        { time: 1, value: [2] },
      ],
    };
    const moved = moveKeys(anim, [{ kind: 'bone', target: 'b', prop: 'rotate', time: 0 }], 0.5);
    expect(anim.bones.b.rotate!.map((k) => k.time)).toEqual([0.5, 1]);
    expect(anim.bones.b.rotate![0].value[0]).toBe(0); // the moved key replaced the one at 0.5
    expect(moved[0].time).toBeCloseTo(0.5, 9);
    removeKeys(anim, [
      { kind: 'bone', target: 'b', prop: 'rotate', time: 0.5 },
      { kind: 'bone', target: 'b', prop: 'rotate', time: 1 },
    ]);
    expect(anim.bones.b).toBeUndefined();
  });
});

describe('numeric expressions', () => {
  it('evaluates arithmetic, the current value and compound operators', () => {
    expect(parseNumberExpr('10 + 2 * 4', 0)).toBe(18);
    expect(parseNumberExpr('v * 2', 21)).toBe(42);
    expect(parseNumberExpr('+=5', 10)).toBe(15);
    expect(parseNumberExpr('*=3', 2)).toBe(6);
    expect(parseNumberExpr('(1+2)*3', 0)).toBe(9);
    expect(parseNumberExpr('2,5', 0)).toBe(2.5);
    expect(parseNumberExpr('abc', 0)).toBeNull();
    expect(parseNumberExpr('1/0', 0)).toBeNull();
    expect(parseNumberExpr('process.exit()', 0)).toBeNull();
  });
});

describe('DocStore history', () => {
  it('undoes and redoes, and coalesces a gesture into one step', () => {
    const store = new DocStore();
    const id = store.get().skeleton.bones[0].id;
    const x = () => store.get().skeleton.bones[0].x;
    store.update('set', (d) => void (d.skeleton.bones[0].x = 5));
    store.beginGesture('drag');
    for (let i = 1; i <= 10; i++) store.update('drag', (d) => void (d.skeleton.bones[0].x = 5 + i));
    store.endGesture();
    expect(x()).toBe(15);
    store.undo();
    expect(x()).toBe(5);
    store.undo();
    expect(x()).toBe(0);
    store.redo();
    store.redo();
    expect(x()).toBe(15);
    expect(store.get().skeleton.bones[0].id).toBe(id);
    expect(store.canRedo).toBe(false);
  });

  it('a new edit clears the redo stack', () => {
    const store = new DocStore();
    store.update('a', (d) => void (d.skeleton.fps = 24));
    store.undo();
    expect(store.canRedo).toBe(true);
    store.update('b', (d) => void (d.skeleton.fps = 60));
    expect(store.canRedo).toBe(false);
  });
});

describe('model factories', () => {
  it('creates unique ids', () => {
    const slots = Array.from({ length: 50 }, (_, i) => newSlot({ name: `s${i}`, bone: 'x' }));
    expect(new Set(slots.map((s) => s.id)).size).toBe(50);
  });
});

describe('numeric fields take the signs of a calculator', () => {
  it('reads × ÷ and the true minus as * / -', () => {
    expect(parseNumberExpr('6 × 7', 0)).toBe(42);
    expect(parseNumberExpr('84 ÷ 2', 0)).toBe(42);
    expect(parseNumberExpr('50 − 8', 0)).toBe(42);
    expect(parseNumberExpr('×= 2', 21)).toBe(42);
    expect(parseNumberExpr('−5', 0)).toBe(-5);
  });
});
