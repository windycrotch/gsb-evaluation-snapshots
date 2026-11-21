/** Animations: create, rename, duplicate, delete, length, time cuts, bake, layers, crossfade. */
import { animationEndTime } from '@/core/animate';
import { DEFAULT_TOLERANCE, bakeAnimation, bakeSkips, scaleTolerance, simplifyAnimation } from '@/core/bake';
import type { BakeOptions } from '@/core/bake';
import { applyCrossfade, fadeRefusal } from '@/core/crossfade';
import type { Crossfade } from '@/core/crossfade';
import { layerBones, stackLayer } from '@/core/layers';
import type { LayerOptions } from '@/core/layers';
import { cleanUpAnimation } from '@/core/cleanup';
import { closeLoop } from '@/core/loops';
import { freshName } from '@/core/edit';
import { deleteTime, insertTime } from '@/core/timeshift';
import { newAnimation } from '@/core/model';
import type { Animation, Id } from '@/core/model';
import { removeAnimation } from '@/core/problems';
import { docStore } from './doc';
import { toast, uiStore } from './ui';
import { currentAnimation, skeletonDoc } from './accessors';

export function createAnimation(name?: string, duration = 1): Id {
  const doc = skeletonDoc();
  const anim = newAnimation(freshName(name?.trim() || 'animation', doc.animations), duration);
  docStore.update('New animation', (d) => {
    d.skeleton.animations.push(anim);
  });
  uiStore.patch({ animationId: anim.id, time: 0, playing: false, overrides: {}, selectedKeys: [] });
  return anim.id;
}

/** Removes the keys of an animation that change nothing. Returns how many keys went. */
export function cleanUpKeys(id: Id): number {
  let removed = 0;
  docStore.update('Clean up animation', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === id);
    if (a) removed = cleanUpAnimation(a);
  });
  uiStore.patch({ selectedKeys: [] });
  toast(removed ? `Removed ${removed} keys that change nothing` : 'Nothing to clean up: every key does something', removed ? 'ok' : 'info');
  return removed;
}

/** Makes the end of the current animation the same as its start (or the start the same as the end). Returns how many timelines changed. */
export function closeCurrentLoop(keep: 'first' | 'last', selectedOnly: boolean): number {
  const anim = currentAnimation();
  if (!anim) return 0;
  const bones = selectedOnly ? uiStore.get().selection.bones : undefined;
  let changed = 0;
  docStore.update('Close the loop', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (a) changed = closeLoop(a, { keep, bones });
  });
  toast(changed ? `Closed the loop on ${changed} timelines` : 'The end already matches the start', changed ? 'ok' : 'info');
  return changed;
}

/** Drops the keys of the bone timelines that a curve does not need (`strength` scales the tolerance). Returns how many keys went. */
export function simplifyCurrentAnimation(strength: number, selectedOnly: boolean): number {
  const anim = currentAnimation();
  if (!anim) return 0;
  const bones = selectedOnly ? uiStore.get().selection.bones : undefined;
  let removed = 0;
  docStore.update('Simplify keys', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (a) removed = simplifyAnimation(a, scaleTolerance(DEFAULT_TOLERANCE, strength), d.skeleton.fps, bones);
  });
  uiStore.patch({ selectedKeys: [] });
  toast(
    removed ? `Removed ${removed} keys, the curves stay within the tolerance` : 'No key can go without changing the motion',
    removed ? 'ok' : 'info',
  );
  return removed;
}

/** Writes the result of the constraints (IK, physics, sliders ...) into plain bone keys of a new animation. Returns its id. */
export function bakeCurrentAnimation(options: Partial<BakeOptions>): Id | null {
  const anim = currentAnimation();
  if (!anim) return null;
  const doc = skeletonDoc();
  const baked = bakeAnimation(doc, anim, { ...options, skinId: uiStore.get().skinId });
  baked.name = freshName(`${anim.name} baked`, doc.animations);
  docStore.update('Bake animation', (d) => {
    d.skeleton.animations.push(baked);
  });
  selectAnimation(baked.id);
  const skipped = bakeSkips(doc, anim);
  if (skipped.length)
    toast(
      `Baked into "${baked.name}", but path constraint "${skipped.join('", "')}" has no path on some frames: its bones are not baked`,
      'info',
      7000,
    );
  else toast(`Baked into "${baked.name}": ${Object.keys(baked.bones).length} bones carry keys`, 'ok');
  return baked.id;
}

/** Bakes `layer` on top of the current animation into a new animation (breathing over a walk). Returns its id. */
export function layerCurrentAnimation(layerId: Id, options: Partial<LayerOptions>): Id | null {
  const anim = currentAnimation();
  const doc = skeletonDoc();
  const layer = doc.animations.find((x) => x.id === layerId);
  if (!anim || !layer) return null;
  if (layer.id === anim.id) {
    toast('Choose another animation for the layer', 'error');
    return null;
  }
  const ids = new Set(doc.bones.map((x) => x.id));
  const moved = layerBones(layer, ids);
  if (!moved.length) {
    toast(`"${layer.name}" moves no bones`, 'info');
    return null;
  }
  const out = stackLayer(anim, layer, ids, doc.fps, options);
  out.name = freshName(`${anim.name} + ${layer.name}`, doc.animations);
  docStore.update('Layer animation', (d) => {
    d.skeleton.animations.push(out);
  });
  selectAnimation(out.id);
  toast(`Layered "${layer.name}" over "${anim.name}" into "${out.name}": ${moved.length} bones`, 'ok');
  return out.id;
}

