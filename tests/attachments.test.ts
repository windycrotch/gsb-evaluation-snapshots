/**
 * Clipping, bounding box and point attachments against the OFFICIAL Spine 4.3 runtime: world geometry, flags,
 * `SkeletonBounds` hit tests, and — the part the stencil renderer depends on — which slots a clip covers and which
 * polygon region is visible (compared with the real `SkeletonClipping`).
 */
import { describe, expect, it } from 'vitest';
import { applyAnimation } from '../src/core/animate';
import { clipOutline, planClipping, polygonContains } from '../src/core/clip';
import { removeBones, removeSlots } from '../src/core/edit';
import { exportSpineJson } from '../src/core/export/spineJson';
import { importSpineJson } from '../src/core/import/spineJson';
import { newAnimation } from '../src/core/model';
import type { ClippingAttachment, Project } from '../src/core/model';
import { compileSkeleton, createSkeleton, meshWorldVertices, pointWorld } from '../src/core/skeleton';
import { repairProject, validateProject } from '../src/core/validate';
import { POLYGON_SQUARE, addAttachmentRig, buildFixture } from './fixture';
import type { AttachmentRig } from './fixture';
import { S, exportAndLoad } from './official';

const close = (a: number, b: number, what: string, eps = 2e-3) => {
  if (!(Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b)))) throw new Error(`${what}: ours=${a} official=${b}`);
};

const SQUARE = POLYGON_SQUARE;
/** An L: concave, so `convex` / `inverse` clips have to fall back to the hull. */
const L_SHAPE = [0, 0, 80, 0, 80, 30, 30, 30, 30, 90, 0, 90];

interface Rig extends AttachmentRig {
  project: Project;
}

/** The fixture plus one slot per new attachment kind (each on an animated bone). */
function buildRig(clip: Partial<ClippingAttachment> & { vertices?: number[] } = {}): Rig {
  const f = buildFixture();
  return { project: f.project, ...addAttachmentRig(f.project, clip) };
}

function officialAt(sd: any, animation: string | null, t: number) {
  const sk = new S.Skeleton(sd);
  sk.setupPose();
  if (animation) {
    const state = new S.AnimationState(new S.AnimationStateData(sd));
    state.setAnimation(0, animation, false);
    state.update(t);
    state.apply(sk);
  }
  sk.updateWorldTransform(S.Physics.update);
  return sk;
}

function oursAt(project: Project, animation: string | null, t: number) {
  const doc = project.skeleton;
  const sk = createSkeleton(compileSkeleton(doc));
  applyAnimation(sk, animation ? (doc.animations.find((a) => a.name === animation) ?? null) : null, t);
  sk.updateWorldTransform();
  return sk;
}

const TIMES: (number | null)[] = [null, 0.1, 0.37, 0.55, 0.9, 1.15];

