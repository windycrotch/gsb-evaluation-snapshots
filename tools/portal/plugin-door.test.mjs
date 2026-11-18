// Offline tests for the standalone blog plugin's listing filter
// (plugin/homecraft-door.js). It keeps its own copy of the directory
// pipeline, so the same URL/dedup/blocked/cap/fallback rules are asserted
// here against synthesized directory JSON — no network involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './browser-shim.mjs';

// The plugin touches document/location at module load; install first.
installBrowser({ url: 'http://127.0.0.1:8080/blog/', reset: true });
const { worlds } = await import('../../plugin/homecraft-door.js');
const { DEFAULT_WORLDS } = await import('../../plugin/worlds-default.js');

test('drops non-http(s) and credential URLs while keeping valid rows', () => {
  const dir = { worlds: [
    { name: 'OK', url: 'https://ok.example/' },
    { name: 'Script', url: 'javascript:alert(1)' },
    { name: 'Creds', url: 'https://u:p@ok.example/' },
    { name: 'HTTP local', url: 'http://127.0.0.1:4173/' },
  ] };
  const { more } = worlds(false, dir);
  assert.deepEqual(more.map(w => w.url), ['https://ok.example/', 'http://127.0.0.1:4173/']);
});

test('de-duplicates by world key and applies blocked prefixes', () => {
  const dir = {
    blocked: ['https://bad.example/'],
    worlds: [
      { name: 'First', url: 'https://dup.example/' },
      { name: 'Second', url: 'https://dup.example/index.html?from=x' },
      { name: 'Bad', url: 'https://bad.example/child/' },
      { name: 'Kept', url: 'https://good.example/' },
    ],
  };
  const { more } = worlds(false, dir);
  assert.deepEqual(more.map(w => w.name), ['First', 'Kept']);
});

test('caps the directory at 256 entries', () => {
  const dir = { worlds: Array.from({ length: 300 }, (_, i) => ({ name: `W${i}`, url: `https://w${i}.example/` })) };
  assert.equal(worlds(false, dir).more.length, 256);
});

test('falls back to the bundled defaults when ready but the directory is empty or failed', () => {
  const empty = worlds(false, { worlds: [] });
  assert.deepEqual(empty.more.map(w => w.url), DEFAULT_WORLDS.map(w => w.url));
  assert.equal(empty.missed, false);

  const failed = worlds(false, null);
  assert.equal(failed.missed, true);
  assert.deepEqual(failed.more.map(w => w.url), DEFAULT_WORLDS.map(w => w.url));
});

test('a still-loading directory shows no fallback rows yet and reports loading', () => {
  const pending = worlds(false, null, false);
  assert.equal(pending.loading, true);
  assert.deepEqual(pending.more, []);
});

test('accepts both string and bilingual names and treats them as plain text', () => {
  const dir = { worlds: [
    { name: { zh: '小屋', en: 'Cottage' }, url: 'https://a.example/' },
    { name: { zh: '小屋', en: 'Cottage' }, url: 'https://b.example/' },
  ] };
  assert.equal(worlds(false, dir).more[0].name, 'Cottage');
  assert.equal(worlds(true, dir).more[0].name, '小屋');
});

test('the "all" footer link must be https to be kept', () => {
  assert.equal(worlds(false, { all: 'http://insecure.example/', worlds: [] }).all, null);
  assert.equal(worlds(false, { all: 'https://secure.example/all', worlds: [] }).all, 'https://secure.example/all');
});
