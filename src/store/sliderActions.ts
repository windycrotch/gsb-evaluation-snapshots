/** Slider constraints (Spine 4.3): create, edit, and key their time / mix. */
import { freshName, makeCurve, upsertKey } from '@/core/edit';
import type { Id, SliderConstraint } from '@/core/model';
import { newSliderConstraint } from '@/core/model';
import { getScene } from '@/store/scene';
import { setSelection } from './actions';
import { docStore } from './doc';
import { toast, uiStore } from './ui';

/**
 * Creates a slider. By default it applies the first animation that is not the one being edited (a slider is normally
 * used to blend a *separate* pose animation in); with a bone it is driven by that bone's rotation.
 */
export function createSlider(boneId: Id | null = null): Id {
  const doc = docStore.get().skeleton;
  const current = uiStore.get().animationId;
  const animation = doc.animations.find((a) => a.id !== current) ?? null;
  const c = newSliderConstraint({
    name: freshName('slider', doc.constraints),
    animation: animation?.id ?? null,
    bone: boneId && doc.bones.some((b) => b.id === boneId) ? boneId : null,
    mix: 1,
  });
  docStore.update('Create slider', (d) => {
    d.skeleton.constraints.push(c);
  });
  setSelection({ constraint: c.id });
  toast(animation ? `Slider "${c.name}" created` : `Slider "${c.name}" created — create an animation for it to apply`, 'ok');
  return c.id;
}

/** Edits the structural / setup properties of a slider (animation, driver bone, mapping, flags, setup mix and time). */
export function updateSlider(id: Id, patch: Partial<Omit<SliderConstraint, 'id' | 'type'>>, label = 'Edit slider') {
  docStore.update(label, (d) => {
    const c = d.skeleton.constraints.find((x) => x.id === id);
    if (!c || c.type !== 'slider') return;
    Object.assign(c, patch);
    if (patch.bone === null) c.bone = null;
  });
}

export interface SliderValues {
  time: number;
  mix: number;
}

/** The slider's current (animated, constrained) time and mix. */
export function currentSliderValues(id: Id): SliderValues | null {
  const c = getScene().skeleton.sliderById(id);
  return c ? { time: c.time, mix: c.mix } : null;
}

/** Edits time / mix: the setup values in Setup mode, a key at the playhead in Animate mode. */
export function setSliderValues(id: Id, patch: Partial<SliderValues>, label = 'Edit slider') {
  const ui = uiStore.get();
  if (ui.mode === 'setup') {
    updateSlider(id, patch, label);
    return;
  }
  const scene = getScene();
  const anim = scene.animation;
  const cur = currentSliderValues(id);
  if (!anim || !cur) return;
  const next = { ...cur, ...patch };
  docStore.update(label, (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    const tl = (a.slider[id] ??= {});
    for (const prop of ['time', 'mix'] as const) {
      if (patch[prop] === undefined) continue;
      const keys = (tl[prop] ??= []);
      const exist = keys.find((k) => Math.abs(k.time - ui.time) < 1e-4);
      if (exist) exist.value = [next[prop]];
      else {
        const curve = makeCurve(ui.defaultCurve, 1);
        upsertKey(keys, { time: ui.time, value: [next[prop]], ...(curve !== undefined ? { curve } : {}) });
      }
    }
    if (ui.time > a.duration) a.duration = ui.time;
  });
}