/** Compares polygon vertices, clip flags and points of every slot at one point in time. Returns how many things were compared. */
function compareGeometry(project: Project, sd: any, t: number | null, tamper?: (sk: ReturnType<typeof createSkeleton>) => void): number {
  const official = officialAt(sd, t === null ? null : 'walk', t ?? 0);
  const ours = oursAt(project, t === null ? null : 'walk', t ?? 0);
  tamper?.(ours);
  if (tamper) ours.updateWorldTransform();
  let compared = 0;
  for (const os of official.slots) {
    const slot = ours.slots.find((s) => s.data.name === os.data.name)!;
    const oa = os.appliedPose.attachment;
    const att = ours.slotAttachment(slot);
    const tag = `t=${t} slot ${os.data.name}`;
    if (!oa) {
      expect(att, `${tag} attachment`).toBeNull();
      continue;
    }
    if (oa instanceof S.PointAttachment) {
      expect(att?.kind, tag).toBe('point');
      if (att?.kind !== 'point') continue;
      const pos = oa.computeWorldPosition(os.bone.appliedPose, new S.Vector2());
      const mine = pointWorld(att, slot.bone);
      close(mine.x, pos.x, `${tag} point x`);
      close(mine.y, pos.y, `${tag} point y`);
      let dr = mine.rotation - oa.computeWorldRotation(os.bone.appliedPose);
      dr = ((((dr + 180) % 360) + 360) % 360) - 180;
      close(dr, 0, `${tag} point rotation`, 1e-2);
      compared += 3;
    } else if (oa instanceof S.ClippingAttachment || oa instanceof S.BoundingBoxAttachment) {
      const isClip = oa instanceof S.ClippingAttachment;
      expect(att?.kind, tag).toBe(isClip ? 'clipping' : 'boundingbox');
      if (!att || (att.kind !== 'clipping' && att.kind !== 'boundingbox')) continue;
      expect(att.vertexCount * 2, `${tag} vertex count`).toBe(oa.worldVerticesLength);
      const out = new Array(oa.worldVerticesLength).fill(0);
      oa.computeWorldVertices(official, os, 0, oa.worldVerticesLength, out, 0, 2);
      const mine = new Float32Array(att.vertexCount * 2);
      meshWorldVertices(ours, slot, att, null, mine);
      for (let i = 0; i < out.length; i++) close(mine[i], out[i], `${tag} vertex[${i}]`, 4e-3);
      compared += out.length;
      if (isClip && att.kind === 'clipping') {
        expect(att.convex, `${tag} convex`).toBe(oa.convex);
        expect(att.inverse, `${tag} inverse`).toBe(oa.inverse);
        const end = oa.endSlot ? ours.data.slots.find((s) => s.name === oa.endSlot.name)!.id : null;
        expect(att.end, `${tag} end slot`).toBe(end);
        compared += 3;
      }
    }
  }
  return compared;
}

describe('clipping / bounding box / point: geometry matches the official runtime', () => {
  const rig = buildRig();
  const { skeletonData: sd } = exportAndLoad(rig.project);

  it('loads in the official runtime and keeps every attachment', () => {
    const names = sd.slots.map((s: any) => s.name);
    expect(names).toEqual(rig.project.skeleton.slots.map((s) => s.name));
    const skin = sd.defaultSkin;
    const att = (slot: string, name: string) => skin.getAttachment(sd.findSlot(slot).index, name);
    expect(att('clip', 'clip')).toBeInstanceOf(S.ClippingAttachment);
    expect(att('box', 'box')).toBeInstanceOf(S.BoundingBoxAttachment);
    expect(att('wbox', 'wbox').bones).toBeTruthy(); // weighted
    expect(att('wclip', 'wclip').bones).toBeTruthy();
    expect(att('point', 'point')).toBeInstanceOf(S.PointAttachment);
  });

  for (const t of TIMES) {
    it(`world polygons, flags and points agree at t=${t}`, () => {
      expect(compareGeometry(rig.project, sd, t)).toBeGreaterThan(30);
    });
  }

  it('the comparison is not vacuous (a moved bone is caught)', () => {
    expect(() => compareGeometry(rig.project, sd, 0.37, (sk) => (sk.bones.find((b) => b.data.name === 'torso')!.x += 5))).toThrow(/ours=/);
  });

  it('SkeletonBounds: the first box containing a point is the same one', () => {
    for (const t of [0.1, 0.55, 0.9]) {
      const official = officialAt(sd, 'walk', t);
      const bounds = new S.SkeletonBounds();
      bounds.update(official, true);
      const ours = oursAt(rig.project, 'walk', t);
      const boxes: { name: string; v: Float32Array; n: number }[] = [];
      for (const slot of ours.slots) {
        const att = ours.slotAttachment(slot);
        if (att?.kind !== 'boundingbox') continue;
        const v = new Float32Array(att.vertexCount * 2);
        meshWorldVertices(ours, slot, att, null, v);
        boxes.push({ name: att.name, v, n: att.vertexCount });
      }
      expect(boxes.length).toBe(bounds.boundingBoxes.length);
      let hits = 0;
      for (let x = -300 + 0.37; x < 400; x += 23.1) {
        for (let y = -100 + 0.41; y < 400; y += 19.7) {
          const o = bounds.containsPoint(x, y);
          const mine = boxes.find((b) => polygonContains(b.v, b.n, x, y));
          expect(mine?.name ?? null, `t=${t} (${x.toFixed(1)}, ${y.toFixed(1)})`).toBe(o ? o.name : null);
          if (o) hits++;
        }
      }
      expect(hits).toBeGreaterThan(5); // the grid really lands inside the boxes
    }
  });
});

