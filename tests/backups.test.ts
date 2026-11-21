/** Backup history: when a copy is due, what is kept, the store over a plain Map, and restoring. */
import { beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_INTERVAL_MS, MAX_BACKUPS, addBackup, dueForBackup, fingerprint, readBackupList, removeBackup } from '../src/core/backups';
import type { BackupMeta } from '../src/core/backups';
import { emptyProject, newBone } from '../src/core/model';
import {
  backupStore,
  deleteBackup,
  maybeAutoBackup,
  readBackupText,
  refreshBackups,
  resetAutoBackupClock,
  saveBackup,
  useBackupStorage,
} from '../src/store/backups';
import { docStore } from '../src/store/doc';
import { loadProjectText, restoreBackup, serializeProject } from '../src/store/project';

const blank = (name: string) => {
  const p = emptyProject(name);
  p.skeleton.bones = [];
  return p;
};
const meta = (i: number, over: Partial<BackupMeta> = {}): BackupMeta => ({
  id: `b${i}`,
  time: i * 1000,
  name: 'p',
  why: 'auto',
  bones: 1,
  animations: 0,
  size: 10,
  hash: `h${i}`,
  ...over,
});

describe('helpers', () => {
  it('a copy is due when there is none or the last one is old', () => {
    expect(dueForBackup(null, 5)).toBe(true);
    expect(dueForBackup(1000, 1000 + BACKUP_INTERVAL_MS - 1)).toBe(false);
    expect(dueForBackup(1000, 1000 + BACKUP_INTERVAL_MS)).toBe(true);
  });
  it('the fingerprint tells different texts apart and is stable', () => {
    expect(fingerprint('abc')).toBe(fingerprint('abc'));
    expect(fingerprint('abc')).not.toBe(fingerprint('abd'));
    expect(fingerprint('')).toMatch(/-0$/);
  });
  it('addBackup puts the newest first, drops the oldest over the count, skips a repeat unless it is manual', () => {
    let list: BackupMeta[] = [];
    const dropped: string[] = [];
    for (let i = 0; i < MAX_BACKUPS + 3; i++) {
      const r = addBackup(list, meta(i));
      list = r.list;
      dropped.push(...r.dropped);
    }
    expect(list).toHaveLength(MAX_BACKUPS);
    expect(list[0].id).toBe(`b${MAX_BACKUPS + 2}`);
    expect(dropped).toEqual(['b0', 'b1', 'b2']);
    const same = addBackup(list, meta(99, { hash: list[0].hash }));
    expect(same.added).toBe(false);
    expect(addBackup(list, meta(99, { hash: list[0].hash, why: 'manual' })).added).toBe(true);
  });
  it('addBackup also keeps the total size under the limit but never drops the newest', () => {
    let list: BackupMeta[] = [];
    for (let i = 0; i < 4; i++) list = addBackup(list, meta(i, { size: 40 }), 20, 100).list;
    expect(list.map((b) => b.id)).toEqual(['b3', 'b2']);
    expect(addBackup([], meta(1, { size: 1e9 }), 20, 100).list).toHaveLength(1);
  });
  it('removeBackup and readBackupList', () => {
    expect(removeBackup([meta(1), meta(2)], 'b1').map((b) => b.id)).toEqual(['b2']);
    const read = readBackupList([meta(1), { id: 3 }, null, meta(5, { why: 'weird' as never }), 'x']);
    expect(read.map((b) => b.id)).toEqual(['b5', 'b1']);
    expect(read[0].why).toBe('auto');
    expect(readBackupList('nope')).toEqual([]);
  });
});

describe('store over a Map', () => {
  let mem: Map<string, unknown>;
  beforeEach(() => {
    mem = new Map();
    useBackupStorage({
      get: async (k) => mem.get(k),
      set: async (k, v) => void mem.set(k, structuredClone(v)),
      del: async (k) => void mem.delete(k),
    });
    backupStore.set([]);
    resetAutoBackupClock();
    docStore.replace(blank('hero'));
  });

  it('saves a copy with its text, lists it, deletes it', async () => {
    expect(await saveBackup('one', 'manual', { name: 'hero', bones: 2, animations: 1 }, 1000)).toBe(true);
    expect(await saveBackup('one', 'auto', { name: 'hero', bones: 2, animations: 1 }, 2000)).toBe(false);
    const [b] = await refreshBackups();
    expect(b.name).toBe('hero');
    expect(await readBackupText(b.id)).toBe('one');
    await deleteBackup(b.id);
    expect(backupStore.get()).toEqual([]);
    expect(await readBackupText(b.id)).toBeUndefined();
    expect([...mem.keys()]).toEqual(['backups']);
  });

  it('the copies over the limit leave the storage too', async () => {
    for (let i = 0; i < MAX_BACKUPS + 2; i++) await saveBackup(`text ${i}`, 'manual', { name: 'p', bones: 0, animations: 0 }, 1000 + i);
    expect(backupStore.get()).toHaveLength(MAX_BACKUPS);
    expect([...mem.keys()].filter((k) => k.startsWith('backup:'))).toHaveLength(MAX_BACKUPS);
  });

  it('an automatic copy waits for something in the project and for the interval', async () => {
    expect(await maybeAutoBackup('x', 0)).toBe(false); // an empty project is not worth a copy
    resetAutoBackupClock();
    const p = blank('hero');
    p.skeleton.bones.push(newBone({ name: 'root' }));
    docStore.replace(p);
    expect(await maybeAutoBackup('first', 10)).toBe(true);
    expect(await maybeAutoBackup('second', 20)).toBe(false);
    expect(await maybeAutoBackup('third', 10 + BACKUP_INTERVAL_MS)).toBe(true);
    expect(backupStore.get().map((b) => b.why)).toEqual(['auto', 'auto']);
  });

  it('restoring brings the old project back and keeps what was open as a copy first', async () => {
    const p = blank('first');
    p.skeleton.bones.push(newBone({ name: 'root' }));
    docStore.replace(p);
    await saveBackup(await serializeProject(), 'manual', { name: 'first', bones: 1, animations: 0 }, 1000);
    const second = blank('second');
    second.skeleton.bones.push(newBone({ name: 'a' }), newBone({ name: 'b' }));
    docStore.replace(second);
    docStore.dirty = true;
    const old = backupStore.get()[0];
    expect(await restoreBackup(old.id)).toBe(true);
    expect(docStore.get().name).toBe('first');
    expect(docStore.get().skeleton.bones).toHaveLength(1);
    const whys = backupStore.get().map((b) => b.why);
    expect(whys).toContain('restore');
    const kept = backupStore.get().find((b) => b.why === 'restore')!;
    const text = (await readBackupText(kept.id))!;
    await loadProjectText(text);
    expect(docStore.get().name).toBe('second');
  });

  it('a missing copy is reported and nothing changes', async () => {
    expect(await restoreBackup('nope')).toBe(false);
  });
});
