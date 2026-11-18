// Offline tests for engine/door-protocol.js (the cross-site travel session):
// arrival is accepted only when referrer and from share an origin, or when
// this tab genuinely departed for that world; pasted/forged links create no
// return entry and never change the skin; from/hash are stripped from the
// address bar; skins must be <=24000-char base64url 64x64 PNGs and are
// re-encoded as pure pixels; returning restores the source world and skin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makePNG, registerImageData, clearImageData, installBrowser } from './browser-shim.mjs';
import {
  createTravelSession, worldURL, worldKey, decodeSkin, MAX_SKIN,
} from '../../engine/door-protocol.js';

const HOME = 'http://127.0.0.1:8080/home/';
const NEIGHBOUR = 'http://127.0.0.1:8081/neighbour/';
const EVIL = 'https://evil.example/';

// base64url helpers matching the wire format (no padding, - and _).
const b64url = bytes => Buffer.from(bytes).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const validSkin = () => b64url(makePNG(64, 64));
const makePNGBytes = (w, h) => makePNG(w, h);

function openAt(href, { referrer = '', navigationType = 'navigate' } = {}) {
  const env = installBrowser({ url: href, referrer });
  env.setNavigationType(navigationType);
  // Every canvas-backed data URL the shim produces is a valid 64x64 PNG the
  // fake Image can decode back through the registered wildcard fixture.
  registerImageData('*', makePNG(64, 64));
  return env;
}

// Baseline environment for the pure-URL tests that never navigate themselves.
installBrowser({ url: HOME, reset: true });

test.beforeEach(() => {
  // Isolated tab per test: storage starts empty even when cases share a file.
  globalThis.sessionStorage?.clear();
  globalThis.localStorage?.clear();
  clearImageData();
  registerImageData('*', makePNG(64, 64));
});

// ---------- URL helpers ----------
test('worldURL accepts only http/https and strips from tokens and credentials', () => {
  assert.equal(worldURL('https://example.com/world/?from=https://x/')?.href, 'https://example.com/world/');
  assert.equal(worldURL('http://localhost:4173/')?.protocol, 'http:');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://example.com/', 'https://u:p@example.com/', '', null, 42]) {
    assert.equal(worldURL(bad), null, `rejected ${bad}`);
  }
  assert.equal(worldKey('https://example.com/a/index.html?from=x'), 'https://example.com/a');
  assert.equal(worldKey('https://example.com/a/'), 'https://example.com/a');
});

// ---------- Forged arrivals ----------
test('a pasted link with from and homecraft hash but no referrer establishes no return entry', () => {
  const env = openAt(`${HOME}?from=${encodeURIComponent(EVIL)}#homecraft=1&skin=default`);
  const session = createTravelSession();
  const arrival = session.arrive();
  assert.equal(arrival.door, false);
  assert.equal(arrival.from, null);
  assert.equal(arrival.fromName, '');
  // The address bar is cleaned regardless of whether the arrival was trusted.
  const url = new URL(env.location.href);
  assert.equal(url.searchParams.has('from'), false);
  assert.equal(url.hash, '');
});

test('a from whose origin does not match the referrer is rejected even with a valid hash', () => {
  const env = openAt(
    `${HOME}?from=${encodeURIComponent(EVIL)}#homecraft=1&skin=default`,
    { referrer: 'https://honest.example/some/page' },
  );
  const arrival = createTravelSession().arrive();
  assert.equal(arrival.door, false);
  assert.equal(arrival.from, null);
  assert.equal(new URL(env.location.href).hash, '');
});

test('a forged link cannot dress the visitor up: its skin is never adopted', async () => {
  openAt(`${HOME}?from=${encodeURIComponent(EVIL)}#homecraft=1&skin=${validSkin()}`);
  const session = createTravelSession();
  session.arrive();
  const worn = await session.wornSkin();
  assert.equal(worn.carried, false, 'only an owner skin or the default character may be worn');
  assert.equal(worn.value, 'default');
});

test('a hash-only marker without from, and a from without the marker, are both ignored', () => {
  const env1 = openAt(`${HOME}#homecraft=1&skin=default`);
  assert.equal(createTravelSession().arrive().door, false);
  assert.equal(new URL(env1.location.href).hash, '');

  const env2 = openAt(`${HOME}?from=${encodeURIComponent(NEIGHBOUR)}`);
  const arrival = createTravelSession().arrive();
  assert.equal(arrival.door, false);
  assert.equal(arrival.from, null);
  assert.equal(new URL(env2.location.href).searchParams.has('from'), false);
});

test('a loopback from is not accepted just because the schemes differ: an unrecorded HTTP world stays untrusted', () => {
  const env = openAt(
    `${HOME}?from=${encodeURIComponent('http://127.0.0.1:9999/other/')}#homecraft=1&skin=default`,
    { referrer: 'https://127.0.0.1:9999/other/page' },
  );
  const arrival = createTravelSession().arrive();
  // Origins include scheme; https referrer vs http from are different origins.
  assert.equal(arrival.door, false);
  assert.equal(new URL(env.location.href).search, '');
});

