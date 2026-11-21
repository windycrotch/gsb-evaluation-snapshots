/** Micro-move: Alt + the arrow keys move the selected bones by a unit (Shift: ten), or, with keys selected in the timeline, move the keys by a frame and change their values. */
import { decodeKey, encodeKey, resolveKeys } from '@/core/keyrefs';
import type { KeyRef } from '@/core/keyrefs';
import { arrowSteps, nudgeValue } from '@/core/nudge';
import type { Id } from '@/core/model';
import { getScene } from '@/store/scene';
import { currentAnimation, moveKeysBy, setBonePose } from './actions';
import { docStore } from './doc';
import { uiStore } from './ui';

/** The selected bones that move on their own: a bone whose parent (or higher ancestor) is selected comes along with it. */
function leaders(): Id[] {
  const doc = docStore.get().skeleton;
  const sel = new Set(uiStore.get().selection.bones.filter((id) => doc.bones.some((b) => b.id === id)));
  const parentOf = new Map(doc.bones.map((b) => [b.id, b.parent] as const));
  return [...sel].filter((id) => {
    for (let p = parentOf.get(id) ?? null; p; p = parentOf.get(p) ?? null) if (sel.has(p)) return false;
    return true;
  });
}

/** Moves the selected bones by (dx, dy) in the scene (y up). Setup mode edits the setup pose, Animate mode keys the bones. Returns how many moved. */
export function nudgeBones(dx: number, dy: number): number {
  const skeleton = getScene().skeleton;
  const updates = leaders().flatMap((id) => {
    const bone = skeleton.boneById(id);
    if (!bone) return [];
    const [x, y] = bone.parent ? bone.parent.worldToLocal(bone.worldX + dx, bone.worldY + dy) : [bone.worldX + dx, bone.worldY + dy];
    return [{ id, props: { x, y } }];
  });
  if (!updates.length) return 0;
  setBonePose(updates, 'Nudge bones');
  return updates.length;
}

/** Moves the selected keys by `frames` frames; the selection follows them. */
export function nudgeKeysTime(frames: number): number {
  const ui = uiStore.get();
  const refs = ui.selectedKeys.map(decodeKey);
  if (!refs.length) return 0;
  const moved = moveKeysBy(refs, frames / docStore.get().skeleton.fps);
  uiStore.patch({ selectedKeys: moved.map(encodeKey) });
  return refs.length;
}

/** Adds `steps` steps to the values of the selected bone keys (see core/nudge for what a step is). Returns how many keys changed. */
export function nudgeKeyValues(steps: number): number {
  const anim = currentAnimation();
  const refs = uiStore
    .get()
    .selectedKeys.map(decodeKey)
    .filter((r): r is KeyRef => r.kind === 'bone');
  if (!anim || !refs.length || !steps) return 0;
  let changed = 0;
  docStore.update('Nudge key values', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    for (const ref of refs) {
      const keys = resolveKeys(a, ref);
      const k = keys?.find((x) => Math.abs(x.time - ref.time) < 1e-4);
      if (k?.value) {
        k.value = nudgeValue(ref.prop, k.value, steps);
        changed++;
      }
    }
  });
  return changed;
}

/**
 * What Alt + an arrow does. With keys selected and the timeline in use: left / right move the keys, up / down change their values. Otherwise
 * the selected bones move. Returns true when something happened.
 */
export function microMove(key: 'arrowleft' | 'arrowright' | 'arrowup' | 'arrowdown', big: boolean, inTimeline: boolean): boolean {
  const { dx, dy } = arrowSteps(key, big);
  const ui = uiStore.get();
  if (inTimeline && ui.mode === 'animate' && ui.selectedKeys.length) return dx ? nudgeKeysTime(dx) > 0 : nudgeKeyValues(dy) > 0;
  return nudgeBones(dx, dy) > 0;
}
