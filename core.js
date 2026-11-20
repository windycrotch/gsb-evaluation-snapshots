/*
 * Neovid core: DOM-free state management for the recent list and the player.
 *
 * The recent list and the player share one explicit identity: every recent
 * entry has a stable `id` and the "currently playing" entry is tracked as
 * `currentEntryId` instead of being re-discovered by matching title or video
 * URL strings. Each playback also gets a monotonically increasing token so
 * that late media events from a previous video can never touch the new one.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.NeovidCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULT_LIMITS = {
    RECENT_SIZE: 30,
    COMPLETED_PERCENT: 97,
  };

  var STORAGE_KEYS = {
    RECENT: "recentVideos",
    WATCH_TIME: "watchTime",
  };

  function generateId() {
    if (
      typeof crypto !== "undefined" &&
      crypto &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }
    return (
      "entry-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 10)
    );
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function createNeovidCore(options) {
    options = options || {};
    var storage = options.storage;
    var limits = options.limits || DEFAULT_LIMITS;
    var recentKey = options.recentKey || STORAGE_KEYS.RECENT;
    var watchTimeKey = options.watchTimeKey || STORAGE_KEYS.WATCH_TIME;

    // Identity shared between the player and the list.
    var currentEntryId = null;
    // Bumped on every new playback; stale media events carry an old token.
    var playbackToken = 0;
    // No media event is accepted until the media belonging to the new token
    // has actually started loading (see markMediaReady).
    var activeMediaToken = 0;

    function readList() {
      var raw;
      try {
        raw = storage.getItem(recentKey);
      } catch (err) {
        raw = null;
      }
      var entries = [];
      if (raw) {
        try {
          var parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            entries = parsed;
          }
        } catch (err) {
          entries = [];
        }
      }
      return ensureEntryIds(entries);
    }

    function writeList(entries) {
      storage.setItem(recentKey, JSON.stringify(entries));
    }

    // Backwards compatibility: data written by older versions has no `id`.
    // Assign stable ids once, in stored order, and persist the migration.
    function ensureEntryIds(entries) {
      var changed = false;
      var seen = Object.create(null);
      entries.forEach(function (entry) {
        if (isPlainObject(entry)) {
          if (typeof entry.id !== "string" || entry.id === "" || seen[entry.id]) {
            entry.id = generateId();
            changed = true;
          }
          seen[entry.id] = true;
        }
      });
      if (changed) {
        writeList(entries);
      }
      return entries;
    }

    function getEntries() {
      return clone(readList());
    }

    function findEntry(entryId) {
      if (!entryId) {
        return null;
      }
      var entries = readList();
      for (var i = 0; i < entries.length; i += 1) {
        if (entries[i].id === entryId) {
          return clone(entries[i]);
        }
      }
      return null;
    }

    // Insert (or move to the top) an entry. Dedup is still title based for the
    // "play again" UX, but the returned identity is the stable id.
    function upsertEntry(data) {
      var entries = readList();
      var progress = 0;
      var existingId = null;
      var index = -1;
      for (var i = 0; i < entries.length; i += 1) {
        if (entries[i].title === data.title) {
          index = i;
          existingId = entries[i].id;
          progress = entries[i].progress;
          break;
        }
      }

      if (index !== -1) {
        entries.splice(index, 1);
      }

      var entry = {
        id: existingId || generateId(),
        title: data.title,
        video: data.video,
        videoType: data.videoType,
        subtitle: data.subtitle || "",
        subtitleType: data.subtitleType || "url",
        progress: progress,
      };

      entries.unshift(entry);
      if (entries.length > limits.RECENT_SIZE) {
        entries = entries.slice(0, limits.RECENT_SIZE);
      }
      writeList(entries);
      return clone(entry);
    }

    function startPlayback(data) {
      var entry = upsertEntry(data);
      currentEntryId = entry.id;
      playbackToken += 1;
      activeMediaToken = 0;
      return { entry: entry, token: playbackToken };
    }

    function markMediaReady(token) {
      if (token === playbackToken) {
        activeMediaToken = token;
      }
    }

    function isMediaCurrent(token) {
      return token !== 0 && token === playbackToken && token === activeMediaToken;
    }

    function getCurrentEntryId() {
      return currentEntryId;
    }

    function getPlaybackToken() {
      return playbackToken;
    }

    function detachCurrentEntry() {
      currentEntryId = null;
      playbackToken += 1;
      activeMediaToken = 0;
    }

    // Progress is written exclusively through the entry id. If the entry no
    // longer exists (deleted / replaced by an import) nothing is written.
    function recordProgress(entryId, percent, token) {
      if (!entryId || !isMediaCurrent(token)) {
        return false;
      }
      var bounded = Math.round(percent);
      if (!Number.isFinite(bounded)) {
        return false;
      }
      bounded = Math.max(0, Math.min(100, bounded));

      var entries = readList();
      for (var i = 0; i < entries.length; i += 1) {
        if (entries[i].id === entryId) {
          entries[i].progress = bounded;
          writeList(entries);
          return true;
        }
      }
      return false;
    }

    function getResumePosition(entryId, duration) {
      var entry = findEntry(entryId);
      if (!entry || !duration) {
        return 0;
      }
      return (entry.progress / 100) * duration;
    }

    function isCompleted(entry) {
      return Boolean(entry) && entry.progress >= limits.COMPLETED_PERCENT;
    }

    function removeEntry(entryId) {
      var entries = readList();
      var next = entries.filter(function (entry) {
        return entry.id !== entryId;
      });
      if (next.length === entries.length) {
        return false;
      }
      writeList(next);
      // If the removed entry was playing, the player keeps playing but loses
      // its link to the list: later progress must not recreate the entry.
      if (currentEntryId === entryId) {
        detachCurrentEntry();
      }
      return true;
    }

    function removeAllEntries() {
      writeList([]);
      detachCurrentEntry();
    }

    // ---- Watch time (total across videos, independent of entry identity) ----

    function readWatchTime() {
      var raw = parseInt(storage.getItem(watchTimeKey) || "0", 10);
      return Number.isFinite(raw) ? raw : 0;
    }

    function writeWatchTime(value) {
      storage.setItem(watchTimeKey, String(value));
    }

    // Returns the number of whole seconds to persist, given a time delta.
    function accumulateWatchTime(currentState, diff) {
      if (!(diff > 0 && diff < 5)) {
        return currentState;
      }
      var next = {
        total: currentState.total,
        accumulated: currentState.accumulated + diff,
      };
      while (next.accumulated >= 1) {
        next.total += 1;
        next.accumulated -= 1;
      }
      return next;
    }

    // ---- Import / export ----

    function normalizeImportedItem(item, usedIds) {
      if (!isPlainObject(item)) {
        return null;
      }
      if (typeof item.title !== "string" || item.title === "") {
        return null;
      }
      if (typeof item.video !== "string" || item.video === "") {
        return null;
      }
      if (item.videoType !== "url" && item.videoType !== "local") {
        return null;
      }
      if (
        item.subtitle !== undefined &&
        item.subtitle !== null &&
        typeof item.subtitle !== "string"
      ) {
        return null;
      }
      if (
        item.subtitleType !== undefined &&
        item.subtitleType !== "url" &&
        item.subtitleType !== "local"
      ) {
        return null;
      }
      if (
        typeof item.progress !== "number" ||
        !Number.isFinite(item.progress) ||
        item.progress < 0 ||
        item.progress > 100
      ) {
        return null;
      }

      var id = item.id;
      if (typeof id !== "string" || id === "" || usedIds[id]) {
        id = generateId();
      }
      usedIds[id] = true;

      return {
        id: id,
        title: item.title,
        video: item.video,
        videoType: item.videoType,
        subtitle: typeof item.subtitle === "string" ? item.subtitle : "",
        subtitleType:
          item.subtitleType === "local" || item.subtitleType === "url"
            ? item.subtitleType
            : "url",
        progress: item.progress,
      };
    }

    // Validate everything before touching storage, so a bad file can never
    // partially overwrite the existing list.
    function importEntries(parsed) {
      if (!Array.isArray(parsed)) {
        return { ok: false, reason: "not-array", imported: 0 };
      }

      var limited = parsed.slice(0, limits.RECENT_SIZE);
      var usedIds = Object.create(null);
      var normalized = [];

      for (var i = 0; i < limited.length; i += 1) {
        var entry = normalizeImportedItem(limited[i], usedIds);
        if (entry === null) {
          return { ok: false, reason: "invalid-item", index: i, imported: 0 };
        }
        normalized.push(entry);
      }

      // Single commit point: storage is only written after full validation.
      writeList(normalized);

      // The imported data replaces the list, so any entry the player was
      // bound to is gone. Detach the player and invalidate the running media
      // session; late events from the old video must not write anywhere.
      detachCurrentEntry();

      return {
        ok: true,
        imported: normalized.length,
        truncated: parsed.length > limits.RECENT_SIZE,
      };
    }

    function importFromText(text) {
      var parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        return { ok: false, reason: "invalid-json", imported: 0 };
      }
      return importEntries(parsed);
    }

    function exportEntries() {
      return getEntries();
    }

    return {
      // entry management
      getEntries: getEntries,
      findEntry: findEntry,
      upsertEntry: upsertEntry,
      removeEntry: removeEntry,
      removeAllEntries: removeAllEntries,
      // playback identity
      startPlayback: startPlayback,
      markMediaReady: markMediaReady,
      isMediaCurrent: isMediaCurrent,
      getCurrentEntryId: getCurrentEntryId,
      getPlaybackToken: getPlaybackToken,
      detachCurrentEntry: detachCurrentEntry,
      recordProgress: recordProgress,
      getResumePosition: getResumePosition,
      isCompleted: isCompleted,
      // watch time
      readWatchTime: readWatchTime,
      writeWatchTime: writeWatchTime,
      accumulateWatchTime: accumulateWatchTime,
      // backup
      importEntries: importEntries,
      importFromText: importFromText,
      exportEntries: exportEntries,
      // exposed for tests / diagnostics
      generateId: generateId,
    };
  }

  return {
    createNeovidCore: createNeovidCore,
    DEFAULT_LIMITS: DEFAULT_LIMITS,
    STORAGE_KEYS: STORAGE_KEYS,
  };
});
