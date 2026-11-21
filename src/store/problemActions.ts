/** The Metrics window's problems: one click puts a warning right (one history step), "fix all" does the safe ones together (see core/problems.ts). */
import type { Finding } from '@/core/lint';
import { closeLoop } from '@/core/loops';
import type { StressFinding } from '@/core/stress';
import { fixAllSafe, fixProblem } from '@/core/problems';
import { projectWarnings } from '@/core/stats';
import type { Warning } from '@/core/stats';
import { selectAnimation, selectBone, setSelection, setTime } from './actions';
import { docStore } from './doc';
import { toast, uiStore } from './ui';

/** The editor shows an animation that was just deleted: it moves to the first one that is left, or back to Setup. */
function keepAnimationValid() {
  const ui = uiStore.get();
  const animations = docStore.get().skeleton.animations;
  if (!ui.animationId || animations.some((a) => a.id === ui.animationId)) return;
  const next = animations[0]?.id ?? null;
  uiStore.patch({ animationId: next, time: 0, playing: false, overrides: {}, selectedKeys: [], mode: next ? ui.mode : 'setup' });
}

/** Fixes one warning. Returns true when the project changed. */
export function fixWarning(w: Warning): boolean {
  let done = false;
  docStore.update('Fix problem', (d) => {
    done = fixProblem(d, w);
  });
  if (!done) {
    toast('Nothing to fix: it was already put right', 'info');
    return false;
  }
  keepAnimationValid();
  return true;
}

/** Fixes every warning that has a safe fix, in one step. Returns how many were fixed. */
export function fixAllSafeWarnings(): number {
  let n = 0;
  docStore.update('Fix problems', (d) => {
    n = fixAllSafe(d, projectWarnings(d));
  });
  toast(n ? `Fixed ${n} problem${n === 1 ? '' : 's'}` : 'Nothing to fix', n ? 'ok' : 'info');
  return n;
}

/** A click on a warning: takes you to the thing it is about, where that can be shown. */
export function revealWarning(w: Warning): void {
  const ref = w.ref;
  if (!ref) return;
  if (ref.animation && w.kind === 'emptyAnimation')
    uiStore.patch({ animationId: ref.animation, time: 0, playing: false, overrides: {}, selectedKeys: [] });
  else if (ref.slot) setSelection({ slot: ref.slot, attachment: ref.name ?? null, bones: uiStore.get().selection.bones });
}

/** The animation check offers one fix: the end of a cycle is made the same as its start. Returns how many timelines changed. */
export function fixFinding(f: Finding): number {
  if (f.kind !== 'loopSeam' || !f.animation) return 0;
  let changed = 0;
  docStore.update('Close the loop', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === f.animation);
    if (a) changed = closeLoop(a);
  });
  toast(changed ? `Closed the loop on ${changed} timelines` : 'The end already matches the start', changed ? 'ok' : 'info');
  return changed;
}

/** A click on a finding: the animation, the moment and the bone it is about, where it has them. */
export function revealFinding(f: Finding): void {
  if (f.animation && docStore.get().skeleton.animations.some((a) => a.id === f.animation)) {
    selectAnimation(f.animation);
    if (f.time !== undefined) setTime(f.time);
  }
  if (f.bone && docStore.get().skeleton.bones.some((b) => b.id === f.bone)) selectBone(f.bone);
}

/** A click on a finding of the rig test: the bone that was turned and the mesh that folded. */
export function revealStress(f: StressFinding): void {
  const doc = docStore.get().skeleton;
  if (!doc.slots.some((x) => x.id === f.slot)) return;
  setSelection({ slot: f.slot, attachment: f.mesh, bones: doc.bones.some((b) => b.id === f.bone) ? [f.bone] : [] });
}
