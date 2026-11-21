/** The browser's IndexedDB as a tiny key-value store: the autosave and the handles of recent files live here. */

const DB = 'bone2d';
/** Database name from before the project was renamed from "Marrow": an autosave left there is still restored, the next one goes to `DB`. */
export const LEGACY_DB = 'marrow';
const STORE = 'kv';

const FAILED = new Error('IndexedDB request failed');

function open(name = DB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      if (name === DB) req.result.createObjectStore(STORE);
      else req.transaction?.abort(); // the legacy database is only read: do not create an empty one when it does not exist
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? FAILED);
  });
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? FAILED);
  });
  db.close();
}

export async function idbGet<T = unknown>(key: string, name = DB): Promise<T | undefined> {
  const db = await open(name);
  const v = await new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error ?? FAILED);
  });
  db.close();
  return v;
}

export async function idbDelete(key: string): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? FAILED);
  });
  db.close();
}
