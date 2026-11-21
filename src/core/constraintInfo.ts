/**
 * What the constraints do, in a form the viewport can draw: for each active constraint, what drives it, which bones it moves and how strongly.
 * The constraint debug view ("who pulls what") uses it; it reads the posed skeleton and changes nothing.
 */
import type { Id } from './model';
import { Bone as BoneRT } from './skeleton';
import type { Bone, PhysicsMode, Skeleton } from './skeleton';

type LinkKind = 'ik' | 'transform' | 'path' | 'slider' | 'physics';

export interface ConstraintLink {
  id: Id;
  name: string;
  kind: LinkKind;
  /** How much of the constraint's result is used, 0..1 (the strongest of its mixes; a slider's mix is its own). */
  strength: number;
  /** The bone the constraint follows (an IK target, a transform source, a slider's bone); null for a path (it follows a slot) or physics. */
  driver: Bone | null;
  /** The bones it moves. */
  driven: Bone[];
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

type RuntimeConstraint = Skeleton['constraints'][number];

/** One constraint as a link (whether or not it is active). */
function linkOf(c: RuntimeConstraint): ConstraintLink {
  const base = { id: c.data.id, name: c.data.name };
  if (c.kind === 'ik') return { ...base, kind: 'ik', strength: clamp01(c.mix), driver: c.target, driven: [...c.bones] };
  if (c.kind === 'transform')
    return { ...base, kind: 'transform', strength: clamp01(Math.max(...c.mix, 0)), driver: c.source, driven: [...c.bones] };
  if (c.kind === 'path') return { ...base, kind: 'path', strength: clamp01(Math.max(...c.mix, 0)), driver: null, driven: [...c.bones] };
  if (c.kind === 'physics') return { ...base, kind: 'physics', strength: clamp01(c.mix), driver: null, driven: [c.bone] };
  return { ...base, kind: 'slider', strength: clamp01(c.mix), driver: c.bone, driven: [] };
}

/** The active constraints of a posed skeleton as links, in the order they are applied. */
export function constraintLinks(skeleton: Skeleton): ConstraintLink[] {
  return skeleton.constraints.filter((c) => c.active).map(linkOf);
}

/** The local transform of a bone as the constraints see it (the applied one): what a constraint is measured against. */
export interface PoseNumbers {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  shearY: number;
}

/** What one constraint did to a bone: the local transform just before it ran and just after. */
interface ConstraintStage {
  id: Id;
  name: string;
  kind: LinkKind;
  strength: number;
  before: PoseNumbers;
  after: PoseNumbers;
}

export interface BoneStages {
  /** The pose the animation gives the bone, before any constraint. */
  start: PoseNumbers;
  /** The constraints that moved this bone, in the order they ran. */
  stages: ConstraintStage[];
  /** The pose when everything has run. */
  end: PoseNumbers;
}

/**
 * The applied local transform of a bone as it stands now. When a constraint has changed the bone's world matrix the applied one is stale and is
 * worked out from the world matrix; that must not stick (the decomposition is not exact, and the update would then build the world matrix from
 * the rounded numbers), so the state is put back afterwards.
 */
const snap = (b: Bone): PoseNumbers => {
  const kept = [b.local, b.world, b.ax, b.ay, b.arotation, b.ascaleX, b.ascaleY, b.ashearX, b.ashearY] as const;
  b.validateApplied();
  const out = { x: b.ax, y: b.ay, rotation: b.arotation, scaleX: b.ascaleX, scaleY: b.ascaleY, shearY: b.ashearY };
  [b.local, b.world, b.ax, b.ay, b.arotation, b.ascaleX, b.ascaleY, b.ashearX, b.ashearY] = kept;
  return out;
};

/**
 * What each constraint contributes to one bone: the skeleton is brought up to date once more with a look between the steps, and the bone's
 * local transform is read before and after every constraint that moves it (a bone under IK, a transform, a path or physics constraint).
 * The constraints that only move other bones, a slider (which plays an animation) and physics (which depends on the time before) are not listed. Null when the bone is not in the skeleton.
 * The skeleton ends in the same pose it had; physics is not simulated again (the stored result is applied).
 */
export function boneStages(skeleton: Skeleton, boneId: Id): BoneStages | null {
  const bone = skeleton.boneById(boneId);
  if (!bone) return null;
  const stages: ConstraintStage[] = [];
  let before: PoseNumbers | null = null;
  const physics: PhysicsMode = skeleton.physicsMode === 'none' ? 'none' : 'pose';
  const start: PoseNumbers = {
    x: bone.x,
    y: bone.y,
    rotation: bone.rotation,
    scaleX: bone.scaleX,
    scaleY: bone.scaleY,
    shearY: bone.shearY,
  };
  skeleton.updateWorldTransform(physics, (item, after) => {
    if (item instanceof BoneRT) return;
    const link = linkOf(item);
    // physics runs over time (a snapshot would say nothing), a slider moves no bone of its own
    if (link.kind === 'physics' || !link.driven.includes(bone)) return;
    if (!after) before = snap(bone);
    else if (before) stages.push({ id: link.id, name: link.name, kind: link.kind, strength: link.strength, before, after: snap(bone) });
  });
  return { start, stages, end: snap(bone) };
}

/** The angle from `a` to `b` in degrees, taken the short way round (-180, 180]. */
export function turn(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

/** How a stage changed the bone: the turn in degrees, the move, and the factor of the scale and shear; all zero when the constraint left it as it was. */
export function stageDelta(s: { before: PoseNumbers; after: PoseNumbers }): {
  rotation: number;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  shearY: number;
} {
  const { before: a, after: b } = s;
  return {
    rotation: turn(a.rotation, b.rotation),
    x: b.x - a.x,
    y: b.y - a.y,
    scaleX: b.scaleX - a.scaleX,
    scaleY: b.scaleY - a.scaleY,
    shearY: turn(a.shearY, b.shearY),
  };
}

/** True when a delta is too small to show: under 0.05 of a degree or a unit (one decimal), 0.005 of a scale (two decimals). A constraint at 0%, or whose target is where the bone already is. */
export const isQuiet = (d: ReturnType<typeof stageDelta>, eps = 0.05): boolean =>
  Math.abs(d.rotation) < eps &&
  Math.abs(d.x) < eps &&
  Math.abs(d.y) < eps &&
  Math.abs(d.scaleX) < eps * 0.1 &&
  Math.abs(d.scaleY) < eps * 0.1 &&
  Math.abs(d.shearY) < eps;

/** The links that touch one of the bones (as the driver or as a bone it moves). */
export function linksTouching(links: readonly ConstraintLink[], bones: ReadonlySet<Id>): ConstraintLink[] {
  return links.filter((l) => (l.driver !== null && bones.has(l.driver.data.id)) || l.driven.some((b) => bones.has(b.data.id)));
}

/**
 * Which links the debug view draws in full: the selected constraint, else the ones that touch the selected bones, else all of them.
 * The others are drawn faded.
 */
export function focusLinks(links: readonly ConstraintLink[], selectedConstraint: Id | null, selectedBones: readonly Id[]): ReadonlySet<Id> {
  if (selectedConstraint && links.some((l) => l.id === selectedConstraint)) return new Set([selectedConstraint]);
  if (selectedBones.length) {
    const touching = linksTouching(links, new Set(selectedBones));
    if (touching.length) return new Set(touching.map((l) => l.id));
  }
  return new Set(links.map((l) => l.id));
}

/** The text of a link's label: the name, and the strength when it is not full. */
export function linkLabel(l: ConstraintLink): string {
  const pct = Math.round(l.strength * 100);
  return pct >= 100 ? l.name : `${l.name} ${pct}%`;
}
