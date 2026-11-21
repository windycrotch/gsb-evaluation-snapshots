/** What the hierarchy shows while a name is typed into its filter, and what "show all" / "isolate" hide. Pure functions over the document. */
import type { Id, SkeletonDoc } from './model';
import { nameMatcher } from './rename';

export interface TreeMatch {
  /** False for an empty filter: everything is shown. */
  active: boolean;
  /** Bones to show: those that match plus every ancestor of what matches. */
  bones: Set<Id>;
  slots: Set<Id>;
  constraints: Set<Id>;
  skins: Set<Id>;
  events: Set<Id>;
  /** The bones and slots whose own name (or, for a slot, image name) matches, in the order of the document: what Select takes (`bones` also holds their ancestors). */
  matchedBones: Id[];
  matchedSlots: Id[];
}

/**
 * The part of the tree that matches a filter. Every word typed has to be in the name (any case). A slot also matches by the names of its
 * images in any skin; a matching node shows with the bones above it, so it is never left hanging in the air.
 */
export function filterTree(doc: SkeletonDoc, query: string): TreeMatch {
  const has = nameMatcher(query);
  const out: TreeMatch = {
    active: has !== null,
    bones: new Set(),
    slots: new Set(),
    constraints: new Set(),
    skins: new Set(),
    events: new Set(),
    matchedBones: [],
    matchedSlots: [],
  };
  if (!has) return out;
  const byId = new Map(doc.bones.map((b) => [b.id, b]));
  const showWithAncestors = (id: Id | null) => {
    for (let at = id ? byId.get(id) : undefined; at && !out.bones.has(at.id); at = at.parent ? byId.get(at.parent) : undefined)
      out.bones.add(at.id);
  };
  for (const b of doc.bones) {
    if (!has(b.name)) continue;
    out.matchedBones.push(b.id);
    showWithAncestors(b.id);
  }
  for (const s of doc.slots) {
    const byImage = doc.skins.some((k) => Object.keys(k.attachments[s.id] ?? {}).some(has));
    if (has(s.name) || byImage) {
      out.slots.add(s.id);
      out.matchedSlots.push(s.id);
      showWithAncestors(s.bone);
    }
  }
  for (const c of doc.constraints) if (has(c.name)) out.constraints.add(c.id);
  for (const k of doc.skins) if (has(k.name)) out.skins.add(k.id);
  for (const e of doc.events) if (has(e.name)) out.events.add(e.id);
  return out;
}

/**
 * What "Select" takes from a filter (Spine's tree search has the same button): the bones that match, and the slots that match as the selected
 * slot and the slots selected with it. Nothing for an inactive filter.
 */
export function selectionOfMatch(match: TreeMatch): { bones: Id[]; slot: Id | null; extraSlots: Id[] } {
  if (!match.active) return { bones: [], slot: null, extraSlots: [] };
  const [slot = null, ...extraSlots] = match.matchedSlots;
  return { bones: [...match.matchedBones], slot, extraSlots };
}

/** The bones and slots that are hidden in the viewport. */
export function hiddenOf(doc: SkeletonDoc): { bones: Id[]; slots: Id[] } {
  return { bones: doc.bones.filter((b) => b.hidden).map((b) => b.id), slots: doc.slots.filter((s) => s.hidden).map((s) => s.id) };
}

/**
 * What to hide so only the selection shows. A selected slot: every other slot goes. Selected bones: everything outside them and their
 * children goes (bones and the slots on them). Nothing selected: nothing to isolate (null).
 */
export function isolation(doc: SkeletonDoc, bones: readonly Id[], slot: Id | null): { bones: Set<Id>; slots: Set<Id> } | null {
  if (slot && doc.slots.some((s) => s.id === slot))
    return { bones: new Set(), slots: new Set(doc.slots.filter((s) => s.id !== slot).map((s) => s.id)) };
  const picked = bones.filter((id) => doc.bones.some((b) => b.id === id));
  if (!picked.length) return null;
  const keep = new Set<Id>(picked);
  for (let grew = true; grew;) {
    grew = false;
    for (const b of doc.bones)
      if (b.parent && keep.has(b.parent) && !keep.has(b.id)) {
        keep.add(b.id);
        grew = true;
      }
  }
  return {
    bones: new Set(doc.bones.filter((b) => !keep.has(b.id)).map((b) => b.id)),
    slots: new Set(doc.slots.filter((s) => !keep.has(s.bone)).map((s) => s.id)),
  };
}
