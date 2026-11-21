/**
 * "Match" of a transform constraint: the offsets of its property mappings are set so that, in the pose of the skeleton in Setup mode, the
 * constraint changes nothing. Without it a new constraint snaps its bones to the values of the source, and the animator has to find the
 * offsets by hand. After Match the bones stay where they are and start to follow the source from there.
 */
import type { Id, SkeletonDoc, TransformConstraint } from './model';
import { compileSkeleton, createSkeleton, transformFrom } from './skeleton';

/** The offsets of the constraint as the solver reads them: rotation, x, y, scaleX, scaleY, shearY. */
function offsetList(c: TransformConstraint): number[] {
  const o = c.offsets;
  return [o.rotation, o.x, o.y, o.scaleX, o.scaleY, o.shearY];
}

export interface MatchResult {
  /** Mappings whose offsets were set. */
  matched: number;
  /** More than one bone is constrained: the first one is matched, the others follow the same offsets. */
  firstOnly: boolean;
}

/**
 * Sets the offsets of constraint `id` in `doc`; null when there is no such constraint or it has nothing to match (no bones, no mappings).
 * A mapping moves its target offset (`to.offset`, and `to.max` with it, so a clamp keeps its width). When the target's current value would
 * fall outside the clamp range of the mapping, the mapping is anchored at the source's current value instead (`from.offset`), which puts
 * the current pose at the start of the range.
 */
export function matchTransformConstraint(doc: SkeletonDoc, id: Id): MatchResult | null {
  const c = doc.constraints.find((x) => x.id === id);
  if (!c || c.type !== 'transform' || !c.bones.length || !c.properties.length) return null;
  // the pose without this constraint: that is the pose the constraint has to leave alone
  const stripped: SkeletonDoc = {
    ...doc,
    constraints: doc.constraints.filter((x) => x.id !== id),
    skins: doc.skins.map((k) => ({ ...k, constraints: k.constraints.filter((x) => x !== id) })),
  };
  const sk = createSkeleton(compileSkeleton(stripped));
  sk.setToSetupPose();
  sk.updateWorldTransform('none');
  const source = sk.boneById(c.source);
  const target = sk.boneById(c.bones[0]);
  if (!source || !target) return null;
  if (c.localSource) source.validateApplied();
  if (c.localTarget) target.validateApplied();
  const off = offsetList(c);
  const none = [0, 0, 0, 0, 0, 0];
  let matched = 0;
  for (const from of c.properties) {
    const raw = transformFrom(from.prop, sk, source, c.localSource, off);
    for (const to of from.to) {
      const now = transformFrom(to.prop, sk, target, c.localTarget, none);
      // additive: the constraint adds `value` (rotation, position, shear) or multiplies by it (scale): the neutral value is 0 or 1
      const goal = c.additive ? (to.prop === 'scaleX' || to.prop === 'scaleY' ? 1 : 0) : now;
      const value = (raw - from.offset) * to.scale;
      const delta = goal - (to.offset + value);
      const lo = Math.min(to.offset + delta, to.max + delta);
      const hi = Math.max(to.offset + delta, to.max + delta);
      if (c.clamp && (goal < lo - 1e-9 || goal > hi + 1e-9)) {
        from.offset = raw;
        const shift = goal - to.offset;
        to.offset += shift;
        to.max += shift;
      } else {
        to.offset += delta;
        to.max += delta;
      }
      matched++;
    }
  }
  return { matched, firstOnly: c.bones.length > 1 };
}
