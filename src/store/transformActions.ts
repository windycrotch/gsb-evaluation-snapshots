/** Transform constraints (Spine 4.3): create from presets and edit. */
import type { Draft } from 'immer';
import { freshName, makeCurve, upsertKey } from '@/core/edit';
import { matchTransformConstraint } from '@/core/matchTransform';
import { TRANSFORM_PROPS, newTransformConstraint } from '@/core/model';
import type { Id, TransformConstraint, TransformFrom, TransformProp } from '@/core/model';
import { getScene } from '@/store/scene';
import { setSelection } from './actions';
import { docStore } from './doc';
import { toast, uiStore } from './ui';

export type TransformPreset = 'rotation' | 'mirror' | 'position' | 'scale' | 'rotateToX';

export const PRESET_LABEL: Record<TransformPreset, string> = {
  rotation: 'Copy rotation',
  mirror: 'Mirror rotation',
  position: 'Copy position',
  scale: 'Copy scale',
  rotateToX: 'Rotation → X (rolling)',
};

function mapping(from: TransformProp, to: TransformProp, scale = 1): TransformFrom {
  return { prop: from, offset: 0, to: [{ prop: to, offset: 0, max: 1, scale }] };
}

function presetProperties(p: TransformPreset): TransformFrom[] {
  switch (p) {
    case 'rotation':
      return [mapping('rotate', 'rotate')];
    case 'mirror':
      return [mapping('rotate', 'rotate', -1)];
    case 'position':
      return [mapping('x', 'x'), mapping('y', 'y')];
    case 'scale':
      return [mapping('scaleX', 'scaleX'), mapping('scaleY', 'scaleY')];
    case 'rotateToX':
      return [mapping('rotate', 'x', 0.5)];
  }
}

export function createTransformConstraint(bones: Id[], source: Id, preset: TransformPreset): Id | null {
  const doc = docStore.get().skeleton;
  if (!bones.length || !source) return null;
  if (bones.includes(source)) {
    toast('The source must be a different bone than the constrained bones', 'error');
    return null;
  }
  const target = doc.bones.find((b) => b.id === bones[0]);
  const src = doc.bones.find((b) => b.id === source);
  const c = newTransformConstraint({
    name: freshName(`${target?.name ?? 'bone'} follows ${src?.name ?? 'source'}`, doc.constraints),
    bones,
    source,
    properties: presetProperties(preset),
  });
  docStore.update('Create transform constraint', (d) => {
    d.skeleton.constraints.push(c);
  });
  setSelection({ constraint: c.id });
  toast(`Transform constraint created (${PRESET_LABEL[preset].toLowerCase()})`, 'ok');
  return c.id;
}

export function updateTransform(id: Id, recipe: (c: Draft<TransformConstraint>) => void, label = 'Edit transform constraint') {
  docStore.update(label, (d) => {
    const c = d.skeleton.constraints.find((x) => x.id === id);
    if (c && c.type === 'transform') recipe(c);
  });
}

/** The constraint's current (animated, constrained) mixes, in `TRANSFORM_PROPS` order. */
export function currentTransformMix(id: Id): number[] | null {
  const c = getScene().skeleton.transformById(id);
  return c ? [...c.mix] : null;
}

/**
 * Edits mixes: the setup values in Setup mode, a key at the playhead in Animate mode. Spine keys all six mixes together, so
 * the channels that are not edited keep their current values.
 */
export function setTransformMix(id: Id, patch: Partial<Record<TransformProp, number>>, label = 'Edit transform mix') {
  const ui = uiStore.get();
  if (ui.mode === 'setup') {
    updateTransform(
      id,
      (x) => {
        for (const k of TRANSFORM_PROPS) if (patch[k] !== undefined) x.mix[k] = patch[k]!;
      },
      label,
    );
    return;
  }
  const anim = getScene().animation;
  const cur = currentTransformMix(id);
  if (!anim || !cur) return;
  const value = TRANSFORM_PROPS.map((k, i) => patch[k] ?? cur[i]);
  docStore.update(label, (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    const keys = (a.transform[id] ??= []);
    const exist = keys.find((k) => Math.abs(k.time - ui.time) < 1e-4);
    if (exist) exist.value = value;
    else {
      const curve = makeCurve(ui.defaultCurve, 6);
      upsertKey(keys, { time: ui.time, value, ...(curve !== undefined ? { curve } : {}) });
    }
    if (ui.time > a.duration) a.duration = ui.time;
  });
}

/** Match: set the offsets of the constraint so that it changes nothing in the Setup pose (see core/matchTransform.ts). One step of the history. */
export function matchTransform(id: Id): boolean {
  if (uiStore.get().mode !== 'setup') {
    toast('Match works in Setup mode', 'info');
    return false;
  }
  let result = null as ReturnType<typeof matchTransformConstraint>;
  docStore.update('Match transform constraint', (d) => {
    result = matchTransformConstraint(d.skeleton, id);
  });
  if (!result) {
    toast('Nothing to match: the constraint needs bones and a mapping', 'info');
    return false;
  }
  toast(result.firstOnly ? 'Matched to the first bone of the constraint' : 'Matched to the current pose', 'ok');
  return true;
}
