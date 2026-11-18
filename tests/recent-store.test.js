/*
 * Automated tests for the Neovid recent-store logic.
 *
 * Run with the Node.js built-in test runner (no dependencies):
 *
 *     node --test tests/
 *
 * Coverage requested by the acceptance criteria:
 *   1. Local entry reselect restores the saved progress.
 *   2. Missing/unusable handle falls back to manual re-pick.
 *   3. Importing a document that contains local entries keeps the
 *      other (valid) records instead of failing or wiping them.
 *   4. Exported JSON never contains handle fields / non-serializable data.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const RecentStore = require(path.join(__dirname, "..", "recent-store.js"));

const HANDLE_KEYS = RecentStore.HANDLE_KEYS;

function makeLocalItem(overrides = {}) {
  return {
    title: "movie.mp4",
    video: "blob:https://neovid.top/dead-beef",
    videoType: "local",
    subtitle: "",
    subtitleType: "url",
    progress: 42,
    ...overrides,
  };
}

function makeUrlItem(overrides = {}) {
  return {
    title: "clip.mp4",
    video: "https://example.com/clip.mp4",
    videoType: "url",
    subtitle: "",
    subtitleType: "url",
    progress: 10,
    ...overrides,
  };
}

/* Fakes mirroring the service contract used by resolveLocalEntry(). */
function makeFakeFile(name) {
  return { name, size: 1234, type: "video/mp4" };
}

function makeFakeHandle(name) {
  return {
    name,
    kind: "file",
    async queryPermission() {
      return this._permission || "prompt";
    },
    async requestPermission() {
      this._permission = "granted";
      return "granted";
    },
    async getFile() {
      return makeFakeFile(name);
    },
  };
}

