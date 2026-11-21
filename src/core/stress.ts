/**
 * The rig test: every bone that moves a weighted mesh is turned through a few angles, the mesh is posed, and the triangles that turn over
 * (their winding changes sign: the picture folds back over itself) are counted. Bad weights show here as folds long before an animation is
 * built on the rig. Only the bone hierarchy is posed: constraints, physics and animation are left out, so the result is about the rig itself.
 * A finding is a hint (a bone that is never turned that far in the animations does not need the weights to hold up there).
 */
import { compileSkeleton, createSkeleton } from './skeleton';
import type { Skeleton, Slot } from './skeleton';
import { meshWorldVertices } from './skeleton';
import type { Id, SkeletonDoc } from './model';

export interface StressFinding {
  /** The bone that was turned, and the slot and mesh that folded. */
  bone: Id;
  slot: Id;
  mesh: string;
  /** The first angle (degrees) at which the mesh folds. */
  angle: number;
  /** How many triangles turned over at that angle, of how many the mesh has. */
  flipped: number;
  triangles: number;
  /** The area of the turned-over triangles as a share of the mesh (0 to 1 and a little more): how bad the fold is. */
  share: number;
}

export interface StressOptions {
  /** The angles to turn each bone to, in degrees from its setup rotation, the gentlest first (the first one that folds is reported). */
  angles?: readonly number[];
  /** The share of the mesh area that has to be folded back over itself (the area of the turned-over triangles over the area of the mesh) before it is reported. */
  minShare?: number;
}

/** From the gentlest to the hardest turn, both ways: a mesh is reported at the first angle where it folds, because a fold at 20 degrees is a fault and one at 90 is a limit. */
export const STRESS_ANGLES: readonly number[] = [20, -20, 35, -35, 50, -50];

/** Twice the signed area of the triangle (a, b, c). */
const area2 = (p: ArrayLike<number>, a: number, b: number, c: number) =>
  (p[b * 2] - p[a * 2]) * (p[c * 2 + 1] - p[a * 2 + 1]) - (p[b * 2 + 1] - p[a * 2 + 1]) * (p[c * 2] - p[a * 2]);

interface Subject {
  slot: Slot;
  data: Parameters<typeof meshWorldVertices>[2];
  name: string;
  triangles: Uint16Array;
  vertexCount: number;
  /** The bones (indices) that move it, and the rest areas. */
  bound: Set<number>;
  rest: Float32Array;
  out: Float32Array;
  restArea: Float64Array;
  /** The area of the whole mesh at rest. */
  total: number;
}

/** The weighted meshes of the default skin that are on a slot, with the bones that carry them. */
function subjects(sk: Skeleton): Subject[] {
  const out: Subject[] = [];
  for (const slot of sk.slots) {
    const data = sk.getAttachment(slot.data.index, slot.attachmentName);
    if (!data || data.kind !== 'mesh' || !data.weighted) continue;
    const bones = data.bones as Int32Array;
    const bound = new Set<number>();
    for (let v = 0, i = 0; i < data.vertexCount; i++) {
      const count = bones[v++];
      for (let k = 0; k < count; k++) bound.add(bones[v++]);
    }
    const tris = data.triangles;
    const rest = new Float32Array(data.vertexCount * 2);
    meshWorldVertices(sk, slot, data, null, rest);
    const restArea = new Float64Array(tris.length / 3);
    for (let t = 0; t < restArea.length; t++) restArea[t] = area2(rest, tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]);
    out.push({
      total: restArea.reduce((n, v) => n + Math.abs(v), 0),
      slot,
      data,
      name: data.name,
      triangles: tris,
      vertexCount: data.vertexCount,
      bound,
      rest,
      out: new Float32Array(rest.length),
      restArea,
    });
  }
  return out;
}

/** Turns every bone that carries a weighted mesh and reports the meshes that fold. The gentlest turn first. */
export function stressRig(doc: SkeletonDoc, options: StressOptions = {}): StressFinding[] {
  const angles = options.angles ?? STRESS_ANGLES;
  const minShare = options.minShare ?? 0.05;
  // the hierarchy alone: no constraint can move a bone behind the test's back
  const bare: SkeletonDoc = { ...doc, constraints: [], skins: doc.skins.map((k) => ({ ...k, constraints: [] })) };
  const sk = createSkeleton(compileSkeleton(structuredClone(bare)), null);
  sk.setToSetupPose();
  sk.updateWorldTransform('none');
  const list = subjects(sk);
  if (!list.length) return [];

  // a bone moves everything below it: the subtree of a bone, as bone indices
  const children = new Map<number, number[]>();
  for (const b of sk.bones) if (b.parent) children.set(b.parent.data.index, [...(children.get(b.parent.data.index) ?? []), b.data.index]);
  const below = (i: number): Set<number> => {
    const seen = new Set<number>();
    const walk = (n: number) => {
      seen.add(n);
      for (const c of children.get(n) ?? []) walk(c);
    };
    walk(i);
    return seen;
  };
  const carriers = new Set<number>();
  for (const s of list) for (const b of s.bound) carriers.add(b);

  const found: StressFinding[] = [];
  for (const i of [...carriers].sort((a, b) => a - b)) {
    const bone = sk.bones[i];
    const moved = below(i);
    const affected = list.filter((s) => [...s.bound].some((b) => moved.has(b)));
    if (!affected.length) continue;
    const setup = bone.rotation;
    for (const s of affected) {
      const count = s.restArea.length;
      for (const angle of angles) {
        bone.rotation = setup + angle;
        sk.updateWorldTransform('none');
        meshWorldVertices(sk, s.slot, s.data, null, s.out);
        let flipped = 0;
        let folded = 0;
        for (let t = 0; t < count; t++) {
          const rest = s.restArea[t];
          const now = area2(s.out, s.triangles[t * 3], s.triangles[t * 3 + 1], s.triangles[t * 3 + 2]);
          // turned over: the other winding, and not just a sliver that passes through flat
          if (rest * now < 0 && Math.abs(now) > Math.abs(rest) * 1e-3) {
            flipped++;
            folded += Math.abs(now);
          }
        }
        if (flipped > 0 && folded >= s.total * minShare) {
          found.push({ bone: bone.data.id, slot: s.slot.data.id, mesh: s.name, angle, flipped, triangles: count, share: folded / s.total });
          break;
        }
      }
      bone.rotation = setup;
    }
    bone.rotation = setup;
    sk.updateWorldTransform('none');
  }
  // the ones that fold at the gentlest turn first, then by how much of the mesh area folds
  return found.sort((a, b) => Math.abs(a.angle) - Math.abs(b.angle) || b.share - a.share);
}
