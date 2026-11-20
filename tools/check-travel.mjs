// The leave/return lifecycle: every way of leaving a world and every way of
// coming back must agree on the player's place, the camera and the pages.
// Runs against two fixture worlds on the local server (this site at /, the
// same site at /visit/ reached through the portal). Nothing online is read or
// changed: the directory is served by the browser fixture.
//
//   npm run serve                    (in another terminal; it prints the address)
//   npm run check:travel [-- http://127.0.0.1:<port>]
//
// What it covers:
//   - a normal departure from the portal: the page closes, the player walks
//     into the light, the loading screen appears, the next world loads;
//   - leaving from a page, in first person or in flight: straight to loading,
//     and third person again on return;
//   - a departure triggered twice (portal, page, Return, Back) navigates once,
//     and a cancelled journey's stale continuation never navigates later;
//   - a cancelled departure (Escape before the navigation) restores a
//     walkable player beside the portal with a settled camera and no page;
//   - the arrivals: through a door (walk out of the light), through history
//     (stand beside the portal), from a restored page, and into a world
//     without a portal (spawn).
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const remembered = () => { try { return readFileSync(new URL('./.serve-url', import.meta.url), 'utf8').trim(); } catch { return ''; } };
const base = (process.argv[2] || remembered()).replace(/\/$/, '');
if (!base) { console.log('Nothing is being served. Run python3 tools/serve.py first, or pass the address.'); process.exit(1); }
const out = new URL('./.check/travel/', import.meta.url);
mkdirSync(out, { recursive: true });
const shot = name => fileURLToPath(new URL(name, out));
const args = process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const browser = await chromium.launch({ ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}), args });
const views = [
  { name: 'computer', viewport: { width: 1280, height: 800 } },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'reduced', viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' },
];
// Two fixtures on one server. /visit/ serves the whole site from / and can
// point its config at a skin, so arrival can be told apart from the start.
const starter = { name: 'Starter', url: `${base}/`, homecraft: true };
const neighbour = { name: 'Neighbour', url: `${base}/visit/`, homecraft: true };
const homecraftSpawn = { x: 0.5, z: 18 };

let context;
const closeContext = async () => {
  const current = context;
  context = null;
  if (!current) return;
  try { await current.unrouteAll({ behavior: 'ignoreErrors' }); }
  finally { await current.close(); }
};

