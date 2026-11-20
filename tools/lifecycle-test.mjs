// Headless regression run for the mission lifecycle (pause / death wait / retry / quit).
// Dev-only: builds the dev bundle, drives it through the Chrome DevTools Protocol, and checks the invariants a
// paused mission must keep. No extra dependencies — it uses the Chrome/Edge already on the machine.
//
//   node tools/lifecycle-test.mjs                 # build, then run every check
//   node tools/lifecycle-test.mjs --no-build      # reuse the current index.html
//
// The browser is launched with --headless and a throwaway profile, so nothing on the machine is touched.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const noBuild = process.argv.includes('--no-build');

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const exe = BROWSERS.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!exe) { console.error('[lifecycle] no Chrome/Edge found; pass a browser path or run the checks by hand'); process.exit(2); }

if (!noBuild) {
  const build = spawn(process.execPath, [path.join(root, 'tools', 'build.mjs'), '--dev'], { cwd: root, stdio: 'inherit' });
  await new Promise((res, rej) => build.on('exit', (c) => (c ? rej(new Error(`build failed (${c})`)) : res())));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9200 + (Math.floor(Math.random() * 60));
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-lifecycle-'));
const proc = spawn(exe, [
  `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--headless', '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--window-size=1280,720', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let browserLog = '';
proc.stderr.on('data', (d) => { browserLog += d; });

const found = (async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error('browser did not expose a page\n' + browserLog);
})();

const page = await found;
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (!m.id || !pending.has(m.id)) return;
  const p = pending.get(m.id); pending.delete(m.id);
  m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }));
});
await send('Runtime.enable');

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails.exception;
    throw new Error((ex && ex.description) || JSON.stringify(r.exceptionDetails));
  }
  return r.result?.value;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : `  —  ${detail}`}`);
}

async function boot() {
  await send('Page.navigate', { url: 'file://' + path.join(root, 'index.html') + '?manual&seed=7' });
  for (let i = 0; i < 400; i++) {
    try { if (await ev('typeof window.__step') === 'function') return; } catch { /* still booting */ }
    await sleep(250);
  }
  throw new Error('game did not boot');
}

const PRESS = async (code, frames = 2) => {
  await ev(`__key('${code}', true)`); await ev(`__step(${frames})`);
  await ev(`__key('${code}', false)`); await ev('__step(2)');
};
const clickPauseItem = (act) => ev(`document.querySelector('#pause .mi[data-act="${act}"]').click()`);

// ------------------------------------------------------------------ checks
async function checkPauseFreezes() {
  await ev('__jump(0)'); await ev('__step(400)');
  const before = await ev('JSON.stringify({ d: +G.rail.d.toFixed(2), t: +G.run.time.toFixed(3) })');
  await PRESS('Escape');
  check('pause opens', await ev('G.paused === true'));
  await ev('__step(600)');
  const after = await ev('JSON.stringify({ d: +G.rail.d.toFixed(2), t: +G.run.time.toFixed(3) })');
  const b = JSON.parse(before), a = JSON.parse(after);
  check('distance frozen while paused', Math.abs(a.d - b.d) < 1e-6, `${b.d} → ${a.d}`);
  check('mission timer frozen while paused', Math.abs(a.t - b.t) < 1e-6, `${b.t} → ${a.t}`);
  await PRESS('Escape');
  const resumedAt = await ev('+G.rail.d.toFixed(2)');
  check('resume continues from the frozen point', Math.abs(resumedAt - a.d) < 10, `${a.d} → ${resumedAt}`);
  await ev('__step(60)');
  check('distance advances after resume', await ev(`G.rail.d > ${resumedAt}`));
}

async function checkDeathWaitFreezes() {
  await ev('__jump(0)'); await ev('__step(400)');
  await ev('(function(){ G.run.shield = 0; ship.damage(500); })()');
  await ev('__step(160)');                       // dying animation, then "dead"
  check('reaches the death wait', await ev(`G.state === 'dead'`), await ev('G.state'));
  await PRESS('Escape');
  check('pause is allowed during the death wait', await ev('G.paused === true'));
  const deathsBefore = await ev('G.run.deaths');
  const dBefore = await ev('G.rail.d');
  await ev('__step(600)');
  check('death countdown frozen while paused', await ev(`G.run.deaths === ${deathsBefore}`) && await ev(`G.state === 'dead'`));
  const dAfter = await ev('G.rail.d');
  check('death wait does not respawn while paused', await ev('ship.alive === false') && Math.abs(dAfter - dBefore) < 0.01, `${dBefore.toFixed(2)} → ${dAfter.toFixed(2)}`);
  // A burst of retry clicks must respawn exactly once.
  await ev(`document.querySelector('#pause .mi[data-act="retry"]').click(); document.querySelector('#pause .mi[data-act="retry"]').click(); document.querySelector('#pause .mi[data-act="retry"]').click();`);
  await ev('__step(2)');
  check('retry closes the pause menu', await ev('G.paused === false'));
  await ev('__step(400)');
  check('retry respawns the ship once', await ev('ship.alive === true && G.state === "play"'), await ev('JSON.stringify({state:G.state, alive:ship.alive, deaths:G.run.deaths})'));
  check('retry did not spend extra lives', (await ev('G.run.lives')) === 3, String(await ev('G.run.lives')));
}

async function checkRespawnLeavesNoResidue() {
  // The death countdown path (not the menu) must also come back clean.
  await ev('__jump(0)'); await ev('__step(400)');
  await ev('(function(){ G.run.checkpoint = 6100; G.run.shield = 0; ship.damage(500); })()');
  await ev('__step(160)');
  await ev('__step(200)');              // past the 2 s death wait: automatic respawn
  await ev('__step(120)');              // finish the fade
  const hud = JSON.parse(await ev(`JSON.stringify({
    state: G.state, warning: document.getElementById('warning').className,
    banner: document.getElementById('banner').className, big: document.querySelector('#banner .b-big').textContent,
    radio: document.getElementById('radio').className, boss: document.getElementById('boss').className,
    tip: document.getElementById('tip').className, results: document.getElementById('results').classList.contains('on') ? 'on' : '' })`));
  check('respawn restarts the run', hud.state === 'play', hud.state);
  check('respawn clears the boss bar', hud.boss === '');
  check('respawn clears the warning overlay', hud.warning === '');
  check('respawn clears the results panel', hud.results !== 'on');
  check('respawn leaves only the new run banner', hud.banner === '' || hud.big === 'CHECKPOINT', `${hud.banner}|${hud.big}`);
}

async function checkBossQuitClears() {
  await ev('__jump(10400)'); await ev('__step(400)');
  check('boss warning is active before quitting', await ev(`document.getElementById('warning').className === 'on' || G.rail.d > 10550`), await ev('+G.rail.d.toFixed(0)'));
  await PRESS('Escape');
  await ev(`document.querySelector('#pause .mi[data-act="quit"]').click(); document.querySelector('#pause .mi[data-act="quit"]').click();`);
  await ev('__step(300)');
  const hud = JSON.parse(await ev(`JSON.stringify({
    state: G.state, warning: document.getElementById('warning').className, banner: document.getElementById('banner').className,
    radio: document.getElementById('radio').className, rtext: document.getElementById('rtext').textContent,
    boss: document.getElementById('boss').className })`));
  check('quit returns to the title', hud.state === 'title', hud.state);
  check('quit clears the boss warning', hud.warning === '');
  check('quit clears the boss bar', hud.boss === '');
  check('quit clears the radio', hud.radio === '' && hud.rtext === '');
  await ev('__start()'); await ev('__step(500)');
  const fresh = JSON.parse(await ev(`JSON.stringify({
    state: G.state, warning: document.getElementById('warning').className, boss: document.getElementById('boss').className,
    big: document.querySelector('#banner .b-big').textContent, results: document.getElementById('results').classList.contains('on') ? 'on' : '' })`));
  check('a fresh mission starts clean', fresh.state === 'play' && fresh.warning === '' && fresh.boss === '' && fresh.results === '', JSON.stringify(fresh));
  check('a fresh mission shows its own banner', fresh.big === 'AZURE COAST', fresh.big);
}

async function checkInputDoesNotStick() {
  await ev('__jump(0)'); await ev('__step(400)');
  await ev(`__key('KeyW', true)`); await ev('__step(10)');
  await PRESS('Escape');
  await ev(`__key('Space', true)`); await ev('__step(2)'); await ev(`__key('Space', false)`);
  await ev('__step(4)');
  check('resume did not fire from the closing key', await ev('G.run.shots === 0'), String(await ev('G.run.shots')));
  check('a held direction still steers after resume', await ev('Input.held("up") === true && Input.y > 0'));
  await ev(`__key('KeyW', false)`);
  await ev('__step(6)');
  check('released direction stops steering', await ev('Input.held("up") === false && Input.y === 0'));
}

async function checkDoubleResults() {
  await ev('CAMP.mode = "select";');   // mission-select runs show the RETRY button on the results panel
  await ev('__jump(10700)');
  for (let i = 0; i < 40; i++) { await ev('__step(60)'); if (await ev('BOSS.inst.phase') === 'p1') break; }
  await ev('BOSS.inst.die()');
  for (let i = 0; i < 40; i++) { await ev('__step(200)'); if (await ev('G.state') === 'results') break; }
  check('clear opens exactly one results screen', await ev(`G.state === 'results' && document.querySelectorAll('#results.on').length === 1`));
  const d = await ev('+G.rail.d.toFixed(0)');
  await ev(`document.querySelector('#results .mi[data-act="again"]').click(); document.querySelector('#results .mi[data-act="again"]').click(); document.querySelector('#results .mi[data-act="again"]').click();`);
  await ev('__step(600)');
  check('a burst of "again" starts one fresh mission', await ev(`G.state === 'play' && G.rail.d < 4000`), await ev('JSON.stringify({state:G.state, d:Math.round(G.rail.d)})'));
  const hud = JSON.parse(await ev(`JSON.stringify({
    warning: document.getElementById('warning').className, boss: document.getElementById('boss').className,
    results: document.getElementById('results').classList.contains('on') ? 'on' : '', big: document.querySelector('#banner .b-big').textContent })`));
  check('the fresh run has no leftover boss bar / results panel', hud.boss === '' && hud.results === '' && hud.warning === '', JSON.stringify(hud));
}

// ------------------------------------------------------------------ run
let failed = false;
try {
  await boot();
  console.log('[lifecycle] pause freeze');
  await checkPauseFreezes();
  console.log('[lifecycle] death wait');
  await checkDeathWaitFreezes();
  console.log('[lifecycle] respawn residue');
  await checkRespawnLeavesNoResidue();
  console.log('[lifecycle] quit residue');
  await checkBossQuitClears();
  console.log('[lifecycle] input after resume');
  await checkInputDoesNotStick();
  console.log('[lifecycle] results screen');
  await checkDoubleResults();
} catch (e) {
  failed = true;
  console.error('[lifecycle] aborted:', e.message);
} finally {
  ws.close();
  proc.kill();
  await sleep(500);
  try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); } catch { /* windows keeps the profile locked briefly */ }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n[lifecycle] ${passed}/${results.length} checks passed`);
if (failed || passed !== results.length) process.exit(1);
