import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";

import {
  savePages,
  getBatches,
  getPagesByBatch,
  deleteBatch,
  storageConfig,
} from "./storage.ts";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

function page(url: string, content: string, status = 200) {
  return { url, content, status };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  // Fresh, isolated IndexedDB per test.
  (globalThis as any).indexedDB = new IDBFactory();
  storageConfig.maxBytes = DEFAULT_MAX_BYTES;
});

afterEach(() => {
  storageConfig.maxBytes = DEFAULT_MAX_BYTES;
});

test("duplicate URLs within one batch are deduped, last result wins", async () => {
  const batchId = await savePages([
    page("https://a.com/1", "first version"),
    page("https://a.com/2", "other page"),
    page("https://a.com/1", "final version"),
  ]);

  const pages = await getPagesByBatch(batchId);
  assert.equal(pages.length, 2);

  const deduped = pages.find((p) => p.url === "https://a.com/1");
  assert.equal(deduped?.content, "final version");

  const batches = await getBatches();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].pageCount, 2);
});

test("different batches never overwrite each other", async () => {
  const batch1 = await savePages([page("https://a.com/1", "crawl one")]);
  await sleep(5);
  const batch2 = await savePages([page("https://a.com/1", "crawl two")]);

  assert.notEqual(batch1, batch2);

  const batches = await getBatches();
  assert.equal(batches.length, 2);

  const pages1 = await getPagesByBatch(batch1);
  const pages2 = await getPagesByBatch(batch2);
  assert.equal(pages1.length, 1);
  assert.equal(pages2.length, 1);
  assert.equal(pages1[0].content, "crawl one");
  assert.equal(pages2[0].content, "crawl two");
});

test("oldest batches are evicted whole when the cap is exceeded", async () => {
  storageConfig.maxBytes = 10_000;

  const batch1 = await savePages([page("https://a.com/1", "x".repeat(4000))]);
  await sleep(5);
  const batch2 = await savePages([page("https://a.com/2", "y".repeat(4000))]);
  await sleep(5);
  // 4000 + 4000 + 4000 = 12000 > 10000, so batch1 (oldest) must go.
  const batch3 = await savePages([page("https://a.com/3", "z".repeat(4000))]);

  const batches = await getBatches();
  const ids = batches.map((b) => b.id).sort();
  assert.deepEqual(ids, [batch2, batch3].sort());

  // Evicted batch is fully gone, surviving batches are intact.
  assert.deepEqual(await getPagesByBatch(batch1), []);
  assert.equal((await getPagesByBatch(batch2))[0].content.length, 4000);
  assert.equal((await getPagesByBatch(batch3))[0].content.length, 4000);

  const total = batches.reduce((sum, b) => sum + b.totalSize, 0);
  assert.ok(total <= storageConfig.maxBytes);
});

test("a batch larger than the cap is rejected without touching old data", async () => {
  storageConfig.maxBytes = 5_000;

  const keeper = await savePages([page("https://a.com/keep", "keep me")]);
  await sleep(5);

  await assert.rejects(
    () => savePages([page("https://a.com/huge", "x".repeat(6000))]),
    /exceeds the .* archive limit/
  );

  // The pre-existing batch survived the rejected write.
  const batches = await getBatches();
  assert.deepEqual(
    batches.map((b) => b.id),
    [keeper]
  );
  const pages = await getPagesByBatch(keeper);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].content, "keep me");
});

test("deleting a batch only removes that batch's pages", async () => {
  const batch1 = await savePages([page("https://a.com/1", "one")]);
  await sleep(5);
  const batch2 = await savePages([page("https://a.com/2", "two")]);

  await deleteBatch(batch1);

  const batches = await getBatches();
  assert.deepEqual(
    batches.map((b) => b.id),
    [batch2]
  );
  assert.deepEqual(await getPagesByBatch(batch1), []);
  assert.equal((await getPagesByBatch(batch2))[0].content, "two");
});