/** Fades the pictures of a slot into each other where this animation changes them (a second slot shows the old picture). Returns the partner slot. */
export function crossfadeSlot(slotId: Id, seconds: number): Id | null {
  const anim = currentAnimation();
  const doc = skeletonDoc();
  const slot = doc.slots.find((s) => s.id === slotId);
  if (!anim || !slot) return null;
  const why = fadeRefusal(doc, slot, anim);
  if (why) {
    toast(
      why === 'no-keys'
        ? 'This animation changes no picture of the slot'
        : why === 'two-color'
          ? 'A slot with a dark color cannot fade'
          : why === 'color-keys'
            ? 'The slot already has color keys in this animation'
            : 'This slot changes no picture',
      'info',
    );
    return null;
  }
  if (!applyCrossfade(structuredClone(doc), anim.id, slotId, seconds)) {
    toast('No change of picture is long enough to fade', 'info');
    return null;
  }
  let made: Crossfade | null = null;
  docStore.update('Crossfade pictures', (d) => {
    made = applyCrossfade(d.skeleton, anim.id, slotId, seconds);
  });
  const got = made as Crossfade | null;
  if (!got) return null;
  uiStore.patch({ selectedKeys: [] });
  toast(
    `Faded ${got.fades} changes of picture; "${skeletonDoc().slots.find((s) => s.id === got.partner)?.name ?? ''}" shows the old pictures`,
    'ok',
  );
  return got.partner;
}

export function selectAnimation(id: Id) {
  uiStore.patch({ animationId: id, time: 0, playing: false, overrides: {}, selectedKeys: [] });
}

export function renameAnimation(id: Id, name: string) {
  const clean = name.trim();
  if (!clean) return;
  const doc = skeletonDoc();
  docStore.update('Rename animation', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === id);
    if (a)
      a.name = freshName(
        clean,
        doc.animations.filter((x) => x.id !== id),
      );
  });
}

export function duplicateAnimation(id: Id) {
  const doc = skeletonDoc();
  const src = doc.animations.find((a) => a.id === id);
  if (!src) return;
  const copy: Animation = { ...structuredClone(src), id: newAnimation('x').id, name: freshName(src.name + ' copy', doc.animations) };
  docStore.update('Duplicate animation', (d) => {
    d.skeleton.animations.push(copy);
  });
  selectAnimation(copy.id);
}

export function deleteAnimation(id: Id) {
  docStore.update('Delete animation', (d) => {
    // sliders that applied it simply do nothing until another animation is chosen; the mix table forgets it
    removeAnimation(d, id);
  });
  const ui = uiStore.get();
  if (ui.animationId === id) {
    const next = skeletonDoc().animations[0]?.id ?? null;
    uiStore.patch({ animationId: next, time: 0, playing: false, overrides: {}, selectedKeys: [], mode: next ? ui.mode : 'setup' });
  }
}

/** Insert time: `frames` of empty time at the playhead; every key, marker and the play range from the playhead on move later, the animation grows. One undo step. */
export function insertTimeAtPlayhead(frames: number): boolean {
  const anim = currentAnimation();
  const ui = uiStore.get();
  const n = Math.round(frames);
  if (!anim || !(n >= 1)) return false;
  const seconds = n / skeletonDoc().fps;
  docStore.update('Insert time', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (a) insertTime(a, ui.time, seconds);
  });
  uiStore.patch({ selectedKeys: [] });
  toast(`Inserted ${n} frame${n === 1 ? '' : 's'} at ${ui.time.toFixed(2)} s`, 'ok');
  return true;
}

/** Delete time: `frames` from the playhead on are cut out; the keys inside go, the later ones move earlier, the animation gets shorter. One undo step. */
export function deleteTimeAtPlayhead(frames: number): boolean {
  const anim = currentAnimation();
  const ui = uiStore.get();
  const n = Math.round(frames);
  if (!anim || !(n >= 1)) return false;
  if (ui.time >= anim.duration - 1e-6) {
    toast('Nothing to delete after the playhead', 'info');
    return false;
  }
  const fps = skeletonDoc().fps;
  docStore.update('Delete time', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (a) deleteTime(a, ui.time, n / fps, 1 / fps);
  });
  uiStore.patch({ selectedKeys: [], time: Math.min(ui.time, currentAnimation()?.duration ?? ui.time) });
  toast(`Deleted ${n} frame${n === 1 ? '' : 's'} from ${ui.time.toFixed(2)} s`, 'ok');
  return true;
}

export function setAnimationDuration(id: Id, duration: number) {
  const anim = skeletonDoc().animations.find((a) => a.id === id);
  if (!anim) return;
  // an export derives the length from the last key, so a shorter value would play differently in the game
  const end = animationEndTime(anim);
  if (duration < end - 1e-6) toast('An animation cannot be shorter than its last key — delete or move the keys first');
  const d0 = Math.max(1 / skeletonDoc().fps, duration, end);
  docStore.update('Animation length', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === id);
    if (a) {
      a.duration = d0;
      for (const m of a.markers ?? []) m.time = Math.min(m.time, d0); // a marker never lies beyond the end
    }
  });
  if (uiStore.get().time > d0) uiStore.patch({ time: d0 });
}

export function setFps(fps: number) {
  const f = Math.max(1, Math.min(240, Math.round(fps)));
  docStore.update('Set FPS', (d) => {
    d.skeleton.fps = f;
  });
}
