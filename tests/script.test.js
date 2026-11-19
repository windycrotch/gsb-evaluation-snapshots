"use strict";

/*
 * Integration tests for script.js, driven through the same DOM events
 * the real page fires. See tests/README.md for trigger/expectation tables.
 */

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { createBrowserEnv } = require("./browser-env.js");

const STORAGE_RECENT = "recentVideos";

let env;
beforeEach(() => {
  env = createBrowserEnv();
});

function readRecent(env) {
  return JSON.parse(env.storage[STORAGE_RECENT] || "[]");
}

function submitUrlForm(env, url, title) {
  const { context, elements } = env;
  elements.get("video-load-type").value = "url";
  elements.get("video-url").value = url;
  const form = elements.get("video-form");
  form.dispatchEvent(new context.Event("submit"));
  return title || url.split("/").pop();
}

function makeFile(env, name, contents) {
  return { name, contents: JSON.stringify(contents) };
}

function triggerImport(env, file) {
  const { elements } = env;
  const input = elements.get("recent-file");
  input.files = [file];
  input.dispatchEvent({ type: "change", target: input });
}

test("normal source switch: playing a URL saves one record and resumes its own progress", () => {
  const { context, elements } = env;
  const player = elements.get("video-player");

  submitUrlForm(env, "https://example.com/a.mp4");
  let recent = readRecent(env);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].video, "https://example.com/a.mp4");

  // Simulate playback reaching 50% and a timeupdate event.
  player.duration = 100;
  player.currentTime = 50;
  player.dispatchEvent({ type: "timeupdate" });
  recent = readRecent(env);
  assert.equal(recent[0].progress, 50);

  // Switching to a second URL adds a second record at the front and
  // leaves the first one's progress untouched.
  submitUrlForm(env, "https://example.com/b.mp4");
  recent = readRecent(env);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].video, "https://example.com/b.mp4");
  assert.equal(recent[1].video, "https://example.com/a.mp4");
  assert.equal(recent[1].progress, 50);

  // Resume positioning targets the record matching the current source.
  player.currentTime = 0;
  player.dispatchEvent({ type: "loadedmetadata" });
  assert.equal(player.currentTime, 0, "b.mp4 has no saved progress yet");

  // Replay the first URL: loadPlayerTime must restore its 50% position.
  submitUrlForm(env, "https://example.com/a.mp4");
  player.dispatchEvent({ type: "loadedmetadata" });
  assert.equal(player.currentTime, 50);
  assert.equal(player.children[0].src, "https://example.com/a.mp4");
});

test("same title, different sources: two coexisting records never overwrite each other", async () => {
  const player = env.elements.get("video-player");

  // host2 is played second, so it is the currently playing source and
  // rendered first in the list.
  submitUrlForm(env, "https://host1.example/clip.mp4");
  submitUrlForm(env, "https://host2.example/clip.mp4");

  let recent = readRecent(env);
  assert.equal(recent.length, 2, "same title/different URL must create two records");

  // Progress written while playing host2 must land only on the host2 record.
  player.duration = 200;
  player.currentTime = 80;
  player.dispatchEvent({ type: "timeupdate" });

  recent = readRecent(env);
  const host1 = recent.find(i => i.video === "https://host1.example/clip.mp4");
  const host2 = recent.find(i => i.video === "https://host2.example/clip.mp4");
  assert.equal(host2.progress, 40);
  assert.equal(host1.progress, 0, "the same-title sibling record must stay untouched");

  // Replay host1 and write progress there: host2 keeps its own value.
  submitUrlForm(env, "https://host1.example/clip.mp4");
  player.currentTime = 20;
  player.dispatchEvent({ type: "timeupdate" });
  recent = readRecent(env);
  assert.equal(
    recent.find(i => i.video === "https://host1.example/clip.mp4").progress,
    10
  );
  assert.equal(
    recent.find(i => i.video === "https://host2.example/clip.mp4").progress,
    40
  );

  // Removing the first rendered record (host1, now most recent) must not
  // remove the same-title host2 record.
  const list = env.elements.get("recent-items");
  assert.equal(list.children.length, 2);
  list.children[0].children[0].click(); // spanRemove is the first child of each li
  await new Promise(resolve => setTimeout(resolve, 0)); // confirmation dialog is async

  recent = readRecent(env);
  assert.equal(recent.length, 1);
  assert.equal(
    recent[0].video,
    "https://host2.example/clip.mp4",
    "removal hits exactly one source identity"
  );
});