// ---------- Genuine arrivals ----------
test('a matching referrer origin vouches for a real arrival and cleans the address bar', () => {
  const env = openAt(
    `${HOME}?from=${encodeURIComponent(NEIGHBOUR)}#homecraft=1&skin=default&fromName=${encodeURIComponent('Neighbour World')}`,
    { referrer: `${NEIGHBOUR}page` },
  );
  const arrival = createTravelSession().arrive();
  assert.equal(arrival.door, true);
  assert.equal(arrival.from, NEIGHBOUR);
  assert.equal(arrival.fromName, 'Neighbour World');
  const url = new URL(env.location.href);
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
});

test('a return to the world this tab actually departed for is trusted without a referrer', async () => {
  // World A: leave for B. The departure is written to A's tab storage.
  let env = openAt(HOME);
  let session = createTravelSession();
  session.arrive();
  const outbound = await session.link({ url: NEIGHBOUR, homecraft: true });
  assert(outbound.includes(`from=${encodeURIComponent('http://127.0.0.1:8080/home')}`));
  assert(outbound.includes('#homecraft=1'));
  assert([...env.sessionStorage.map.values()].some(raw => raw.includes(worldKey(NEIGHBOUR))));

  // World B: arrival vouched by the real referrer (same-origin test setup),
  // then the visitor presses Back. B's one-click return link points at A.
  env = openAt(outbound, { referrer: HOME });
  session = createTravelSession();
  const atB = session.arrive();
  assert.equal(atB.door, true);
  const linkBack = await session.link({ url: atB.from, homecraft: true });

  // Back on A with NO referrer (the HTTPS->local case the protocol calls out):
  // only A's own recorded departure may establish the return entry.
  env = openAt(linkBack, { referrer: '' });
  assert([...env.sessionStorage.map.values()].some(raw => raw.includes(worldKey(NEIGHBOUR))),
    'the departure record survived the tab navigation');
  session = createTravelSession();
  const back = session.arrive();
  assert.equal(back.door, true, 'the recorded departure vouches for the return');
  assert.equal(back.from, NEIGHBOUR);
  assert.equal(new URL(env.location.href).hash, '');
});

test('a departure recorded for a different world does not vouch for an attacker link', async () => {
  const env = openAt(HOME);
  const session = createTravelSession();
  session.arrive();
  // Record a departure for the real neighbour...
  await session.link({ url: NEIGHBOUR, homecraft: true });
  // ...but arrive claiming to come from evil.example, no referrer.
  const forged = `${HOME}?from=${encodeURIComponent(EVIL)}#homecraft=1&skin=default`;
  const env2 = openAt(forged, { referrer: '' });
  const arrival = createTravelSession().arrive();
  assert.equal(arrival.door, false);
  assert.equal(arrival.from, null);
  assert.equal(new URL(env2.location.href).hash, '');
  assert(env);
});

// ---------- Skin validation ----------
test('decodeSkin accepts a compact 64x64 PNG and repaints it to pure pixel data', async () => {
  const value = validSkin();
  assert(value.length <= MAX_SKIN);
  const skin = await decodeSkin(value);
  assert(skin, 'a valid skin decodes');
  assert.equal(skin.carried, true);
  assert(skin.url.startsWith('data:image/png;base64,'));
  // Repainting re-encodes: the output is canonical data, not the input bytes.
  assert.notEqual(skin.value, value);
  assert(skin.value.length <= MAX_SKIN);
});

test('decodeSkin rejects over-long, malformed, and wrong-dimension skins', async () => {
  // The wire limit is 24000 base64url characters, enforced before decoding.
  assert.equal(await decodeSkin('A'.repeat(MAX_SKIN + 1)), null);
  assert.equal(await decodeSkin('A'.repeat(MAX_SKIN)), null, 'right-length but not a PNG is still rejected');
  assert.equal(await decodeSkin('not base64 url!'), null);
  assert.equal(await decodeSkin(''), null);
  assert.equal(await decodeSkin(42), null);
  // Correct base64url but not a PNG at all.
  const notPng = b64url(Buffer.from('this is definitely not a png file'));
  assert.equal(await decodeSkin(notPng), null);
  // Real PNG, wrong IHDR dimensions.
  const wrongSize = b64url(makePNGBytes(32, 32));
  assert.equal(await decodeSkin(wrongSize), null);
  // A 64x64 IHDR on an oversized payload is rejected by the byte cap.
  const header = makePNGBytes(64, 64);
  const padded = Buffer.concat([header, Buffer.alloc(MAX_SKIN)]);
  assert.equal(await decodeSkin(b64url(padded)), null);
});

test('the literal default skin is always the original character, never a receiver default', async () => {
  const skin = await decodeSkin('default');
  assert.deepEqual(skin, { url: '', value: 'default', carried: true });
});

