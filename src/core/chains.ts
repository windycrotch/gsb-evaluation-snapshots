/**
 * A value along a chain of bones (a tail, a spine, a tentacle): one number per bone, drawn from a curve instead of typed bone by bone.
 * Used to spread a physics parameter (stiffness, damping, follow-through) over the bones of a chain.
 */
import type { Id, PhysicsParam, SkeletonDoc } from './model';

export type ChainShape = 'linear' | 'in' | 'out' | 'smooth';
export const CHAIN_SHAPES: ChainShape[] = ['linear', 'in', 'out', 'smooth'];

/** The physics parameters that make sense to spread over a chain, in the order the panel lists them. */
export const CHAIN_PARAMS: PhysicsParam[] = ['strength', 'damping', 'inertia', 'mass', 'mix', 'wind', 'gravity'];

/** Where on the curve the position `t` (0 at the first bone, 1 at the last) is, 0..1. `power` bends it: 1 is straight, 2 gentle, 4 steep. */
export function shapeAt(t: number, shape: ChainShape, power: number): number {
  const x = Math.min(1, Math.max(0, t));
  const p = Math.max(0.1, power);
  switch (shape) {
    case 'linear':
      return x;
    case 'in':
      return x ** p;
    case 'out':
      return 1 - (1 - x) ** p;
    case 'smooth':
      return x < 0.5 ? 0.5 * (2 * x) ** p : 1 - 0.5 * (2 * (1 - x)) ** p;
  }
}

/** One value per bone from `from` (first bone) to `to` (last bone) along the curve. A single bone gets `from`. */
export function chainValues(count: number, from: number, to: number, shape: ChainShape, power: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [from];
  return Array.from({ length: count }, (_, i) => from + (to - from) * shapeAt(i / (count - 1), shape, power));
}

/**
 * The bones a chain tool works on. One bone selected: that bone and its descendants, following the first child at each step (a tail or spine).
 * Several selected: those bones, parents first.
 */
export function chainBones(doc: SkeletonDoc, selected: Id[]): Id[] {
  if (selected.length > 1) return doc.bones.filter((b) => selected.includes(b.id)).map((b) => b.id);
  const first = doc.bones.find((b) => b.id === selected[0]);
  if (!first) return [];
  const out = [first.id];
  let cur = first;
  for (let guard = 0; guard < doc.bones.length; guard++) {
    const next = doc.bones.find((b) => b.parent === cur.id);
    if (!next) break;
    out.push(next.id);
    cur = next;
  }
  return out;
}
