/** Path constraints (Spine 4.3): create, edit, and key their position / spacing / mixes. */
import { freshName, makeCurve, upsertKey } from '@/core/edit';
import { newPathConstraint } from '@/core/model';
import type { Id, PathConstraint } from '@/core/model';
import { getScene } from '@/store/scene';
import { setSelection } from './actions';
import { docStore } from './doc';
import { toast, uiStore } from './ui';

/**
 * Creates a path constraint that moves the selected bones along a path. The path is the one in the selected slot, else in the
 * first slot that holds one. The bones keep their hierarchy order (the first one starts the chain).
 */
export function createPathConstraint(): Id | null {
  const doc = docStore.get().skeleton;
  const sel = uiStore.get().selection;
  const skin = doc.skins[0];
  const holdsPath = (slotId: Id) => Object.values(skin?.attachments[slotId] ?? {}).some((a) => a.type === 'path');
  const target = sel.slot && holdsPath(sel.slot) ? sel.slot : doc.slots.find((s) => holdsPath(s.id))?.id;
  if (!target) {
    toast('Draw a path first (Path tool, N)', 'error');
    return null;
  }
  const bones = doc.bones.filter((b) => sel.bones.includes(b.id)).map((b) => b.id);
  if (!bones.length) {
    toast('Select the bones that should follow the path', 'error');
    return null;
  }
  const c = newPathConstraint({ name: freshName('path constraint', doc.constraints), bones, target });
  docStore.update('Create path constraint', (d) => {
    d.skeleton.constraints.push(c);
  });
  setSelection({ constraint: c.id });
  toast(`Path constraint "${c.name}" created`, 'ok');
  return c.id;
}

/** Edits a path constraint (structure and setup pose). */
export function updatePathConstraint(id: Id, recipe: (c: PathConstraint) => void, label = 'Edit path constraint') {
  docStore.update(label, (d) => {
    const c = d.skeleton.constraints.find((x) => x.id === id);
    if (c && c.type === 'path') recipe(c);
  });
}

export interface PathValues {
  position: number;
  spacing: number;
  /** rotate, x, y */
  mix: [number, number, number];
}

/** The constraint's current (animated) position, spacing and mixes. */
export function currentPathValues(id: Id): PathValues | null {
  const c = getScene().skeleton.pathById(id);
  return c ? { position: c.position, spacing: c.spacing, mix: [c.mix[0], c.mix[1], c.mix[2]] } : null;
}

/** Edits position / spacing / mixes: the setup values in Setup mode, a key at the playhead in Animate mode. */
export function setPathValues(
  id: Id,
  patch: { position?: number; spacing?: number; mix?: Partial<{ rotate: number; x: number; y: number }> },
  label = 'Edit path constraint',
) {
  const ui = uiStore.get();
  if (ui.mode === 'setup') {
    updatePathConstraint(
      id,
      (c) => {
        if (patch.position !== undefined) c.position = patch.position;
        if (patch.spacing !== undefined) c.spacing = patch.spacing;
        if (patch.mix?.rotate !== undefined) c.mix.rotate = patch.mix.rotate;
        if (patch.mix?.x !== undefined) c.mix.x = patch.mix.x;
        if (patch.mix?.y !== undefined) c.mix.y = patch.mix.y;
      },
      label,
    );
    return;
  }
  const anim = getScene().animation;
  const cur = currentPathValues(id);
  if (!anim || !cur) return;
  docStore.update(label, (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    a.path ??= {};
    const tl = (a.path[id] ??= {});
    const put = (prop: 'position' | 'spacing' | 'mix', value: number[]) => {
      const keys = (tl[prop] ??= []);
      const exist = keys.find((k) => Math.abs(k.time - ui.time) < 1e-4);
      if (exist) exist.value = value;
      else {
        const curve = makeCurve(ui.defaultCurve, value.length);
        upsertKey(keys, { time: ui.time, value, ...(curve !== undefined ? { curve } : {}) });
      }
    };
    if (patch.position !== undefined) put('position', [patch.position]);
    if (patch.spacing !== undefined) put('spacing', [patch.spacing]);
    if (patch.mix) put('mix', [patch.mix.rotate ?? cur.mix[0], patch.mix.x ?? cur.mix[1], patch.mix.y ?? cur.mix[2]]);
    if (ui.time > a.duration) a.duration = ui.time;
  });
}
