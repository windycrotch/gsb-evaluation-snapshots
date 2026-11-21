/** Backup history in the browser (IndexedDB): the list lives under one key, every copy under its own. Taking and restoring never throws into the editor. */
import { BACKUP_INTERVAL_MS, addBackup, dueForBackup, fingerprint, readBackupList, removeBackup as dropFromList } from '@/core/backups';
import type { BackupMeta, BackupWhy } from '@/core/backups';
import { docStore } from './doc';
import { idbDelete, idbGet, idbSet } from './idb';
import { createStore, useStore } from './store';

/** Where the copies are kept; the tests put a plain Map here. */
export interface BackupStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}
const idbStorage: BackupStorage = { get: (k) => idbGet(k), set: idbSet, del: idbDelete };
let storage: BackupStorage = idbStorage;
export const useBackupStorage = (s: BackupStorage | null) => void ((storage = s ?? idbStorage), (loaded = false));

const INDEX = 'backups';
export const backupStore = createStore<BackupMeta[]>([]);
export const useBackups = () => useStore(backupStore, (s) => s);

let loaded = false;
/** A chain so two copies taken at once cannot overwrite each other's list. */
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
};

export async function refreshBackups(): Promise<BackupMeta[]> {
  try {
    backupStore.set(readBackupList(await storage.get(INDEX)));
    loaded = true;
  } catch (e) {
    console.warn('backups could not be read', e);
  }
  return backupStore.get();
}

/** Stores a copy of `text`; resolves to whether one was added. `info` says what the project holds. */
export function saveBackup(
  text: string,
  why: BackupWhy,
  info: { name: string; bones: number; animations: number },
  now = Date.now(),
): Promise<boolean> {
  return serial(async () => {
    try {
      if (!loaded) await refreshBackups();
      const meta: BackupMeta = {
        id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        time: now,
        name: info.name,
        why,
        bones: info.bones,
        animations: info.animations,
        size: text.length,
        hash: fingerprint(text),
      };
      const res = addBackup(backupStore.get(), meta);
      if (!res.added) return false;
      await storage.set(`backup:${meta.id}`, text);
      await storage.set(INDEX, res.list);
      for (const id of res.dropped) await storage.del(`backup:${id}`).catch(() => undefined);
      backupStore.set(res.list);
      return true;
    } catch (e) {
      console.warn('backup failed', e);
      return false;
    }
  });
}

export function readBackupText(id: string): Promise<string | undefined> {
  return storage.get(`backup:${id}`).then((v) => (typeof v === 'string' ? v : undefined));
}

export function deleteBackup(id: string): Promise<void> {
  return serial(async () => {
    try {
      const list = dropFromList(backupStore.get(), id);
      await storage.set(INDEX, list);
      await storage.del(`backup:${id}`);
      backupStore.set(list);
    } catch (e) {
      console.warn('backup could not be deleted', e);
    }
  });
}

/** True when the open project holds something worth keeping. */
export function hasContent(): boolean {
  const p = docStore.get();
  return p.skeleton.bones.length > 0 || p.skeleton.slots.length > 0 || p.images.length > 0 || p.skeleton.animations.length > 0;
}

export function describeProject() {
  const p = docStore.get();
  return { name: p.name || 'untitled', bones: p.skeleton.bones.length, animations: p.skeleton.animations.length };
}

let lastAuto: number | null = null;
/** After an autosave: takes an automatic copy when the last one is old enough. `text` is what the autosave just wrote. */
export function maybeAutoBackup(text: string, now = Date.now()): Promise<boolean> {
  if (!dueForBackup(lastAuto, now, BACKUP_INTERVAL_MS) || !hasContent()) return Promise.resolve(false);
  lastAuto = now;
  return saveBackup(text, 'auto', describeProject(), now);
}
export const resetAutoBackupClock = () => void (lastAuto = null);
