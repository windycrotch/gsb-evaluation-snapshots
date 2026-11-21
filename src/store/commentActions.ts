/** The Comments window: the review comments of the whole project, a jump to where one is, and "resolved" marks. */
import { selectAnimation, selectBone, setMode, setTime } from './actions';
import { docStore } from './doc';
import { toast, uiStore } from './ui';

/** Takes the editor to a comment: its animation, its moment, and the bone it points at. Returns false when the comment is gone. */
export function goToComment(animationId: string, markerId: string): boolean {
  const doc = docStore.get().skeleton;
  const anim = doc.animations.find((a) => a.id === animationId);
  const marker = anim?.markers?.find((m) => m.id === markerId);
  if (!anim || !marker) return false;
  if (uiStore.get().mode !== 'animate') setMode('animate');
  if (uiStore.get().animationId !== anim.id) selectAnimation(anim.id);
  setTime(marker.time);
  const bone = marker.bone ? doc.bones.find((b) => b.name === marker.bone) : undefined;
  if (bone) selectBone(bone.id);
  return true;
}

/** Marks one comment dealt with (or open again), whichever animation it is on. One history step. */
export function setCommentResolved(animationId: string, markerId: string, resolved: boolean): boolean {
  let done = false;
  docStore.update(resolved ? 'Resolve comment' : 'Reopen comment', (d) => {
    const m = d.skeleton.animations.find((a) => a.id === animationId)?.markers?.find((x) => x.id === markerId);
    if (!m || !m.review || !!m.resolved === resolved) return;
    m.resolved = resolved;
    done = true;
  });
  return done;
}

/** Marks every open comment dealt with. One history step; returns how many. */
export function resolveAllComments(): number {
  let n = 0;
  docStore.update('Resolve all comments', (d) => {
    for (const a of d.skeleton.animations)
      for (const m of a.markers ?? [])
        if (m.review && !m.resolved) {
          m.resolved = true;
          n++;
        }
  });
  if (n) toast(`Resolved ${n} comment${n === 1 ? '' : 's'}`, 'ok');
  return n;
}
