/**
 * Selection history (Spine's PgUp / PgDn): the places the selection has been, to go back to the bone or slot that was selected a moment ago
 * and forward again. Only a selection that holds something is remembered; what no longer exists is skipped over.
 */
import type { SkeletonDoc } from '@/core/model';
import type { Id } from '@/core/model';
import { docStore } from './doc';
import { toast, uiStore } from './ui';
import type { Selection } from './ui';

export type SelEntry = Pick<Selection, 'bones' | 'slot' | 'attachment' | 'constraint'>;

const holds = (e: SelEntry) => e.bones.length > 0 || e.slot !== null || e.constraint !== null;
const same = (a: SelEntry, b: SelEntry) =>
  a.slot === b.slot &&
  a.attachment === b.attachment &&
  a.constraint === b.constraint &&
  a.bones.length === b.bones.length &&
  a.bones.every((id, i) => id === b.bones[i]);

export class SelectionHistory {
  list: SelEntry[] = [];
  /** The entry that is current (-1: none yet). */
  at = -1;

  constructor(readonly max = 100) {}

  /** A new selection: anything that was "forward" is forgotten. A selection equal to the current one, or an empty one, is not remembered. */
  push(sel: SelEntry) {
    if (!holds(sel)) return;
    if (this.at >= 0 && same(this.list[this.at], sel)) return;
    this.list.splice(this.at + 1);
    this.list.push({ bones: [...sel.bones], slot: sel.slot, attachment: sel.attachment, constraint: sel.constraint });
    if (this.list.length > this.max) this.list.shift();
    this.at = this.list.length - 1;
  }

  /** Goes one entry back (-1) or forward (1), over the entries `valid` refuses. Null (and no move) when there is none. */
  move(dir: -1 | 1, valid: (e: SelEntry) => boolean): SelEntry | null {
    let i = this.at + dir;
    while (i >= 0 && i < this.list.length && !valid(this.list[i])) i += dir;
    if (i < 0 || i >= this.list.length) return null;
    this.at = i;
    return this.list[i];
  }

  clear() {
    this.list = [];
    this.at = -1;
  }
}

/** Whether every bone, slot, attachment and constraint of the entry is still in the skeleton. */
export function entryExists(doc: SkeletonDoc, e: SelEntry): boolean {
  const ids = (list: { id: Id }[]) => new Set(list.map((x) => x.id));
  const bones = ids(doc.bones);
  if (!e.bones.every((b) => bones.has(b))) return false;
  if (e.slot !== null && !doc.slots.some((s) => s.id === e.slot)) return false;
  if (e.attachment !== null && !(e.slot !== null && doc.skins[0]?.attachments[e.slot]?.[e.attachment])) return false;
  return e.constraint === null || doc.constraints.some((c) => c.id === e.constraint);
}

export const selectionHistory = new SelectionHistory();

let applying = false;

function go(dir: -1 | 1): boolean {
  const doc = docStore.get().skeleton;
  const entry = selectionHistory.move(dir, (e) => entryExists(doc, e));
  if (!entry) {
    toast(dir < 0 ? 'No earlier selection' : 'No later selection', 'info');
    return false;
  }
  applying = true;
  try {
    uiStore.patch({
      selection: { bones: [...entry.bones], slot: entry.slot, attachment: entry.attachment, constraint: entry.constraint, vertices: [] },
    });
  } finally {
    applying = false;
  }
  return true;
}

/** Back to the selection before this one (PgUp). */
export const selectionBack = () => go(-1);
/** Forward again after going back (PgDn). */
export const selectionForward = () => go(1);

/** Starts remembering selections as they change; returns the function that stops it. */
export function startSelectionHistory(): () => void {
  let last = uiStore.get().selection;
  selectionHistory.push(last);
  return uiStore.subscribe(() => {
    const sel = uiStore.get().selection;
    if (sel === last) return;
    last = sel;
    if (!applying) selectionHistory.push(sel);
  });
}