test('a carried custom skin survives a session reload and is re-saved canonically', async () => {
  const env = openAt(
    `${HOME}?from=${encodeURIComponent(NEIGHBOUR)}#homecraft=1&skin=${validSkin()}&fromName=N`,
    { referrer: NEIGHBOUR },
  );
  const first = createTravelSession();
  const arrival = first.arrive();
  assert.equal(arrival.door, true);
  const worn = await first.wornSkin();
  assert.equal(worn.carried, true);

  // A fresh session object models a reload of the same tab/storage.
  const second = createTravelSession();
  const again = await second.wornSkin();
  assert.equal(again.carried, true);
  assert.equal(again.url, worn.url);
  assert.equal(new URL(env.location.href).search, '');
});

// ---------- Round trip: leave, arrive, return, restore ----------
test('a full round trip restores the source world and keeps the character on return', async () => {
  // World A: own default character, leave for B.
  let env = openAt(HOME);
  let session = createTravelSession();
  session.arrive();
  const wornAtHome = await session.wornSkin();
  assert.equal(wornAtHome.carried, false);
  const linkToB = await session.link({ url: NEIGHBOUR, name: 'Neighbour', homecraft: true });
  const target = new URL(linkToB);
  assert.equal(target.searchParams.get('from'), 'http://127.0.0.1:8080/home/');
  const hash = new URLSearchParams(target.hash.slice(1));
  assert.equal(hash.get('homecraft'), '1');
  assert.equal(hash.get('skin'), 'default');

  // World B: the referrer origin vouches for the arrival; default skin carried.
  env = openAt(linkToB, { referrer: HOME });
  session = createTravelSession();
  const arrivedAtB = session.arrive();
  assert.equal(arrivedAtB.door, true);
  assert.equal(arrivedAtB.from, 'http://127.0.0.1:8080/home/');
  const skinAtB = await session.wornSkin();
  assert.equal(skinAtB.carried, true);
  assert.equal(skinAtB.value, 'default');

  // One-click return: the link points back at A and still carries the skin.
  const linkBack = await session.link({ url: arrivedAtB.from, name: 'Home', homecraft: true });
  const back = new URL(linkBack);
  assert.equal(back.origin + back.pathname, 'http://127.0.0.1:8080/home/');
  assert.equal(new URLSearchParams(back.hash.slice(1)).get('skin'), 'default');
  // Back on A: the return entry now points to B, character still carried.
  env = openAt(linkBack, { referrer: NEIGHBOUR });
  session = createTravelSession();
  const backHome = session.arrive();
  assert.equal(backHome.door, true);
  assert.equal(backHome.from, NEIGHBOUR);
  const wornAgain = await session.wornSkin();
  assert.equal(wornAgain.carried, true);
  assert.equal(new URL(env.location.href).hash, '');
});

test('a direct revisit with no protocol markers resets to the host character', async () => {
  // First a genuine arrival stores a carried skin.
  const env = openAt(
    `${HOME}?from=${encodeURIComponent(NEIGHBOUR)}#homecraft=1&skin=${validSkin()}`,
    { referrer: NEIGHBOUR },
  );
  const visiting = createTravelSession();
  visiting.arrive();
  assert.equal((await visiting.wornSkin()).carried, true);

  // A brand-new direct navigation (no from/hash) starts clean.
  env.location.href = HOME;
  env.setNavigationType('navigate');
  const direct = createTravelSession();
  const arrival = direct.arrive();
  assert.equal(arrival.door, false);
  assert.equal(arrival.from, null);
  const worn = await direct.wornSkin();
  assert.equal(worn.carried, false);
});

test('links to non-protocol worlds carry no from parameter or fragment', async () => {
  openAt(HOME);
  const session = createTravelSession();
  session.arrive();
  const href = await session.link({ url: 'https://blog.example/post/', homecraft: false });
  const url = new URL(href);
  assert.equal(url.searchParams.has('from'), false);
  assert.equal(url.hash, '');
  // The departure is still remembered for a possible later return.
  assert.equal(worldKey(href), 'https://blog.example/post');
});

test('storage is scoped by world path, and blocked storage still vouches for the current page in memory', async () => {
  const env = openAt(
    `${HOME}?from=${encodeURIComponent(NEIGHBOUR)}#homecraft=1&skin=default`,
    { referrer: NEIGHBOUR },
  );
  const session = createTravelSession();
  session.arrive();
  const key = [...env.sessionStorage.map.keys()][0];
  assert.match(key, /^homecraft-visit:http:\/\/127\.0\.0\.1:8080\/home$/);

  // With storage blocked, a fresh page can't reload the record — but the
  // session already built in memory still accepts the arrival and the skin.
  const blocked = openAt(
    `${HOME}?from=${encodeURIComponent(NEIGHBOUR)}#homecraft=1&skin=default`,
    { referrer: NEIGHBOUR },
  );
  blocked.sessionStorage.setItem = () => { throw new DOMException('blocked', 'SecurityError'); };
  blocked.sessionStorage.getItem = () => { throw new DOMException('blocked', 'SecurityError'); };
  const resilient = createTravelSession();
  const arrival = resilient.arrive();
  assert.equal(arrival.door, true);
  const worn = await resilient.wornSkin();
  assert.equal(worn.carried, true);
  assert.equal(worn.value, 'default');
});
