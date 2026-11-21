/**
 * Backup history: copies of the project kept in the browser next to the autosave, so a bad hour can be taken back. Pure helpers (when to take one,
 * which to keep); src/store/backups.ts keeps them in IndexedDB and the History window lists them.
 */
export type BackupWhy = 'auto' | 'manual' | 'open' | 'new' | 'restore';

export interface BackupMeta {
  id: string;
  /** When it was taken, ms since 1970. */
  time: number;
  name: string;
  why: BackupWhy;
  bones: number;
  animations: number;
  /** Characters of the stored text (the pictures are inside it). */
  size: number;
  /** A cheap fingerprint of the text: the same project is not stored twice in a row. */
  hash: string;
}

/** At most this many copies are kept, and at most this many characters of text altogether. */
export const MAX_BACKUPS = 20;
const MAX_BACKUP_CHARS = 150_000_000;
/** An automatic copy is taken when the project changed and the last copy is older than this. */
export const BACKUP_INTERVAL_MS = 5 * 60 * 1000;

/** FNV-1a over the text, in hex, with the length. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}-${text.length}`;
}

/** True when an automatic copy is due: there is none yet, or the last one is old enough. */
export function dueForBackup(last: number | null, now: number, interval = BACKUP_INTERVAL_MS): boolean {
  return last === null || now - last >= interval;
}

/**
 * Puts a copy at the front of the list (newest first) and drops what is over the limits, oldest first. Returns the new list and the ids dropped.
 * A copy with the same fingerprint as the newest one is not added (nothing changed), unless it is a manual one, which is always kept.
 */
export function addBackup(
  list: readonly BackupMeta[],
  meta: BackupMeta,
  maxCount = MAX_BACKUPS,
  maxChars = MAX_BACKUP_CHARS,
): { list: BackupMeta[]; dropped: string[]; added: boolean } {
  if (list[0] && list[0].hash === meta.hash && meta.why !== 'manual') return { list: [...list], dropped: [], added: false };
  const next = [meta, ...list];
  const dropped: string[] = [];
  let total = next.reduce((n, b) => n + b.size, 0);
  while (next.length > 1 && (next.length > maxCount || total > maxChars)) {
    const gone = next.pop()!;
    total -= gone.size;
    dropped.push(gone.id);
  }
  return { list: next, dropped, added: true };
}

/** Takes one copy out of the list. */
export const removeBackup = (list: readonly BackupMeta[], id: string): BackupMeta[] => list.filter((b) => b.id !== id);

/** Reads the stored list back, keeping only what is well formed (the newest first). */
export function readBackupList(raw: unknown): BackupMeta[] {
  if (!Array.isArray(raw)) return [];
  const out: BackupMeta[] = [];
  const why = new Set<BackupWhy>(['auto', 'manual', 'open', 'new', 'restore']);
  for (const b of raw as Partial<BackupMeta>[]) {
    if (!b || typeof b.id !== 'string' || typeof b.time !== 'number' || typeof b.hash !== 'string' || typeof b.size !== 'number') continue;
    out.push({
      id: b.id,
      time: b.time,
      name: typeof b.name === 'string' ? b.name : '',
      why: why.has(b.why as BackupWhy) ? (b.why as BackupWhy) : 'auto',
      bones: Number(b.bones) || 0,
      animations: Number(b.animations) || 0,
      size: b.size,
      hash: b.hash,
    });
  }
  return out.sort((a, b) => b.time - a.time);
}
