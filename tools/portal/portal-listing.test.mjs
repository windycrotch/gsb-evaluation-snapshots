// Offline tests for the listing pipeline in engine/portal.js: entry URL
// validation, de-duplication, blocked-prefix filtering, the 256-entry cap,
// and the built-in fallback when the directory fails or answers empty.
// Directory JSON is synthesized in-process; fetch never leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './browser-shim.mjs';

// portal.js -> gate.js reads matchMedia at module load, so the browser
// environment must exist before the engine module graph is imported.
installBrowser({ url: 'http://127.0.0.1:8080/home/', reset: true });
const { initialWorlds, getWorlds, isCurrentWorld, __resetDirectoryForTests } = await import('../../engine/portal.js');
const { DEFAULT_WORLDS } = await import('../../engine/worlds-default.js');

const SELF = 'http://127.0.0.1:8080/home/';
const DIRECTORY_URL = 'http://127.0.0.1:9001/worlds.json';
const world = (over = {}) => ({ name: 'A World', url: 'https://a.example/', homecraft: true, ...over });

function stubDirectory(payload, { fail = false } = {}) {
  globalThis.fetch = async url => {
    if (String(url) !== DIRECTORY_URL) throw new TypeError(`unexpected fetch ${url}`);
    if (fail) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => structuredClone(payload) };
  };
}

test.beforeEach(() => {
  installBrowser({ url: SELF });
  __resetDirectoryForTests(); // each case starts with a cold directory cache
});
test.afterEach(() => { globalThis.fetch = undefined; });

test('entries require an http/https URL; javascript and credential URLs are dropped', async () => {
  stubDirectory({ worlds: [
    world({ name: 'OK', url: 'https://ok.example/' }),
    world({ name: 'Script', url: 'javascript:alert(1)' }),
    world({ name: 'Data', url: 'data:text/html,<h1>x</h1>' }),
    world({ name: 'Creds', url: 'https://user:pass@ok.example/secret' }),
    world({ name: 'Empty', url: '' }),
    'not-an-object',
    null,
  ] });
  const { worlds } = await getWorlds(true);
  assert.deepEqual(worlds.map(w => w.name), ['OK']);
  assert.equal(worlds[0].url, 'https://ok.example/');
});

test('entries are de-duplicated by world key, keeping the first occurrence', async () => {
  stubDirectory({ worlds: [
    world({ name: 'First', url: 'https://dup.example/' }),
    world({ name: 'Second', url: 'https://dup.example/index.html?from=https://x/' }),
    world({ name: 'Third', url: 'https://dup.example#fragment' }),
    world({ name: 'Other', url: 'https://other.example/' }),
  ] });
  const { worlds } = await getWorlds(true);
  assert.deepEqual(worlds.map(w => w.name), ['First', 'Other']);
});

test('blocked prefixes hide the world and every path beneath it', async () => {
  stubDirectory({
    blocked: ['https://bad.example/'],
    worlds: [
      world({ name: 'Bad root', url: 'https://bad.example/' }),
      world({ name: 'Bad child', url: 'https://bad.example/deep/place/' }),
      world({ name: 'Sibling stays', url: 'https://good.example/' }),
      world({ name: 'Nearly bad stays', url: 'https://bad.example.other.host/' }),
    ],
  });
  const { worlds } = await getWorlds(true);
  assert.deepEqual(worlds.map(w => w.name), ['Sibling stays', 'Nearly bad stays']);
});

test('the list holds at most 256 entries even when the directory sends more', async () => {
  stubDirectory({
    worlds: Array.from({ length: 300 }, (_, i) => world({ name: `W${i}`, url: `https://w${i}.example/` })),
  });
  const { worlds } = await getWorlds(true);
  assert.equal(worlds.length, 256);
  assert.equal(worlds[0].name, 'W0');
  assert.equal(worlds[255].name, 'W255');
});

test('an empty directory falls back to the built-in default worlds', async () => {
  stubDirectory({ worlds: [] });
  const result = await getWorlds(true);
  assert.equal(result.missed, false, 'an answered empty list is not a network miss');
  assert.equal(result.worlds.length, DEFAULT_WORLDS.length);
  assert.equal(result.worlds[0].url, DEFAULT_WORLDS[0].url);
});

test('a failed directory falls back to defaults and reports the miss quietly', async () => {
  stubDirectory(null, { fail: true });
  const result = await getWorlds(true);
  assert.equal(result.missed, true);
  assert.deepEqual(result.worlds.map(w => w.url), DEFAULT_WORLDS.map(w => w.url));
});

test('initialWorlds before any response reports no miss and no error, and getWorlds supplies the fallback', async () => {
  // With sources configured but nothing fetched yet: not "missed" (the
  // request is still in flight), not an error, just no rows to paint yet.
  const initial = initialWorlds();
  assert.equal(initial.ready, false);
  assert.equal(initial.missed, false);
  assert.deepEqual(initial.worlds, []);

  stubDirectory(null, { fail: true });
  const resolved = await getWorlds(true);
  assert.equal(resolved.missed, true);
  assert.deepEqual(resolved.worlds.map(w => w.url), DEFAULT_WORLDS.map(w => w.url));
});

test('with no valid remote entry, names fall back to the hostname and labels are plain text', async () => {
  stubDirectory({ worlds: [
    { url: 'https://noname.example/path/', homecraft: true },
    { name: { zh: '小屋', en: 'Cottage' }, url: 'https://named.example/' },
    { name: '   spaced   name  ', url: 'https://spaced.example/' },
  ] });
  const { worlds } = await getWorlds(true);
  assert.equal(worlds.find(w => w.url.startsWith('https://noname.example/')).name, 'noname.example');
  assert.equal(worlds.find(w => w.url.startsWith('https://named.example/')).name, 'Cottage');
  assert.equal(worlds.find(w => w.url.startsWith('https://spaced.example/')).name, 'spaced name');
});

test('join/all footer links must be https or they are ignored', async () => {
  stubDirectory({
    join: 'javascript:alert(1)', all: 'http://insecure.example/all',
    worlds: [world()],
  });
  const result = await getWorlds(true);
  assert.equal(result.join, null);
  assert.equal(result.all, null);

  stubDirectory({
    join: 'https://example.com/join', all: 'https://example.com/all',
    worlds: [world()],
  });
  const https = await getWorlds(true);
  assert.equal(https.join, 'https://example.com/join');
  assert.equal(https.all, 'https://example.com/all');
});

test('isCurrentWorld compares world keys, ignoring query strings and index.html', () => {
  assert.equal(isCurrentWorld(`${SELF}?anything=here`), true);
  assert.equal(isCurrentWorld(`${SELF}index.html`), true);
  assert.equal(isCurrentWorld('https://elsewhere.example/'), false);
});

test('the default bundled world itself is not re-moderated by remote entries', async () => {
  // A remote directory whose only valid entry is blocked leaves the fallback.
  stubDirectory({ blocked: ['https://a.example/'], worlds: [world()] });
  const { worlds } = await getWorlds(true);
  assert.deepEqual(worlds.map(w => w.url), DEFAULT_WORLDS.map(w => w.url));
});
