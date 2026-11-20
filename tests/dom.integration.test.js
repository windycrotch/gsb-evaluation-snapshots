"use strict";

/*
 * DOM-integration smoke test.
 *
 * Loads the real script.js inside a sandbox whose `document`, `localStorage`
 * and <video> element are lightweight stubs, then drives the same event
 * sequence the browser would produce. This verifies the wiring between the
 * DOM layer and core.js (entry ids, playback tokens, import rollback).
 *
 * Run: node --test tests/dom.integration.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const REPO_ROOT = path.join(__dirname, "..");

function createElement(tagName) {
  const listeners = {};
  const element = {
    tagName: String(tagName || "div").toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    value: "",
    textContent: "",
    _innerHTML: "",
    className: "",
    disabled: false,
    files: [],
    currentTime: 0,
    duration: 0,
    paused: true,
    ended: false,
    volume: 1,
    muted: false,
    appendChild(child) {
      this.children.push(child);
    },
    get innerHTML() {
      return this._innerHTML;
    },
    // Clearing innerHTML in a real element also removes child nodes.
    set innerHTML(value) {
      this._innerHTML = value;
      if (value === "") {
        this.children = [];
      }
    },
    addEventListener(type, handler) {
      (listeners[type] = listeners[type] || []).push(handler);
    },
    removeEventListener() {},
    dispatch(type, event) {
      (listeners[type] || []).forEach((handler) => handler(event || {}));
    },
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    load() {
      // The real element fires `loadstart` synchronously-ish after load().
      queueMicrotask(() => this.dispatch("loadstart"));
    },
    requestSubmit() {},
    scrollIntoView() {},
    click() {},
  };
  return element;
}

function buildSandbox() {
  const storageMap = new Map();
  const localStorage = {
    getItem: (key) => (storageMap.has(key) ? storageMap.get(key) : null),
    setItem: (key, value) => storageMap.set(key, String(value)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear(),
  };

  const elementsById = {};
  const documentListeners = {};
  const windowListeners = {};

  const documentStub = {
    getElementById(id) {
      if (!elementsById[id]) {
        elementsById[id] = createElement("div");
      }
      return elementsById[id];
    },
    createElement: (tagName) => createElement(tagName),
    addEventListener(type, handler) {
      (documentListeners[type] = documentListeners[type] || []).push(handler);
    },
    dispatch(type, event) {
      (documentListeners[type] || []).forEach((handler) => handler(event || {}));
    },
    fullscreenElement: null,
    exitFullscreen: async () => {},
  };

  const windowStub = {
    location: { search: "", reload() {} },
    addEventListener(type, handler) {
      (windowListeners[type] = windowListeners[type] || []).push(handler);
    },
    dispatch(type, event) {
      (windowListeners[type] || []).forEach((handler) => handler(event || {}));
    },
  };

  const URLStub = {
    createObjectURL: () => "blob:stub",
    revokeObjectURL: () => {},
  };

  // Resolve confirmations synchronously so removal handlers run inline,
  // matching the ordering the assertions rely on.
  const SwalStub = {
    fire: () => ({
      then: (onFulfilled) =>
        onFulfilled({ isConfirmed: true, value: "export.json" }),
    }),
  };

  const sandbox = {
    console,
    document: documentStub,
    window: windowStub,
    localStorage,
    URL: URLStub,
    URLSearchParams,
    Swal: SwalStub,
    FileReader: function () {
      this.readAsText = (file) => {
        // Mirrors the real FileReader: result is read from the instance.
        this.result = file.content;
        this.onload({ target: this });
      };
    },
    Blob: class Blob {
      constructor(parts) {
        this.parts = parts;
      }
    },
    crypto: require("node:crypto").webcrypto,
    navigator: {},
    queueMicrotask,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  const coreSource = fs.readFileSync(path.join(REPO_ROOT, "core.js"), "utf8");
  const scriptSource = fs.readFileSync(path.join(REPO_ROOT, "script.js"), "utf8");
  vm.runInContext(coreSource, sandbox);
  vm.runInContext(scriptSource, sandbox);

  // DOMContentLoaded initialises the page.
  windowStub.dispatch("DOMContentLoaded");

  return { sandbox, elementsById, localStorage, storageMap };
}

function getStoredList(localStorage) {
  return JSON.parse(localStorage.getItem("recentVideos") || "[]");
}

// Fill the play form and submit it through the real handler.
function submitVideo(env, url) {
  const { elementsById, sandbox } = env;
  elementsById["video-load-type"].value = "url";
  elementsById["subtitle-load-type"].value = "url";
  elementsById["video-url"].value = url;
  elementsById["subtitle-url"].value = "";
  elementsById["video-file"].files = [];
  elementsById["video-form"].dispatch("submit", {
    preventDefault() {},
  });
  return sandbox;
}

function setPlayerTime(env, currentTime, duration) {
  const player = env.elementsById["video-player"];
  player.currentTime = currentTime;
  player.duration = duration;
  player.dispatch("timeupdate");
}

test("integration: progress is written to the playing entry via its id", async () => {
  const env = buildSandbox();
  submitVideo(env, "https://example.com/a.mp4");
  await Promise.resolve(); // let loadstart fire

  const player = env.elementsById["video-player"];
  player.duration = 100;
  player.dispatch("loadedmetadata");
  assert.equal(player.currentTime, 0);

  setPlayerTime(env, 50, 100);
  const list = getStoredList(env.localStorage);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "a.mp4");
  assert.equal(list[0].progress, 50);
  assert.ok(list[0].id);
});

test("integration: deleting the current entry stops further progress writes", async () => {
  const env = buildSandbox();
  submitVideo(env, "https://example.com/delete-me.mp4");
  await Promise.resolve();
  setPlayerTime(env, 30, 100);

  const before = getStoredList(env.localStorage);
  assert.equal(before[0].progress, 30);
  const entryId = before[0].id;

  // Click the trash icon rendered inside the list item.
  const listEl = env.elementsById["recent-items"];
  const li = listEl.children[0];
  const trash = li.children[0]; // spanRemove is appended first
  trash.dispatch("click");
  await Promise.resolve();

  assert.equal(getStoredList(env.localStorage).length, 0);

  // Playback continues; further timeupdate events must not recreate the entry.
  setPlayerTime(env, 90, 100);
  assert.equal(getStoredList(env.localStorage).length, 0);

  // Replay the same video: a fresh entry at 0%.
  submitVideo(env, "https://example.com/delete-me.mp4");
  await Promise.resolve();
  const replayed = getStoredList(env.localStorage);
  assert.equal(replayed.length, 1);
  assert.notEqual(replayed[0].id, entryId);
  assert.equal(replayed[0].progress, 0);
});

test("integration: rapid switch keeps each video's progress isolated", async () => {
  const env = buildSandbox();
  const player = env.elementsById["video-player"];

  submitVideo(env, "https://example.com/first.mp4");
  await Promise.resolve(); // first media ready
  player.duration = 100;
  setPlayerTime(env, 60, 100);

  // Immediately switch; the new media has not fired loadstart yet.
  submitVideo(env, "https://example.com/second.mp4");

  // A late timeupdate from the old media must be ignored.
  player.currentTime = 95;
  player.dispatch("timeupdate");
  await Promise.resolve(); // second media loadstart now fires

  const list = getStoredList(env.localStorage);
  const first = list.find((item) => item.title === "first.mp4");
  const second = list.find((item) => item.title === "second.mp4");
  assert.equal(first.progress, 60);
  assert.equal(second.progress, 0);

  // After the new media is ready, its events apply to its own entry.
  setPlayerTime(env, 20, 100);
  const updated = getStoredList(env.localStorage);
  assert.equal(updated.find((item) => item.title === "second.mp4").progress, 20);
  assert.equal(updated.find((item) => item.title === "first.mp4").progress, 60);
});

test("integration: invalid import rolls back, valid import replaces and detaches player", async () => {
  const env = buildSandbox();
  submitVideo(env, "https://example.com/original.mp4");
  await Promise.resolve();
  setPlayerTime(env, 40, 100);
  const original = getStoredList(env.localStorage);
  assert.equal(original[0].progress, 40);

  const fileInput = env.elementsById["recent-file"];

  // Invalid payload (progress out of range): error path, list untouched.
  fileInput.files = [
    {
      name: "bad.json",
      content: JSON.stringify([
        { title: "x.mp4", video: "v", videoType: "url", subtitle: "", subtitleType: "url", progress: 200 },
      ]),
    },
  ];
  fileInput.dispatch("change");
  assert.deepEqual(getStoredList(env.localStorage), original);

  // Valid payload replaces the list.
  const backup = [
    { id: "b1", title: "imported.mp4", video: "https://example.com/imported.mp4", videoType: "url", subtitle: "", subtitleType: "url", progress: 10 },
  ];
  fileInput.files = [{ name: "good.json", content: JSON.stringify(backup) }];
  fileInput.dispatch("change");

  const replaced = getStoredList(env.localStorage);
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].id, "b1");

  // The old player is detached: its late events cannot write anywhere.
  setPlayerTime(env, 99, 100);
  const afterStrayEvent = getStoredList(env.localStorage);
  assert.equal(afterStrayEvent[0].progress, 10);

  // The rendered list reflects the imported data.
  const rendered = env.elementsById["recent-items"];
  assert.equal(rendered.children.length, 1);
  const renderedLi = rendered.children[0];
  assert.equal(renderedLi.dataset.entryId, "b1");
  const titleSpan = renderedLi.children.find((child) => child.className === "recent-title");
  assert.equal(titleSpan.textContent, "imported.mp4");
});
