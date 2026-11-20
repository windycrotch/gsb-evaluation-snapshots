// End-to-end lifecycle checks for one portal journey, driven through the real
// 3D world and DOM in a headless browser. These complement the pure
// node:test suites in journey.test.mjs / journey-run.test.mjs, which cover
// the same three scenarios without a browser.
//
//   npm run serve            (in another terminal; it prints the address),
//                            or pass the address explicitly
//   node tools/check-portal-lifecycle.mjs [http://127.0.0.1:<port>]
//
// Scenarios:
//   1. concurrent repeated initiations are ignored, never queued
//   2. after a failed departure the gate, player and input are restored and
//      a fresh world choice succeeds
//   3. a persisted pageshow (history back-forward cache) settles the player
//      outside the door and cannot be advanced by the old journey's callbacks
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const remembered = () => { try { return readFileSync(new URL('./.serve-url', import.meta.url), 'utf8').trim(); } catch { return ''; } };
const base = (process.argv[2] || remembered()).replace(/\/$/, '');
if (!base) { console.log('Nothing is being served. Run python tools/serve.py first, or pass the address.'); process.exit(1); }
const out = fileURLToPath(new URL('./.check/portal/', import.meta.url));
mkdirSync(out, { recursive: true });

const DIRECTORY = ['https://terryhu7.github.io/homecraft/worlds.json'];
const neighbour = { name: 'Neighbour', url: `${base}/visit/`, homecraft: true };
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
// Network 404s on homecraft.json are the deliberate directory fixture; track
// them separately so they do not count as engine errors.
page.on('response', r => { if (r.status() >= 400 && !r.url().includes('homecraft.json')) errors.push(`${r.status()} ${r.url()}`); });