// ------------------------------------------------------------------ clipping semantics

/** What the official renderer loop (SkeletonRendererCore) does with `SkeletonClipping`, per slot that draws an image. */
function officialPlan(sk: any): {
  draws: { slot: string; clip: string | null }[];
  starts: { name: string; polygons: number[][]; inverse: boolean }[];
} {
  const clipper = new S.SkeletonClipping();
  const draws: { slot: string; clip: string | null }[] = [];
  const starts: { name: string; polygons: number[][]; inverse: boolean }[] = [];
  for (const slot of sk.drawOrder.appliedPose) {
    const att = slot.appliedPose.attachment;
    if (!att) {
      clipper.clipEnd(slot);
      continue;
    }
    if (att instanceof S.ClippingAttachment) {
      clipper.clipEnd(slot);
      const before = clipper.isClipping();
      clipper.clipStart(sk, slot, att);
      // the clipper is reset as soon as the clip ends, so copy what the test needs now (a nested clip is ignored)
      if (!before)
        starts.push({ name: att.name, polygons: clipper.clippingPolygons.map((p: number[]) => p.slice()), inverse: clipper.inverse });
      continue;
    }
    if (att instanceof S.RegionAttachment || att instanceof S.MeshAttachment) {
      draws.push({ slot: slot.data.name, clip: clipper.isClipping() ? clipper.clipAttachment.name : null });
    }
    clipper.clipEnd(slot);
  }
  return { draws, starts };
}

/** Inside a convex polygon of x,y pairs, whatever its winding. */
function insideConvex(p: number[], x: number, y: number): boolean {
  let pos = false;
  let neg = false;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const cross = (p[i + 2] - p[i]) * (y - p[i + 1]) - (p[i + 3] - p[i + 1]) * (x - p[i]);
    if (cross > 0) pos = true;
    if (cross < 0) neg = true;
  }
  const lastCross = (p[0] - p[p.length - 2]) * (y - p[p.length - 1]) - (p[1] - p[p.length - 1]) * (x - p[p.length - 2]);
  if (lastCross > 0) pos = true;
  if (lastCross < 0) neg = true;
  return !(pos && neg);
}

