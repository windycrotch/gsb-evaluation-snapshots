/**
 * Differential test: our exported Spine 4.3 JSON must load in the OFFICIAL runtime (@esotericsoftware/spine-core 4.3.x)
 * and produce the same bone transforms / vertices / colors / draw order as our own solver, at many points in time.
 */
import { describe, expect, it } from 'vitest';
import * as spine from '@esotericsoftware/spine-core';
import { buildFixture } from './fixture';
import { loadOfficial } from './official';
import { exportSpineJson } from '../src/core/export/spineJson';
import { packAtlas, writeAtlas } from '../src/core/export/atlas';
import { compileSkeleton, createSkeleton, meshWorldVertices, regionWorldVertices } from '../src/core/skeleton';
import { applyAnimation } from '../src/core/animate';
import { sampleKeys } from '../src/core/curve';
import { newAnimation } from '../src/core/model';

const close = (a: number, b: number, what: string, eps = 2e-3) => {
  if (!(Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b)))) throw new Error(`${what}: ours=${a} official=${b}`);
};

function officialVertices(sk: any, slot: any): number[] | null {
  const att = slot.appliedPose.attachment;
  if (!att) return null;
  if (att instanceof (spine as any).RegionAttachment) {
    const out = new Array(8).fill(0);
    att.computeWorldVertices(slot, att.getOffsets(slot.appliedPose), out, 0, 2);
    return out;
  }
  if (att instanceof (spine as any).MeshAttachment) {
    const out = new Array(att.worldVerticesLength).fill(0);
    att.computeWorldVertices(sk, slot, 0, att.worldVerticesLength, out, 0, 2);
    return out;
  }
  return null;
}

