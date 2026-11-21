/** The demo rig "Kit": it is built from data, so it can be checked like any project: valid, exports for the official runtime, plays without blowing up. */
import { describe, expect, it } from 'vitest';
import { applyAnimation } from '../src/core/animate';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import { validateProject } from '../src/core/validate';
import { uid } from '../src/core/ids';
import type { ImageRef } from '../src/core/model';
import { DEMO_IMAGES, buildDemoRig } from '../src/store/demo/kit';
import { S, exportAndLoad } from './official';

function rig() {
  const images: Record<string, ImageRef> = {};
  for (const i of DEMO_IMAGES) images[i.name] = { id: uid(), name: i.name, width: i.width, height: i.height };
  return buildDemoRig(images);
}

describe('demo rig Kit', () => {
  it('is a valid project with the advertised content', () => {
    const p = rig();
    expect(validateProject(p)).toEqual([]);
    const doc = p.skeleton;
    expect(doc.animations.map((a) => a.name)).toEqual(['idle', 'walk', 'wave', 'jump']);
    expect(doc.skins.map((s) => s.name)).toEqual(['default', 'arctic']);
    expect(doc.constraints.filter((c) => c.type === 'ik')).toHaveLength(2);
    expect(doc.constraints.filter((c) => c.type === 'physics')).toHaveLength(7);
    expect(doc.events.length).toBeGreaterThanOrEqual(3);
  });

  it('the far arm never comes in front of the body: no draw-order change, and it only lifts a little in the wave', () => {
    const doc = rig().skeleton;
    const wave = doc.animations.find((x) => x.name === 'wave')!;
    expect(wave.drawOrder).toEqual([]);
    for (const name of ['arm far 1', 'arm far 2']) {
      const keys = wave.bones[doc.bones.find((x) => x.name === name)!.id]?.rotate ?? [];
      for (const k of keys) expect(Math.abs(k.value[0])).toBeLessThanOrEqual(20);
    }
  });

  it('the tail is between the two arms: in front of the far arm, behind the body and the near arm', () => {
    const doc = rig().skeleton;
    const at = (name: string) => doc.slots.findIndex((s) => s.name === name);
    expect(at('tail')).toBeGreaterThan(at('arm far'));
    expect(at('tail')).toBeGreaterThan(at('hand far'));
    expect(at('tail')).toBeLessThan(at('body'));
    expect(at('tail')).toBeLessThan(at('arm near'));
  });

  it('each ear has a picture of its own that stands along its bone, so the two ears do not lean the same way', () => {
    const doc = rig().skeleton;
    const pictureOf = (slot: string) => {
      const id = doc.slots.find((s) => s.name === slot)!.id;
      const att = Object.values(doc.skins[0].attachments[id] ?? {})[0];
      return att && 'path' in att ? att.path : '';
    };
    expect(pictureOf('ear far')).not.toBe(pictureOf('ear near'));
    const near = doc.bones.find((b) => b.name === 'ear near')!;
    const far = doc.bones.find((b) => b.name === 'ear far')!;
    expect(far.rotation).toBeGreaterThan(near.rotation); // the far ear leans back, the near one forward
  });

  it('weighted meshes have normalised weights', () => {
    const p = rig();
    let meshes = 0;
    for (const skin of p.skeleton.skins) {
      for (const slot of Object.values(skin.attachments)) {
        for (const att of Object.values(slot)) {
          if (att.type !== 'mesh') continue;
          meshes++;
          expect(att.weights).not.toBeNull();
          const verts = att.weights!;
          expect(verts.length).toBe(att.uvs.length / 2);
          for (const v of verts) expect(v.reduce((a, inf) => a + inf[3], 0)).toBeCloseTo(1, 4);
        }
      }
    }
    expect(meshes).toBeGreaterThanOrEqual(12);
  });

  it('every image used by a skin exists, and both skins use only their own pictures', () => {
    const p = rig();
    const names = new Set(p.images.map((i) => i.name));
    const used = (skin: string) => {
      const out = new Set<string>();
      for (const slot of Object.values(p.skeleton.skins.find((s) => s.name === skin)!.attachments))
        for (const a of Object.values(slot)) if ('path' in a) out.add(a.path);
      return out;
    };
    for (const n of [...used('default'), ...used('arctic')]) expect(names.has(n)).toBe(true);
    for (const n of used('arctic')) expect(n.startsWith('fox-')).toBe(false);
  });

  it('exports for the official runtime, in both skins', () => {
    const { skeletonData } = exportAndLoad(rig());
    expect(skeletonData.bones.length).toBe(25);
    expect(skeletonData.animations.map((a: { name: string }) => a.name)).toEqual(['idle', 'walk', 'wave', 'jump']);
    expect(skeletonData.skins.length).toBe(2);
    expect(skeletonData.constraints.filter((c: unknown) => c instanceof S.PhysicsConstraintData)).toHaveLength(7);
  });

  it('plays every animation without a bad number, the feet stay near the ground', () => {
    const p = rig();
    const sk = createSkeleton(compileSkeleton(structuredClone(p.skeleton)));
    for (const anim of p.skeleton.animations) {
      for (let t = 0; t <= anim.duration + 1e-9; t += 1 / 30) {
        applyAnimation(sk, anim, t);
        sk.updateWorldTransform('update');
        for (const b of sk.bones) {
          for (const v of [b.a, b.b, b.c, b.d, b.worldX, b.worldY]) expect(Number.isFinite(v)).toBe(true);
          expect(Math.abs(b.worldX)).toBeLessThan(600);
          expect(Math.abs(b.worldY)).toBeLessThan(600);
        }
      }
    }
  });

  it('the walk is a loop: the first and the last frame are the same pose', () => {
    const p = rig();
    const walk = p.skeleton.animations.find((a) => a.name === 'walk')!;
    for (const tl of Object.values(walk.bones)) {
      for (const line of [tl.rotate, tl.translate]) {
        if (!line || line.length < 2) continue;
        expect(line[0].value).toEqual(line[line.length - 1].value);
      }
    }
  });
});
