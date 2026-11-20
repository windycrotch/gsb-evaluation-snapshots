"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const NeovidCore = require(path.join(__dirname, "..", "core.js"));

// Minimal in-memory localStorage replacement.
function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    _dump(key) {
      return JSON.parse(map.get(key));
    },
  };
}

function makeCore(storage) {
  return NeovidCore.createNeovidCore({
    storage: storage || createMemoryStorage(),
  });
}

function makeItem(overrides = {}) {
  return Object.assign(
    {
      id: undefined,
      title: "video.mp4",
      video: "https://example.com/video.mp4",
      videoType: "url",
      subtitle: "",
      subtitleType: "url",
      progress: 0,
    },
    overrides
  );
}

// Create an entry that has already accumulated watched progress.
function seedEntryWithProgress(core, title, percent) {
  const playback = core.startPlayback(makeItem({ title }));
  core.markMediaReady(playback.token);
  core.recordProgress(playback.entry.id, percent, playback.token);
  return playback.entry.id;
}

function startVideo(core, title) {
  const result = core.startPlayback(
    makeItem({ title: title || "a.mp4", video: `https://example.com/${title || "a.mp4"}` })
  );
  // The browser fires `loadstart` once the new media begins loading.
  core.markMediaReady(result.token);
  return result;
}

function fireTimeUpdate(core, entryId, token, percent) {
  return core.recordProgress(entryId, percent, token);
}

// ---------------------------------------------------------------------------
// 1. Normal import: list, progress, completion mark and resume all come from
//    the imported data; oversize files are truncated to the first 30 entries.
// ---------------------------------------------------------------------------
test("import: valid backup replaces the list and drives progress/completion/resume", () => {
  const storage = createMemoryStorage();
  const core = makeCore(storage);

  // Pre-existing data that must be fully replaced.
  core.upsertEntry(makeItem({ title: "old.mp4", progress: 55 }));
  assert.equal(core.getEntries().length, 1);

  const backup = [
    makeItem({ id: "id-1", title: "imported-1.mp4", progress: 50 }),
    makeItem({
      id: "id-2",
      title: "imported-2.mp4",
      video: "https://example.com/imported-2.mp4",
      progress: 97,
    }),
  ];

  const result = core.importFromText(JSON.stringify(backup));
  assert.equal(result.ok, true);
  assert.equal(result.imported, 2);

  const entries = core.getEntries();
  assert.deepEqual(
    entries.map((entry) => entry.title),
    ["imported-1.mp4", "imported-2.mp4"]
  );
  // Percentages come straight from the imported payload.
  assert.equal(entries[0].progress, 50);
  assert.equal(entries[1].progress, 97);
  // >= 97% is treated as completed.
  assert.equal(core.isCompleted(entries[0]), false);
  assert.equal(core.isCompleted(entries[1]), true);

  // "Resume last" points at the first imported entry with its saved position.
  const first = entries[0];
  assert.equal(core.getResumePosition(first.id, 1000), 500);
  // Imported entries keep their supplied ids.
  assert.equal(first.id, "id-1");
});

test("import: more than 30 entries keeps only the first 30 in export order", () => {
  const core = makeCore();
  const backup = [];
  for (let i = 0; i < 35; i += 1) {
    backup.push(makeItem({ id: `id-${i}`, title: `video-${i}.mp4`, progress: i }));
  }

  const result = core.importEntries(backup);
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);

  const entries = core.getEntries();
  assert.equal(entries.length, 30);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    backup.slice(0, 30).map((item) => item.id)
  );
});

test("import: while a video is playing, late progress cannot touch replaced entries", () => {
  const core = makeCore();
  const playback = startVideo(core, "playing.mp4");

  const backup = [makeItem({ id: "new-id", title: "replacement.mp4", progress: 10 })];
  const result = core.importEntries(backup);
  assert.equal(result.ok, true);

  // The player has been detached from the list.
  assert.equal(core.getCurrentEntryId(), null);

  // A timeupdate arriving from the still-playing old video must be dropped.
  const written = fireTimeUpdate(core, playback.entry.id, playback.token, 80);
  assert.equal(written, false);
  const oldEntry = core.findEntry(playback.entry.id);
  assert.equal(oldEntry, null);

  // The imported entry is untouched by the stray event.
  const imported = core.getEntries()[0];
  assert.equal(imported.id, "new-id");
  assert.equal(imported.progress, 10);
});