describe('Spine 4.3 parity', () => {
  const { project, images } = buildFixture();
  const doc = project.skeleton;
  const pages = packAtlas(images, { maxSize: 1024, padding: 2 });
  const atlasText = writeAtlas(pages, (i) => `atlas${i}.png`);
  const json = exportSpineJson(doc);
  const sd = loadOfficial(json, atlasText);
  const data = compileSkeleton(doc);

  it('events: definitions and keyed overrides reach the official runtime', () => {
    expect(sd.events.length).toBe(1);
    const ev = sd.findEvent('hit');
    expect(ev.setupPose.intValue).toBe(3);
    expect(ev.setupPose.floatValue).toBeCloseTo(1.5, 6);
    const timeline = sd.findAnimation('walk').timelines.find((t: any) => t.events);
    expect(timeline).toBeTruthy();
    expect(timeline.events.length).toBe(2);
    expect(timeline.events[1].intValue).toBe(7);
    expect(timeline.events[1].stringValue).toBe('again');
    expect(timeline.events[0].intValue).toBe(3); // inherited from the definition
  });

  it('exports valid structure', () => {
    expect((json as any).skeleton.spine).toMatch(/^4\.3\./);
    expect(sd.bones.length).toBe(doc.bones.length);
    expect(sd.slots.length).toBe(doc.slots.length);
    expect(sd.animations.length).toBe(3); // walk + the two animations the sliders apply
    expect(sd.findAnimation('walk').duration).toBeCloseTo(1.2, 4);
  });

  const stats = { bones: 0, vertices: 0, meshes: 0, dark: 0 };
  const compare = (t: number | null, mutate?: (s: ReturnType<typeof createSkeleton>) => void, skinName?: string) => {
    const official = new (spine as any).Skeleton(sd);
    if (skinName) official.setSkin(sd.findSkin(skinName));
    official.setupPose();
    if (t !== null) {
      const state = new (spine as any).AnimationState(new (spine as any).AnimationStateData(sd));
      state.setAnimation(0, 'walk', false);
      state.update(t);
      state.apply(official);
    }
    official.updateWorldTransform((spine as any).Physics.update);

    const ours = createSkeleton(data, skinName ? doc.skins.find((s) => s.name === skinName)!.id : undefined);
    applyAnimation(ours, t === null ? null : doc.animations[0], t ?? 0);
    mutate?.(ours);
    ours.updateWorldTransform();

    for (const ob of official.bones) {
      stats.bones++;
      const mine = ours.bones[data.boneIndex.get(doc.bones.find((b) => b.name === ob.data.name)!.id)!];
      const p = ob.appliedPose;
      const tag = `t=${t} bone ${ob.data.name}`;
      close(mine.a, p.a, `${tag}.a`);
      close(mine.b, p.b, `${tag}.b`);
      close(mine.c, p.c, `${tag}.c`);
      close(mine.d, p.d, `${tag}.d`);
      close(mine.worldX, p.worldX, `${tag}.worldX`);
      close(mine.worldY, p.worldY, `${tag}.worldY`);
    }

    const orderOfficial = official.drawOrder.appliedPose.map((s: any) => s.data.name);
    const orderMine = ours.drawOrder.map((s) => s.data.name);
    expect(orderMine, `draw order t=${t}`).toEqual(orderOfficial);

    for (const os of official.slots) {
      const mine = ours.slots.find((s) => s.data.name === os.data.name)!;
      const tag = `t=${t} slot ${os.data.name}`;
      expect(mine.attachmentName ?? null, `${tag} attachment`).toBe(os.appliedPose.attachment?.name ?? null);
      const c = os.appliedPose.color;
      close(mine.color[0], c.r, `${tag}.r`);
      close(mine.color[1], c.g, `${tag}.g`);
      close(mine.color[2], c.b, `${tag}.b`);
      close(mine.color[3], c.a, `${tag}.a`);
      const dk = os.appliedPose.darkColor; // null unless the slot has a dark color (two-color tinting)
      expect(!!mine.dark, `${tag} has a dark color`).toBe(!!dk);
      if (dk && mine.dark) {
        close(mine.dark[0], dk.r, `${tag}.dark.r`);
        close(mine.dark[1], dk.g, `${tag}.dark.g`);
        close(mine.dark[2], dk.b, `${tag}.dark.b`);
        stats.dark++;
      }
      const ov = officialVertices(official, os);
      const att = ours.slotAttachment(mine);
      if (ov && att && att.kind !== 'point') {
        const mv = new Float32Array(Math.max(8, att.kind === 'region' ? 8 : att.vertexCount * 2));
        if (att.kind === 'region') regionWorldVertices(att, mine.bone, mv);
        else meshWorldVertices(ours, mine, att, att.kind === 'mesh' && mine.deform.length ? mine.deform : null, mv);
        for (let i = 0; i < ov.length; i++) close(mv[i], ov[i], `${tag} vertex[${i}]`, 4e-3);
        stats.vertices += ov.length / 2;
        if (att.kind === 'mesh') stats.meshes++;
      } else expect(!!att, `${tag} has attachment`).toBe(!!ov);
    }
  };

  it('matches in setup pose', () => compare(null));
  for (const t of [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1.0, 1.15, 1.2]) {
    it(`matches at t=${t}`, () => compare(t));
  }

  it('matches with the "alt" skin (image swap + moved attachment)', () => {
    compare(null, undefined, 'alt');
    compare(0.2, undefined, 'alt');
    compare(0.4, undefined, 'alt');
  });

  it('the alt skin really changes the geometry', () => {
    expect(() => compare(0.2, (s) => (s.bones[0].x += 1), 'alt')).toThrow(/ours=/);
  });

  it('draw order keys with random permutations survive export (offset encoding)', () => {
    const f = buildFixture();
    const d = structuredClone(f.project.skeleton);
    const anim = newAnimation('orders', 2);
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const keyTimes: number[] = [];
    for (let k = 0; k < 8; k++) {
      const order = d.slots.map((s) => s.id);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      anim.drawOrder.push({ time: k * 0.25, order });
      keyTimes.push(k * 0.25);
    }
    d.animations = [anim];
    const json = exportSpineJson(d);
    const sd2 = loadOfficial(json, atlasText);
    const data2 = compileSkeleton(d);
    for (const t of [...keyTimes, 0.3, 1.1, 1.99]) {
      const official = new (spine as any).Skeleton(sd2);
      official.setupPose();
      const state = new (spine as any).AnimationState(new (spine as any).AnimationStateData(sd2));
      state.setAnimation(0, 'orders', false);
      state.update(t);
      state.apply(official);
      official.updateWorldTransform((spine as any).Physics.update);
      const ours = createSkeleton(data2);
      applyAnimation(ours, d.animations[0], t);
      expect(
        ours.drawOrder.map((s) => s.data.name),
        `t=${t}`,
      ).toEqual(official.drawOrder.appliedPose.map((s: any) => s.data.name));
    }
  });

  it('actually compares a meaningful amount of data', () => {
    expect(stats.bones).toBeGreaterThan(150);
    expect(stats.meshes).toBeGreaterThan(10);
    expect(stats.vertices).toBeGreaterThan(100);
    expect(stats.dark).toBeGreaterThan(10); // the two-color slot
  });

  describe('two-color tinting (rgba2)', () => {
    const glowId = doc.slots.find((s) => s.name === 'glow')!.id;
    const glowKeys = doc.animations[0].slots[glowId].rgba2!;
    const slotOf = (s: ReturnType<typeof createSkeleton>) => s.slots.find((x) => x.data.name === 'glow')!;

    it('exports light and dark colors, and the official runtime loads them', () => {
      const exported = (json as any).animations.walk.slots.glow.rgba2;
      expect(exported).toHaveLength(glowKeys.length);
      expect(exported[0]).toMatchObject({ light: expect.stringMatching(/^[0-9a-f]{8}$/), dark: expect.stringMatching(/^[0-9a-f]{6}$/) });
      expect((json as any).slots.find((s: any) => s.name === 'glow').dark).toBe('1a334d');
      expect(sd.findSlot('glow').setupPose.darkColor).not.toBeNull();
    });

    it('keys overshoot 0..1 in the fixture, and ours is clamped like Spine (Color.set / Color.add)', () => {
      const out: number[] = [];
      let over = 0;
      let under = 0;
      for (let t = 0; t < 0.6; t += 0.01) {
        sampleKeys(glowKeys, t, out);
        if (out.some((v) => v > 1)) over++;
        if (out.some((v) => v < 0)) under++;
        compare(t + 0.0013);
        const ours = createSkeleton(data);
        applyAnimation(ours, doc.animations[0], t + 0.0013);
        for (const v of [...slotOf(ours).color, ...slotOf(ours).dark!]) expect(v >= 0 && v <= 1).toBe(true);
      }
      expect(over).toBeGreaterThan(3);
      expect(under).toBeGreaterThan(3);
    });

    it('animates the dark color (it differs from the setup color, and the comparison is not vacuous)', () => {
      const ours = createSkeleton(data);
      applyAnimation(ours, doc.animations[0], 0.7);
      expect(slotOf(ours).dark).not.toEqual(doc.slots.find((s) => s.id === glowId)!.dark);
      expect(() => compare(0.3513, (s) => (slotOf(s).dark![0] += 0.25))).toThrow(/ours=/);
      expect(() => compare(0.3513, (s) => (slotOf(s).dark![2] += 0.2))).toThrow(/ours=/);
      expect(() => compare(0.3513, (s) => (slotOf(s).dark = null))).toThrow();
    });

    it('a slider applying an animation with rgba2 keys mixes the dark color in (the "from the current pose" path)', () => {
      const without = structuredClone(doc);
      delete without.animations.find((a) => a.name === 'pose')!.slots[glowId];
      const a = createSkeleton(data);
      applyAnimation(a, doc.animations[0], 0.7); // slider A is at 0.34 s of "pose" here (before its first key at 0.2 s nothing happens)
      a.updateWorldTransform();
      const b = createSkeleton(compileSkeleton(without));
      applyAnimation(b, without.animations[0], 0.7);
      b.updateWorldTransform();
      expect(slotOf(a).dark).not.toEqual(slotOf(b).dark);
    });
  });

  const at = (name: string) => doc.constraints.findIndex((c) => c.name === name);

  it('loads all constraints (3 IK + 4 transform + 3 slider) in the official runtime', () => {
    expect(sd.constraints.length).toBe(10);
    expect(sd.constraints.map((c: any) => c.constructor.name)).toEqual([
      'SliderData',
      'IkConstraintData',
      'IkConstraintData',
      'IkConstraintData',
      'TransformConstraintData',
      'TransformConstraintData',
      'TransformConstraintData',
      'TransformConstraintData',
      'SliderData',
      'SliderData',
    ]);
  });

  it('transform constraints change the pose (comparison is sensitive to them)', () => {
    for (const name of ['gear drive', 'slide follow', 'world to local', 'world add']) {
      expect(() => compare(0.6, (s) => ((s.constraints[at(name)] as any).mix = [0, 0, 0, 0, 0, 0]))).toThrow(/ours=/);
    }
  });

  it('sliders change the pose (comparison is sensitive to them)', () => {
    for (const name of ['pose slider', 'loop slider', 'manual slider']) {
      expect(() => compare(0.6, (s) => ((s.constraints[at(name)] as any).mix = 0)), name).toThrow(/ours=|attachment|draw order/);
    }
    // the driven time really matters: shifting the driver bone moves the pose
    expect(() => compare(0.9, (s) => (s.boneById(doc.bones.find((b) => b.name === 'slider')!.id)!.x += 9))).toThrow(
      /ours=|attachment|draw order/,
    );
  });

  it('matches the official runtime across a dense time sweep (sliders, mixes, loops, additive)', () => {
    // (offset from the frame grid: the official runtime keeps key times as float32, so a probe exactly ON a key is ambiguous)
    for (let i = 0; i < 60; i++) compare(i * 0.02 + 0.0013);
  });

  it('detects deliberate differences (the comparison is not vacuous)', () => {
    expect(() => compare(0.4, (s) => (s.constraints[at('arm ik')].mix = 1))).toThrow(/ours=/);
    expect(() => compare(0.4, (s) => (s.bones[2].rotation += 3))).toThrow(/ours=/);
    expect(() => compare(0.7, (s) => s.slots[0].deform.push(0))).not.toThrow();
  });
});
