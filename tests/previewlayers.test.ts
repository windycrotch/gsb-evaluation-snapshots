/** Preview: animations played over the main one (alpha, additive, loop) and Hold previous for the crossfade. */
import { describe, expect, it } from 'vitest';
import { emptyProject, newAnimation, newBone } from '@/core/model';
import type { Project } from '@/core/model';
import { PreviewPlayer, keyedChannels, layerTime, poseLayers, poseMixed } from '@/core/preview';
import { compileSkeleton, createSkeleton } from '@/core/skeleton';

function build() {
  const p: Project = emptyProject();
  p.skeleton.bones = [];
  const a = newBone({ name: 'a', length: 10 });
  const b = newBone({ name: 'b', length: 10, parent: a.id, x: 10 });
  p.skeleton.bones.push(a, b);
  // the main animation turns bone a by 60 and moves b by 20 along x
  const main = newAnimation('main', 1);
  main.bones[a.id] = {
    rotate: [
      { time: 0, value: [0] },
      { time: 1, value: [60] },
    ],
  };
  main.bones[b.id] = {
    translate: [
      { time: 0, value: [0, 0] },
      { time: 1, value: [20, 0] },
    ],
  };
  // the layer turns bone a by 40 and nothing else
  const over = newAnimation('over', 1);
  over.bones[a.id] = {
    rotate: [
      { time: 0, value: [0] },
      { time: 1, value: [40] },
    ],
  };
  p.skeleton.animations.push(main, over);
  const data = compileSkeleton(p.skeleton);
  return { p, a, b, main, over, sk: createSkeleton(data), scratch: createSkeleton(data) };
}

describe('keyedChannels', () => {
  it('says which values an animation keys, a split translate keying one axis', () => {
    expect(keyedChannels(undefined).rotation).toBe(false);
    const k = keyedChannels({ rotate: [{ time: 0, value: [0] }], translatey: [{ time: 0, value: [0] }] });
    expect(k).toMatchObject({ rotation: true, x: false, y: true, scaleX: false, shearX: false });
  });
});

describe('layers', () => {
  it('a layer at full strength replaces what it keys and leaves the rest of the pose alone', () => {
    const { a, b, main, over, sk, scratch } = build();
    const pl = new PreviewPlayer();
    pl.play(main);
    pl.time = 1;
    pl.addLayer(over, { alpha: 1, loop: false });
    pl.layers[0].time = 0.5;
    pl.pose(sk, scratch);
    expect(sk.boneById(a.id)!.rotation).toBeCloseTo(a.rotation + 20, 6);
    expect(sk.boneById(b.id)!.x).toBeCloseTo(b.x + 20, 6);
  });
  it('a lower alpha blends toward the layer, and zero does nothing', () => {
    const { a, main, over, sk, scratch } = build();
    const pl = new PreviewPlayer();
    pl.play(main);
    pl.time = 1; // main: +60
    const layer = pl.addLayer(over, { alpha: 0.5, loop: false });
    layer.time = 1; // layer: +40
    pl.pose(sk, scratch);
    expect(sk.boneById(a.id)!.rotation).toBeCloseTo(a.rotation + 50, 6);
    layer.alpha = 0;
    pl.pose(sk, scratch);
    expect(sk.boneById(a.id)!.rotation).toBeCloseTo(a.rotation + 60, 6);
  });
  it('an additive layer adds its change from the setup pose, scaled by alpha', () => {
    const { a, main, over, sk, scratch } = build();
    const pl = new PreviewPlayer();
    pl.play(main);
    pl.time = 1;
    const layer = pl.addLayer(over, { alpha: 0.5, additive: true, loop: false });
    layer.time = 1;
    pl.pose(sk, scratch);
    expect(sk.boneById(a.id)!.rotation).toBeCloseTo(a.rotation + 60 + 20, 6);
  });
  it('layers go one over the other in order', () => {
    const { a, main, over, sk, scratch } = build();
    const pl = new PreviewPlayer();
    pl.play(main);
    pl.time = 1;
    pl.addLayer(over, { additive: true, loop: false }).time = 1; // +40 added: 100
    pl.addLayer(over, { alpha: 1, loop: false }).time = 0.5; // then replaced by 20
    pl.pose(sk, scratch);
    expect(sk.boneById(a.id)!.rotation).toBeCloseTo(a.rotation + 20, 6);
  });
  it('a layer has its own time: it loops, or holds its last frame, and advances with the player', () => {
    const { over } = build();
    expect(layerTime({ anim: over, time: 2.25, loop: true })).toBeCloseTo(0.25, 9);
    expect(layerTime({ anim: over, time: 2.25, loop: false })).toBe(1);
    expect(layerTime({ anim: null, time: 3, loop: true })).toBe(0);
    const pl = new PreviewPlayer();
    const layer = pl.addLayer(over);
    pl.advance(0.4);
    expect(layer.time).toBeCloseTo(0.4, 9);
    pl.playing = false;
    pl.advance(1);
    expect(layer.time).toBeCloseTo(0.4, 9);
  });
  it('without a scratch skeleton, or with no layers, the pose is the main animation only', () => {
    const { a, main, over, sk } = build();
    const pl = new PreviewPlayer();
    pl.play(main);
    pl.time = 1;
    pl.addLayer(over);
    pl.pose(sk);
    expect(sk.boneById(a.id)!.rotation).toBeCloseTo(a.rotation + 60, 6);
  });
  it('a layer with no animation, or on a bone the skeleton lacks, is skipped', () => {
    const { a, main, sk, scratch } = build();
    const ghost = newAnimation('ghost', 1);
    ghost.bones['nope'] = { rotate: [{ time: 0, value: [10] }] };
    const pl = new PreviewPlayer();
    pl.play(main);
    pl.time = 1;
    pl.addLayer(null);
    pl.addLayer(ghost);
    expect(() => pl.pose(sk, scratch)).not.toThrow();
    expect(sk.boneById(a.id)!.rotation).toBeCloseTo(a.rotation + 60, 6);
    poseLayers(sk, scratch, []);
  });
});

describe('Hold previous', () => {
  it('keeps what the new animation does not key where the old one had it', () => {
    const { b, main, over, sk } = build();
    // from `main` at its end (b moved 20 along x) to `over` (does not key b), halfway through the crossfade
    poseMixed(sk, { anim: main, time: 1 }, { anim: over, time: 0 }, 0.5, false);
    expect(sk.boneById(b.id)!.x).toBeCloseTo(b.x + 10, 6); // faded halfway back to the setup pose
    poseMixed(sk, { anim: main, time: 1 }, { anim: over, time: 0 }, 0.5, true);
    expect(sk.boneById(b.id)!.x).toBeCloseTo(b.x + 20, 6); // held
  });
  it('still mixes the values the new animation keys', () => {
    const { a, main, over, sk } = build();
    poseMixed(sk, { anim: main, time: 1 }, { anim: over, time: 1 }, 0.5, true);
    expect(sk.boneById(a.id)!.rotation).toBeCloseTo(a.rotation + 50, 6);
  });
  it('the player passes the flag on to the crossfade', () => {
    const { b, main, over, sk } = build();
    const pl = new PreviewPlayer();
    pl.play(main);
    pl.time = 1;
    pl.hold = true;
    pl.play(over, { default: 1, pairs: [] });
    pl.advance(0.5);
    pl.pose(sk);
    expect(sk.boneById(b.id)!.x).toBeGreaterThan(b.x + 19);
  });
});
