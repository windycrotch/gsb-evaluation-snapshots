/** Pasting copied keys onto the bone that is selected now (the swing of one arm onto the other). */
import { beforeEach, describe, expect, it } from 'vitest';
import { linearBetweenEqual } from '../src/core/edit';
import { retargetClip } from '../src/core/keyrefs';
import { validateProject } from '../src/core/validate';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

const bone = (target: string) => ({ kind: 'bone' as const, target, prop: 'rotate', time: 0 });
const slot = (target: string) => ({ kind: 'slot' as const, target, prop: 'rgba', time: 0 });

describe('retargetClip', () => {
  it('moves the keys of one bone onto the selected bone, and copies them for several', () => {
    expect(retargetClip([bone('a'), bone('a')], ['b'], null).map((c) => c.target)).toEqual(['b', 'b']);
    expect(retargetClip([bone('a')], ['b', 'c'], null).map((c) => c.target)).toEqual(['b', 'c']);
  });

  it('keeps them where they are when the same bone is selected, nothing is, or the copy came from several bones', () => {
    expect(retargetClip([bone('a')], ['a'], null).map((c) => c.target)).toEqual(['a']);
    expect(retargetClip([bone('a')], [], null).map((c) => c.target)).toEqual(['a']);
    expect(retargetClip([bone('a'), bone('b')], ['c'], null).map((c) => c.target)).toEqual(['a', 'b']);
  });

  it('sends the keys of several bones onto as many other selected bones, one for one, in the order of the document', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];
    // copied from a and b (in any order), pasted onto d and c: a goes to the first of them in the document (c), b to d
    expect(retargetClip([bone('b'), bone('a')], ['d', 'c'], null, order).map((c) => c.target)).toEqual(['d', 'c']);
    expect(retargetClip([bone('a'), bone('b'), bone('a')], ['d', 'c'], null, order).map((c) => c.target)).toEqual(['c', 'd', 'c']);
    // not as many bones selected, or the same bones: they stay
    expect(retargetClip([bone('a'), bone('b')], ['c', 'd', 'e'], null, order).map((c) => c.target)).toEqual(['a', 'b']);
    expect(retargetClip([bone('a'), bone('b')], ['b', 'a'], null, order).map((c) => c.target)).toEqual(['a', 'b']);
    // without the order the lists are taken as they come
    expect(retargetClip([bone('a'), bone('b')], ['d', 'c'], null).map((c) => c.target)).toEqual(['d', 'c']);
  });

  it('leaves the keys that are not bone keys alone when it moves the bone keys', () => {
    const ik = { kind: 'ik' as const, target: 'ik1', prop: '', time: 0 };
    expect(retargetClip([bone('a'), ik, bone('b')], ['c', 'd'], null, ['a', 'b', 'c', 'd']).map((c) => c.target)).toEqual([
      'c',
      'ik1',
      'd',
    ]);
  });

  it('does the same for the keys of one slot', () => {
    expect(retargetClip([slot('s1')], [], 's2').map((c) => c.target)).toEqual(['s2']);
    expect(retargetClip([slot('s1')], [], 's1').map((c) => c.target)).toEqual(['s1']);
  });
});

