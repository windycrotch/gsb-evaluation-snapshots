/**
 * Muting a timeline: the animation plays without what a bone, a slot or a constraint does in it, and the keys stay where they are.
 * A way to compare "with" and "without" a part of the motion. It only changes what the editor plays (nothing is exported or saved).
 */
import type { Animation, Id } from './model';

function without<T>(rec: Record<Id, T>, muted: ReadonlySet<Id>): Record<Id, T> {
  let out: Record<Id, T> | null = null;
  for (const id of muted) {
    if (id in rec) {
      out ??= { ...rec };
      delete out[id];
    }
  }
  return out ?? rec;
}

/** Whether muting any of `muted` would change this animation. */
export function hasMutedKeys(anim: Animation, muted: ReadonlySet<Id>): boolean {
  for (const id of muted) {
    if (
      id in anim.bones ||
      id in anim.slots ||
      id in anim.ik ||
      id in anim.transform ||
      id in anim.slider ||
      id in anim.path ||
      id in anim.physics
    )
      return true;
  }
  return false;
}

/** The animation without the timelines of the muted bones, slots and constraints (the same object when nothing is muted in it). */
export function withoutMuted(anim: Animation, muted: ReadonlySet<Id>): Animation {
  if (!muted.size || !hasMutedKeys(anim, muted)) return anim;
  const copy: Animation = { ...anim };
  copy.bones = without(anim.bones, muted);
  copy.slots = without(anim.slots, muted);
  copy.ik = without(anim.ik, muted);
  copy.transform = without(anim.transform, muted);
  copy.slider = without(anim.slider, muted);
  copy.path = without(anim.path, muted);
  copy.physics = without(anim.physics, muted);
  // what a muted slot does to its attachments (deform, sequence) goes too
  const slotMuted = [...muted].filter(
    (id) => id in anim.slots || Object.values(anim.deform).some((s) => id in s) || Object.values(anim.sequence ?? {}).some((s) => id in s),
  );
  if (slotMuted.length) {
    const skinMap = <T>(m: Record<Id, Record<Id, T>>) =>
      Object.fromEntries(Object.entries(m).map(([skin, perSlot]) => [skin, without(perSlot, muted)]));
    copy.deform = skinMap(anim.deform);
    if (anim.sequence) copy.sequence = skinMap(anim.sequence);
  }
  return copy;
}
