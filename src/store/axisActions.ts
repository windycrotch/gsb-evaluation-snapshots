/** Split / merge the axes of a bone's translate, scale or shear timelines in the open animation. */
import { isSplit, mergeGroup, splitGroup } from '@/core/axes';
import { AXIS_GROUPS } from '@/core/model';
import type { AxisGroup, Id } from '@/core/model';
import { currentAnimation, currentPose, extendDuration } from './actions';
import { docStore } from './doc';
import { toast, uiStore } from './ui';

const NAME: Record<AxisGroup, string> = { translate: 'translate', scale: 'scale', shear: 'shear' };

/**
 * Splits (`split`) or merges the group of each bone; returns how many bones changed. A bone with no keys on the group yet starts per-axis
 * keying: both axes get a key at the playhead, on their own timelines, so a single axis can be keyed from there on.
 */
export function setAxesSplit(boneIds: Id[], group: AxisGroup, split: boolean): number {
  const anim = currentAnimation();
  if (!anim || !boneIds.length) return 0;
  const time = uiStore.get().time;
  const [ax, ay] = AXIS_GROUPS[group];
  let changed = 0;
  docStore.update(split ? `Split ${NAME[group]} into X / Y` : `Merge ${NAME[group]} X / Y`, (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    for (const id of boneIds) {
      const tl = a.bones[id];
      if (tl && (split ? splitGroup(tl, group) : mergeGroup(tl, group))) {
        changed++;
        continue;
      }
      if (!split || (tl && (tl[group]?.length || isSplit(tl, group)))) continue;
      // nothing keyed on this group yet: both axes start with a key where the bone is now
      const setup = d.skeleton.bones.find((b) => b.id === id);
      const pose = currentPose(id);
      if (!setup || !pose) continue;
      const now = {
        translate: [pose.x - setup.x, pose.y - setup.y],
        scale: [setup.scaleX !== 0 ? pose.scaleX / setup.scaleX : 1, setup.scaleY !== 0 ? pose.scaleY / setup.scaleY : 1],
        shear: [pose.shearX - setup.shearX, pose.shearY - setup.shearY],
      }[group];
      const t = (a.bones[id] ??= {});
      t[ax] = [{ time, value: [now[0]] }];
      t[ay] = [{ time, value: [now[1]] }];
      extendDuration(a, time);
      changed++;
    }
  });
  if (!changed) toast(split ? `Nothing to split in ${NAME[group]}` : `Nothing to merge: ${NAME[group]} is not split`);
  return changed;
}
