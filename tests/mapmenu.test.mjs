// Automated tests for the in-browser map picker in web/index.html.
// Runs locally without Docker: loads the page over file:// and injects a fake
// window.__xash engine. Covers four paths:
//   1. happy path        — rcon issued once, "switching" → confirmed → highlight
//   2. engine missing    — no rcon, immediate in-panel error, no highlight
//   3. click while busy  — second click swallowed, no second rcon command
//   4. timeout           — no server-ready signal → explicit timeout error
// Run with: npm test
import { chromium } from 'playwright';

const PAGE_URL = new URL('../web/index.html', import.meta.url).href;

let failures = 0;
function check(cond, msg) {
    if (cond) console.log('  ok  - ' + msg);
    else { failures++; console.error('  FAIL - ' + msg); }
}

async function launch() {
    const candidates = [
        { channel: 'chrome' },
        { executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
        { executablePath: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' },
        {}, // bundled chromium, if downloaded
    ];
    let lastErr;
    for (const opts of candidates) {
        try {
            return await chromium.launch({ headless: true, ...opts });
        } catch (e) { lastErr = e; }
    }
    throw lastErr;
}

// opts:
//   xash:            install a fake window.__xash engine (records commands in window.__cmds)
//   running:         value of __xash.running (default true)
//   controlledReady: gate the server-ready signal on window.__ready === true
//   timeoutMs:       window.__csMapSwitchTimeoutMs override
//   successCloseMs:  window.__csMapSuccessCloseMs override
async function newPage(browser, opts = {}) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('  [pageerror]', String(e)));
    await page.addInitScript((o) => {
        window.__cmds = [];
        if (o.xash) {
            window.__xash = {
                running: o.running !== false,
                Cmd_ExecuteString: (s) => { window.__cmds.push(s); },
            };
        }
        if (o.controlledReady) window.__csServerReady = () => window.__ready === true;
        if (o.timeoutMs) window.__csMapSwitchTimeoutMs = o.timeoutMs;
        if (o.successCloseMs) window.__csMapSuccessCloseMs = o.successCloseMs;
    }, opts);
    await page.goto(PAGE_URL);
    await page.waitForSelector('#cs-mapmenu'); // picker built
    return page;
}

const openPicker = (page) => page.evaluate(() => window.__csMapOpen());
const clickMap = (page, map) =>
    page.evaluate((m) => {
        const t = [...document.querySelectorAll('#cs-mapgrid .cs-maptile')]
            .find((el) => el.getAttribute('data-map') === m);
        t.click();
    }, map);
const statusText = (page) =>
    page.evaluate(() => document.getElementById('cs-mapstatus').textContent);
const statusVisible = (page) =>
    page.evaluate(() => document.getElementById('cs-mapstatus').style.display === 'block');
const panelOpen = (page) =>
    page.evaluate(() => document.getElementById('cs-mapmenu').style.display === 'flex');
const cmds = (page) => page.evaluate(() => window.__cmds);
const selectedMap = (page) => page.evaluate(() => window.__csSelectedMap);
const allTilesDisabled = (page) =>
    page.evaluate(() => [...document.querySelectorAll('#cs-mapgrid .cs-maptile')].every((t) => t.disabled));
const allTilesEnabled = (page) =>
    page.evaluate(() => [...document.querySelectorAll('#cs-mapgrid .cs-maptile')].every((t) => !t.disabled));
const searchDisabled = (page) =>
    page.evaluate(() => document.getElementById('cs-mapsearch').disabled);
const tileText = (page, map) =>
    page.evaluate((m) => {
        const t = [...document.querySelectorAll('#cs-mapgrid .cs-maptile')]
            .find((el) => el.getAttribute('data-map') === m);
        return t.textContent;
    }, map);

async function waitStatus(page, needle, timeoutMs = 5000) {
    await page.waitForFunction(
        (n) => {
            const st = document.getElementById('cs-mapstatus');
            return st && st.style.display === 'block' && st.textContent.includes(n);
        },
        needle,
        { timeout: timeoutMs },
    );
}

// ---------------------------------------------------------------- test 1
async function testHappyPath(browser) {
    console.log('\n[1] happy path: rcon issued once, confirmed, highlighted');
    const page = await newPage(browser, { xash: true, running: true, successCloseMs: 500 });
    // Real entry point: the Maps button appears once the engine runs.
    await page.waitForSelector('#cs-mapbtn', { state: 'visible', timeout: 5000 });
    await page.click('#cs-mapbtn');
    check(await panelOpen(page), 'panel opens from the Maps button');

    await clickMap(page, 'de_dust2');
    await waitStatus(page, 'Switched to de_dust2');

    const sent = await cmds(page);
    check(sent.filter((c) => c === 'rcon changelevel de_dust2').length === 1,
        'exactly one "rcon changelevel de_dust2" sent, got: ' + JSON.stringify(sent));
    check(sent.includes('rcon_password cs16lan'), 'rcon_password sent before changelevel');
    check(sent.indexOf('rcon_password cs16lan') < sent.indexOf('rcon changelevel de_dust2'),
        'password precedes changelevel');
    check((await selectedMap(page)) === 'de_dust2', 'window.__csSelectedMap === de_dust2');
    check((await tileText(page, 'de_dust2')) === '✓ de_dust2', 'tile shows ✓ highlight');
    check(await allTilesEnabled(page), 'tiles re-enabled after confirmation');
    check(!(await searchDisabled(page)), 'search re-enabled after confirmation');

    await page.waitForFunction(
        () => document.getElementById('cs-mapmenu').style.display === 'none',
        undefined,
        { timeout: 3000 },
    );
    check(true, 'panel auto-closes within bounded time after success');
    await page.close();
}