describe('clipping: which slots are clipped, and where the visible region is', () => {
  it('a clip covers the slots after it up to and including its end slot', () => {
    const rig = buildRig();
    const { skeletonData: sd } = exportAndLoad(rig.project);
    for (const t of TIMES) {
      const official = officialAt(sd, t === null ? null : 'walk', t ?? 0);
      const ours = oursAt(rig.project, t === null ? null : 'walk', t ?? 0);
      const theirs = officialPlan(official).draws;
      const plan = planClipping(ours);
      const mine = ours.drawOrder
        .map((s, i) => ({ slot: s.data.name, att: ours.slotAttachment(s), clip: plan[i]?.att.name ?? null }))
        .filter((e) => e.att && (e.att.kind === 'region' || e.att.kind === 'mesh'));
      expect(
        mine.map((e) => [e.slot, e.clip]),
        `t=${t}`,
      ).toEqual(theirs.map((e) => [e.slot, e.clip]));
    }
    // sanity: in this rig some slots are clipped and some are not (the end slot included, the one after it excluded)
    const plan = officialPlan(officialAt(sd, null, 0)).draws;
    expect(plan.filter((e) => e.clip).map((e) => e.slot)).toEqual(['head', 'flag']);
    expect(plan.filter((e) => !e.clip).map((e) => e.slot)).toEqual(['body', 'front', 'arm', 'glow']);
  });

  it('follows draw order changes, nested clips and a clip without an end slot', () => {
    const rig = buildRig({ end: null });
    const doc = rig.project.skeleton;
    // a second clipping slot inside the first clip must be ignored; the draw order keys shuffle everything around
    const anim = newAnimation('orders', 2);
    let seed = 987;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const times: number[] = [];
    for (let k = 0; k < 10; k++) {
      const order = doc.slots.map((s) => s.id);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      anim.drawOrder.push({ time: k * 0.2, order });
      times.push(k * 0.2 + 0.05);
    }
    doc.animations.push(anim);
    const { skeletonData: sd } = exportAndLoad(rig.project);
    let clippedSlots = 0;
    for (const t of times) {
      const official = officialAt(sd, 'orders', t);
      const ours = oursAt(rig.project, 'orders', t);
      expect(ours.drawOrder.map((s) => s.data.name)).toEqual(official.drawOrder.appliedPose.map((s: any) => s.data.name));
      const theirs = officialPlan(official).draws;
      const plan = planClipping(ours);
      const mine = ours.drawOrder
        .map((s, i) => ({ slot: s.data.name, att: ours.slotAttachment(s), clip: plan[i]?.att.name ?? null }))
        .filter((e) => e.att && (e.att.kind === 'region' || e.att.kind === 'mesh'));
      expect(
        mine.map((e) => [e.slot, e.clip]),
        `t=${t}`,
      ).toEqual(theirs.map((e) => [e.slot, e.clip]));
      clippedSlots += theirs.filter((e) => e.clip).length;
    }
    expect(clippedSlots).toBeGreaterThan(5);
  });

  const variants: { name: string; convex: boolean; inverse: boolean; vertices: number[] }[] = [
    { name: 'convex polygon', convex: false, inverse: false, vertices: SQUARE },
    { name: 'concave polygon (decomposed by the reference)', convex: false, inverse: false, vertices: L_SHAPE },
    { name: 'concave polygon flagged convex (hull)', convex: true, inverse: false, vertices: L_SHAPE },
    { name: 'inverse convex polygon', convex: false, inverse: true, vertices: SQUARE },
    { name: 'inverse concave polygon (hull)', convex: false, inverse: true, vertices: L_SHAPE },
  ];
  for (const v of variants) {
    it(`the visible region matches the reference: ${v.name}`, () => {
      const rig = buildRig({ convex: v.convex, inverse: v.inverse, vertices: v.vertices });
      const { skeletonData: sd } = exportAndLoad(rig.project);
      let inside = 0;
      let outside = 0;
      for (const t of [null, 0.37, 0.9]) {
        const official = officialAt(sd, t === null ? null : 'walk', t ?? 0);
        const ours = oursAt(rig.project, t === null ? null : 'walk', t ?? 0);
        const theirs = officialPlan(official).starts.find((e) => e.name === 'clip')!;
        expect(theirs, `t=${t}: the reference starts the clip`).toBeTruthy();
        const plan = planClipping(ours);
        // a clip that covers no drawable slot is never "in effect" in the per-slot plan, so look the slot up directly
        const clipSlot = ours.slots.find((s) => s.data.name === 'clip')!;
        const clipAtt = ours.slotAttachment(clipSlot);
        if (clipAtt?.kind !== 'clipping') throw new Error('the clip slot has no clipping attachment');
        const state = { slot: clipSlot, att: clipAtt };
        void plan;
        const n = state.att.vertexCount;
        const world = new Float32Array(n * 2);
        meshWorldVertices(ours, state.slot, state.att, null, world);
        const outline = clipOutline(world, n, state.att.convex, state.att.inverse);
        for (let x = -200 + 0.37; x < 300; x += 7.3) {
          for (let y = -100 + 0.41; y < 300; y += 6.9) {
            const refInside = theirs.polygons.some((p: number[]) => insideConvex(p, x, y));
            const refVisible = theirs.inverse ? !refInside : refInside;
            const mineInside = polygonContains(outline.vertices, outline.count, x, y);
            const mineVisible = state.att.inverse ? !mineInside : mineInside;
            if (mineVisible !== refVisible)
              throw new Error(`${v.name} t=${t} (${x.toFixed(1)}, ${y.toFixed(1)}): ours visible=${mineVisible}, official=${refVisible}`);
            if (refVisible) inside++;
            else outside++;
          }
        }
      }
      expect(inside).toBeGreaterThan(100);
      expect(outside).toBeGreaterThan(100);
    });
  }
});