try {
  for (const { name, ...view } of views) {
    const reduced = name === 'reduced';
    context = await browser.newContext({ ...view, locale: 'zh-CN' });
    const page = await context.newPage(), errors = [];
    // A test-only brake so the departing page can be inspected: hold the
    // anchor click the engine would navigate with, then release it (or drop
    // it) once the assertions are done.
    await page.addInitScript(() => {
      const click = HTMLElement.prototype.click;
      HTMLElement.prototype.click = function () {
        if (!window.__holdNavigation || !(this instanceof HTMLAnchorElement)) return click.call(this);
        window.__releaseNavigation = () => { window.__releaseNavigation = null; click.call(this); };
        window.__cancelNavigation = () => { window.__releaseNavigation = null; };
      };
    });
    page.on('pageerror', e => errors.push(e.message));
    // The fixture answers homecraft.json with 404 on purpose; a missing
    // optional file is not an error. Script errors still count.
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    // /visit/ is the same site with its world taken away: no portal, so an
    // arrival there can only land at spawn.
    let neighbourPortal = false;
    await context.route(`${base}/visit/**`, async route => {
      const url = new URL(route.request().url());
      url.pathname = url.pathname.replace(/^\/visit/, '') || '/';
      const response = await route.fetch({ url: url.href });
      if (suddenWorld() && url.pathname === '/world/layout.js') {
        const body = (await response.text())
          .replace(/export const PORTAL[^;]*;/, '')
          .replace(/\{ id: 'portal'[^}]*\},?/, '');
        return route.fulfill({ response, body });
      }
      await route.fulfill({ response });
    });
    await context.route('**/homecraft.json', route => route.fulfill({ status: 404 }));
    for (const url of ['https://terryhu7.github.io/homecraft/worlds.json'])
      await context.route(url, route => route.fulfill({ json: { version: 1, blocked: [], worlds: [starter, neighbour] }, headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' } }));
    // A page is "no portal" when this flag is on; keep it per test step.
    let noPortal = false;
    function suddenWorld() { return noPortal; }

    const ready = async () => {
      await page.waitForFunction(() => window.__home?.player, null, { timeout: 60000 });
      await page.waitForFunction(() => !document.querySelector('#loading') && !document.querySelector('#hud').hidden && !__home.portal?.busy, null, { timeout: 20000 });
      await page.waitForFunction(() => __home.travel.phase === 'idle');
    };
    const openList = async () => {
      await page.evaluate(() => __home.openPortal());
      await page.waitForFunction(() => document.querySelector('.world-directory')?.dataset.loaded === 'true');
      await page.waitForFunction(() => document.querySelector('#panel').open);
    };
    const placeAtPortal = () => page.evaluate(() => {
      const h = __home, f = h.portal.front;
      h.player.teleport(f.x + Math.sin(f.heading) * .9, f.z + Math.cos(f.heading) * .9, { look: [f.x, f.z] });
      h.rig.recenter(h.player);
    });
    const state = () => page.evaluate(() => {
      const h = __home, f = h.portal?.front;
      return {
        pos: [h.player.pos.x, h.player.pos.z], y: h.player.y,
        front: f ? [f.x, f.z] : null,
        phase: h.travel.phase, busy: !!h.portal?.busy,
        panel: document.querySelector('#panel')?.open === true,
        loading: !!document.querySelector('#loading'),
        firstPerson: h.rig.firstPerson,
        intro: h.rig.introActive,
        pathname: new URL(location.href).pathname,
      };
    });

    // ---------- A normal departure from the portal ----------
    await page.goto(`${base}/?lang=zh`);
    await ready();
    await placeAtPortal();
    await openList();
    // Hold the navigation so the walk into the light can be inspected even
    // while the page is about to leave.
    await page.evaluate(() => { window.__holdNavigation = true; });
    await page.locator(`.world-list button[data-world="${base}/visit/"]`).click();
    await page.waitForFunction(() => document.querySelector('#panel')?.open === false, null, { timeout: 5000 });
    const departure = await state();
    if (!reduced) {
      assert.equal(departure.phase, 'walking', 'Choosing a world beside the portal must walk in, not jump to loading');
      assert.equal(departure.busy, true, 'The portal must charge while the player walks in');
      assert.equal(departure.loading, false, 'The loading screen must wait for the walk');
      await page.screenshot({ path: shot(`${name}-departure.png`) });
      // The walk finishes at the light, then the loading screen takes over.
      await page.waitForFunction(() => __home.travel.phase === 'sailing', null, { timeout: 5000 });
      const stepped = await page.evaluate(() => {
        const h = __home, f = h.portal.front, at = h.portal.root.position;
        return { inside: Math.hypot(h.player.pos.x - at.x, h.player.pos.z - at.z) < 1.2, front: [f.x, f.z] };
      });
      assert(stepped.inside, 'The walk must finish inside the light');
      assert.equal((await state()).loading, true, 'The loading screen shows once the player is in the light');
    } else {
      assert.equal(departure.phase, 'sailing', 'Reduced motion goes straight to loading');
      assert.equal(departure.loading, true);
    }
    await page.waitForFunction(() => document.querySelector('#loading .loading-label')?.textContent.includes('Neighbour'), null, { timeout: 15000 });
    await page.waitForFunction(() => typeof window.__releaseNavigation === 'function', null, { timeout: 15000 });
    await page.evaluate(() => window.__releaseNavigation());
    await page.waitForURL(url => url.pathname === '/visit/', { timeout: 30000 });
    await page.evaluate(() => { window.__holdNavigation = false; window.__releaseNavigation = null; });
    await page.waitForFunction(() => window.__home?.player, null, { timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('#loading'), null, { timeout: 30000 });
    const arrival = await page.evaluate(() => {
      const h = __home, f = h.portal?.front;
      return { phase: h.travel.phase, pos: [h.player.pos.x, h.player.pos.z], front: f ? [f.x, f.z] : null, firstPerson: h.rig.firstPerson, panel: document.querySelector('#panel')?.open === true };
    });
    assert.equal(arrival.phase, 'idle');
    assert.equal(arrival.panel, false, 'An arrival must not leave a page open');
    assert.equal(arrival.firstPerson, false, 'An arrival restores the third-person camera');
    assert(arrival.front, 'The arrival world has a portal and the player stands beside it');
    assert(Math.hypot(arrival.pos[0] - (arrival.front?.[0] ?? homecraftSpawn.x), arrival.pos[1] - (arrival.front?.[1] ?? homecraftSpawn.z)) < 4 || Math.hypot(arrival.pos[0] - homecraftSpawn.x, arrival.pos[1] - homecraftSpawn.z) < 1,
      'The player must arrive beside the portal or at spawn');
    await page.screenshot({ path: shot(`${name}-arrival.png`) });

    // ---------- The same departure triggered twice navigates once ----------
    await page.evaluate(() => history.back());
    await page.waitForURL(url => url.pathname === '/', { timeout: 20000 });
    await ready();
    await placeAtPortal();
    await openList();
    const choice = `.world-list button[data-world="${base}/visit/"]`;
    // Hold the navigation so the duplicate triggers can be inspected while
    // the journey is still live.
    await page.evaluate(() => { window.__holdNavigation = true; });
    await page.locator(choice).click();
    // The page is closed, so a second trigger comes from the page API and
    // the portal's own light, not from the list again. All must be ignored.
    const duplicates = await page.evaluate(() => {
      const h = __home;
      const before = h.travel.epoch;
      const did = [h.travel.depart({ url: location.origin + '/visit/', name: 'Neighbour', homecraft: true }), h.openPortal(), h.go('about')];
      return { did, epoch: [before, h.travel.epoch], phase: h.travel.phase };
    });
    assert.equal(duplicates.did[0], false, 'A second depart must be ignored');
    assert.equal(duplicates.epoch[0], duplicates.epoch[1], 'A duplicate trigger must not mint a new journey');
    assert(!duplicates.did[1], 'Opening the portal mid-journey must be ignored');
    // Exactly one navigation: the URL changes once, and the journey is not
    // repeated when it lands.
    await page.waitForFunction(() => typeof window.__releaseNavigation === 'function', null, { timeout: 20000 });
    await page.evaluate(() => window.__releaseNavigation());
    await page.waitForURL(url => url.pathname === '/visit/', { timeout: 30000 });
    await page.evaluate(() => { window.__holdNavigation = false; window.__releaseNavigation = null; });
    await page.waitForFunction(() => window.__home?.player && !document.querySelector('#loading'), null, { timeout: 60000 });
    await page.waitForTimeout(600);
    assert.equal(new URL(page.url()).pathname, '/visit/');
    assert.equal(await page.evaluate(() => __home.travel.phase), 'idle');
    await page.screenshot({ path: shot(`${name}-concurrent.png`) });

    // ---------- Cancelled: Escape during the walk restores the world ----------
    await page.evaluate(() => history.back());
    await page.waitForURL(url => url.pathname === '/', { timeout: 20000 });
    await ready();
    if (!reduced) {
      await placeAtPortal();
      await openList();
      await page.locator(choice).click();
      // Escape while walking into the light, before the navigation starts.
      await page.waitForFunction(() => __home.travel.phase === 'walking');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => __home.travel.phase === 'idle', null, { timeout: 5000 });
      const after = await state();
      assert.equal(after.loading, false, 'A cancelled walk must take the loading screen away');
      assert.equal(after.busy, false, 'A cancelled walk must leave the portal at rest');
      assert.equal(after.phase, 'idle');
      assert.equal(after.firstPerson, false);
      assert.equal(new URL(page.url()).pathname, '/', 'A cancelled walk must not navigate');
      assert(Math.hypot(after.pos[0] - after.front[0], after.pos[1] - after.front[1]) < 5, 'A cancelled walk returns the player beside the portal');
      // The world is operable again: the player can walk.
      const moved = await page.evaluate(() => {
        const h = __home, from = [h.player.pos.x, h.player.pos.z];
        for (let i = 0; i < 120; i++) h.player.update(1 / 60, { x: 0, z: 1, run: false }, 0);
        return Math.hypot(h.player.pos.x - from[0], h.player.pos.z - from[1]);
      });
      assert(moved > 0.5, 'After a cancelled walk the player must be able to move');
      await page.screenshot({ path: shot(`${name}-cancelled.png`) });
    }

    // ---------- Cancelled: an old journey cannot act after it is abandoned ----------
    // The engine builds the link and waits for frames before navigating. Both
    // waits are asynchronous, so a cancel can land after the journey has
    // started. Start a departure and cancel it in the same task; when its
    // awaits resume, the stale continuation must change nothing.
    await ready();
    await placeAtPortal();
    await page.evaluate(() => {
      const travel = __home.travel;
      travel.depart({ url: location.origin + '/visit/', name: 'Neighbour', homecraft: true });
      travel.cancel('test');
    });
    await page.waitForTimeout(1200);
    const abandoned = await state();
    assert.equal(new URL(page.url()).pathname, '/', 'A cancelled navigation must not navigate later');
    assert.equal(abandoned.loading, false, 'A cancelled navigation must clear the loading screen');
    assert.equal(abandoned.panel, false, 'A cancelled navigation must leave no page open');
    assert.equal(abandoned.firstPerson, false);
    assert.equal(abandoned.phase, 'idle');
    assert(Math.hypot(abandoned.pos[0] - abandoned.front[0], abandoned.pos[1] - abandoned.front[1]) < 5);
    assert.equal(await page.evaluate(() => __home.portal.busy), false, 'A cancelled navigation must leave the portal at rest');
    assert.equal(await page.evaluate(() => !!window.__releaseNavigation), false, 'A cancelled journey must not reach the navigation');

    // The same when the walk into the light has started: its route is
    // dropped and the player returns outside without a later jump.
    if (!reduced) {
      await placeAtPortal();
      await openList();
      await page.evaluate(() => {
        const travel = __home.travel;
        travel.depart({ url: location.origin + '/visit/', name: 'Neighbour', homecraft: true });
        travel.cancel('test');
      });
      await page.waitForTimeout(1200);
      const walked = await state();
      assert.equal(walked.phase, 'idle');
      assert.equal(walked.busy, false);
      assert.equal(walked.loading, false);
      assert.equal(new URL(page.url()).pathname, '/');
    }

    // ---------- Leaving while a page is open, in first person, or in flight ----------
    // A page open at departure must close, and input must be released: the
    // loading screen is the only thing the visitor should see next.
    await page.evaluate(() => __home.openPage('about'));
    await page.waitForFunction(() => document.querySelector('#panel')?.open === true);
    await placeAtPortal();
    await openList();
    await page.evaluate(() => { window.__holdNavigation = true; });
    await page.locator(choice).click();
    await page.waitForFunction(() => __home.travel.phase === 'sailing', null, { timeout: 10000 });
    const fromPage = await state();
    assert.equal(fromPage.panel, false, 'A page open at departure must close before the journey');
    assert.equal(fromPage.loading, true, 'A page departure goes straight to the loading screen');
    assert.equal(fromPage.phase, 'sailing');
    // Escape returns the world with no page open and the player beside the portal.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => __home.travel.phase === 'idle');
    const pageBack = await state();
    assert.equal(pageBack.panel, false, 'A cancelled page departure must leave no page open');
    assert.equal(pageBack.loading, false);
    assert(Math.hypot(pageBack.pos[0] - pageBack.front[0], pageBack.pos[1] - pageBack.front[1]) < 5);

    // First person and flight cannot walk into the light: they go straight to
    // loading, and are put back in third person on the far side.
    for (const mode of ['first-person', 'flight']) {
      await ready();
      await placeAtPortal();
      await page.evaluate(mode => {
        const h = __home;
        if (mode === 'flight') h.player.toggleFly();
        else h.rig.setFirstPerson(true, h.player.heading);
      }, mode);
      await openList();
      await page.evaluate(() => { window.__holdNavigation = true; });
      await page.locator(choice).click();
      await page.waitForFunction(() => __home.travel.phase === 'sailing', null, { timeout: 10000 });
      const fast = await state();
      assert.equal(fast.phase, 'sailing', `Leaving in ${mode} goes straight to loading`);
      assert.equal(fast.loading, true);
      assert.equal(fast.busy, false, `Leaving in ${mode} must not charge the portal`);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => __home.travel.phase === 'idle');
      const restored = await state();
      assert.equal(restored.firstPerson, false, `A cancelled ${mode} departure restores third person`);
      assert.equal(restored.loading, false);
      assert.equal(await page.evaluate(() => __home.player.flying), false, `A cancelled ${mode} departure lands the player`);
      // Drop the held anchor click without navigating: the journey is over.
      await page.evaluate(() => { window.__cancelNavigation?.(); window.__holdNavigation = false; });
      await page.waitForTimeout(200);
    }

    // ---------- Return through history: stand beside the portal ----------
    // Leave normally, then use the browser's Back button: the world comes
    // back beside its portal with the camera settled, never mid-air.
    await page.goto(`${base}/?lang=zh`);
    await ready();
    await placeAtPortal();
    await openList();
    await page.evaluate(() => { window.__holdNavigation = true; });
    await page.locator(choice).click();
    await page.waitForFunction(() => typeof window.__releaseNavigation === 'function', null, { timeout: 10000 });
    await page.evaluate(() => window.__releaseNavigation());
    await page.waitForURL(url => url.pathname === '/visit/', { timeout: 30000 });
    await page.evaluate(() => { window.__holdNavigation = false; window.__releaseNavigation = null; });
    await page.waitForFunction(() => window.__home?.player && !document.querySelector('#loading'), null, { timeout: 60000 });
    await page.goBack();
    await page.waitForURL(url => url.pathname === '/', { timeout: 20000 });
    await ready();
    const back = await state();
    assert.equal(back.panel, false, 'Back into a world must not leave a page open');
    assert.equal(back.firstPerson, false);
    assert.equal(back.busy, false, 'Back into a world must leave the portal at rest');
    assert(Math.hypot(back.pos[0] - back.front[0], back.pos[1] - back.front[1]) < 5, `Back into a world stands beside the portal (${JSON.stringify(back)})`);
    // The camera looks down at the player from behind, not from inside a wall.
    const camera = await page.evaluate(() => ({ y: __home.stage.camera.position.y, d: __home.rig.distance }));
    assert(camera.y > 0 && camera.y < 12 && camera.d >= 3, 'The camera must settle at a usable distance');
    await page.screenshot({ path: shot(`${name}-history.png`) });

    // ---------- Back or Forward into a page restored from the cache ----------
    // The engine's own pageshow handler must produce the same settled state:
    // no page open, third person, the player beside the portal.
    await page.evaluate(() => {
      __home.openPage('about');
      dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await page.waitForFunction(() => __home.travel.phase === 'idle' && !document.querySelector('#loading'), null, { timeout: 10000 });
    const restoredPage = await state();
    assert.equal(restoredPage.panel, false, 'A restored page must not keep a page open');
    assert.equal(restoredPage.firstPerson, false);
    assert.equal(restoredPage.busy, false);
    assert(Math.hypot(restoredPage.pos[0] - restoredPage.front[0], restoredPage.pos[1] - restoredPage.front[1]) < 5,
      'A restored page puts the player back beside the portal');

    // ---------- A world without a portal lands at spawn ----------
    // Both a fresh load and a Back/Forward return: no portal to stand beside,
    // so the player lands at spawn with the default view.
    noPortal = true;
    try {
      await page.evaluate(() => history.forward());
      await page.waitForURL(url => url.pathname === '/visit/', { timeout: 20000 });
      await page.waitForFunction(() => window.__home?.player, null, { timeout: 60000 });
      await page.reload();
      await ready();
      const plain = await page.evaluate(() => ({ portal: !!__home.portal, pos: [__home.player.pos.x, __home.player.pos.z], intro: __home.rig.introActive, firstPerson: __home.rig.firstPerson }));
      assert.equal(plain.portal, false, 'The fixture world must have no portal');
      assert(Math.hypot(plain.pos[0] - homecraftSpawn.x, plain.pos[1] - homecraftSpawn.z) < 3, 'A world without a portal starts at spawn');
      assert.equal(plain.firstPerson, false);
      // Leave the portal-less world through its own Dock, then come Back:
      // there is no portal to stand beside, so the player lands at spawn.
      await page.evaluate(() => {
        const a = document.createElement('a'); a.href = '/'; document.body.append(a); a.click(); a.remove();
      });
      await page.waitForURL(url => url.pathname === '/');
      await page.goBack();
      await page.waitForURL(url => url.pathname === '/visit/', { timeout: 20000 });
      await ready();
      const plainBack = await page.evaluate(() => ({
        portal: !!__home.portal, pos: [__home.player.pos.x, __home.player.pos.z],
        firstPerson: __home.rig.firstPerson, intro: __home.rig.introActive, panel: document.querySelector('#panel')?.open === true,
      }));
      assert.equal(plainBack.portal, false);
      assert.equal(plainBack.panel, false, 'Back into a portal-less world must not leave a page open');
      assert.equal(plainBack.firstPerson, false);
      assert(Math.hypot(plainBack.pos[0] - homecraftSpawn.x, plainBack.pos[1] - homecraftSpawn.z) < 3, 'Back into a portal-less world lands at spawn');
    } finally { noPortal = false; }

    assert.deepEqual(errors, []);
    console.log(`PASS ${name}: normal departure${reduced ? ' (reduced motion)' : ' (walk-in)'}, page/first-person/flight departures, duplicate triggers, cancelled walk, cancelled navigation, history return, restored page, spawn without a portal`);
    await closeContext();
  }
} catch (error) {
  await closeContext().catch(() => {});
  throw error;
} finally { await browser.close(); }
