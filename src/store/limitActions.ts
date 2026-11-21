/** Rotation limits (a sector a bone may swing in): add, change and remove. The model is in core/limits. */
import { addRotationLimit, limitRefusal, removeRotationLimit, rotationLimitOf, setRotationLimitRange } from '@/core/limits';
import type { Id } from '@/core/model';
import { setSelection } from './actions';
import { docStore } from './doc';
import { toast } from './ui';

/** Gives the bone a sector of ±`half` degrees around its current rotation. */
export function addLimit(boneId: Id, half = 60): Id | null {
  const doc = docStore.get().skeleton;
  const refusal = limitRefusal(doc, boneId);
  if (refusal) {
    toast(refusal, 'error');
    return null;
  }
  const bone = doc.bones.find((b) => b.id === boneId)!;
  let control: Id | null = null;
  docStore.update('Add rotation limit', (d) => {
    control = addRotationLimit(d.skeleton, boneId, Math.round(bone.rotation - half), Math.round(bone.rotation + half));
  });
  if (control) {
    setSelection({ bones: [boneId] });
    toast('Rotation limit added: rotate the control bone, the limited bone follows inside the sector', 'ok');
  }
  return control;
}

export function setLimit(boneId: Id, min: number, max: number) {
  if (!(max > min)) return;
  const cur = rotationLimitOf(docStore.get().skeleton, boneId);
  if (!cur || (cur.min === min && cur.max === max)) return;
  docStore.update('Edit rotation limit', (d) => {
    setRotationLimitRange(d.skeleton, boneId, min, max);
  });
}

export function removeLimit(boneId: Id) {
  if (!rotationLimitOf(docStore.get().skeleton, boneId)) return;
  docStore.update('Remove rotation limit', (d) => {
    removeRotationLimit(d.skeleton, boneId);
  });
  setSelection({ bones: [boneId] });
}
