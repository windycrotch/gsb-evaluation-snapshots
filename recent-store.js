/*
 * recent-store.js
 *
 * Pure, side-effect-free logic for the Neovid "recently played" store.
 * It is deliberately free of DOM / IndexedDB / localStorage access so that
 * it can run unchanged in the browser and in Node.js automated tests.
 *
 * Browser globals are consumed through the `services` argument of
 * resolveLocalEntry() instead of being referenced directly, which keeps
 * every branch testable with fakes.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.RecentStore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var RECENT_SIZE = 30;
  var COMPLETED_PERCENT = 97;

  /* Keys that must never be serialized into an exported JSON file.
     FileSystemFileHandle objects are not JSON-serializable and the key
     itself is only an internal IndexedDB lookup token. */
  var HANDLE_KEY = "videoHandleKey";
  var SUBTITLE_HANDLE_KEY = "subtitleHandleKey";
  var HANDLE_KEYS = [HANDLE_KEY, SUBTITLE_HANDLE_KEY];

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function clampProgress(value) {
    var progress = Number(value);
    if (!Number.isFinite(progress)) return 0;
    return Math.max(0, Math.min(100, Math.round(progress)));
  }

  /*
   * Coerce one untrusted record (localStorage entry or imported JSON)
   * into a valid recent item. Returns null when the mandatory fields
   * (title / video) are unusable. Handle keys are always stripped here
   * because handles live in IndexedDB, never inside the JSON record.
   */
  function normalizeRecentItem(raw) {
    if (!isObject(raw)) return null;
    if (typeof raw.title !== "string" || !raw.title) return null;
    if (typeof raw.video !== "string" || !raw.video) return null;

    var videoType = raw.videoType === "local" ? "local" : "url";
    var subtitleType = raw.subtitleType === "local" ? "local" : "url";
    var subtitle = typeof raw.subtitle === "string" ? raw.subtitle : "";

    var item = {
      title: raw.title,
      video: raw.video,
      videoType: videoType,
      subtitle: subtitle,
      subtitleType: subtitleType,
      progress: clampProgress(raw.progress),
    };
    return item;
  }

  /*
   * Validate an imported JSON document.
   *
   * Local entries are accepted even when no FileSystem handle is
   * available (imported files never contain handles): invalid rows are
   * dropped while every valid row is preserved, so one bad local entry
   * can no longer wipe out or reject the whole import.
   *
   * Returns at most RECENT_SIZE items, in most-recent-first order.
   */
  function normalizeImportedRecords(parsed) {
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeRecentItem)
      .filter(function (item) {
        return item !== null;
      })
      .slice(0, RECENT_SIZE);
  }

  /*
   * Produce a JSON-safe copy of the store. Handle key fields are removed
   * and every item is re-normalized, so even a record that somehow carries
   * a non-serializable value can never break the export or leak a handle
   * into the exported file.
   */
  function serializeRecent(recent) {
    var list = Array.isArray(recent) ? recent : [];
    return list
      .map(function (raw) {
        var item = normalizeRecentItem(raw);
        if (!item) return null;
        HANDLE_KEYS.forEach(function (key) {
          delete item[key];
        });
        return item;
      })
      .filter(Boolean);
  }

  /*
   * Insert (or replace the same-title entry) and move it to the front.
   * Same-title replacement always preserves the previously saved progress
   * (a reselect resumes from the original percentage; a fresh play passes
   * no usable prior progress), and keeps the list capped at RECENT_SIZE,
   * ordered by most recently used.
   */
  function upsertRecent(recent, item) {
    var list = Array.isArray(recent) ? recent.slice() : [];
    var normalized = normalizeRecentItem(item);
    if (!normalized) return list.slice(0, RECENT_SIZE);

    var existingIndex = list.findIndex(function (entry) {
      return entry && entry.title === normalized.title;
    });

    if (existingIndex !== -1) {
      var existing = list[existingIndex];
      if (Number.isFinite(Number(existing.progress))) {
        normalized.progress = clampProgress(existing.progress);
      }
      list = list.filter(function (entry) {
        return entry.title !== normalized.title;
      });
    }

    list.unshift(normalized);
    return list.slice(0, RECENT_SIZE);
  }

  /* IndexedDB key under which a FileSystemFileHandle is stored.
     The "@@" separator makes the role/title combination unambiguous. */
  function handleKeyFor(title, role) {
    return role + "@@" + title;
  }

  function calculateProgress(currentTime, duration) {
    if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(100, Math.round((currentTime / duration) * 100)));
  }

  function isCompleted(progress) {
    return Number(progress) >= COMPLETED_PERCENT;
  }

  /*
   * Reopen one local media source.
   *
   * 1. When the browser supports the File System Access API and a stored
   *    handle exists, ask for read permission and call getFile() on it.
   * 2. Anything else (unsupported browser, no handle, denied/lost
   *    permission, dead handle) falls back to a manual re-pick.
   *
   * services:
   *   supportsFsAccess() -> boolean
   *   getHandle(key)     -> FileSystemFileHandle | null (async)
   *   queryPermission(handle) / requestPermission(handle) -> string
   *   openPicker({ kind, suggestedName, id }) -> File | null (async)
   *   notify(kind)       -> void (UI prompt before the fallback picker)
   *
   * Returns { file, pickedNewHandle, handle } or null when the user
   * cancels / no file can be obtained.
   */
  async function resolveMedia(entry, role, services) {
    var kind = role === "subtitle" ? "subtitle" : "video";
    var key = entry.handleKey || null;

    if (await services.supportsFsAccess()) {
      var handle = key ? await services.getHandle(key) : null;
      if (handle) {
        try {
          var granted =
            (await services.queryPermission(handle)) === "granted" ||
            (await services.requestPermission(handle)) === "granted";
          if (granted) {
            var fileFromHandle = await handle.getFile();
            return { file: fileFromHandle, pickedNewHandle: false, handle: handle };
          }
        } catch (error) {
          /* Permission loss / stale handle: fall through to re-pick. */
        }
      }

      try {
        var picked = await services.openPicker({
          kind: kind,
          suggestedName: entry.title,
          id: key || undefined,
        });
        if (picked) {
          return { file: picked, pickedNewHandle: true, handle: null };
        }
        return null;
      } catch (error) {
        /* SecurityError (user dismissed the picker) -> manual fallback. */
      }
    }

    services.notify(kind);
    var fallbackFile = await services.openPicker({
      kind: kind,
      suggestedName: entry.title,
      id: key || undefined,
    });
    if (!fallbackFile) return null;
    return { file: fallbackFile, pickedNewHandle: true, handle: null };
  }

  /*
   * Resolve a full recent entry (video + optional local subtitle).
   * A cancelled subtitle pick never blocks video playback.
   */
  async function resolveLocalEntry(item, services) {
    var videoEntry = {
      title: item.title,
      handleKey: item[HANDLE_KEY] || null,
    };
    var videoResult = await resolveMedia(videoEntry, "video", services);
    if (!videoResult) return null;

    var subtitleResult = null;
    if (item.subtitle && item.subtitleType === "local") {
      var subtitleEntry = {
        title: item.subtitleName || item.title,
        handleKey: item[SUBTITLE_HANDLE_KEY] || null,
      };
      subtitleResult = await resolveMedia(subtitleEntry, "subtitle", services);
    }

    return {
      video: videoResult,
      subtitle: subtitleResult,
    };
  }

  /*
   * Build the replacement recent record after a successful re-pick.
   * The original title and saved progress are preserved (progress
   * restoration still uses the existing percentage logic), while the
   * media references are replaced by fresh, usable ones.
   */
  function buildResolvedRecord(item, sources, handleKeys) {
    var record = normalizeRecentItem(item);
    record.video = sources.videoUrl;
    record.videoType = "local";

    if (sources.subtitleUrl) {
      record.subtitle = sources.subtitleUrl;
      record.subtitleType = "local";
    } else if (item.subtitleType !== "local") {
      record.subtitle = item.subtitle || "";
      record.subtitleType = item.subtitleType || "url";
    } else {
      record.subtitle = "";
      record.subtitleType = "url";
    }

    if (handleKeys && handleKeys.video) {
      record[HANDLE_KEY] = handleKeys.video;
    }
    if (handleKeys && handleKeys.subtitle) {
      record[SUBTITLE_HANDLE_KEY] = handleKeys.subtitle;
    }
    return record;
  }

  return {
    LIMITS: {
      RECENT_SIZE: RECENT_SIZE,
      COMPLETED_PERCENT: COMPLETED_PERCENT,
    },
    HANDLE_KEYS: {
      VIDEO: HANDLE_KEY,
      SUBTITLE: SUBTITLE_HANDLE_KEY,
    },
    normalizeRecentItem: normalizeRecentItem,
    normalizeImportedRecords: normalizeImportedRecords,
    serializeRecent: serializeRecent,
    upsertRecent: upsertRecent,
    handleKeyFor: handleKeyFor,
    calculateProgress: calculateProgress,
    isCompleted: isCompleted,
    resolveMedia: resolveMedia,
    resolveLocalEntry: resolveLocalEntry,
    buildResolvedRecord: buildResolvedRecord,
  };
});
