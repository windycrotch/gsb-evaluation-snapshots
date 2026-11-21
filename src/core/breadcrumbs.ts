/**
 * Breadcrumbs of the selection (Spine 4.3): where the selected thing sits, from the skeleton down: skeleton › parent bones › bone › slot › attachment.
 * Only the nearest `parents` parent bones are listed; a "…" stands for the ones left out.
 */
import type { Id, SkeletonDoc } from './model';

export interface Crumb {
  kind: 'skeleton' | 'more' | 'bone' | 'bones' | 'slot' | 'attachment' | 'constraint';
  label: string;
  /** What a click selects (a bone or slot id); absent for what cannot be selected by itself. */
  id?: Id;
}

export interface CrumbSelection {
  bones: readonly Id[];
  slot: Id | null;
  attachment: string | null;
  constraint: Id | null;
}

/** The most parents a trail shows (the setting is clamped to this). */
export const MAX_CRUMB_PARENTS = 10;

export function breadcrumbs(doc: SkeletonDoc, sel: CrumbSelection, parents = 3): Crumb[] {
  const limit = Math.max(0, Math.min(MAX_CRUMB_PARENTS, Math.floor(parents)));
  const bones = new Map(doc.bones.map((b) => [b.id, b] as const));
  const slot = sel.slot ? doc.slots.find((s) => s.id === sel.slot) : undefined;
  const constraint = sel.constraint ? doc.constraints.find((c) => c.id === sel.constraint) : undefined;
  // the bone the trail runs through: the selected one, or the bone of the selected slot
  const single = sel.bones.length === 1 ? bones.get(sel.bones[0]) : undefined;
  const boneId = slot ? slot.bone : single?.id;
  const bone = boneId ? bones.get(boneId) : undefined;
  if (!bone && !slot && !constraint && sel.bones.length < 2) return [];

  const out: Crumb[] = [{ kind: 'skeleton', label: doc.name || 'skeleton' }];
  if (bone) {
    const chain: (typeof bone)[] = [];
    let cur = bone.parent ? bones.get(bone.parent) : undefined;
    for (let guard = 0; cur && guard < doc.bones.length; guard++) {
      chain.push(cur);
      cur = cur.parent ? bones.get(cur.parent) : undefined;
    }
    const shown = chain.slice(0, limit).reverse();
    if (chain.length > shown.length) out.push({ kind: 'more', label: '…' });
    for (const b of shown) out.push({ kind: 'bone', label: b.name, id: b.id });
    out.push({ kind: 'bone', label: bone.name, id: bone.id });
  } else if (sel.bones.length > 1) {
    out.push({ kind: 'bones', label: `${sel.bones.length} bones` });
  }
  if (slot) {
    out.push({ kind: 'slot', label: slot.name, id: slot.id });
    if (sel.attachment) out.push({ kind: 'attachment', label: sel.attachment });
  }
  if (constraint) out.push({ kind: 'constraint', label: constraint.name, id: constraint.id });
  return out;
}
