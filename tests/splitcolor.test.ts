/**
 * Separate colour and alpha timelines (Spine's `rgb` and `alpha`): the exporter writes them when a slot's colour keys only change that part
 * (an option), and the importer merges both kinds into our rgba keys. The oracle is the official runtime, from JSON and from binary.
 */
import { describe, expect, it } from 'vitest';
import { applyAnimation } from '../src/core/animate';
import { exportSpineBinary, jsonToBinary } from '../src/core/export/spineBinary';
import { exportSpineJson } from '../src/core/export/spineJson';
import { importSpineJson, mergeRgbAlpha } from '../src/core/import/spineJson';
import { newSliderConstraint } from '../src/core/model';
import type { Animation, Key, Project } from '../src/core/model';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import { buildFixture } from './fixture';
import { S, exportAndLoad, loadOfficialBinary } from './official';

type J = Record<string, any>;

const SETUP: [number, number, number, number] = [0.5, 0.6, 0.7, 0.8];

function rig(keys: Key[]) {
  const f = buildFixture();
  const p: Project = f.project;
  const slot = p.skeleton.slots[0];
  slot.color = [...SETUP];
  slot.dark = null;
  const anim = p.skeleton.animations.find((a) => a.name === 'walk') as Animation;
  anim.slots[slot.id] = { rgba: keys };
  return { p, slot, anim };
}

const at = (t: number, v: number[], curve?: Key['curve']): Key => ({ time: t, value: v, ...(curve !== undefined ? { curve } : {}) });
const BEZIER = [0.2, 0.1, 0.7, 0.9, 0.25, 0.1, 0.8, 0.95, 0.3, 0.2, 0.6, 0.9, 0.2, 0.05, 0.9, 0.7];

function officialColor(sd: unknown, anim: string, t: number, slot: string) {
  const sk = new S.Skeleton(sd);
  sk.setupPose();
  const state = new S.AnimationState(new S.AnimationStateData(sd));
  state.setAnimation(0, anim, false);
  state.update(t);
  state.apply(sk);
  sk.updateWorldTransform(S.Physics.update);
  const c = sk.findSlot(slot).appliedPose.color;
  return [c.r, c.g, c.b, c.a];
}

/** Our colour at t against the official runtime's, for the JSON export and for its binary form. */
function expectSameColors(p: Project, options: { splitColor?: boolean }, times: number[]) {
  const { skeletonData, atlasText, json } = exportAndLoad(p, options);
  const binary = loadOfficialBinary(jsonToBinary(json), atlasText);
  const data = compileSkeleton(p.skeleton);
  const anim = p.skeleton.animations.find((a) => a.name === 'walk')!;
  for (const t of times) {
    const ours = createSkeleton(data);
    applyAnimation(ours, anim, t);
    const mine = Array.from(ours.slotById(p.skeleton.slots[0].id)!.color);
    for (const [label, sd] of [
      ['json', skeletonData],
      ['binary', binary],
    ] as const) {
      const theirs = officialColor(sd, 'walk', t, p.skeleton.slots[0].name);
      for (let c = 0; c < 4; c++)
        expect(Math.abs(mine[c] - theirs[c]), `${label} channel ${c} at ${t}: ${mine} vs ${theirs}`).toBeLessThan(1.6e-2);
    }
  }
  return json;
}

const slotJson = (json: J, name: string) => json.animations.walk.slots[name] as J;

