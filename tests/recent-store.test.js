"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const RecentStore = require("../recent-store.js");

const urlEntry = (title, video, extra = {}) => ({
  title,
  video,
  videoType: "url",
  subtitle: "",
  subtitleType: "url",
  progress: 0,
  ...extra
});

const localEntry = (fileName, blobUrl, extra = {}) => ({
  title: fileName,
  video: blobUrl,
  videoType: "local",
  subtitle: "",
  subtitleType: "url",
  progress: 0,
  ...extra
});

test("identity: URL records keyed by full video URL, not title", () => {
  const a = RecentStore.getVideoId("url", "https://x/a.mp4", "a.mp4");
  const b = RecentStore.getVideoId("url", "https://x/b.mp4", "a.mp4");
  assert.notEqual(a, b, "same title, different URL must differ");
  assert.equal(
    RecentStore.getVideoId("url", "https://x/a.mp4", "other.mp4"),
    a,
    "same URL with a different title must stay the same record"
  );
});

test("identity: local records keyed by file name, not blob URL", () => {
  const a = RecentStore.getVideoId("local", "blob:1", "movie.mkv");
  const b = RecentStore.getVideoId("local", "blob:2", "movie.mkv");
  assert.equal(a, b, "the same file reselected in a new session is one record");
  assert.notEqual(
    a,
    RecentStore.getVideoId("local", "blob:1", "other.mkv"),
    "different file names must be different records"
  );
});

test("upsert: same source updates one record and keeps progress", () => {
  let recent = RecentStore.upsertRecent([], urlEntry("a.mp4", "https://x/a.mp4"));
  recent[0].progress = 42;

  recent = RecentStore.upsertRecent(recent, urlEntry("a.mp4", "https://x/a.mp4"));
  assert.equal(recent.length, 1);
  assert.equal(recent[0].progress, 42, "progress must survive re-save");
});

test("upsert: same title with different sources produces two records", () => {
  let recent = RecentStore.upsertRecent(
    [],
    urlEntry("clip.mp4", "https://host1/clip.mp4")
  );
  recent = RecentStore.upsertRecent(
    recent,
    urlEntry("clip.mp4", "https://host2/clip.mp4")
  );
  assert.equal(recent.length, 2);
  assert.notEqual(recent[0].video, recent[1].video);
});

test("upsert: local re-save collapses on file name even with a new blob URL", () => {
  let recent = RecentStore.upsertRecent([], localEntry("movie.mkv", "blob:1"));
  recent[0].progress = 10;
  recent = RecentStore.upsertRecent(recent, localEntry("movie.mkv", "blob:2"));
  assert.equal(recent.length, 1);
  assert.equal(recent[0].video, "blob:2", "record is refreshed to the new URL");
  assert.equal(recent[0].progress, 10, "progress is retained across reselection");
});

test("upsert: list is capped at 30 entries and the oldest drops off", () => {
  let recent = [];
  for (let i = 0; i < 35; i++) {
    recent = RecentStore.upsertRecent(
      recent,
      urlEntry("v" + i + ".mp4", "https://x/v" + i + ".mp4")
    );
  }
  assert.equal(recent.length, 30);
  assert.equal(recent[0].title, "v34.mp4", "newest entry is at the front");
  assert.equal(recent[29].title, "v5.mp4", "entries beyond the cap are dropped");
});

test("remove: only the matching source identity is removed", () => {
  let recent = RecentStore.upsertRecent(
    [],
    urlEntry("clip.mp4", "https://host1/clip.mp4")
  );
  recent = RecentStore.upsertRecent(
    recent,
    urlEntry("clip.mp4", "https://host2/clip.mp4")
  );

  recent = RecentStore.removeRecentById(
    recent,
    "url",
    "https://host1/clip.mp4",
    "clip.mp4"
  );
  assert.equal(recent.length, 1);
  assert.equal(recent[0].video, "https://host2/clip.mp4");
});

test("import: valid unique list is accepted", () => {
  const payload = [
    urlEntry("a.mp4", "https://x/a.mp4", { progress: 10 }),
    localEntry("b.mkv", "blob:z", { progress: 100 })
  ];
  const result = RecentStore.validateImportedData(payload);
  assert.equal(result.ok, true);
  assert.equal(result.data.length, 2);
});

test("import: duplicate URL records are rejected", () => {
  const payload = [
    urlEntry("name.mp4", "https://x/same.mp4"),
    urlEntry("different-name.mp4", "https://x/same.mp4")
  ];
  const result = RecentStore.validateImportedData(payload);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "duplicate-entry");
});

test("import: duplicate local records (same file name) are rejected", () => {
  const payload = [
    localEntry("movie.mkv", "blob:1"),
    localEntry("movie.mkv", "blob:2")
  ];
  const result = RecentStore.validateImportedData(payload);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "duplicate-entry");
});

test("import: a list longer than 30 entries is truncated, not rejected", () => {
  const payload = [];
  for (let i = 0; i < 40; i++) {
    payload.push(urlEntry("v" + i + ".mp4", "https://x/v" + i + ".mp4"));
  }
  const result = RecentStore.validateImportedData(payload);
  assert.equal(result.ok, true);
  assert.equal(result.data.length, 30);
});

test("import: malformed payloads are rejected", () => {
  assert.equal(RecentStore.validateImportedData(null).ok, false);
  assert.equal(RecentStore.validateImportedData({}).ok, false);
  assert.equal(RecentStore.validateImportedData("nope").ok, false);
  assert.equal(
    RecentStore.validateImportedData([
      urlEntry("a.mp4", "https://x/a.mp4", { progress: 101 })
    ]).ok,
    false,
    "progress above 100 is invalid"
  );
  assert.equal(
    RecentStore.validateImportedData([
      urlEntry("a.mp4", "https://x/a.mp4", { videoType: "disc" })
    ]).ok,
    false,
    "unknown videoType is invalid"
  );
  assert.equal(
    RecentStore.validateImportedData([
      { ...urlEntry("a.mp4", "https://x/a.mp4"), title: 123 }
    ]).ok,
    false,
    "wrong field type is invalid"
  );
});