// ------------------------------------------------------------------ round trip, validator, edits

describe('new attachments in the document', () => {
  it('export -> import -> export is identical', () => {
    const rig = buildRig({ convex: true, inverse: true });
    const json = exportSpineJson(rig.project.skeleton);
    const { project, warnings } = importSpineJson(JSON.parse(JSON.stringify(json)), 'rt');
    expect(warnings).toEqual([]);
    const again = JSON.parse(JSON.stringify(exportSpineJson(project.skeleton)));
    const original = JSON.parse(JSON.stringify(json));
    delete again.skeleton.hash;
    delete original.skeleton.hash;
    expect(again).toEqual(original);
    expect(validateProject(project)).toEqual([]);
    const clipSlot = project.skeleton.slots.find((s) => s.name === 'clip')!;
    const clip = project.skeleton.skins[0].attachments[clipSlot.id].clip;
    expect(clip).toMatchObject({ type: 'clipping', convex: true, inverse: true });
    if (clip.type === 'clipping') expect(project.skeleton.slots.find((s) => s.id === clip.end)?.name).toBe('flag');
  });

  it('the repaired project keeps polygons and points, and fixes a dangling end slot', () => {
    const rig = buildRig();
    const doc = rig.project.skeleton;
    expect(validateProject(rig.project)).toEqual([]);
    const clip = doc.skins[0].attachments[rig.slotId.clip].clip;
    if (clip.type !== 'clipping') throw new Error('not a clip');
    clip.end = 'no-such-slot';
    const notes = repairProject(rig.project);
    expect(notes.join('\n')).toContain('end slot does not exist');
    expect(clip.end).toBeNull();
    // a polygon with fewer than three vertices cannot be used
    const box = doc.skins[0].attachments[rig.slotId.box].box;
    if (box.type !== 'boundingbox') throw new Error('not a box');
    box.vertices = [0, 0, 1, 1];
    expect(repairProject(rig.project).join('\n')).toContain('at least 3 vertices');
    expect(doc.skins[0].attachments[rig.slotId.box].box).toBeUndefined();
  });

  it('deleting the end slot makes the clip run to the end; deleting a bone re-binds weighted polygons in place', () => {
    const rig = buildRig();
    const doc = structuredClone(rig.project.skeleton);
    removeSlots(doc, new Set([rig.slotId.flag]));
    const clip = doc.skins[0].attachments[rig.slotId.clip].clip;
    expect(clip.type === 'clipping' && clip.end).toBeNull();

    const before = rig.project.skeleton;
    const setup = createSkeleton(compileSkeleton(before));
    setup.setToSetupPose();
    setup.updateWorldTransform();
    const mats = new Map(setup.bones.map((b) => [b.data.id, { a: b.a, b: b.b, c: b.c, d: b.d, x: b.worldX, y: b.worldY }] as const));
    const after = structuredClone(before);
    removeBones(after, [rig.boneId.armLower, rig.boneId.armUpper], mats);
    // every slot on the removed bones is gone with them, so a polygon on a surviving bone is what must stay valid
    expect(validateProject({ ...rig.project, skeleton: after })).toEqual([]);
  });
});