const directory = { version: 1, join: null, blocked: [], worlds: [{ name: 'Starter', url: `${base}/`, homecraft: true }, neighbour] };
await context.route('**/homecraft.json', route => route.fulfill({ status: 404 }));
for (const url of DIRECTORY) await context.route(url, route => route.fulfill({ json: directory, headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' } }));
// Test-only tuning of the journey module, applied only to the origin page:
//  - a short failure watchdog so the failure scenario runs without a 4s wait
//  - when window.__blockNextNavigation is set, the navigation is swallowed so
//    the watchdog proves the failure/recovery path
//  - when window.__holdWorldNavigation is set, navigation waits (used by the
//    concurrent and history scenarios to inspect the in-flight state)
// The /visit/ neighbour requests the same files but gets the untouched
// module so its own arrival journey is never held. This single handler owns
// both the rewrite and the instrumentation to avoid two competing routes.
await context.route('**/engine/journey-run.js', async route => {
  const requestURL = route.request().url();
  const isVisit = requestURL.includes('/visit/');
  const fetchURL = isVisit ? requestURL.replace(/^(https?:\/\/[^/]+)\/visit/, '$1') : requestURL;
  const response = await route.fetch({ url: fetchURL });
  if (isVisit) { await route.fulfill({ response }); return; }
  let body = await response.text();
  body = body.replace('const NAV_FAILURE_MS = 4000;', 'const NAV_FAILURE_MS = 120;');
  // Hold at the two-frames await, which is BEFORE the post-await current()
  // guard. A BFCache restore during the hold therefore proves the stale
  // continuation is rejected instead of navigating.
  body = body.replace('      await twoFrames(requestFrame);',
    '      if (window.__holdWorldNavigation) await new Promise(resolve => { window.__releaseWorldNavigation = resolve; });\n      await twoFrames(requestFrame);');
  body = body.replace('      try { navigate(href); } catch { fail(ticket); return false; }',
    '      if (!window.__blockNextNavigation) { try { navigate(href); } catch { fail(ticket); return false; } }');
  await route.fulfill({ response, body });
});
// Every other /visit/ asset rewrites to the origin's same-named file.
await context.route(`${base}/visit/**`, async route => {
  const u = new URL(route.request().url()); u.pathname = u.pathname.replace(/^\/visit/, '') || '/';
  await route.fulfill({ response: await route.fetch({ url: u.href }) });
});

const ready = async () => {
  await page.waitForFunction(() => window.__home?.player, null, { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('#loading') && !window.__home.portal?.busy, null, { timeout: 15000 });
};
const openList = async () => {
  await page.evaluate(() => __home.go('portal'));
  await page.waitForFunction(() => document.querySelector('.world-directory')?.dataset.loaded === 'true');
  await page.waitForFunction(() => document.querySelector('#panel').open);
};
const standAtDoor = async () => {
  await page.evaluate(() => {
    const h = __home, f = h.portal.front;
    h.player.teleport(f.x + Math.sin(f.heading) * .9, f.z + Math.cos(f.heading) * .9, { look: [h.portal.root.position.x, h.portal.root.position.z] });
    h.rig.recenter(h.player);
  });
};
const travelling = () => page.evaluate(() => window.__homecraftJourney.isTravelling());

try {
  await page.goto(`${base}/?lang=zh`);
  await ready();
  await page.evaluate(() => __home.setTimeMode('day'));

  // ---------- Scenario 1: concurrent repeated initiations ----------
  await page.evaluate(() => { window.__holdWorldNavigation = false; window.__blockNextNavigation = false; });
  await standAtDoor();
  await openList();
  await page.evaluate(() => { window.__holdWorldNavigation = true; });
  // The first choice starts the walk-in; every repeat is issued while it is
  // in flight (covers repeated clicks during the animation).
  await page.locator(`.world-list button[data-world="${base}/visit/"]`).click();
  await page.waitForFunction(() => window.__home.portal?.busy === true);
  await page.waitForFunction(() => window.__homecraftJourney.isTravelling() === true);
  const attempts = await page.evaluate(() => {
    const api = window.__homecraftJourney;
    const tickets = [api.begin(), api.begin(), api.begin()]; // all refused while active
    return { tickets, active: api.isTravelling(), busy: window.__home.portal.busy };
  });
  assert.deepEqual(attempts.tickets, [null, null, null], 'repeat initiations are ignored, not queued');
  assert.equal(attempts.active, true);
  assert.equal(attempts.busy, true);
  // Esc during the animation must not open another flow or reset the gate.
  await page.keyboard.press('Escape');
  assert.equal(await travelling(), true, 'Esc cannot cancel or restart the in-flight journey');
  assert.equal(await page.evaluate(() => __home.portal.busy), true);
  // The held navigation never left; release it and confirm exactly one trip.
  await page.evaluate(() => { window.__holdWorldNavigation = false; window.__releaseWorldNavigation?.(); });
  await page.waitForURL(u => u.pathname === '/visit/', { timeout: 15000 });
  await ready();
  assert.equal(new URL(page.url()).pathname, '/visit/');
  console.log('PASS scenario 1: concurrent initiations ignored (single navigation, Esc inert while in flight)');

  // Come back home for the next scenarios.
  await page.goBack();
  await ready();
  assert.equal(new URL(page.url()).pathname, '/');

  // ---------- Scenario 2: failure restores everything, retry succeeds ----------
  await page.evaluate(() => { window.__holdWorldNavigation = false; window.__blockNextNavigation = false; });
  await standAtDoor();
  await openList();
  await page.evaluate(() => { window.__blockNextNavigation = true; });
  await page.locator(`.world-list button[data-world="${base}/visit/"]`).click();
  // The watchdog fires, the failed journey restores the world.
  await page.waitForFunction(() => window.__homecraftJourney.isTravelling() === false, null, { timeout: 10000 });
  await page.waitForFunction(() => window.__home.portal?.busy === false, null, { timeout: 5000 });
  // finishLoading() starts a 600ms fade-out before removing the element.
  await page.waitForFunction(() => !document.querySelector('#loading'), null, { timeout: 5000 });
  const restored = await page.evaluate(() => {
    const h = __home;
    // The player is controllable again: movement input is not blocked.
    return { mode: h.player.mode, pos: h.player.pos.toArray(), reading: document.body.classList.contains('reading') };
  });
  assert.equal(restored.mode, 'ground');
  assert.equal(restored.reading, false, 'the reading/modal state is cleared');
  // A fresh choice now works.
  await openList();
  await page.evaluate(() => { window.__blockNextNavigation = false; });
  await page.locator(`.world-list button[data-world="${base}/visit/"]`).click();
  await page.waitForURL(u => u.pathname === '/visit/', { timeout: 15000 });
  await ready();
  assert.equal(new URL(page.url()).pathname, '/visit/', 'the retry after recovery navigates');
  console.log('PASS scenario 2: failed departure restores gate/player/input and a retry succeeds');

  await page.goBack();
  await ready();

  // ---------- Scenario 3: persisted pageshow settle, mutually exclusive ----------
  await page.evaluate(() => { window.__holdWorldNavigation = false; window.__blockNextNavigation = false; });
  await standAtDoor();
  await openList();
  await page.evaluate(() => { window.__holdWorldNavigation = true; });
  await page.locator(`.world-list button[data-world="${base}/visit/"]`).click();
  await page.waitForFunction(() => window.__homecraftJourney.isTravelling() === true);
  // Simulate the BFCache restore while the old journey is still in flight.
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.waitForFunction(() => window.__homecraftJourney.isTravelling() === false, null, { timeout: 5000 });
  await page.waitForFunction(() => !document.querySelector('#loading'), null, { timeout: 5000 });
  const settled = await page.evaluate(() => {
    const h = __home, f = h.portal.front;
    return { busy: h.portal.busy, atDoor: Math.hypot(h.player.pos.x - f.x, h.player.pos.z - f.z), mode: h.player.mode };
  });
  assert.equal(settled.busy, false, 'the gate is reset on history restore');
  assert.ok(settled.atDoor < 0.5, 'the player is settled outside the door');
  assert.equal(settled.mode, 'ground');
  // Releasing the held continuation after restore must not navigate: its
  // ticket was invalidated by the BFCache epoch bump.
  const urlBefore = page.url();
  await page.evaluate(() => { window.__holdWorldNavigation = false; window.__releaseWorldNavigation?.(); });
  await page.waitForTimeout(300);
  assert.equal(page.url(), urlBefore, 'the stale continuation cannot navigate after restore');
  // A brand new journey can still begin on the restored page, then release it.
  const fresh = await page.evaluate(() => window.__homecraftJourney.begin());
  assert.notEqual(fresh, null, 'a new journey can begin on the restored page');
  await page.evaluate(() => { window.__blockNextNavigation = true; });
  console.log('PASS scenario 3: persisted pageshow settles outside the door and is exclusive with the old journey');

  assert.deepEqual(errors, [], `no page/console errors: ${errors.join(' | ')}`);
  await page.screenshot({ path: `${out}lifecycle-final.png` });
  console.log('ALL PORTAL LIFECYCLE CHECKS PASSED');
} catch (error) {
  await page.screenshot({ path: `${out}lifecycle-failure.png` }).catch(() => {});
  throw error;
} finally {
  await context.close();
  await browser.close();
}
