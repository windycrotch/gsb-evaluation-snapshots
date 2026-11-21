/** Keys of a timeline: delete, move, curves, channel values, the key clipboard. */
import { animationEndTime } from '@/core/animate';
import { KEY_EPS, keyAt, linearBetweenEqual, makeCurve, rgba2ToRgba, sameKeyValue, snapTime, upsertKey } from '@/core/edit';
import { moveKeys, removeKeys, resolveKeys, retargetClip } from '@/core/keyrefs';
import type { KeyRef } from '@/core/keyrefs';
import { curveOfKey, withSavedCurve } from '@/core/savedCurves';
import { RAD2DEG } from '@/core/math';
import type { Id, Key } from '@/core/model';
import { docStore } from './doc';
import { setSettings, settingsStore } from './settings';
import { toast, uiStore } from './ui';
import { currentAnimation, skeletonDoc } from './accessors';
import { ensureBoneTimelines, extendDuration } from './boneActions';

export function deleteKeys(refs: KeyRef[]) {
  const anim = currentAnimation();
  if (!anim || !refs.length) return;
  docStore.update('Delete keys', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (a) removeKeys(a, refs);
  });
}

/** `ripple`: the later keys of each timeline come along (Shift keys). `loop`: the keys travel round the animation's length (Offset keys). */
export function moveKeysBy(refs: KeyRef[], dt: number, ripple = false, loop = false): KeyRef[] {
  const anim = currentAnimation();
  if (!anim || !refs.length) return refs;
  let result = refs;
  docStore.update('Move keys', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    result = moveKeys(a, refs, dt, ripple, loop ? a.duration : 0);
    // a ripple also moved keys that are not in `refs`: the animation must still cover the last one (a loop never leaves the animation)
    if (!loop) extendDuration(a, ripple ? animationEndTime(a) : Math.max(...result.map((r) => r.time)));
  });
  return result;
}

/** Sets the interpolation of the referenced keys (applies to the segment that starts at each key). */
/** Keeps the curve of the key `ref` under a name (Timeline menu → Save this curve). Returns false when the key has no bezier curve to keep. */
export function saveKeyCurve(ref: KeyRef): boolean {
  const anim = currentAnimation();
  if (!anim) return false;
  const keys = resolveKeys(anim, ref);
  const key = keyAt(keys, ref.time);
  const curve = curveOfKey(key?.curve);
  if (!curve) {
    toast('Only a bezier curve can be saved: this key has a linear or stepped interpolation', 'info');
    return false;
  }
  const before = settingsStore.get().savedCurves;
  const next = withSavedCurve(before, curve);
  if (next.length === before.length && next.every((c, i) => c.name === before[i].name)) {
    toast('This curve is already saved', 'info');
    return false;
  }
  setSettings({ savedCurves: next });
  toast(`Saved as "${next[next.length - 1].name}"`, 'ok');
  return true;
}

/** Forgets the saved curve at `index`. */
export function forgetSavedCurve(index: number) {
  const list = settingsStore.get().savedCurves;
  if (index >= 0 && index < list.length) setSettings({ savedCurves: list.filter((_, i) => i !== index) });
}

export function setKeysCurve(refs: KeyRef[], kind: 'linear' | 'stepped' | 'bezier' | number[]) {
  const anim = currentAnimation();
  if (!anim || !refs.length) return;
  docStore.update('Set interpolation', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    for (const ref of refs) {
      const keys = resolveKeys(a, ref);
      const k = keyAt(keys, ref.time);
      if (!k || !('value' in k) || !k.value) continue;
      const channels = ref.kind === 'deform' ? 1 : k.value.length;
      if (kind === 'linear') delete k.curve;
      else if (kind === 'stepped') k.curve = 'stepped';
      else if (kind === 'bezier') k.curve = makeCurve('bezier', channels);
      else {
        const c: number[] = [];
        for (let i = 0; i < channels; i++) c.push(...kind.slice(0, 4));
        k.curve = c;
      }
    }
  });
  // "last chosen": the next new key starts with this interpolation (a custom curve counts as smooth)
  if (settingsStore.get().lastChosenCurve) uiStore.patch({ defaultCurve: kind === 'linear' || kind === 'stepped' ? kind : 'bezier' });
}

/** Edits one channel of one key (graph editor). */
export function setKeyChannelValue(ref: KeyRef, channel: number, value: number) {
  const anim = currentAnimation();
  if (!anim) return;
  docStore.update('Edit key value', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    const keys = resolveKeys(a, ref);
    const k = keyAt(keys, ref.time);
    if (k?.value) k.value[channel] = value;
  });
}

/** Moves one bezier handle (1 or 2) of a key's curve for a channel. x in 0..1 of the segment, y relative to the value change. */
export function setKeyCurveHandle(ref: KeyRef, channel: number, handle: 1 | 2, nx: number, ny: number) {
  const anim = currentAnimation();
  if (!anim) return;
  docStore.update('Edit curve', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    const keys = resolveKeys(a, ref);
    const k = keyAt(keys, ref.time);
    if (!k || !k.value) return;
    const channels = ref.kind === 'deform' ? 1 : k.value.length;
    let curve = k.curve;
    if (!Array.isArray(curve)) {
      curve = [];
      for (let c = 0; c < channels; c++) curve.push(1 / 3, 1 / 3, 2 / 3, 2 / 3);
    }
    const arr = curve;
    const i = channel * 4 + (handle === 1 ? 0 : 2);
    arr[i] = Math.max(0, Math.min(1, nx));
    arr[i + 1] = ny;
    k.curve = arr;
  });
}