function makeServices(overrides = {}) {
  const calls = { picker: [], getHandle: [], requestPermission: [], notify: [] };
  return {
    calls,
    fsAccessSupported: true,
    storedHandles: {},
    pickerResults: [],
    async supportsFsAccess() {
      return this.fsAccessSupported;
    },
    async getHandle(key) {
      calls.getHandle.push(key);
      return this.storedHandles[key] || null;
    },
    async queryPermission(handle) {
      return handle._permission || "prompt";
    },
    async requestPermission(handle) {
      calls.requestPermission.push(handle.name);
      return handle.requestPermissionInternal
        ? handle.requestPermissionInternal()
        : "granted";
    },
    async openPicker(options) {
      calls.picker.push(options);
      const next = this.pickerResults.shift();
      return next === undefined ? null : next;
    },
    notify(kind) {
      calls.notify.push(kind);
    },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* 1. Local entry reselect + progress restoration                     */
/* ------------------------------------------------------------------ */

test("reselect via stored handle reopens the file without a picker", async () => {
  const handle = makeFakeHandle("movie.mp4");
  const key = RecentStore.handleKeyFor("movie.mp4", "video");
  const services = makeServices({ storedHandles: { [key]: handle } });
  const item = makeLocalItem({ [HANDLE_KEYS.VIDEO]: key });

  const result = await RecentStore.resolveLocalEntry(item, services);

  assert.ok(result, "resolution should succeed");
  assert.equal(result.video.file.name, "movie.mp4");
  assert.equal(result.video.pickedNewHandle, false);
  assert.equal(services.calls.picker.length, 0, "no manual picker must open");
  assert.equal(services.calls.notify.length, 0, "no fallback prompt is needed");
});

test("reselected local entry keeps the saved percentage and restores it", async () => {
  // Simulate the full reselect -> record -> resume pipeline.
  const handle = makeFakeHandle("movie.mp4");
  const key = RecentStore.handleKeyFor("movie.mp4", "video");
  const services = makeServices({ storedHandles: { [key]: handle } });
  const item = makeLocalItem({ progress: 35, [HANDLE_KEYS.VIDEO]: key });

  const resolved = await RecentStore.resolveLocalEntry(item, services);
  const freshBlobUrl = "blob:https://neovid.top/fresh-1234";
  const record = RecentStore.buildResolvedRecord(
    item,
    { videoUrl: freshBlobUrl, subtitleUrl: "" },
    { video: key }
  );

  // The record keeps its title so the saved progress stays associated.
  assert.equal(record.title, "movie.mp4");
  assert.equal(record.video, freshBlobUrl);
  assert.equal(record.videoType, "local");

  // saveRecent-equivalent upsert preserves the 35% progress on same title.
  const stored = RecentStore.upsertRecent([item], record);
  assert.equal(stored[0].progress, 35);

  // loadPlayerTime-equivalent percentage math: 35% of a 200s video = 70s.
  const duration = 200;
  const resumeTime = (stored[0].progress / 100) * duration;
  assert.equal(resumeTime, 70);
});

test("reselect with a local subtitle reopens both media sources", async () => {
  const videoHandle = makeFakeHandle("movie.mp4");
  const subHandle = makeFakeHandle("movie.vtt");
  const videoKey = RecentStore.handleKeyFor("movie.mp4", "video");
  const subKey = RecentStore.handleKeyFor("movie.mp4", "subtitle");
  const services = makeServices({
    storedHandles: { [videoKey]: videoHandle, [subKey]: subHandle },
  });
  const item = makeLocalItem({
    subtitle: "blob:https://neovid.top/old-sub",
    subtitleType: "local",
    [HANDLE_KEYS.VIDEO]: videoKey,
    [HANDLE_KEYS.SUBTITLE]: subKey,
  });

  const result = await RecentStore.resolveLocalEntry(item, services);

  assert.equal(result.video.file.name, "movie.mp4");
  assert.ok(result.subtitle, "subtitle should be resolved");
  assert.equal(result.subtitle.file.name, "movie.vtt");
  assert.equal(services.calls.picker.length, 0);
});

test("cancelling the subtitle pick does not block video playback", async () => {
  const videoHandle = makeFakeHandle("movie.mp4");
  const videoKey = RecentStore.handleKeyFor("movie.mp4", "video");
  const subKey = RecentStore.handleKeyFor("movie.mp4", "subtitle");
  const services = makeServices({
    storedHandles: { [videoKey]: videoHandle }, // no subtitle handle
    pickerResults: [null], // user cancels the subtitle picker
  });
  const item = makeLocalItem({
    subtitle: "blob:https://neovid.top/old-sub",
    subtitleType: "local",
    [HANDLE_KEYS.VIDEO]: videoKey,
    [HANDLE_KEYS.SUBTITLE]: subKey,
  });

  const result = await RecentStore.resolveLocalEntry(item, services);

  assert.ok(result.video, "video still resolves");
  assert.equal(result.subtitle, null, "subtitle resolution is simply empty");
});

/* ------------------------------------------------------------------ */
/* 2. Handle missing / unusable -> fallback to manual re-pick         */
/* ------------------------------------------------------------------ */

test("no stored handle on a supporting browser opens the FSAA picker", async () => {
  const picked = makeFakeFile("movie.mp4");
  const services = makeServices({ pickerResults: [picked] });
  const item = makeLocalItem(); // no handle key at all

  const result = await RecentStore.resolveLocalEntry(item, services);

  assert.equal(result.video.file, picked);
  assert.equal(result.video.pickedNewHandle, true);
  assert.equal(services.calls.picker[0].kind, "video");
});

test("stale handle (getFile throws) falls back to a fresh picker", async () => {
  function StaleHandleError(message) {
    this.message = message;
    this.name = "StaleHandleError";
  }
  const brokenHandle = {
    name: "movie.mp4",
    async queryPermission() {
      return "granted";
    },
    async requestPermission() {
      return "granted";
    },
    async getFile() {
      throw new StaleHandleError("handle moved or deleted");
    },
  };
  const key = RecentStore.handleKeyFor("movie.mp4", "video");
  const replacement = makeFakeFile("movie.mp4");
  const services = makeServices({
    storedHandles: { [key]: brokenHandle },
    pickerResults: [replacement],
  });
  const item = makeLocalItem({ [HANDLE_KEYS.VIDEO]: key });

  const result = await RecentStore.resolveLocalEntry(item, services);

  assert.equal(result.video.file, replacement);
  assert.equal(result.video.pickedNewHandle, true);
  assert.equal(services.calls.picker.length, 1);
});

test("denied permission falls back to the picker", async () => {
  const handle = makeFakeHandle("movie.mp4");
  handle._permission = "denied";
  const key = RecentStore.handleKeyFor("movie.mp4", "video");
  const picked = makeFakeFile("movie.mp4");
  const services = makeServices({
    storedHandles: { [key]: handle },
    pickerResults: [picked],
    async requestPermission() {
      return "denied";
    },
  });
  const item = makeLocalItem({ [HANDLE_KEYS.VIDEO]: key });

  const result = await RecentStore.resolveLocalEntry(item, services);

  assert.equal(result.video.pickedNewHandle, true);
  assert.equal(services.calls.picker.length, 1);
});

test("browser without FSAA support notifies and uses the fallback picker", async () => {
  const picked = makeFakeFile("movie.mp4");
  const services = makeServices({
    fsAccessSupported: false,
    pickerResults: [picked],
  });
  const item = makeLocalItem({
    [HANDLE_KEYS.VIDEO]: RecentStore.handleKeyFor("movie.mp4", "video"),
  });

  const result = await RecentStore.resolveLocalEntry(item, services);

  assert.equal(result.video.file, picked);
  assert.deepEqual(services.calls.notify, ["video"], "user is guided to re-pick");
  assert.equal(services.calls.getHandle.length, 0, "no IndexedDB lookup attempted");
});

test("cancelling every picker returns null and nothing is played", async () => {
  const services = makeServices({ fsAccessSupported: false, pickerResults: [null] });
  const result = await RecentStore.resolveLocalEntry(makeLocalItem(), services);
  assert.equal(result, null);
});

/* ------------------------------------------------------------------ */
/* 3. Import containing local entries preserves the other records     */
/* ------------------------------------------------------------------ */

test("import keeps valid records when local entries have no handle", () => {
  const imported = [
    makeUrlItem({ title: "a.mp4" }),
    makeLocalItem({ title: "local-one.mp4" }), // no handle fields -> still valid
    makeUrlItem({ title: "b.mp4" }),
    makeLocalItem({
      title: "local-two.mp4",
      subtitle: "blob:old",
      subtitleType: "local",
    }),
  ];

  const normalized = RecentStore.normalizeImportedRecords(imported);

  assert.equal(normalized.length, 4, "no valid record is lost");
  assert.deepEqual(
    normalized.map(item => item.title),
    ["a.mp4", "local-one.mp4", "b.mp4", "local-two.mp4"]
  );
  normalized.forEach(item => {
    assert.equal(HANDLE_KEYS.VIDEO in item, false);
    assert.equal(HANDLE_KEYS.SUBTITLE in item, false);
  });
});

test("import drops only malformed rows instead of rejecting the whole file", () => {
  const imported = [
    makeUrlItem({ title: "good.mp4" }),
    { title: "missing-video.mp4", videoType: "local" }, // no video string
    null,
    "not-an-object",
    makeLocalItem({ title: "good-local.mp4", video: "blob:still-here" }),
    { title: 123, video: "https://x/y.mp4" }, // bad title
  ];

  const normalized = RecentStore.normalizeImportedRecords(imported);

  assert.deepEqual(
    normalized.map(item => item.title),
    ["good.mp4", "good-local.mp4"],
    "valid URL and local records both survive"
  );
});

test("import tolerates unexpected handle-shaped junk without throwing", () => {
  const circular = {};
  circular.self = circular;
  const imported = [
    makeLocalItem({
      title: "junk.mp4",
      [HANDLE_KEYS.VIDEO]: "some-internal-key",
      weirdHandle: circular, // non-serializable junk must be ignored
    }),
  ];

  const normalized = RecentStore.normalizeImportedRecords(imported);
  assert.equal(normalized.length, 1);
  assert.equal(HANDLE_KEYS.VIDEO in normalized[0], false);
  assert.equal("weirdHandle" in normalized[0], false);

  // Must be JSON-serializable end to end.
  assert.doesNotThrow(() => JSON.stringify(normalized));
});

test("import of a non-array or fully invalid document yields an empty list", () => {
  assert.deepEqual(RecentStore.normalizeImportedRecords(null), []);
  assert.deepEqual(RecentStore.normalizeImportedRecords({}), []);
  assert.deepEqual(RecentStore.normalizeImportedRecords([null, 42]), []);
});

test("import is capped at 30 entries in source order", () => {
  const imported = Array.from({ length: 45 }, (_, i) =>
    makeUrlItem({ title: `v${String(i).padStart(2, "0")}.mp4` })
  );
  const normalized = RecentStore.normalizeImportedRecords(imported);
  assert.equal(normalized.length, 30);
  assert.equal(normalized[0].title, "v00.mp4");
  assert.equal(normalized[29].title, "v29.mp4");
});

/* ------------------------------------------------------------------ */
/* 4. Export never serializes handles                                 */
/* ------------------------------------------------------------------ */

test("export strips every handle key and produces JSON-safe data", () => {
  const fakeHandle = { kind: "file", nonSerializable: true };
  const recent = [
    {
      ...makeLocalItem({
        [HANDLE_KEYS.VIDEO]: RecentStore.handleKeyFor("movie.mp4", "video"),
        [HANDLE_KEYS.SUBTITLE]: RecentStore.handleKeyFor("movie.mp4", "subtitle"),
      }),
      liveHandle: fakeHandle, // must never appear in the export
    },
    makeUrlItem(),
  ];

  const exported = RecentStore.serializeRecent(recent);
  const json = JSON.stringify(exported);
  const reparsed = JSON.parse(json);

  assert.equal(reparsed.length, 2);
  reparsed.forEach(item => {
    assert.equal(HANDLE_KEYS.VIDEO in item, false);
    assert.equal(HANDLE_KEYS.SUBTITLE in item, false);
    assert.equal("liveHandle" in item, false);
  });
  assert.equal(json.includes("Handle"), false, "no Handle-named field leaks");
});

test("export of an empty store is an empty JSON array", () => {
  assert.equal(JSON.stringify(RecentStore.serializeRecent([])), "[]");
  assert.equal(JSON.stringify(RecentStore.serializeRecent(undefined)), "[]");
});

/* ------------------------------------------------------------------ */
/* MRU ordering, 30-entry cap, progress and completion rules          */
/* ------------------------------------------------------------------ */

test("same-title local reselect replaces the reference and moves to front", () => {
  const original = makeLocalItem({ progress: 60 });
  const other = makeUrlItem({ title: "other.mp4" });
  const recent = [other, original];

  const updated = RecentStore.upsertRecent(recent, {
    ...makeLocalItem({ video: "blob:https://neovid.top/new-url" }),
  });

  assert.equal(updated.length, 2, "no duplicate title row is created");
  assert.equal(updated[0].title, "movie.mp4");
  assert.equal(updated[0].video, "blob:https://neovid.top/new-url");
  assert.equal(updated[0].progress, 60, "previous progress is retained");
  assert.equal(updated[1].title, "other.mp4");
});

test("upsert keeps at most 30 entries in most-recent-first order", () => {
  let recent = [];
  for (let i = 0; i < 35; i++) {
    recent = RecentStore.upsertRecent(recent, makeUrlItem({ title: `t${i}.mp4` }));
  }
  assert.equal(recent.length, 30);
  assert.equal(recent[0].title, "t34.mp4", "newest entry first");
  assert.equal(recent[29].title, "t5.mp4", "oldest five evicted");
});

test("progress math clamps to 0-100 and 97%+ still reads as completed", () => {
  assert.equal(RecentStore.calculateProgress(50, 100), 50);
  assert.equal(RecentStore.calculateProgress(99.6, 100), 100, "rounds and clamps");
  assert.equal(RecentStore.calculateProgress(-5, 100), 0);
  assert.equal(RecentStore.calculateProgress(10, 0), 0, "no duration -> 0");
  assert.equal(RecentStore.calculateProgress(NaN, 100), 0);

  assert.equal(RecentStore.isCompleted(96), false);
  assert.equal(RecentStore.isCompleted(97), true, "97% threshold preserved");
  assert.equal(RecentStore.isCompleted(100), true);
});

test("buildResolvedRecord drops an unavailable local subtitle cleanly", () => {
  const item = makeLocalItem({
    subtitle: "blob:dead",
    subtitleType: "local",
  });
  const record = RecentStore.buildResolvedRecord(
    item,
    { videoUrl: "blob:new", subtitleUrl: "" },
    {}
  );
  assert.equal(record.subtitle, "");
  assert.equal(record.subtitleType, "url");
  assert.equal(record.progress, 42);
});

test("handle keys are namespaced by role and unique per title", () => {
  const videoKey = RecentStore.handleKeyFor("a b.mp4", "video");
  const subKey = RecentStore.handleKeyFor("a b.mp4", "subtitle");
  assert.notEqual(videoKey, subKey);
  assert.match(videoKey, /^video@@/);
  assert.match(subKey, /^subtitle@@/);
});

/* ------------------------------------------------------------------ */
/* Acceptance sample file shipped under tests/fixtures                */
/* ------------------------------------------------------------------ */

test("shipped acceptance sample matches the import/export contract", () => {
  const samplePath = path.join(__dirname, "fixtures", "sample-import.json");
  const sample = JSON.parse(fs.readFileSync(samplePath, "utf8"));

  const normalized = RecentStore.normalizeImportedRecords(sample);
  assert.equal(normalized.length, sample.length, "every sample row is usable");
  assert.ok(normalized.some(item => item.videoType === "local"));
  assert.ok(normalized.some(item => item.videoType === "url"));

  const exported = JSON.stringify(RecentStore.serializeRecent(sample));
  assert.equal(exported.includes("videoHandleKey"), false);
  assert.equal(exported.includes("subtitleHandleKey"), false);
});
