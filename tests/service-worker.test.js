"use strict";

/*
 * Service-worker tests. service-worker.js is evaluated inside a vm
 * sandbox with minimal Cache/Clients/Event stubs, then its install,
 * activate and fetch event handlers are driven the same way the
 * browser would.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const SW_PATH = path.join(REPO_ROOT, "service-worker.js");

function createSwEnv() {
  const stores = new Map();

  // Browsers normalize cache entries against the scope URL, so the stub
  // stores everything under an absolute http://localhost URL.
  const cacheKey = key => {
    if (typeof key === "string") {
      const path = key === "./" ? "/" : key.replace(/^\.\//, "/");
      return new URL(path, "http://localhost").href;
    }
    return new URL(key.url).href;
  };

  const cachesStub = {
    async open(name) {
      if (!stores.has(name)) {
        const entries = new Map();
        stores.set(name, entries);
      }
      const store = stores.get(name);
      return {
        async addAll(urls) {
          for (const url of urls) store.set(cacheKey(url), { cached: url });
        },
        async put(key, response) {
          store.set(cacheKey(key), response);
        },
        async match(key) {
          const url = cacheKey(key);
          return store.has(url) ? store.get(url) : undefined;
        }
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
    async match(key) {
      const url = cacheKey(key);
      for (const store of stores.values()) {
        if (store.has(url)) return store.get(url);
      }
      return undefined;
    }
  };
  const handlers = {};
  const selfStub = {
    location: { origin: "http://localhost" },
    clients: {
      claimed: 0,
      claim() {
        selfStub.clients.claimed += 1;
      }
    },
    skipWaitingCalls: 0,
    skipWaiting() {
      selfStub.skipWaitingCalls += 1;
    },
    addEventListener(type, handler) {
      handlers[type] = handler;
    }
  };

  const context = {
    console,
    caches: cachesStub,
    self: selfStub,
    URL,
    Promise,
    fetch: globalThis.fetch
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(SW_PATH, "utf8"), context, {
    filename: "service-worker.js"
  });

  function dispatch(type, event) {
    const calls = [];
    handlers[type]({
      ...event,
      waitUntil(promise) {
        calls.push(promise);
      }
    });
    return Promise.all(calls);
  }

  return {
    context,
    stores,
    handlers,
    self: selfStub,
    dispatch,
    cacheName: vm.runInContext("cacheName", context)
  };
}

function navigateRequest() {
  return {
    method: "GET",
    mode: "navigate",
    url: "http://localhost/some/deep/route"
  };
}

function assetRequest(assetUrl) {
  return { method: "GET", mode: "no-cors", url: assetUrl };
}

test("install pre-caches the app shell under the new cache name", async () => {
  const env = createSwEnv();
  await env.dispatch("install", {});
  assert.ok(env.stores.has(env.cacheName));
  assert.equal(env.cacheName, "neovid-v1.5");
  const shell = env.stores.get(env.cacheName);
  assert.ok(shell.has("http://localhost/index.html"));
  assert.ok(
    shell.has("http://localhost/recent-store.js"),
    "new shared module is part of the shell"
  );
});

test("activation deletes every cache except the current version", async () => {
  const env = createSwEnv();

  // Simulate caches left behind by older service-worker versions.
  env.stores.set("neovid-v1.3", new Map([["index.html", {}]]));
  env.stores.set("neovid-v1.4", new Map([["index.html", {}]]));
  await env.dispatch("install", {});
  assert.ok(env.stores.has("neovid-v1.4"), "old cache exists before activation");

  await env.dispatch("activate", {});

  assert.ok(!env.stores.has("neovid-v1.3"), "v1.3 cache is deleted");
  assert.ok(!env.stores.has("neovid-v1.4"), "v1.4 cache is deleted");
  assert.ok(env.stores.has("neovid-v1.5"), "current cache is preserved");
  assert.equal(env.self.clients.claimed, 1, "clients.claim() runs during activation");
});

test("offline navigation falls back to the cached homepage", async () => {
  const env = createSwEnv();
  await env.dispatch("install", {});

  let respondWithValue;
  const offlineFetch = () => Promise.reject(new Error("network offline"));
  env.context.fetch = offlineFetch;

  env.handlers.fetch({
    request: navigateRequest(),
    respondWith(responsePromise) {
      respondWithValue = responsePromise;
    }
  });

  const response = await respondWithValue;
  assert.deepEqual(response, { cached: "index.html" }, "cached homepage is served offline");
});

test("online navigation prefers the network and refreshes the cached homepage", async () => {
  const env = createSwEnv();
  await env.dispatch("install", {});

  const freshResponse = { fresh: true, clone() { return { fresh: true }; } };
  env.context.fetch = () => Promise.resolve(freshResponse);

  let respondWithValue;
  env.handlers.fetch({
    request: navigateRequest(),
    respondWith(responsePromise) {
      respondWithValue = responsePromise;
    }
  });

  const response = await respondWithValue;
  assert.equal(response, freshResponse, "online navigation uses the network response");
  // The fallback copy is stored for the next offline navigation.
  assert.deepEqual(
    env.stores.get(env.cacheName).get("http://localhost/index.html"),
    { fresh: true }
  );
});

test("non-GET and cross-origin requests bypass the service worker", () => {
  const env = createSwEnv();
  let called = false;
  const event = {
    request: { method: "POST", mode: "cors", url: "http://localhost/api" },
    respondWith() {
      called = true;
    }
  };
  env.handlers.fetch(event);
  assert.equal(called, false);

  called = false;
  env.handlers.fetch({
    request: { method: "GET", mode: "cors", url: "https://other-origin.example/x" },
    respondWith() {
      called = true;
    }
  });
  assert.equal(called, false);
});

test("cached same-origin assets are served without hitting the network", async () => {
  const env = createSwEnv();
  await env.dispatch("install", {});
  env.context.fetch = () => {
    throw new Error("network must not be used for a cached asset");
  };

  let respondWithValue;
  env.handlers.fetch({
    request: assetRequest("http://localhost/style.css"),
    respondWith(promise) {
      respondWithValue = promise;
    }
  });
  const response = await respondWithValue;
  assert.deepEqual(response, { cached: "style.css" });
});

test("SKIP_WAITING message calls skipWaiting exactly once", () => {
  const env = createSwEnv();
  env.handlers.message({ data: { type: "SKIP_WAITING" } });
  assert.equal(env.self.skipWaitingCalls, 1);

  // Unrelated messages are ignored.
  env.handlers.message({ data: { type: "OTHER" } });
  assert.equal(env.self.skipWaitingCalls, 1);
});