describe('the exporter', () => {
  const times = [0, 0.13, 0.4, 0.55, 0.7, 1, 1.2];

  it('writes an alpha timeline for keys that only change the alpha', () => {
    const { p, slot } = rig([
      at(0.2, [0.5, 0.6, 0.7, 0], BEZIER),
      at(0.9, [0.5, 0.6, 0.7, 1]),
      at(1.3, [0.5, 0.6, 0.7, 0.25], 'stepped'),
      at(1.5, [0.5, 0.6, 0.7, 0.9]),
    ]);
    const json = expectSameColors(p, { splitColor: true }, times);
    const s = slotJson(json, slot.name);
    expect(s.rgba).toBeUndefined();
    expect(s.alpha).toHaveLength(4);
    // the alpha of the first key is 0: Spine leaves the value out, and the curve is the one of the alpha channel
    expect(s.alpha[0].value).toBeUndefined();
    expect(s.alpha[0].curve).toHaveLength(4);
    expect(s.alpha[2].curve).toBe('stepped');
  });

  it('writes an rgb timeline for keys that only change the colour', () => {
    const { p, slot } = rig([at(0, [1, 0, 0, 0.8], BEZIER), at(0.6, [0, 1, 0, 0.8]), at(1.2, [0.25, 0.5, 1, 0.8])]);
    const json = expectSameColors(p, { splitColor: true }, times);
    const s = slotJson(json, slot.name);
    expect(s.rgba).toBeUndefined();
    expect(s.rgb).toHaveLength(3);
    expect(s.rgb[0].color).toBe('ff0000');
    expect(s.rgb[0].curve).toHaveLength(12);
  });

  it('keeps one rgba timeline when both change, when the option is off, and for two-colour keys', () => {
    const both = rig([at(0, [1, 0, 0, 0.1], BEZIER), at(1, [0, 1, 0, 0.9])]);
    expect(slotJson(expectSameColors(both.p, { splitColor: true }, times), both.slot.name).rgba).toHaveLength(2);
    const off = rig([at(0, [0.5, 0.6, 0.7, 0]), at(1, [0.5, 0.6, 0.7, 1])]);
    expect(slotJson(expectSameColors(off.p, {}, times), off.slot.name).rgba).toHaveLength(2);
    expect(slotJson(expectSameColors(off.p, { splitColor: false }, times), off.slot.name).alpha).toBeUndefined();
  });

  it('keeps rgba when the other part differs from the setup colour (the runtime would not hold it at the setup colour then)', () => {
    const { p, slot } = rig([at(0, [0.9, 0.6, 0.7, 0]), at(1, [0.9, 0.6, 0.7, 1])]);
    expect(slotJson(expectSameColors(p, { splitColor: true }, times), slot.name).rgba).toHaveLength(2);
  });

  it('keeps rgba in an animation that a slider plays: the slider applies it over a pose the slot may already have', () => {
    const { p, slot, anim } = rig([at(0, [0.5, 0.6, 0.7, 0.1]), at(1, [0.5, 0.6, 0.7, 0.9])]);
    expect(slotJson(exportSpineJson(p.skeleton, { splitColor: true }), slot.name).alpha).toBeDefined();
    p.skeleton.constraints.push(newSliderConstraint({ name: 'fade', animation: anim.id, mix: 1, time: 0.5 }));
    const json = exportSpineJson(p.skeleton, { splitColor: true });
    expect(slotJson(json, slot.name).alpha).toBeUndefined();
    expect(slotJson(json, slot.name).rgba).toHaveLength(2);
  });

  it('writes a binary file the official binary loader reads the same (alpha, rgb, a bezier on each)', () => {
    const a = rig([at(0, [0.5, 0.6, 0.7, 0.1], BEZIER), at(1, [0.5, 0.6, 0.7, 0.9])]);
    const bytes = exportSpineBinary(a.p.skeleton, { splitColor: true });
    expect(bytes.length).toBeGreaterThan(50);
    expectSameColors(a.p, { splitColor: true }, times);
    const b = rig([at(0, [0.1, 0.6, 0.2, 0.8], BEZIER), at(1, [0.9, 0.3, 0.7, 0.8])]);
    expectSameColors(b.p, { splitColor: true }, times);
  });
});

