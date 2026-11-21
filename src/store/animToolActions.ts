/** Actions for the animation tools: wiggle, mirror a half cycle, hide the bones an animation does not touch. */
import { mirrorCycle, unkeyedBones, wiggleKeys } from '@/core/animtools';
import type { MirrorOptions, WiggleOptions } from '@/core/animtools';
import { makeCurve, upsertKey } from '@/core/edit';
import { decodeKey, resolveKeys } from '@/core/keyrefs';
import { rotationLimitOf } from '@/core/limits';
import { tweenBone } from '@/core/tween';
import type { BoneProp, Key } from '@/core/model';
import { currentAnimation } from './actions';
import { docStore } from './doc';
import { toast, uiStore } from './ui';

/** Number timelines among the selected keys, once each (a timeline with several selected keys is shaken once). */
function selectedTimelines(anim: NonNullable<ReturnType<typeof currentAnimation>>) {
  const seen = new Set<unknown>();
  const out: ReturnType<typeof decodeKey>[] = [];
  for (const enc of uiStore.get().selectedKeys) {
    const ref = decodeKey(enc);
    const keys = resolveKeys(anim, ref) as Key[] | undefined;
    if (!keys?.length || !Array.isArray(keys[0].value) || ref.kind === 'deform' || ref.prop === 'reset' || seen.has(keys)) continue;
    seen.add(keys);
    out.push(ref);
  }
  return out;
}

/** Wiggle on the timelines of the selected keys. Returns how many timelines were changed. */
export function wiggleSelected(options: Omit<WiggleOptions, 'fps'>): number {
  const anim = currentAnimation();
  if (!anim) return 0;
  const refs = selectedTimelines(anim);
  if (!refs.length) {
    toast('Select keys in the timeline first (click the name of a row to take all its keys)');
    return 0;
  }
  const fps = docStore.get().skeleton.fps;
  let changed = 0;
  docStore.update('Wiggle', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    for (const ref of refs) {
      const keys = resolveKeys(a, ref) as Key[] | undefined;
      if (!keys || keys.length < 2) continue;
      const next = wiggleKeys(JSON.parse(JSON.stringify(keys)) as Key[], { ...options, fps });
      if (next === keys) continue;
      // a colour outside 0..1 never shows and cannot be exported, so the shake stays inside
      if (ref.kind === 'slot' && ref.prop.startsWith('rgba'))
        for (const k of next) k.value = k.value.map((x) => Math.min(1, Math.max(0, x)));
      keys.splice(0, keys.length, ...next);
      changed++;
    }
  });
  if (!changed) toast('A timeline needs two keys or more to wiggle');
  return changed;
}

/** Makes a full cycle from the open half cycle as a new animation. Returns its id. */
export function mirrorCurrentCycle(options: MirrorOptions): string | null {
  const anim = currentAnimation();
  if (!anim) return null;
  if (anim.duration <= 0) {
    toast('The animation has no length to mirror');
    return null;
  }
  const doc = docStore.get().skeleton;
  let name = `${anim.name} full`;
  for (let i = 2; doc.animations.some((a) => a.name === name); i++) name = `${anim.name} full ${i}`;
  const made = mirrorCycle(doc, anim, name, options);
  docStore.update('Mirror the cycle', (d) => {
    d.skeleton.animations.push(made);
  });
  uiStore.patch({ animationId: made.id, time: 0, playing: false, overrides: {}, selectedKeys: [] });
  toast(`Made "${name}": the second half is the first with left and right swapped`, 'ok');
  return made.id;
}

/** Hides the bones that have no key in the open animation. Returns how many were hidden. */
export function hideUnkeyedBones(): number {
  const anim = currentAnimation();
  if (!anim) {
    toast('Select an animation first');
    return 0;
  }
  const ids = new Set(unkeyedBones(docStore.get().skeleton, anim));
  if (!ids.size) {
    toast('Every bone has keys in this animation');
    return 0;
  }
  docStore.update('Hide bones without keys', (d) => {
    for (const b of d.skeleton.bones) b.hidden = ids.has(b.id);
  });
  return ids.size;
}

/**
 * Puts the selected bones between their previous and next keys at the playhead (0 = the previous key, 1 = the next, outside 0..1 overshoots).
 * Every channel a bone has keys on gets a key at the playhead; an existing key there keeps its curve. Returns how many bones were posed.
 */
export function tweenSelected(amount: number): number {
  const ui = uiStore.get();
  const anim = currentAnimation();
  if (!anim || ui.mode !== 'animate') return 0;
  const doc = docStore.get().skeleton;
  const ids = ui.selection.bones.filter((id) => doc.bones.some((b) => b.id === id));
  if (!ids.length) return 0;
  const t = ui.time;
  let posed = 0;
  docStore.update('Tween', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    for (const id of ids) {
      // a bone with a rotation limit is turned by its control bone, so the rotation keys are there
      const limit = rotationLimitOf(d.skeleton, id);
      const values = tweenBone(a, id, t, amount, limit ? limit.control : id);
      let any = false;
      for (const prop of Object.keys(values) as BoneProp[]) {
        const owner = prop === 'rotate' && limit ? limit.control : id;
        const tl = (a.bones[owner] ??= {}) as Record<string, { time: number; value: number[]; curve?: unknown }[]>;
        const keys = (tl[prop] ??= []);
        const hit = keys.find((k) => Math.abs(k.time - t) < 1e-4);
        if (hit) hit.value = values[prop]!;
        else {
          const curve = makeCurve(ui.defaultCurve, values[prop]!.length);
          upsertKey(keys, { time: t, value: values[prop]!, ...(curve !== undefined ? { curve } : {}) });
        }
        any = true;
      }
      if (any) posed++;
    }
    if (posed && t > a.duration) a.duration = t;
  });
  if (posed) {
    const overrides = { ...uiStore.get().overrides };
    for (const id of ids) delete overrides[id]; // the keys now say where these bones are
    uiStore.patch({ overrides });
  }
  return posed;
}
