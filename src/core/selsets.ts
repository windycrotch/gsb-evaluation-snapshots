/**
 * Selection sets: groups of bones kept under a name ("left arm", "tail") so that one click selects them again. They belong to the skeleton
 * and are saved in the project file; they are editor data and are not exported. The bones are held by id, so a rename does not break a set.
 */
import { uid, uniqueName } from './ids';
import type { Id, SelectionSet, SkeletonDoc } from './model';

/** The bones of a set that still exist, in the order of the hierarchy. */
export function setBones(doc: SkeletonDoc, set: SelectionSet): Id[] {
  const members = new Set(set.bones);
  return doc.bones.filter((b) => members.has(b.id)).map((b) => b.id);
}

export function newSetName(sets: readonly SelectionSet[], wanted = 'Set'): string {
  return uniqueName(
    wanted.trim() || 'Set',
    sets.map((s) => s.name),
  );
}

export function newSelectionSet(doc: SkeletonDoc, bones: readonly Id[], name?: string): SelectionSet {
  const alive = new Set(doc.bones.map((b) => b.id));
  return { id: uid(), name: newSetName(doc.selectionSets ?? [], name), bones: [...new Set(bones)].filter((id) => alive.has(id)) };
}

/** Takes the removed bones out of the sets; a set left with no bone goes too (and the list with it when it is empty). */
export function dropBonesFromSets(doc: SkeletonDoc, gone: ReadonlySet<Id>) {
  if (!doc.selectionSets) return;
  for (const s of doc.selectionSets) s.bones = s.bones.filter((b) => !gone.has(b));
  doc.selectionSets = doc.selectionSets.filter((s) => s.bones.length > 0);
  if (!doc.selectionSets.length) delete doc.selectionSets;
}

/** True when the selection is exactly the (living) bones of the set. */
export function selectionIs(doc: SkeletonDoc, set: SelectionSet, selected: readonly Id[]): boolean {
  const mine = setBones(doc, set);
  return mine.length === selected.length && mine.every((id) => selected.includes(id));
}

/** The ids to select after a click on a set: the set alone, or added to what is selected (Shift), or taken out of it when it is all selected already. */
export function pickSet(doc: SkeletonDoc, set: SelectionSet, selected: readonly Id[], additive: boolean): Id[] {
  const mine = setBones(doc, set);
  if (!additive) return mine;
  const all = mine.every((id) => selected.includes(id));
  if (all) return selected.filter((id) => !mine.includes(id));
  return [...new Set([...selected, ...mine])];
}