describe('the importer', () => {
  const file = (timelines: J) => ({
    skeleton: { spine: '4.3.20', fps: 30 },
    bones: [{ name: 'root' }],
    slots: [{ name: 'fx', bone: 'root', color: '80a0c0cc' }],
    skins: [{ name: 'default', attachments: {} }],
    animations: { a: { slots: { fx: timelines } } },
  });
  const keysOf = (json: J) => {
    const sk = importSpineJson(json).project.skeleton;
    return sk.animations[0].slots[sk.slots[0].id].rgba!;
  };

  it('reads an alpha timeline: the colour stays the setup colour, a missing value is 0 as in Spine', () => {
    const k = keysOf(file({ alpha: [{}, { time: 1, value: 0.5 }] }));
    expect(k[0].value[3]).toBe(0);
    expect(k[1].value[3]).toBeCloseTo(0.5, 5);
    expect(k[0].value[0]).toBeCloseTo(0x80 / 255, 5);
    expect(k[1].value[2]).toBeCloseTo(0xc0 / 255, 5);
  });

  it('merges rgb and alpha timelines that are keyed together, with the curve of each part', () => {
    const r = importSpineJson(
      file({
        rgb: [
          { color: 'ff0000', curve: [0.25, 0, 0.75, 1, 0.25, 0, 0.75, 1, 0.25, 0, 0.75, 1] },
          { time: 1, color: '00ff00' },
        ],
        alpha: [
          { value: 1, curve: [0.4, 1, 0.6, 0.5] },
          { time: 1, value: 0.5 },
        ],
      }),
    );
    const slot = r.project.skeleton.slots[0];
    const k = r.project.skeleton.animations[0].slots[slot.id].rgba!;
    expect(k).toHaveLength(2);
    expect(k[0].value).toEqual([1, 0, 0, 1]);
    expect(k[1].value[3]).toBeCloseTo(0.5, 5);
    expect(Array.isArray(k[0].curve) && k[0].curve).toHaveLength(16);
    expect(r.warnings.some((w) => /approximated/.test(w))).toBe(false);
  });

  it('keeps stepped keys stepped when both parts are', () => {
    const k = keysOf(
      file({
        rgb: [
          { color: 'ff0000', curve: 'stepped' },
          { time: 1, color: '00ff00' },
        ],
        alpha: [
          { value: 1, curve: 'stepped' },
          { time: 1, value: 0 },
        ],
      }),
    );
    expect(k[0].curve).toBe('stepped');
  });

  it('merges rgb and alpha that are keyed at different times by sampling, and says it approximated the curves', () => {
    const r = importSpineJson(
      file({
        rgb: [{ color: 'ff0000' }, { time: 1, color: '0000ff' }],
        alpha: [{ value: 0 }, { time: 0.5, value: 1, curve: [0.6, 1, 0.9, 0] }, { time: 1, value: 0 }],
      }),
    );
    const k = r.project.skeleton.animations[0].slots[r.project.skeleton.slots[0].id].rgba!;
    expect(k.map((x) => x.time)).toEqual([0, 0.5, 1]);
    // the colour at 0.5 is the middle of red and blue, as the runtime has it there
    expect(k[1].value[0]).toBeCloseTo(0.5, 5);
    expect(k[1].value[2]).toBeCloseTo(0.5, 5);
    expect(k[1].value[3]).toBe(1);
    expect(k[0].value[3]).toBe(0);
    expect(r.warnings.some((w) => /approximated/.test(w))).toBe(false); // the linear colour segment is split exactly
  });

  it('round trips what the exporter writes: alpha timelines come back as the same rgba keys', () => {
    const { p, slot } = rig([at(0, [0.5, 0.6, 0.7, 0.1], BEZIER), at(1, [0.5, 0.6, 0.7, 0.9])]);
    const json = exportSpineJson(p.skeleton, { splitColor: true });
    expect(slotJson(json, slot.name).alpha).toBeDefined();
    const back = importSpineJson(json).project.skeleton;
    const k = back.animations.find((a) => a.name === 'walk')!.slots[back.slots[0].id].rgba!;
    expect(k).toHaveLength(2);
    for (let c = 0; c < 4; c++)
      expect(k[0].value[c]).toBeCloseTo(p.skeleton.animations.find((a) => a.name === 'walk')!.slots[slot.id].rgba![0].value[c], 2);
  });
});

describe('mergeRgbAlpha', () => {
  it('without rgb it holds the setup colour, without alpha the setup alpha', () => {
    const a = mergeRgbAlpha(null, [at(0, [1]), at(1, [0])], SETUP);
    expect(a.keys.map((k) => k.value)).toEqual([
      [0.5, 0.6, 0.7, 1],
      [0.5, 0.6, 0.7, 0],
    ]);
    const c = mergeRgbAlpha([at(0, [1, 1, 1])], null, SETUP);
    expect(c.keys[0].value).toEqual([1, 1, 1, 0.8]);
  });
});

describe('a random alpha / colour animation agrees with the official runtime', () => {
  it('for 40 random slots, split or not', () => {
    let s = 12345;
    const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (let n = 0; n < 40; n++) {
      const count = 2 + Math.floor(r() * 3);
      const mode = n % 3; // 0 alpha only, 1 colour only, 2 both
      const keys: Key[] = [];
      for (let i = 0; i < count; i++) {
        const value = mode === 0 ? [SETUP[0], SETUP[1], SETUP[2], r()] : mode === 1 ? [r(), r(), r(), SETUP[3]] : [r(), r(), r(), r()];
        const kind = r();
        const curve: Key['curve'] | undefined =
          i === count - 1
            ? undefined
            : kind < 0.4
              ? undefined
              : kind < 0.6
                ? 'stepped'
                : Array.from({ length: 16 }, (_, j) => (j % 4 === 0 || j % 4 === 2 ? 0.1 + 0.8 * r() : 0.9 * r() - 0.05));
        keys.push(at(i * 0.4 + 0.1, value, curve));
      }
      const { p, slot } = rig(keys);
      const json = expectSameColors(p, { splitColor: true }, [0.05, 0.3, 0.77, 1.01, 1.4]);
      const sj = slotJson(json, slot.name);
      expect(!!sj.alpha).toBe(mode === 0);
      expect(!!sj.rgb).toBe(mode === 1);
      expect(!!sj.rgba).toBe(mode === 2);
    }
  });
});
