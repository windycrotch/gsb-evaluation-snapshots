/** Mute a timeline (play without a bone's keys, nothing else changes), and a pasted key that repeats the value keeps the curve it lands on. */
import { beforeEach, describe, expect, it } from 'vitest';
import { sameKeyValue } from '@/core/edit';
import { hasMutedKeys, withoutMuted } from '@/core/mute';
import { emptyProject, newAnimation, newBone } from '@/core/model';
import { getScene } from '@/store/scene';
import * as A from '@/store/actions';
import { docStore } from '@/store/doc';
import { clearMute, toggleMute } from '@/store/muteActions';
import { uiStore } from '@/store/ui';

function rig() {
  const p = emptyProject();
  p.skeleton.bones = [];
  const root = newBone({ name: 'root' });
  const arm = newBone({ name: 'arm', parent: root.id, length: 50 });
  const leg = newBone({ name: 'leg', parent: root.id, length: 50 });
  p.skeleton.bones.push(root, arm, leg);
  const a = newAnimation('a', 2);
  a.bones[arm.id] = {
    rotate: [
      { time: 0, value: [0] },
      { time: 1, value: [40] },
    ],
  };
  a.bones[leg.id] = {
    rotate: [
      { time: 0, value: [0] },
      { time: 1, value: [25] },
    ],
  };
  p.skeleton.animations.push(a);
  docStore.replace(p);
  uiStore.patch({ mode: 'animate', animationId: a.id, time: 1, muted: [], overrides: {}, selectedKeys: [] });
  return { root, arm, leg, a };
}

describe('mute', () => {
  beforeEach(() => void rig());

  it('withoutMuted drops the timelines of the muted entities and leaves the document alone', () => {
    const { arm, leg, a } = rig();
    const doc = docStore.get().skeleton.animations[0];
    expect(hasMutedKeys(doc, new Set([arm.id]))).toBe(true);
    expect(hasMutedKeys(doc, new Set(['nothing']))).toBe(false);
    expect(withoutMuted(doc, new Set())).toBe(doc);
    expect(withoutMuted(doc, new Set(['nothing']))).toBe(doc);
    const cut = withoutMuted(doc, new Set([arm.id]));
    expect(cut.bones[arm.id]).toBeUndefined();
    expect(cut.bones[leg.id]).toBeDefined();
    expect(doc.bones[arm.id]).toBeDefined();
    expect(a.id).toBe(doc.id);
  });

  it('the scene plays without the muted bone and with it again after unmuting; the keys stay', () => {
    const { arm, leg } = rig();
    expect(getScene().skeleton.boneById(arm.id)!.rotation).toBeCloseTo(40, 9);
    toggleMute(arm.id);
    expect(getScene().skeleton.boneById(arm.id)!.rotation).toBeCloseTo(0, 9);
    expect(getScene().skeleton.boneById(leg.id)!.rotation).toBeCloseTo(25, 9);
    expect(docStore.get().skeleton.animations[0].bones[arm.id].rotate!.length).toBe(2);
    toggleMute(leg.id);
    clearMute();
    expect(uiStore.get().muted).toEqual([]);
    expect(getScene().skeleton.boneById(arm.id)!.rotation).toBeCloseTo(40, 9);
  });
});

describe('paste that repeats a value', () => {
  beforeEach(() => void rig());

  it('same value: the curve already there stays; a different value replaces the key', () => {
    const { arm } = rig();
    docStore.update('curve', (d) => {
      d.skeleton.animations[0].bones[arm.id].rotate![1].curve = [0.1, 0, 0.9, 1];
    });
    A.copyKeys([{ kind: 'bone', target: arm.id, prop: 'rotate', time: 1 }]);
    // paste the key onto itself: nothing to change
    uiStore.patch({ selection: { ...uiStore.get().selection, bones: [arm.id] } });
    A.pasteKeys(1);
    expect(docStore.get().skeleton.animations[0].bones[arm.id].rotate![1].curve).toEqual([0.1, 0, 0.9, 1]);
    // a different value there: the pasted key wins
    docStore.update('edit', (d) => {
      d.skeleton.animations[0].bones[arm.id].rotate![1].value = [99];
    });
    A.pasteKeys(1);
    const k = docStore.get().skeleton.animations[0].bones[arm.id].rotate![1];
    expect(k.value).toEqual([40]);
  });

  it('sameKeyValue ignores time and curve, compares numbers loosely', () => {
    expect(sameKeyValue({ time: 0, value: [1, 2], curve: [0, 0, 1, 1] }, { time: 5, value: [1, 2 + 1e-9] })).toBe(true);
    expect(sameKeyValue({ time: 0, value: [1] }, { time: 0, value: [1.1] })).toBe(false);
    expect(sameKeyValue({ time: 0, name: 'a' }, { time: 0, name: 'b' })).toBe(false);
  });
});

describe('swap left and right pose', () => {
  it('pairs by name swap their pose, the centre stays, one undo step', async () => {
    const { swapSides } = await import('@/store/poseActions');
    const p = emptyProject();
    p.skeleton.bones = [];
    const root = newBone({ name: 'root' });
    const l = newBone({ name: 'arm L', parent: root.id, rotation: 10, x: 5 });
    const r = newBone({ name: 'arm R', parent: root.id, rotation: -30, x: -5 });
    const mid = newBone({ name: 'spine', parent: root.id, rotation: 7 });
    p.skeleton.bones.push(root, l, r, mid);
    docStore.replace(p);
    uiStore.patch({ mode: 'setup', selection: { ...uiStore.get().selection, bones: [] }, muted: [] });
    expect(swapSides()).toBe(1);
    const bones = docStore.get().skeleton.bones;
    expect(bones.find((b) => b.id === l.id)!.rotation).toBe(-30);
    expect(bones.find((b) => b.id === r.id)!.rotation).toBe(10);
    expect(bones.find((b) => b.id === l.id)!.x).toBe(-5);
    expect(bones.find((b) => b.id === mid.id)!.rotation).toBe(7);
    docStore.undo();
    expect(docStore.get().skeleton.bones.find((b) => b.id === l.id)!.rotation).toBe(10);
  });
});