interface ClipKey {
  kind: KeyRef['kind'];
  target: Id;
  prop: string;
  dt: number;
  key: Record<string, unknown>;
}
let clipboard: ClipKey[] = [];

export function copyKeys(refs: KeyRef[]) {
  const anim = currentAnimation();
  if (!anim || !refs.length) return;
  const min = Math.min(...refs.map((r) => r.time));
  clipboard = [];
  for (const r of refs) {
    const keys = resolveKeys(anim, r);
    const k = keys?.find((x) => Math.abs(x.time - r.time) < 1e-4);
    if (k) clipboard.push({ kind: r.kind, target: r.target, prop: r.prop, dt: r.time - min, key: structuredClone(k) });
  }
  toast(`Copied ${clipboard.length} key${clipboard.length === 1 ? '' : 's'}`);
}

/** Pastes the copied keys at `time`. With `hold` (Paste Keys - Hold) a segment between pasted keys that hold the same value becomes linear. */
export function pasteKeys(time: number, hold = false): KeyRef[] {
  const anim = currentAnimation();
  if (!anim || !clipboard.length) return [];
  const out: KeyRef[] = [];
  const doc = skeletonDoc();
  const fps = doc.fps;
  // keys copied from one bone go onto the bone that is selected now (the other arm), keys from several bones onto as many selected bones, else back where they came from
  const sel = uiStore.get().selection;
  const items = retargetClip(
    clipboard,
    sel.bones.filter((id) => doc.bones.some((b) => b.id === id)),
    sel.slot && doc.slots.some((s) => s.id === sel.slot) ? sel.slot : null,
    doc.bones.map((b) => b.id),
  );
  docStore.update('Paste keys', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    for (const original of items) {
      let c = original;
      // colour keys follow the target slot: two-colour keys need a dark colour there, and a two-colour slot keeps its kind of keys
      if (c.kind === 'slot' && (c.prop === 'rgba' || c.prop === 'rgba2')) {
        const dark = !!d.skeleton.slots.find((s) => s.id === c.target)?.dark;
        if (c.prop === 'rgba2' && !dark)
          c = { ...c, prop: 'rgba', key: rgba2ToRgba([c.key as unknown as Key])[0] as unknown as Record<string, unknown> }; // the curve loses its dark channels too
        else if (c.prop === 'rgba' && dark) continue;
      }
      const t = snapTime(time + c.dt, fps);
      let keys = resolveKeys(a, c);
      if (!keys) {
        // create the timeline container
        if (c.kind === 'bone') (ensureBoneTimelines(a, c.target) as Record<string, unknown>)[c.prop] = keys = [];
        else if (c.kind === 'slot') ((a.slots[c.target] ??= {}) as Record<string, unknown>)[c.prop] = keys = [];
        else if (c.kind === 'ik') keys = a.ik[c.target] = [];
        else if (c.kind === 'transform') keys = a.transform[c.target] = [];
        else if (c.kind === 'slider') ((a.slider[c.target] ??= {}) as Record<string, unknown>)[c.prop] = keys = [];
        else if (c.kind === 'path') ((a.path[c.target] ??= {}) as Record<string, unknown>)[c.prop] = keys = [];
        else if (c.kind === 'physics') ((a.physics[c.target] ??= {}) as Record<string, unknown>)[c.prop] = keys = [];
        else if (c.kind === 'deform') {
          const [skinId, att] = c.prop.split('\u0001');
          keys = ((a.deform[skinId] ??= {})[c.target] ??= {})[att] = [];
        } else if (c.kind === 'sequence') {
          const [skinId, att] = c.prop.split('\u0001');
          keys = (((a.sequence ??= {})[skinId] ??= {})[c.target] ??= {})[att] = [];
        }
      }
      if (!keys) continue;
      // a pasted key that says what the key there already says changes nothing, so the curve that was drawn on it stays
      const there = (keys as { time: number }[]).find((k) => Math.abs(k.time - t) <= KEY_EPS);
      if (!there || !sameKeyValue(there, c.key)) upsertKey(keys as { time: number }[], { ...c.key, time: t });
      out.push({ kind: c.kind, target: c.target, prop: c.prop, time: t });
    }
    extendDuration(a, Math.max(...out.map((o) => o.time)));
    if (hold) {
      const seen = new Map<unknown, number[]>();
      for (const o of out) {
        const keys = resolveKeys(a, o);
        if (keys) seen.set(keys, [...(seen.get(keys) ?? []), o.time]);
      }
      for (const [keys, times] of seen) linearBetweenEqual(keys as { time: number; value?: number[]; curve?: unknown }[], times);
    }
  });
  return out;
}

export { RAD2DEG };
