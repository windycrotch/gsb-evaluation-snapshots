/*
 * fs-handles.js
 *
 * Persists FileSystemFileHandle objects in IndexedDB. Handles are
 * structured-cloneable but NOT JSON-serializable, so they must never be
 * stored in localStorage or written into an exported JSON file.
 *
 * All operations fail soft: an IndexedDB failure (private mode, quota,
 * unsupported environment) resolves to null / no-op instead of breaking
 * playback, which then simply uses the manual re-pick fallback.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FsHandles = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DB_NAME = "neovid-db";
  var DB_VERSION = 1;
  var STORE_NAME = "file-handles";

  var dbPromise = null;

  function isAvailable() {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  }

  function openDb() {
    if (!isAvailable()) {
      return Promise.reject(new Error("IndexedDB is not available"));
    }
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error);
      };
    });

    /* Do not cache a rejected promise: a later call may succeed. */
    dbPromise.catch(function () {
      dbPromise = null;
    });

    return dbPromise;
  }

  function withStore(mode, action) {
    return openDb().then(
      function (db) {
        return new Promise(function (resolve, reject) {
          var transaction = db.transaction(STORE_NAME, mode);
          var store = transaction.objectStore(STORE_NAME);
          var request = action(store);
          transaction.oncomplete = function () {
            resolve(request ? request.result : undefined);
          };
          transaction.onerror = function () {
            reject(transaction.error);
          };
          transaction.onabort = function () {
            reject(transaction.error);
          };
        });
      }
    );
  }

  function saveHandle(key, handle) {
    if (!key || !handle) return Promise.resolve();
    return withStore("readwrite", function (store) {
      return store.put(handle, key);
    }).catch(function () {
      /* Persistence is best-effort. */
    });
  }

  function getHandle(key) {
    if (!key) return Promise.resolve(null);
    return withStore("readonly", function (store) {
      return store.get(key);
    }).then(
      function (value) {
        return value || null;
      },
      function () {
        return null;
      }
    );
  }

  function deleteHandle(key) {
    if (!key) return Promise.resolve();
    return withStore("readwrite", function (store) {
      return store.delete(key);
    }).catch(function () {
      /* Best-effort cleanup. */
    });
  }

  return {
    isAvailable: isAvailable,
    saveHandle: saveHandle,
    getHandle: getHandle,
    deleteHandle: deleteHandle,
  };
});
