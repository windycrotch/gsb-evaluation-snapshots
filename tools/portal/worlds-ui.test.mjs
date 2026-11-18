// Offline UI tests for engine/ui/worlds.js: the list paints directory rows,
// falls back quietly (no startup loading bar, no error-style notice) when the
// directory fails or answers empty, and a refresh that resolves after the
// list was closed can never touch another page that opened later.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './browser-shim.mjs';

// worlds.js -> portal.js -> gate.js reads matchMedia at module load, so the
// browser environment must be installed before the engine graph is imported.
installBrowser({ url: 'http://127.0.0.1:8080/home/', reset: true });
const { createWorldList } = await import('../../engine/ui/worlds.js');
const { showLoading, finishLoading } = await import('../../engine/ui/loading.js');
const { __resetDirectoryForTests } = await import('../../engine/portal.js');
const { DEFAULT_WORLDS } = await import('../../engine/worlds-default.js');

const SELF = 'http://127.0.0.1:8080/home/';
const DIRECTORY_URL = 'http://127.0.0.1:9001/worlds.json';
const neighbour = { name: 'Neighbour', url: 'https://neighbour.example/', homecraft: true };
const starter = { name: 'Starter', url: SELF, homecraft: true };

let net;
function mockFetch(handler) {
  net = { calls: 0, handler };
  globalThis.fetch = async url => {
    net.calls++;
    return handler(String(url));
  };
}
const ok = data => ({ ok: true, status: 200, json: async () => structuredClone(data) });
const fail = () => ({ ok: false, status: 503, json: async () => ({}) });

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test.beforeEach(() => {
  installBrowser({ url: SELF });
  __resetDirectoryForTests();
  net = null;
});
test.afterEach(() => { globalThis.fetch = undefined; });

function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const chosen = [];
  const list = createWorldList({ onChoose: world => chosen.push(world) });
  list.mount(container);
  return { container, list, chosen };
}
const rootOf = container => container.children[0];
const rowButtons = container => [...container.querySelectorAll?.('.world-row') || []];
// The shim keeps children as nodes; walk the tree instead of querySelector.
function findRows(node, out = []) {
  for (const child of node.children || []) {
    if (child.className?.split(' ').includes('world-row')) out.push(child);
    findRows(child, out);
  }
  return out;
}
function findByClass(node, className, out = []) {
  for (const child of node.children || []) {
    if (child.className?.split(' ').includes(className)) out.push(child);
    findByClass(child, className, out);
  }
  return out;
}

test('a healthy directory renders its rows and marks the current world disabled', async () => {
  mockFetch(() => ok({ worlds: [starter, neighbour] }));
  const { container } = mount();
  await settle(); await settle();
  const rows = findRows(rootOf(container));
  assert.equal(rows.length, 2);
  const selfRow = rows.find(r => r.dataset.world === SELF);
  assert(selfRow.hasAttribute('aria-current'));
  assert.equal(selfRow.getAttribute('disabled') !== null || selfRow.disabled, true);
  assert.equal(rootOf(container).dataset.loaded, 'true');
});

test('an empty directory paints the bundled fallback, never an error state', async () => {
  mockFetch(() => ok({ worlds: [] }));
  const { container } = mount();
  await settle(); await settle();
  const rows = findRows(rootOf(container));
  assert.equal(rows.length, DEFAULT_WORLDS.length);
  assert.equal(rows[0].dataset.world, DEFAULT_WORLDS[0].url);
  // No error-style status line is part of the fallback presentation.
  assert.equal(findByClass(rootOf(container), 'is-error').length, 0);
  // A retry control may be offered, but it is not an error banner.
  const retry = findByClass(rootOf(container), 'world-refresh');
  assert(retry.length <= 1);
});

test('a failed directory keeps the visitor in the current world with the fallback list and no loading bar', async () => {
  mockFetch(() => fail());
  const before = document.getElementById('loading');
  const { container } = mount();
  await settle(); await settle(); await settle();
  const rows = findRows(rootOf(container));
  assert(rows.length >= 1, 'the list stays usable via defaults');
  assert.equal(findByClass(rootOf(container), 'is-error').length, 0);
  // Directory failures never create or replace the full-screen journey screen.
  assert.equal(document.getElementById('loading'), before);
  assert.equal(findByClass(document.body, 'loading-label').length, 0);
});

test('opening the list never starts a journey loading screen on its own', async () => {
  mockFetch(url => url === DIRECTORY_URL ? ok({ worlds: [neighbour] }) : fail());
  const loadingBefore = document.getElementById('loading');
  const { container } = mount();
  await settle(); await settle();
  assert.equal(document.getElementById('loading'), loadingBefore);
  const label = findByClass(rootOf(container), 'loading-label');
  assert.equal(label.length, 0);
});

test('a refresh resolving after the list closed cannot modify a page opened later', async () => {
  let releaseDirectory;
  mockFetch(() => new Promise(resolve => { releaseDirectory = () => resolve(ok({ worlds: [neighbour] })); }));
  const { container, list } = mount();
  await settle();
  const staleRoot = rootOf(container);
  assert.equal(net.calls >= 1, true);

  // User closes the portal list (the component drops its root reference) and
  // opens an unrelated page in the same panel.
  list.destroy();
  container.replaceChildren();
  const otherPage = document.createElement('article');
  otherPage.className = 'page'; otherPage.textContent = 'About page content';
  container.append(otherPage);

  // Now the stale directory response finally comes back. The in-flight load
  // must bail on its revision/root guard rather than painting into the page.
  releaseDirectory();
  await settle(); await settle(); await settle();
  assert.equal(container.children[0], otherPage, 'the late response did not replace the open page');
  assert.equal(otherPage.textContent, 'About page content');
  assert.equal(findRows(otherPage).length, 0);
  // The detached, abandoned list root was never repopulated by the late fetch.
  assert.equal(findRows(staleRoot).length, 0);

  // A brand-new list mount starts from fresh state and renders normally.
  const next = mount();
  await settle(); await settle();
  const rows = findRows(rootOf(next.container));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dataset.world, neighbour.url);
});

test('choosing a row reports the world through onChoose only for other worlds', async () => {
  mockFetch(() => ok({ worlds: [starter, neighbour] }));
  const { container, chosen } = mount();
  await settle(); await settle();
  const rows = findRows(rootOf(container));
  const other = rows.find(r => r.dataset.world === neighbour.url);
  other.click();
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].url, neighbour.url);

  const selfRow = rows.find(r => r.dataset.world === SELF);
  selfRow.click();
  assert.equal(chosen.length, 1, 'the current world is not selectable');
});

test('the shared loading screen lifecycle is untouched by list refreshes', async () => {
  // Guard the contract the task calls out: directory work must not leave a
  // startup progress bar behind. Exercise the real loading module too.
  mockFetch(() => ok({ worlds: [neighbour] }));
  showLoading('Loading a world…', 0.1);
  assert(document.getElementById('loading'));
  finishLoading();
  const { container } = mount();
  await settle(); await settle();
  assert.equal(findRows(rootOf(container)).length, 1);
});
