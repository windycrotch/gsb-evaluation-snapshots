/** Draw order folders: put a slot into a folder (or out of it), rename a folder, delete it. */
import { freshName } from '@/core/edit';
import { pruneFolders } from '@/core/folders';
import { uid } from '@/core/ids';
import type { Id, Project } from '@/core/model';
import { docStore } from './doc';

/** The keys of the folders only list the slots they hold now. */
function tidyKeys(d: Project) {
  const members = new Map((d.skeleton.drawOrderFolders ?? []).map((f) => [f.id, new Set(f.slots)] as const));
  for (const a of d.skeleton.animations) {
    for (const id of Object.keys(a.drawOrderFolder ?? {})) {
      const set = members.get(id);
      if (!set) delete a.drawOrderFolder![id];
      else for (const k of a.drawOrderFolder![id]) k.order = k.order.filter((s) => set.has(s));
    }
    if (a.drawOrderFolder && !Object.keys(a.drawOrderFolder).length) delete a.drawOrderFolder;
  }
}

/** Puts a slot into a folder (`'new'` makes one for it), or takes it out of its folder (`null`). A slot is in one folder at most. */
export function setSlotFolder(slotId: Id, folder: Id | null) {
  const before = docStore.get().skeleton.drawOrderFolders?.find((f) => f.slots.includes(slotId))?.id ?? null;
  if (folder === before) return;
  docStore.update(folder === null ? 'Take slot out of its folder' : 'Put slot in a folder', (d) => {
    const doc = d.skeleton;
    for (const f of doc.drawOrderFolders ?? []) f.slots = f.slots.filter((s) => s !== slotId);
    if (folder === 'new') {
      (doc.drawOrderFolders ??= []).push({ id: uid(), name: freshName('folder', doc.drawOrderFolders), slots: [slotId] });
    } else if (folder !== null) doc.drawOrderFolders?.find((f) => f.id === folder)?.slots.push(slotId);
    pruneFolders(doc);
    tidyKeys(d);
  });
}

export function renameFolder(id: Id, name: string) {
  const clean = name.trim();
  if (!clean) return;
  docStore.update('Rename folder', (d) => {
    const list = d.skeleton.drawOrderFolders ?? [];
    const f = list.find((x) => x.id === id);
    if (f)
      f.name = freshName(
        clean,
        list.filter((x) => x.id !== id),
      );
  });
}

/** Deletes the folder with its keys; the slots stay. */
export function deleteFolder(id: Id) {
  docStore.update('Delete folder', (d) => {
    d.skeleton.drawOrderFolders = (d.skeleton.drawOrderFolders ?? []).filter((f) => f.id !== id);
    if (!d.skeleton.drawOrderFolders.length) delete d.skeleton.drawOrderFolders;
    tidyKeys(d);
  });
}