// ---------------------------------------------------------------- test 2
async function testEngineMissing(browser) {
    console.log('\n[2] engine missing: no rcon, immediate error, no highlight');
    const page = await newPage(browser, { xash: false });
    await openPicker(page);
    check(await panelOpen(page), 'panel opened');

    await clickMap(page, 'cs_assault');
    await waitStatus(page, 'Cannot switch to cs_assault');

    check((await selectedMap(page)) === undefined, 'no map marked selected');
    check((await tileText(page, 'cs_assault')) === 'cs_assault', 'no ✓ highlight on the tile');
    check(await allTilesEnabled(page), 'tiles never disabled (switch ended immediately)');
    check(!(await searchDisabled(page)), 'search never disabled');
    check(await panelOpen(page), 'panel stays open with the error');
    check(await statusVisible(page), 'error message visible in-panel');
    await page.close();
}

// ---------------------------------------------------------------- test 3
async function testDoubleClickWhileSwitching(browser) {
    console.log('\n[3] click while switching: swallowed, no second rcon');
    const page = await newPage(browser, { xash: true, running: true, controlledReady: true });
    await openPicker(page);

    await clickMap(page, 'de_dust2');
    await waitStatus(page, 'Switching to de_dust2');
    check(await allTilesDisabled(page), 'all tiles disabled while switching');
    check(await searchDisabled(page), 'search disabled while switching');

    // Attempt a second map by every route: DOM click, Enter on a unique search
    // result (search is disabled, so set value programmatically), and a direct
    // switchMap-shaped re-entry via another tile click.
    await clickMap(page, 'de_inferno');
    await page.evaluate(() => {
        const s = document.getElementById('cs-mapsearch');
        s.value = 'de_inferno';
        s.dispatchEvent(new Event('input'));
        s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await page.waitForTimeout(600);

    const sent = await cmds(page);
    check(sent.filter((c) => c.startsWith('rcon changelevel')).length === 1,
        'still exactly one changelevel command, got: ' + JSON.stringify(sent));
    check(!sent.some((c) => c.includes('de_inferno')), 'no command for the second map');
    check((await selectedMap(page)) === undefined, 'nothing highlighted yet while switching');

    // Now let the server report ready → the FIRST map wins.
    await page.evaluate(() => { window.__ready = true; });
    await waitStatus(page, 'Switched to de_dust2');
    check((await selectedMap(page)) === 'de_dust2', 'first map confirmed, not the second');
    check(await allTilesEnabled(page), 'tiles re-enabled after confirmation');
    await page.close();
}

// ---------------------------------------------------------------- test 4
async function testTimeout(browser) {
    console.log('\n[4] timeout: no server-ready signal → explicit error, panel stays');
    const page = await newPage(browser, { xash: true, running: false, timeoutMs: 700 });
    await openPicker(page);

    await clickMap(page, 'de_nuke');
    await waitStatus(page, 'Switching to de_nuke');
    check(await allTilesDisabled(page), 'tiles disabled while switching');
    check((await cmds(page)).includes('rcon changelevel de_nuke'), 'command was issued (engine exists)');

    await waitStatus(page, 'Timed out waiting for the server to switch to de_nuke', 5000);
    check(await panelOpen(page), 'panel does NOT silently collapse on timeout');
    check((await selectedMap(page)) === undefined, 'no stale selection after timeout');
    check((await tileText(page, 'de_nuke')) === 'de_nuke', 'no ✓ highlight left behind');
    check(await allTilesEnabled(page), 'tiles re-enabled so the player can retry');
    check(!(await searchDisabled(page)), 'search re-enabled');
    const color = await page.evaluate(() => document.getElementById('cs-mapstatus').style.color);
    check(color === 'rgb(255, 123, 114)', 'error shown in error color, got: ' + color);
    await page.close();
}

// ------------------------------------------------------------------ main
const browser = await launch();
try {
    await testHappyPath(browser);
    await testEngineMissing(browser);
    await testDoubleClickWhileSwitching(browser);
    await testTimeout(browser);
} finally {
    await browser.close();
}

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('\nAll map-picker tests passed.');