describe('pasting keys', () => {
  const doc = () => docStore.get().skeleton;
  beforeEach(() => {
    const f = buildFixture();
    docStore.replace(f.project);
    uiStore.patch({
      mode: 'animate',
      tool: 'select',
      animationId: f.project.skeleton.animations[0].id,
      skinId: null,
      time: 0,
      selection: emptySelection,
      overrides: {},
      autoKey: true,
      playing: false,
    });
  });

  it('puts the keys of one arm on the other bone, shifted to the playhead', () => {
    const [, , , upper, lower] = doc().bones;
    A.selectBone(upper.id);
    A.setTime(0.2);
    A.setBonePose([{ id: upper.id, props: { rotation: 41 } }]);
    A.setTime(0.6);
    A.setBonePose([{ id: upper.id, props: { rotation: -12 } }]);
    const anim = () => A.currentAnimation()!;
    const mine = anim().bones[upper.id].rotate!.filter((k) => k.time >= 0.19 && k.time <= 0.61);
    A.copyKeys(mine.map((k) => ({ kind: 'bone' as const, target: upper.id, prop: 'rotate', time: k.time })));
    A.selectBone(lower.id);
    A.setTime(1);
    const pasted = A.pasteKeys(1);
    expect(pasted.length).toBe(mine.length);
    expect(pasted.every((p) => p.target === lower.id)).toBe(true);
    const copy = anim().bones[lower.id].rotate!;
    expect(copy.map((k) => k.value[0])).toEqual(expect.arrayContaining(mine.map((k) => k.value[0]))); // relative to the setup pose, so the same swing
    expect(Math.min(...pasted.map((p) => p.time))).toBeCloseTo(1, 4);
    expect(validateProject(docStore.get())).toEqual([]);
    docStore.undo();
    expect(anim().bones[lower.id]?.rotate?.some((k) => k.value[0] === mine[0].value[0]) ?? false).toBe(false);
  });

  it('puts the keys of two bones on two other bones, each pair matched in the order of the document', () => {
    const bones = doc().bones;
    const [a, b, c, d] = [bones[1], bones[2], bones[3], bones[4]];
    A.setTime(0.2);
    A.setBonePose([
      { id: a.id, props: { rotation: 30 } },
      { id: b.id, props: { rotation: -40 } },
    ]);
    A.copyKeys([
      { kind: 'bone', target: b.id, prop: 'rotate', time: 0.2 },
      { kind: 'bone', target: a.id, prop: 'rotate', time: 0.2 },
    ]);
    const src = (id: string) => A.currentAnimation()!.bones[id].rotate!.find((k) => Math.abs(k.time - 0.2) < 1e-3)!.value[0];
    A.setSelection({ bones: [d.id, c.id] });
    const pasted = A.pasteKeys(0.8);
    expect(pasted.map((p) => p.target).sort()).toEqual([c.id, d.id].sort());
    const keyOf = (id: string) => A.currentAnimation()!.bones[id].rotate!.find((k) => Math.abs(k.time - 0.8) < 1e-3)!;
    // the keys carry the same swing as their source (their values are relative to the setup pose of the bone)
    expect(keyOf(c.id).value[0]).toBeCloseTo(src(a.id), 6);
    expect(keyOf(d.id).value[0]).toBeCloseTo(src(b.id), 6);
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('still pastes onto the same bone when it is the one selected', () => {
    const upper = doc().bones[3];
    A.selectBone(upper.id);
    A.setTime(0.3);
    A.setBonePose([{ id: upper.id, props: { rotation: 20 } }]);
    A.copyKeys([{ kind: 'bone', target: upper.id, prop: 'rotate', time: 0.3 }]);
    const pasted = A.pasteKeys(0.9);
    expect(pasted.map((p) => p.target)).toEqual([upper.id]);
  });

  it('two-colour keys pasted onto a slot without a dark colour become plain colour keys, curve included', () => {
    const [from, to] = doc().slots;
    const anim = A.currentAnimation()!;
    docStore.update('prepare', (d) => {
      d.skeleton.slots.find((x) => x.id === from.id)!.dark = [0, 0, 0];
      d.skeleton.slots.find((x) => x.id === to.id)!.dark = null;
      const a = d.skeleton.animations.find((x) => x.id === anim.id)!;
      const curve = Array.from({ length: 7 }, () => [1 / 3, 1 / 3, 2 / 3, 2 / 3]).flat();
      (a.slots[from.id] ??= {}).rgba2 = [
        { time: 0.1, value: [1, 1, 1, 1, 0, 0, 0], curve },
        { time: 0.5, value: [0.5, 0.5, 0.5, 1, 0.1, 0.1, 0.1] },
      ];
    });
    A.copyKeys([{ kind: 'slot', target: from.id, prop: 'rgba2', time: 0.1 }]);
    A.selectSlot(to.id);
    const pasted = A.pasteKeys(0.3);
    expect(pasted.map((p) => p.prop)).toEqual(['rgba']);
    const key = A.currentAnimation()!.slots[to.id].rgba![0];
    expect(key.value.length).toBe(4);
    expect(Array.isArray(key.curve) ? key.curve.length : 16).toBe(16);
    expect(validateProject(docStore.get())).toEqual([]);
  });
});

describe('Paste Keys - Hold', () => {
  const bez = [0.3, 1.4, 0.7, -0.4];
  it('makes the segment between two keys of the same value linear, and only when a pasted key touches it', () => {
    const keys = [
      { time: 0, value: [5], curve: bez },
      { time: 1, value: [5], curve: bez },
      { time: 2, value: [9], curve: bez },
      { time: 3, value: [9] },
      { time: 4, value: [9], curve: 'stepped' as const },
      { time: 5, value: [9] },
    ];
    expect(linearBetweenEqual(keys, [1])).toBe(1); // the segment 1 -> 2 differs in value; 0 -> 1 ends on the pasted key
    expect(keys[0].curve).toBeUndefined();
    expect(keys[1].curve).toEqual(bez);
    expect(linearBetweenEqual(keys, [4])).toBe(1); // 4 -> 5: stepped becomes linear
    expect(keys[4].curve).toBeUndefined();
    expect(linearBetweenEqual(keys, [3])).toBe(1); // 2 -> 3 ends on the pasted key; 3 -> 4 was already linear
    expect(keys[2].curve).toBeUndefined();
    expect(linearBetweenEqual(keys, [3])).toBe(0);
  });

  it('compares every channel of the key', () => {
    const keys = [
      { time: 0, value: [1, 2], curve: [...bez, ...bez] },
      { time: 1, value: [1, 3] },
    ];
    expect(linearBetweenEqual(keys, [0])).toBe(0);
    expect(keys[0].curve).toBeDefined();
  });

  it('skips keys that carry no number, and an empty list', () => {
    expect(linearBetweenEqual([], [0])).toBe(0);
    expect(linearBetweenEqual([{ time: 0 }, { time: 1 }], [0])).toBe(0);
  });
});

describe('pasting with hold', () => {
  beforeEach(() => {
    const f = buildFixture();
    docStore.replace(f.project);
    uiStore.patch({
      mode: 'animate',
      tool: 'select',
      animationId: f.project.skeleton.animations[0].id,
      skinId: null,
      time: 0,
      selection: emptySelection,
      overrides: {},
      autoKey: true,
      playing: false,
    });
  });

  it('pasted keys that hold one value get no curve; a plain paste keeps the curves it copied', () => {
    const upper = docStore.get().skeleton.bones[3];
    const bez = [0.2, 1.5, 0.8, -0.5];
    docStore.update('prepare', (d) => {
      const a = d.skeleton.animations.find((x) => x.id === A.currentAnimation()!.id)!;
      (a.bones[upper.id] ??= {}).rotate = [
        { time: 0.1, value: [7], curve: bez },
        { time: 0.3, value: [7], curve: bez },
        { time: 0.5, value: [7] },
      ];
    });
    const refs = [0.1, 0.3, 0.5].map((t) => ({ kind: 'bone' as const, target: upper.id, prop: 'rotate', time: t }));
    A.copyKeys(refs);
    A.selectBone(upper.id);
    A.pasteKeys(1);
    const at = (t: number) => A.currentAnimation()!.bones[upper.id].rotate!.find((k) => Math.abs(k.time - t) < 1e-3)!;
    expect(at(1).curve).toEqual(bez);
    expect(at(1.2).curve).toEqual(bez);
    A.pasteKeys(1.6, true);
    expect(at(1.6).curve).toBeUndefined();
    expect(at(1.8).curve).toBeUndefined();
    docStore.undo();
    expect(A.currentAnimation()!.bones[upper.id].rotate!.some((k) => Math.abs(k.time - 1.6) < 1e-3)).toBe(false);
    expect(validateProject(docStore.get())).toEqual([]);
  });
});
