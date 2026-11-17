// Tiny IndexedDB wrapper for persisting the library across page reloads.
// Imported audio files (Blobs), their analysis and the playlist order are
// stored locally so a refresh no longer loses everything.

const DB_NAME = "autodj";
const DB_VERSION = 1;
const TRACK_STORE = "tracks";
const META_STORE = "meta";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TRACK_STORE)) {
        db.createObjectStore(TRACK_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function run(storeName, mode, action) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        const request = action(store);
        transaction.oncomplete = () => resolve(request?.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      })
  );
}

// A track record holds everything needed to restore a track: the original File
// (cloneable by IndexedDB), its analysis and status. The object URL is never
// stored — it is recreated on load.
export function saveTrackRecord(record) {
  return run(TRACK_STORE, "readwrite", (store) => store.put(record));
}

export function deleteTrackRecord(id) {
  return run(TRACK_STORE, "readwrite", (store) => store.delete(id));
}

export function clearTrackRecords() {
  return run(TRACK_STORE, "readwrite", (store) => store.clear());
}

export function getAllTrackRecords() {
  return run(TRACK_STORE, "readonly", (store) => store.getAll());
}

export function saveMeta(key, value) {
  return run(META_STORE, "readwrite", (store) => store.put(value, key));
}

export function getMeta(key) {
  return run(META_STORE, "readonly", (store) => store.get(key));
}