// ---------------------------------------------------------------------------
// 2. Invalid import: bad JSON, non-array payloads and illegal fields are
//    rejected and the original list is preserved with no partial writes.
// ---------------------------------------------------------------------------
test("import rollback: invalid JSON leaves the existing list intact", () => {
  const storage = createMemoryStorage();
  const core = makeCore(storage);
  seedEntryWithProgress(core, "keep.mp4", 42);
  const before = storage._dump("recentVideos");

  const result = core.importFromText("{not valid json");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-json");
  assert.deepEqual(storage._dump("recentVideos"), before);
});

test("import rollback: non-array payload leaves the existing list intact", () => {
  const storage = createMemoryStorage();
  const core = makeCore(storage);
  seedEntryWithProgress(core, "keep.mp4", 42);
  const before = storage._dump("recentVideos");

  const result = core.importFromText(JSON.stringify({ title: "oops" }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-array");
  assert.deepEqual(storage._dump("recentVideos"), before);
});

test("import rollback: illegal fields (progress, videoType, subtitleType) are rejected atomically", () => {
  const storage = createMemoryStorage();
  const core = makeCore(storage);
  seedEntryWithProgress(core, "keep.mp4", 42);
  const before = storage._dump("recentVideos");

  const invalidPayloads = [
    [makeItem({ progress: -1 })],
    [makeItem({ progress: 101 })],
    [makeItem({ progress: "50" })],
    [makeItem({ progress: NaN })],
    [makeItem({ videoType: "disk" })],
    [makeItem({ subtitleType: "webdav" })],
    [makeItem({ title: 123 })],
    [makeItem({ video: null })],
    [null],
    "not-an-object",
  ];

  for (const payload of invalidPayloads) {
    const result = core.importFromText(JSON.stringify(payload));
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(payload)}`);
    // Full rollback: storage still holds exactly the original single entry.
    const current = storage._dump("recentVideos");
    assert.deepEqual(current, before);
    assert.equal(core.getEntries()[0].title, "keep.mp4");
    assert.equal(core.getEntries()[0].progress, 42);
  }
});

// ---------------------------------------------------------------------------
// 3. Deleting the currently playing entry: playback continues but progress is
//    no longer written; replaying the same video starts a fresh entry at 0.
// ---------------------------------------------------------------------------
test("delete current: player keeps playing but progress writes stop; replay starts at 0", () => {
  const core = makeCore();
  const playback = startVideo(core, "current.mp4");
  fireTimeUpdate(core, playback.entry.id, playback.token, 40);
  assert.equal(core.findEntry(playback.entry.id).progress, 40);

  // User removes the currently playing entry from the list.
  const removed = core.removeEntry(playback.entry.id);
  assert.equal(removed, true);
  assert.equal(core.getCurrentEntryId(), null);
  assert.equal(core.findEntry(playback.entry.id), null);

  // Late timeupdate events from the still-running player are discarded.
  const written = fireTimeUpdate(core, playback.entry.id, playback.token, 75);
  assert.equal(written, false);
  assert.equal(core.getEntries().length, 0);

  // Replaying the same video creates a brand new entry with zero progress.
  const replay = core.startPlayback(
    makeItem({ title: "current.mp4", video: "https://example.com/current.mp4" })
  );
  core.markMediaReady(replay.token);
  assert.notEqual(replay.entry.id, playback.entry.id);
  assert.equal(replay.entry.progress, 0);
  assert.equal(core.getEntries().length, 1);
  assert.equal(core.getCurrentEntryId(), replay.entry.id);

  // New playback progress is recorded against the new identity.
  const replayWritten = fireTimeUpdate(core, replay.entry.id, replay.token, 10);
  assert.equal(replayWritten, true);
  assert.equal(core.findEntry(replay.entry.id).progress, 10);
});

test("delete current: removing a different entry does not detach the player", () => {
  const core = makeCore();
  const playing = startVideo(core, "playing.mp4");
  const other = core.upsertEntry(makeItem({ title: "other.mp4" }));

  core.removeEntry(other.id);
  assert.equal(core.getCurrentEntryId(), playing.entry.id);

  const written = fireTimeUpdate(core, playing.entry.id, playing.token, 30);
  assert.equal(written, true);
  assert.equal(core.findEntry(playing.entry.id).progress, 30);
});

// ---------------------------------------------------------------------------
// 4. Rapid switching: late progress events from the previous video can never
//    overwrite the new video's progress.
// ---------------------------------------------------------------------------
test("rapid switch: stale timeupdate events from the old video are ignored", () => {
  const core = makeCore();

  // First video is playing and reaches 60%.
  const first = startVideo(core, "first.mp4");
  fireTimeUpdate(core, first.entry.id, first.token, 60);
  assert.equal(core.findEntry(first.entry.id).progress, 60);

  // User immediately switches to a second video. In the browser the new
  // media has not fired `loadstart` yet, so the new token is not "ready".
  const second = core.startPlayback(
    makeItem({ title: "second.mp4", video: "https://example.com/second.mp4" })
  );
  assert.notEqual(second.token, first.token);

  // A late timeupdate from the first video (old token) must be dropped.
  const staleByOldToken = fireTimeUpdate(core, first.entry.id, first.token, 90);
  assert.equal(staleByOldToken, false);
  // Even an event misrouted with the new token is rejected before loadstart.
  const staleBeforeReady = fireTimeUpdate(core, second.entry.id, second.token, 90);
  assert.equal(staleBeforeReady, false);

  assert.equal(core.findEntry(first.entry.id).progress, 60);
  assert.equal(core.findEntry(second.entry.id).progress, 0);

  // Once the new media is ready, its own events are accepted.
  core.markMediaReady(second.token);
  const written = fireTimeUpdate(core, second.entry.id, second.token, 25);
  assert.equal(written, true);
  assert.equal(core.findEntry(second.entry.id).progress, 25);
  // The first entry is unaffected by the new video's events.
  assert.equal(core.findEntry(first.entry.id).progress, 60);
});

test("rapid switch: three quick switches only the final video accepts progress", () => {
  const core = makeCore();
  const first = startVideo(core, "first.mp4");
  const second = core.startPlayback(
    makeItem({ title: "second.mp4", video: "https://example.com/second.mp4" })
  );
  const third = core.startPlayback(
    makeItem({ title: "third.mp4", video: "https://example.com/third.mp4" })
  );
  core.markMediaReady(third.token);

  // Events carrying tokens from the two abandoned playbacks are rejected.
  assert.equal(fireTimeUpdate(core, first.entry.id, first.token, 50), false);
  assert.equal(fireTimeUpdate(core, second.entry.id, second.token, 50), false);
  assert.equal(fireTimeUpdate(core, third.entry.id, third.token, 50), true);

  assert.equal(core.findEntry(first.entry.id).progress, 0);
  assert.equal(core.findEntry(second.entry.id).progress, 0);
  assert.equal(core.findEntry(third.entry.id).progress, 50);
});

// ---------------------------------------------------------------------------
// Supporting guarantees: completion threshold, export reflects the real list,
// and legacy data without ids is migrated.
// ---------------------------------------------------------------------------
test("completion: 96% is not completed, 97% and above are", () => {
  const core = makeCore();
  assert.equal(core.isCompleted(makeItem({ progress: 96 })), false);
  assert.equal(core.isCompleted(makeItem({ progress: 97 })), true);
  assert.equal(core.isCompleted(makeItem({ progress: 100 })), true);
});

test("export: output matches the current stored list exactly", () => {
  const core = makeCore();
  seedEntryWithProgress(core, "one.mp4", 10);
  seedEntryWithProgress(core, "two.mp4", 20);

  const exported = core.exportEntries();
  const stored = core.getEntries();
  assert.deepEqual(exported, stored);
  assert.deepEqual(
    exported.map((entry) => entry.title),
    ["two.mp4", "one.mp4"]
  );
  assert.deepEqual(
    exported.map((entry) => entry.progress),
    [20, 10]
  );

  // Mutating the export must not corrupt internal state.
  exported[0].progress = 999;
  assert.equal(core.getEntries()[0].progress, 20);
});

test("migration: legacy entries without ids receive stable unique ids", () => {
  const storage = createMemoryStorage({
    recentVideos: JSON.stringify([
      { title: "legacy.mp4", video: "u", videoType: "url", subtitle: "", subtitleType: "url", progress: 5 },
    ]),
  });
  const core = makeCore(storage);
  const entries = core.getEntries();
  assert.equal(typeof entries[0].id, "string");
  assert.ok(entries[0].id.length > 0);
  // The id is persisted, so re-reading yields the same identity.
  const again = core.getEntries();
  assert.equal(again[0].id, entries[0].id);
});
