/*
 * recent-store.js
 *
 * Single source of truth for the "Recently Played" list identity rules.
 *
 * A record is identified by its video SOURCE, never by its title:
 *   - URL videos  -> the full video URL
 *   - local files -> the file name (blob: ObjectURLs are session-scoped
 *                    and therefore cannot be used as a stable identity)
 *
 * The same helper is used by save / progress update / resume / remove so
 * two records that merely share a title (but point at different sources)
 * can never overwrite each other.
 *
 * The file is loaded as a classic <script> in the browser and is also
 * require()-able from the Node test suite (no DOM dependencies).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (typeof root === "object" && root) {
    root.RecentStore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const RECENT_SIZE = 30;

  /**
   * Stable identity of a recent-played record.
   *
   * @param {string} videoType "url" or "local"
   * @param {string} video     video URL, or the blob: ObjectURL for locals
   * @param {string} [title]   file name for local entries
   * @returns {string}
   */
  function getVideoId(videoType, video, title) {
    if (videoType === "local") {
      return "local:" + (title || "");
    }
    return "url:" + video;
  }

  /** Identity of an already stored record. */
  function getRecordId(item) {
    return getVideoId(item.videoType, item.video, item.title);
  }

  function findRecordIndex(recent, videoType, video, title) {
    const id = getVideoId(videoType, video, title);
    return recent.findIndex(item => getRecordId(item) === id);
  }

  /**
   * Insert or update a record. An existing record with the same source
   * keeps its saved progress and is moved to the front of the list.
   * Records with the same title but a different source stay untouched.
   *
   * @returns {Array} a new list, capped at RECENT_SIZE entries
   */
  function upsertRecent(recent, entry) {
    const next = Array.isArray(recent) ? recent.slice() : [];
    const idx = findRecordIndex(
      next,
      entry.videoType,
      entry.video,
      entry.title
    );

    let progress = 0;
    if (idx !== -1) {
      progress = next[idx].progress || 0;
      next.splice(idx, 1);
    }

    next.unshift({
      title: entry.title,
      video: entry.video,
      videoType: entry.videoType,
      subtitle: entry.subtitle || "",
      subtitleType: entry.subtitleType || "url",
      progress
    });

    if (next.length > RECENT_SIZE) {
      return next.slice(0, RECENT_SIZE);
    }
    return next;
  }

  /** Remove every record matching the given source identity. */
  function removeRecentById(recent, videoType, video, title) {
    const id = getVideoId(videoType, video, title);
    return recent.filter(item => getRecordId(item) !== id);
  }

  /** Field validation shared by the import flow. */
  function isValidRecord(item) {
    return (
      item &&
      typeof item === "object" &&
      typeof item.title === "string" &&
      typeof item.video === "string" &&
      (item.videoType === "url" || item.videoType === "local") &&
      (item.subtitle === "" || typeof item.subtitle === "string") &&
      (item.subtitleType === "url" || item.subtitleType === "local") &&
      typeof item.progress === "number" &&
      Number.isFinite(item.progress) &&
      item.progress >= 0 &&
      item.progress <= 100
    );
  }

  /**
   * Validate an imported backup.
   *
   * Rules (on top of per-field validation):
   *   - the payload must be an array of records
   *   - duplicate records (same source identity) are rejected wholesale
   *   - lists longer than 30 entries are truncated to the limit
   *
   * @returns {{ok: true, data: Array}} or {ok: false, reason: string}
   */
  function validateImportedData(parsed) {
    if (!Array.isArray(parsed)) {
      return { ok: false, reason: "not-an-array" };
    }
    if (!parsed.every(isValidRecord)) {
      return { ok: false, reason: "invalid-record" };
    }

    const seen = new Set();
    for (const item of parsed) {
      const id = getRecordId(item);
      if (seen.has(id)) {
        return { ok: false, reason: "duplicate-entry" };
      }
      seen.add(id);
    }

    return { ok: true, data: parsed.slice(0, RECENT_SIZE) };
  }

  return {
    RECENT_SIZE,
    getVideoId,
    getRecordId,
    findRecordIndex,
    upsertRecent,
    removeRecentById,
    isValidRecord,
    validateImportedData
  };
});