test("local ObjectURLs are revoked after use but never while still referenced", () => {
  const { context, objectUrls } = env;

  // Register URLs through the same URL.createObjectURL stub the app uses.
  const blob = { name: "blob" };
  const video1 = context.URL.createObjectURL(blob);
  const video2 = context.URL.createObjectURL(blob);
  const video3 = context.URL.createObjectURL(blob);
  const video4 = context.URL.createObjectURL(blob);
  const sub1 = context.URL.createObjectURL(blob);
  const sub2 = context.URL.createObjectURL(blob);

  context.playVideo(video1, "", "movie.mkv", "local", "url");
  assert.ok(objectUrls.has(video1), "current local URL stays alive while playing");

  // Replaying the SAME URL must not revoke it.
  context.playVideo(video1, "", "movie.mkv", "local", "url");
  assert.ok(objectUrls.has(video1));

  // Switching to another local video revokes the old one only.
  context.playVideo(video2, "", "other.mkv", "local", "url");
  assert.ok(!objectUrls.has(video1), "previous URL is released");
  assert.ok(objectUrls.has(video2), "new URL remains referenced");

  // Switching to a remote URL releases the local URL as well.
  context.playVideo("https://example.com/stream.mp4", "", "stream.mp4", "url", "url");
  assert.ok(!objectUrls.has(video2));

  // Local subtitle ObjectURLs get the same lifecycle treatment.
  context.playVideo(video3, sub1, "movie.mkv", "local", "local");
  assert.ok(objectUrls.has(sub1));
  context.playVideo(video4, sub2, "movie2.mkv", "local", "local");
  assert.ok(!objectUrls.has(sub1));
  assert.ok(objectUrls.has(sub2));

  // The pagehide flush releases whatever is still held.
  env.windowListeners.pagehide[0]();
  assert.ok(!objectUrls.has(video4));
  assert.ok(!objectUrls.has(sub2));
});

test("local recent entry click switches the form to local mode and opens the picker", () => {
  const { context, elements } = env;

  context.saveRecent("movie.mkv", "blob:dead-url", "local");
  const loadType = elements.get("video-load-type");
  const fileInput = elements.get("video-file");
  let pickerOpened = 0;
  fileInput.click = () => {
    pickerOpened += 1;
  };

  const list = elements.get("recent-items");
  const li = list.children[0];
  const titleSpan = li.children[1]; // spanTitle is appended after spanRemove
  titleSpan.click();

  assert.equal(loadType.value, "local", "load type switches to Local File");
  assert.equal(fileInput.style.display, "block", "file input is shown");
  assert.equal(pickerOpened, 1, "user is guided to reselect the file");
  assert.equal(elements.get("video-url").value, "", "no dead blob URL is submitted");
});

test("import: duplicate entries are rejected and the existing list is preserved", () => {

  submitUrlForm(env, "https://example.com/original.mp4");
  const before = readRecent(env);

  const backup = [
    {
      title: "dup.mp4",
      video: "https://example.com/dup.mp4",
      videoType: "url",
      subtitle: "",
      subtitleType: "url",
      progress: 0
    },
    {
      title: "other.mp4",
      video: "https://example.com/dup.mp4",
      videoType: "url",
      subtitle: "",
      subtitleType: "url",
      progress: 5
    }
  ];
  triggerImport(env, makeFile(env, "backup.json", backup));

  assert.deepEqual(readRecent(env), before, "failed import must not touch stored data");
});

test("import: over-long valid list is truncated to 30 entries", () => {
  const backup = [];
  for (let i = 0; i < 35; i++) {
    backup.push({
      title: "v" + i + ".mp4",
      video: "https://example.com/v" + i + ".mp4",
      videoType: "url",
      subtitle: "",
      subtitleType: "url",
      progress: 0
    });
  }
  triggerImport(env, makeFile(env, "long.json", backup));

  const imported = readRecent(env);
  assert.equal(imported.length, 30, "imported list is capped at the limit");
});

test("import: illegal files leave the existing list unchanged", () => {
  submitUrlForm(env, "https://example.com/keep.mp4");
  const before = readRecent(env);

  // Not JSON at all.
  triggerImport(env, { name: "bad.json", contents: "not-json{" });
  assert.deepEqual(readRecent(env), before);

  // JSON but wrong shape.
  triggerImport(env, makeFile(env, "obj.json", { nope: true }));
  assert.deepEqual(readRecent(env), before);

  // JSON array containing an invalid record.
  triggerImport(
    env,
    makeFile(env, "bad-record.json", [
      { title: "x", video: 5, videoType: "url", subtitleType: "url", progress: 0 }
    ])
  );
  assert.deepEqual(readRecent(env), before);
});

test("service-worker update: one confirmation produces exactly one reload", async () => {
  const { registration, navigator, reloadCalls } = env;

  // Fire the window load handler that registers the service worker and
  // wait for the registration microtasks to settle.
  await env.windowListeners.load[0]();

  // A waiting worker appears while the page is controlled.
  navigator.serviceWorker.controller = {};
  const waitingWorker = {
    state: "installed",
    listeners: {},
    addEventListener(type, handler) {
      (this.listeners[type] ||= []).push(handler);
    },
    postMessage(message) {
      this.lastMessage = message;
    }
  };
  // Real browsers fire updatefound and expose reg.installing together;
  // publish the worker on the registration before dispatching the event.
  registration.installing = waitingWorker;
  registration.dispatchEvent({ type: "updatefound" });
  registration.waiting = waitingWorker;

  // Repeated statechange notifications must only open one prompt.
  waitingWorker.listeners.statechange[0]({ target: waitingWorker });
  waitingWorker.listeners.statechange[0]({ target: waitingWorker });

  // Auto-confirmed Swal stub resolves the single prompt; allow the full
  // promise chain (fire -> Swal.fire -> .then -> postMessage) to settle.
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(waitingWorker.lastMessage && waitingWorker.lastMessage.type, "SKIP_WAITING");

  // Even multiple controllerchange events reload the page only once.
  navigator.serviceWorker.dispatchEvent({ type: "controllerchange" });
  navigator.serviceWorker.dispatchEvent({ type: "controllerchange" });
  assert.equal(reloadCalls.count, 1);
});
