// Offline tests for engine/door-directory.js: multiple directory addresses,
// first valid answer, failure/empty fallback behavior, caching and stale
// refresh handling. All directory JSON is produced in-process; fetch is
// replaced with a controllable router, so no network or server is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectory } from '../../engine/door-directory.js';

const A = 'http://127.0.0.1:9001/a/worlds.json';
const B = 'http://127.0.0.1:9002/b/worlds.json';
const C = 'http://127.0.0.1:9003/c/worlds.json';

const jsonResponse = data => ({
  ok: true,
  status: 200,
  json: async () => structuredClone(data),
});
const failureResponse = status => ({ ok: false, status, json: async () => ({}) });

// A fetch router whose routes can answer immediately, hang until released,
// or reject. Every call is recorded with its AbortSignal for assertions.
// Like a real fetch, a pending route rejects when the signal aborts.
function router(setup) {
  const calls = [];
  const routes = new Map();
  globalThis.fetch = async (url, init = {}) => {
    const record = { url: String(url), init, aborted: false };
    init.signal?.addEventListener?.('abort', () => { record.aborted = true; });
    calls.push(record);
    const route = routes.get(String(url));
    if (!route) throw new TypeError(`unexpected request ${url}`);
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return Promise.race([
      route(record),
      new Promise((_, reject) => init.signal?.addEventListener('abort',
        () => reject(new DOMException('The operation was aborted', 'AbortError')))),
    ]);
  };
  setup(routes);
  return {
    calls,
    routes,
    immediate(data) { routes.set(A, async () => jsonResponse(data)); },
    reset() { routes.clear(); calls.length = 0; },
  };
}

test.beforeEach(() => { globalThis.fetch = undefined; });
test.afterEach(() => { globalThis.fetch = undefined; });

test('the first valid mirror answer wins and losers are aborted', async () => {
  const net = router(routes => {
    routes.set(A, async () => new Promise(() => {})); // stalls until aborted
    routes.set(B, async () => jsonResponse({ version: 1, worlds: [{ name: 'From B', url: 'https://b.example/' }] }));
    routes.set(C, async () => new Promise(() => {}));
  });
  const directory = createDirectory([A, B, C], { timeout: 1000 });
  const data = await directory.read();
  assert.equal(data.worlds[0].name, 'From B');
  assert.equal(net.calls.length, 3, 'every mirror is raced');
  assert(net.calls.find(c => c.url === A).aborted, 'the stalled primary is aborted');
  assert(net.calls.find(c => c.url === C).aborted);
  assert.equal(directory.peek(), data);
});

test('non-OK responses and invalid JSON shapes are skipped, then retried after a total miss', async () => {
  const net = router(routes => {
    routes.set(A, async () => failureResponse(503));
    routes.set(B, async () => ({ ok: true, status: 200, json: async () => ({ not: 'a directory' }) }));
  });
  const directory = createDirectory([A, B], { timeout: 1000 });
  assert.equal(await directory.read(), null);
  assert.equal(directory.peek(), null);
  assert.equal(net.calls.length, 2);
  // A miss with nothing stored must be tried again rather than cached.
  assert.equal(await directory.read(), null);
  assert.equal(net.calls.length, 4);
});

test('a network rejection or the timeout produces null, never a thrown error', async () => {
  router(routes => {
    routes.set(A, async () => { throw new TypeError('Failed to fetch'); });
    routes.set(B, async () => new Promise(() => {})); // never settles; timeout aborts it
  });
  const start = Date.now();
  const directory = createDirectory([A, B], { timeout: 60 });
  assert.equal(await directory.read(), null);
  assert(Date.now() - start < 800, 'the timeout fired instead of waiting forever');
});

test('fresh snapshots are cached; after maxAge a forced refresh can replace them', async () => {
  const net = router(routes => {
    routes.set(A, async () => jsonResponse({ version: 1, updated: '2026-10-25T08:00:00.000Z', worlds: [] }));
  });
  const directory = createDirectory([A], { maxAge: 50, timeout: 1000 });
  const first = await directory.read();
  await directory.read(); // still fresh
  assert.equal(net.calls.length, 1, 'within maxAge no new request is made');
  await new Promise(resolve => setTimeout(resolve, 70));
  net.routes.set(A, async () => jsonResponse({ version: 1, updated: '2026-10-26T08:00:00.000Z', worlds: [] }));
  const second = await directory.read();
  assert.equal(net.calls.length, 2);
  assert.equal(second.updated, '2026-10-26T08:00:00.000Z');
  assert.notEqual(first, second);
});

test('a failed refresh keeps the previous directory including its blocked list', async () => {
  const net = router(routes => {
    routes.set(A, async () => jsonResponse({ version: 1, updated: '2026-10-25T08:00:00.000Z', blocked: ['https://bad.example/'], worlds: [] }));
  });
  const directory = createDirectory([A], { maxAge: 20, timeout: 1000 });
  const first = await directory.read();
  await new Promise(resolve => setTimeout(resolve, 30));
  net.routes.set(A, async () => failureResponse(500));
  const kept = await directory.read(true);
  assert.equal(kept, first, 'the old snapshot survives the failed refresh');
  assert.deepEqual(kept.blocked, ['https://bad.example/']);
  // The successful retry window resets: another immediate read uses cache.
  const callsSoFar = net.calls.length;
  assert.equal(await directory.read(), first);
  assert.equal(net.calls.length, callsSoFar);
});

test('an older mirror snapshot never replaces a newer directory', async () => {
  const net = router(routes => {
    routes.set(A, async () => jsonResponse({ version: 1, updated: '2026-10-25T08:00:00.000Z', worlds: [{ url: 'https://new.example/' }] }));
  });
  const directory = createDirectory([A], { maxAge: 10, timeout: 1000 });
  const current = await directory.read();
  await new Promise(resolve => setTimeout(resolve, 20));
  net.routes.set(A, async () => jsonResponse({ version: 1, updated: '2026-10-20T08:00:00.000Z', worlds: [{ url: 'https://old.example/' }] }));
  assert.equal(await directory.read(true), current);
  assert.deepEqual(directory.peek().worlds, [{ url: 'https://new.example/' }]);
});

test('concurrent reads share one in-flight request per mirror', async () => {
  const net = router(routes => {
    routes.set(A, async () => jsonResponse({ version: 1, worlds: [] }));
    routes.set(B, async () => failureResponse(503));
  });
  const directory = createDirectory([A, B], { timeout: 1000 });
  const [one, two] = await Promise.all([directory.read(), directory.read()]);
  assert.equal(one, two);
  assert.equal(net.calls.length, 2, 'the second caller reuses the in-flight fetch');
});

test('source lists are deduplicated and non-string entries are ignored', async () => {
  const net = router(routes => {
    routes.set(A, async () => jsonResponse({ version: 1, worlds: [] }));
  });
  const directory = createDirectory([A, A, '', null, 7, A], { timeout: 1000 });
  await directory.read();
  assert.deepEqual(net.calls.map(c => c.url), [A]);
});

test('both top-level array and { worlds } payloads are accepted', async () => {
  const net = router(routes => {
    routes.set(A, async () => jsonResponse([{ name: 'Plain array', url: 'https://arr.example/' }]));
    routes.set(B, async () => jsonResponse({ worlds: [{ name: 'Wrapped', url: 'https://wrap.example/' }] }));
  });
  assert.deepEqual((await createDirectory([A], { timeout: 1000 }).read())[0].name, 'Plain array');
  assert.deepEqual((await createDirectory([B], { timeout: 1000 }).read()).worlds[0].name, 'Wrapped');
  assert.equal(net.calls.length, 2);
});
