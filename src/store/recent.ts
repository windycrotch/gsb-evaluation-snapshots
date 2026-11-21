/**
 * Recent projects. A project opened or saved through the browser's file picker leaves its file handle in IndexedDB, so the Welcome
 * window can open it again with one click (the browser asks for permission once per session). Browsers without file handles
 * (Firefox, Safari) have no recent list: a file there is only ever picked from the disk by hand.
 */
import { uid } from '@/core/ids';
import { idbDelete, idbGet, idbSet } from './idb';

/** What the File System Access API gives us; only the parts used here. */
export interface FileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  isSameEntry(other: FileHandle): Promise<boolean>;
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}

export interface RecentEntry {
  id: string;
  name: string;
  /** When it was last opened or saved (ms). */
  time: number;
}

export const MAX_RECENT = 8;
const INDEX = 'recent:index';
const handleKey = (id: string) => `recent:${id}`;

/** The list with `entry` first and at most `max` entries: an entry with the same id moves to the front instead of appearing twice. */
export function mergeRecent(list: RecentEntry[], entry: RecentEntry, max = MAX_RECENT): RecentEntry[] {
  return [entry, ...list.filter((e) => e.id !== entry.id)].slice(0, max);
}

export async function listRecent(): Promise<RecentEntry[]> {
  try {
    const list = await idbGet<RecentEntry[]>(INDEX);
    return Array.isArray(list) ? list.filter((e) => e && typeof e.id === 'string' && typeof e.name === 'string') : [];
  } catch {
    return [];
  }
}

/** Puts a file at the top of the list (a file already in it keeps its entry). */
export async function rememberRecent(handle: FileHandle): Promise<void> {
  try {
    const list = await listRecent();
    let id: string | null = null;
    for (const e of list) {
      const other = await idbGet<FileHandle>(handleKey(e.id));
      if (other && (await other.isSameEntry(handle).catch(() => false))) {
        id = e.id;
        break;
      }
    }
    id ??= uid();
    const next = mergeRecent(list, { id, name: handle.name, time: Date.now() });
    await idbSet(handleKey(id), handle);
    await idbSet(INDEX, next);
    // handles of the entries that fell off the end are not needed any more
    for (const e of list) if (!next.some((n) => n.id === e.id)) await idbDelete(handleKey(e.id)).catch(() => undefined);
  } catch (e) {
    console.warn('could not remember the file', e);
  }
}

export async function recentHandle(id: string): Promise<FileHandle | undefined> {
  return idbGet<FileHandle>(handleKey(id));
}

export async function forgetRecent(id: string): Promise<void> {
  try {
    const list = await listRecent();
    await idbSet(
      INDEX,
      list.filter((e) => e.id !== id),
    );
    await idbDelete(handleKey(id));
  } catch (e) {
    console.warn('could not forget the file', e);
  }
}

/** True when this browser can keep file handles. */
export const canKeepHandles = (): boolean => typeof window !== 'undefined' && 'showOpenFilePicker' in window && 'indexedDB' in window;
