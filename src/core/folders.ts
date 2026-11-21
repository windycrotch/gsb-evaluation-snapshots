/**
 * Draw order folders (Spine 4.3): a folder is a group of slots; a folder timeline keys the order of just those slots. They swap places among the
 * seats they hold in the draw order (the other slots do not move). Pure helpers; the animation code, the exporters and the editor use them.
 */
import type { DrawOrderFolder, Id, SkeletonDoc } from './model';

/** The slots of a folder that exist, in setup order. */
export function folderSlotsInOrder(doc: SkeletonDoc, folder: DrawOrderFolder): Id[] {
  const members = new Set(folder.slots);
  return doc.slots.filter((s) => members.has(s.id)).map((s) => s.id);
}

/** The folder a slot is in, if any. */
export function folderOfSlot(doc: SkeletonDoc, slotId: Id): DrawOrderFolder | undefined {
  return doc.drawOrderFolders?.find((f) => f.slots.includes(slotId));
}

/** An order of a folder's slots made complete: only slots of the folder, each once, the ones left out after the rest in setup order. */
export function completeFolderOrder(setup: readonly Id[], order: readonly Id[]): Id[] {
  const members = new Set(setup);
  const out: Id[] = [];
  const seen = new Set<Id>();
  for (const id of order) {
    if (members.has(id) && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  for (const id of setup) if (!seen.has(id)) out.push(id);
  return out;
}

/**
 * The offsets Spine stores for an order: for every slot that is not where it was in `setup`, how many places it moved, in setup order.
 * (Both the JSON and the binary draw order of the skeleton and of a folder are written this way.)
 */
export function drawOrderOffsets(setup: readonly Id[], order: readonly Id[]): { id: Id; offset: number }[] {
  const full = completeFolderOrder(setup, order);
  const at = new Map(setup.map((id, i) => [id, i] as const));
  const moved: { id: Id; offset: number; from: number }[] = [];
  full.forEach((id, to) => {
    const from = at.get(id)!;
    if (from !== to) moved.push({ id, offset: to - from, from });
  });
  return moved.sort((a, b) => a.from - b.from).map(({ id, offset }) => ({ id, offset }));
}

/**
 * The new order of a folder when slot `id` is dragged so that it lands at `toIndex` of the whole draw order `order` (bottom to top): the folder's
 * slots in the order they have after the move. Null when the slot is not in a folder with another slot.
 */
export function folderOrderAfterMove(
  doc: SkeletonDoc,
  order: readonly Id[],
  id: Id,
  toIndex: number,
): { folder: DrawOrderFolder; order: Id[] } | null {
  const folder = folderOfSlot(doc, id);
  if (!folder || folder.slots.filter((s) => doc.slots.some((x) => x.id === s)).length < 2) return null;
  const moved = order.filter((s) => s !== id);
  moved.splice(Math.max(0, Math.min(moved.length, toIndex)), 0, id);
  const members = new Set(folder.slots);
  return { folder, order: moved.filter((s) => members.has(s)) };
}

/** Removes the slots that no longer exist from the folders and drops the folders left empty; returns the ids of the folders dropped. */
export function pruneFolders(doc: SkeletonDoc): Id[] {
  const gone: Id[] = [];
  if (!doc.drawOrderFolders) return gone;
  const slots = new Set(doc.slots.map((s) => s.id));
  const claimed = new Set<Id>();
  doc.drawOrderFolders = doc.drawOrderFolders.filter((f) => {
    f.slots = f.slots.filter((s) => slots.has(s) && !claimed.has(s) && !!claimed.add(s));
    if (f.slots.length) return true;
    gone.push(f.id);
    return false;
  });
  if (!doc.drawOrderFolders.length) delete doc.drawOrderFolders;
  for (const a of doc.animations) {
    if (!a.drawOrderFolder) continue;
    for (const id of gone) delete a.drawOrderFolder[id];
    if (!Object.keys(a.drawOrderFolder).length) delete a.drawOrderFolder;
  }
  return gone;
}
