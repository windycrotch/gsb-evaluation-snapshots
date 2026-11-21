/** Physics constraints (Spine 4.2+): create, edit, and key their parameters. */
import { freshName, makeCurve, upsertKey } from '@/core/edit';
import { GLOBAL_PHYSICS, newPhysicsConstraint } from '@/core/model';
import type { Id, PhysicsConstraint, PhysicsParam } from '@/core/model';
import { getScene, restartScene } from '@/store/scene';
import { setSelection } from './actions';
import { docStore } from './doc';
import { toast, uiStore } from './ui';

/** Creates a physics constraint on the first selected bone (it swings, stretches or shears that bone as the animation plays). */
export function createPhysicsConstraint(): Id | null {
  const doc = docStore.get().skeleton;
  const sel = uiStore.get().selection;
  const bone = doc.bones.find((b) => sel.bones.includes(b.id));
  if (!bone) {
    toast('Select the bone that should swing', 'error');
    return null;
  }
  if (!bone.parent) {
    toast('The root bone has nothing to hang on: select a child bone', 'error');
    return null;
  }
  const c = newPhysicsConstraint({ name: freshName(`${bone.name} physics`, doc.constraints), bone: bone.id });
  docStore.update('Create physics constraint', (d) => {
    d.skeleton.constraints.push(c);
  });
  setSelection({ constraint: c.id });
  toast(`Physics constraint "${c.name}" created: play an animation to see it`, 'ok');
  return c.id;
}

/** Edits a physics constraint (structure and setup pose). */
export function updatePhysicsConstraint(id: Id, recipe: (c: PhysicsConstraint) => void, label = 'Edit physics constraint') {
  docStore.update(label, (d) => {
    const c = d.skeleton.constraints.find((x) => x.id === id);
    if (c && c.type === 'physics') recipe(c);
  });
}

/** What the simulation can run with: a negative mass, a damping above 1 (the speed would grow with every step) would break it. */
export function clampPhysicsValue(param: PhysicsParam, v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (param === 'mass') return Math.max(0.01, v);
  if (param === 'damping') return Math.min(1, Math.max(0, v)); // above 1 every step would multiply the speed
  if (param === 'mix') return Math.max(0, v);
  return v;
}

/** The constraint's current (animated) value of a parameter. */
export function currentPhysicsValue(id: Id, param: PhysicsParam): number | null {
  const c = getScene().skeleton.physicsById(id);
  return c ? c.getParam(param) : null;
}

/**
 * Edits a parameter: the setup value in Setup mode, a key at the playhead in Animate mode. A parameter that is driven globally
 * is keyed on the animation's global timeline, where every constraint that opted in shares it.
 */
export function setPhysicsValue(id: Id, param: PhysicsParam, raw: number, label = 'Edit physics constraint') {
  const value = clampPhysicsValue(param, raw);
  const ui = uiStore.get();
  if (ui.mode === 'setup') {
    updatePhysicsConstraint(id, (c) => void (c[param] = value), label);
    return;
  }
  const anim = getScene().animation;
  if (!anim) return;
  docStore.update(label, (d) => {
    const c = d.skeleton.constraints.find((x) => x.id === id);
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a || !c || c.type !== 'physics') return;
    const tl = ((a.physics ??= {})[c.global[param] ? GLOBAL_PHYSICS : id] ??= {});
    const keys = (tl[param] ??= []);
    const exist = keys.find((k) => Math.abs(k.time - ui.time) < 1e-4);
    if (exist) exist.value = [value];
    else {
      const curve = makeCurve(ui.defaultCurve, 1);
      upsertKey(keys, { time: ui.time, value: [value], ...(curve !== undefined ? { curve } : {}) });
    }
    if (ui.time > a.duration) a.duration = ui.time;
  });
}

/** Puts a reset key at the playhead: the simulation of the constraint (or of all of them, `GLOBAL_PHYSICS`) restarts there. */
export function addPhysicsReset(id: Id, label = 'Key a physics reset') {
  const ui = uiStore.get();
  const anim = getScene().animation;
  if (!anim) return;
  docStore.update(label, (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    const tl = ((a.physics ??= {})[id] ??= {});
    const keys = (tl.reset ??= []);
    if (!keys.some((k) => Math.abs(k.time - ui.time) < 1e-4)) upsertKey(keys, { time: ui.time, value: [1] });
    if (ui.time > a.duration) a.duration = ui.time;
  });
}

/** Forgets what the simulation has learned: it starts again from rest at the next frame. */
export function restartPhysics() {
  restartScene();
  uiStore.patch({ overrides: { ...uiStore.get().overrides } }); // a new object: everything repaints
}
