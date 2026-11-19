#!/usr/bin/env node
/**
 * EXILIUM — in-game post-processing acceptance check (real browser, real GPU path).
 *
 *   npm run test:pipeline:live
 *   node tools/pipeline-live-check.mjs
 *   node tools/pipeline-live-check.mjs --headed --keep
 *
 * WHAT THIS ADDS OVER tools/pipeline-selftest.mjs
 * -----------------------------------------------
 * The Node harness drives the pipeline against a stub renderer: it proves the
 * STATE machine, which is where every reported defect lived. It cannot prove the
 * game actually boots that pipeline, that the resize path the ENGINE calls agrees
 * with the one the API calls, or that a real `devicePixelRatio` round-trip leaves
 * the composer and the AO targets in agreement. This script boots the real app in
 * a real (headless) Chrome through the real Vite dev server and runs the SAME
 * oracle — `World.pipeline.selfTest()` — in the page, then drives live quality,
 * AA, AO and resize transitions and re-checks after each.

 * The defects this covers, in player language:
 *   - "the picture goes dark / contact shadow disappears" → a tier applied to one
 *     AO pass but not the other, or contact left on under a disabled broad pass
 *   - "there's a ghost"                                  → stale TAA accumulation
 *                                                          surviving a mode/size change
 *   - "switching quality does nothing visible"           → a coerced tier that
 *                                                          silently stayed on ultra
 *
 * HOW IT RUNS
 * -----------
 * Spawns `vite` and a headless Chrome with a remote-debugging port, talks CDP
 * over the built-in `WebSocket` (Node 22+). No Playwright/Puppeteer dependency —
 * the repo has none and this must run offline.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = 5199;
const CDP_PORT = 9333;
const HEADED = process.argv.includes('--headed');
const KEEP = process.argv.includes('--keep');
const verbose = process.argv.includes('--verbose');

// ---------------------------------------------------------------- assertion
const results = [];
let cur = null;
function scenario(name, fn) {
  cur = { name, checks: 0, failures: [] };
  return Promise.resolve()
    .then(fn)
    .catch((e) => cur.failures.push(`THREW ${e && e.stack || e}`))
    .then(() => {
      const ok = cur.failures.length === 0;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${cur.checks} checks)`);
      for (const f of cur.failures) console.log(`        ✗ ${f}`);
      results.push(cur);
      cur = null;
    });
}
function check(label, cond, detail) {
  cur.checks++;
  if (!cond) cur.failures.push(detail ? `${label}: ${detail}` : label);
  else if (verbose) console.log(`        · ${label}`);
}
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  check(label, a === b, `got ${a}, want ${b}`);
}

// ---------------------------------------------------------------- chrome
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a URL until it answers 2xx. Resolves the parsed JSON body when there is
 *  one (the DevTools endpoints), `{}` when the body is not JSON (Vite's index). */
async function waitForHttp(url, tries = 60, gap = 500) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const text = await r.text();
        try { return JSON.parse(text); } catch { return {}; }
      }
    } catch { /* not up yet */ }
    await sleep(gap);
  }
  return null;
}

/** Minimal CDP client over WebSocket. */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.console = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params.exceptionDetails?.exception?.description
          || msg.params.exceptionDetails?.text || 'exception');
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.console.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** Evaluate an expression in the page and return its JSON value. */
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(() => { ${expr} })()`,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }
}

// ---------------------------------------------------------------- main
let vite, chrome, profile, cdp;
const cleanup = () => {
  try { cdp?.ws.close(); } catch {}
  try { chrome?.kill(); } catch {}
  try { vite?.kill(); } catch {}
  if (profile && !KEEP) { try { rmSync(profile, { recursive: true, force: true }); } catch {} }
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

try {
  // 1. Vite dev server, on its own port so it never fights a running `npm run dev`.
  vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: 'ignore', shell: process.platform === 'win32',
  });
  const viteUp = await waitForHttp(`http://127.0.0.1:${PORT}/`, 60, 500).catch(() => null);
  if (viteUp === null) {
    console.log('SKIP  could not start vite on', PORT);
    cleanup();
    process.exit(0);
  }

  // 2. Headless Chrome with a CDP port. `--user-data-dir` must be non-default or
  //    recent Chrome refuses remote debugging outright.
  const chromePath = findChrome();
  if (!chromePath) { console.log('SKIP  no Chrome/Edge found (set CHROME_PATH)'); cleanup(); process.exit(0); }
  profile = mkdtempSync(join(tmpdir(), 'exilium-cdp-'));
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-swiftshader', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--window-size=1280,720',
    HEADED ? '--headless=no' : '--headless=new',
    'about:blank',
  ];
  if (!HEADED) args.push('--disable-gpu');
  chrome = spawn(chromePath, args, { stdio: 'ignore' });

  const version = await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 60, 500);
  if (!version) { console.log('SKIP  Chrome debugging port never opened'); cleanup(); process.exit(0); }

  // 3. Open a page target and attach.
  const target = await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, 10, 300)
    .catch(() => null);
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const pageTarget = target || targets.find((t) => t.type === 'page');
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 2, mobile: false,
  });

  // 4. Load the app and wait for its own readiness signal.
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  let ready = false, bootErr = null;
  for (let i = 0; i < 160; i++) {
    await sleep(500);
    try {
      const s = await cdp.eval('return { r: !!window.__EXILIUM_READY, e: window.__EXILIUM_ERROR || null };');
      if (s.e) { bootErr = s.e; break; }
      if (s.r) { ready = true; break; }
    } catch { /* main thread busy generating the dungeon */ }
  }
  if (!ready) {
    console.log('FAIL  app never reached __EXILIUM_READY', bootErr ? `(${bootErr})` : '');
    cleanup();
    process.exit(1);
  }

  // Freeze the sim so the state we assert on does not race a resize or a
  // frame-driven camera move. This touches only the engine's loop guard.
  await cdp.eval('window.__ENGINE.ctx.World.paused = true; document.getElementById("boot")?.remove(); return true;');

  const P = `window.__ENGINE.ctx.World.pipeline`;
  const state = () => cdp.eval(`return ${P}.getState();`);
  const selfTest = () => cdp.eval(`return ${P}.selfTest();`);
  const healthy = async (label) => {
    const errs = await selfTest();
    check(`${label}: selfTest clean`, errs.length === 0, errs.join(' | '));
  };
  /** The chain must contain these passes in this order. `godray` is optional
   *  (installed only when sky.js exposes a pass), so it is matched as a
   *  subsequence rather than compared literally. */
  const wantChain = (chain) => {
    const want = ['render', 'broadAO', 'contactAO', 'bloom', 'output', 'grade', 'smaa'];
    let i = 0;
    for (const name of chain) if (name === want[i]) i++;
    return i === want.length;
  };

  // -------------------------------------------------------------------------
  await scenario('live A. booted game exposes a healthy, queryable pipeline', async () => {
    const s = await state();
    eq('ready', s.ready, true);
    check('chain order', wantChain(s.chain), s.chain.join('>'));
    eq('broad AO on', s.broadAO.enabled, true);
    eq('contact AO on', s.contactAO.enabled, true);
    eq('contact shares g-buffer', s.contactAO.sharesGBuffer, true);
    eq('pixelRatio', s.pixelRatio, 1);     // CFG caps it at 1
    eq('AO is half the composer', s.broadAO.width * 2, s.composer.width);
    eq('state has no error', s.lastError, null);
    await healthy('boot');
  });

  await scenario('live B. quality switches keep both AO tiers in lockstep', async () => {
    for (const [tier, on, samples] of [['medium', false, 9], ['high', true, 9], ['ultra', true, 16]]) {
      await cdp.eval(`return ${P}.setQuality('${tier}');`);
      const s = await state();
      eq(`${tier}: quality`, s.quality, tier);
      eq(`${tier}: broad==contact enable`, s.broadAO.enabled, s.contactAO.enabled);
      eq(`${tier}: broad on?`, s.broadAO.enabled, on);
      eq(`${tier}: contact samples track broad`, s.contactAO.samples, s.broadAO.samples);
      eq(`${tier}: samples`, s.broadAO.samples, samples);
      await healthy(tier);
    }
    // Render a few real frames at each tier so a broken chain would throw on the
    // GPU rather than only in the state read. Unpause just long enough for a
    // handful of rAF ticks, then pause again.
    await cdp.eval('window.__ENGINE.ctx.World.paused = false; return true;');
    await sleep(500);
    await cdp.eval('window.__ENGINE.ctx.World.paused = true; return true;');
    eq('render errors since boot', cdp.errors.length, 0);
  });

  await scenario('live C. broad-AO off takes contact with it; restore brings it back', async () => {
    await cdp.eval(`return ${P}.setBroadAO(false);`);
    let s = await state();
    eq('broad off', s.broadAO.enabled, false);
    eq('contact off', s.contactAO.enabled, false);
    await healthy('broad off');

    await cdp.eval(`return ${P}.setBroadAO(true);`);
    s = await state();
    eq('broad back', s.broadAO.enabled, true);
    eq('contact resumed', s.contactAO.enabled, true);
    eq('g-buffer shared', s.contactAO.sharesGBuffer, true);
    await healthy('broad restored');
  });

  await scenario('live D. AA switching rebuilds the chain and clears TAA history', async () => {
    await cdp.eval(`return ${P}.setAA('taa');`);
    let s = await state();
    eq('taa mode', s.aa, 'taa');
    eq('chain head', s.chain[0], 'taa');
    check('no smaa in chain', !s.chain.includes('smaa'), s.chain.join('>'));
    eq('accum reset', s.taa.accumulateIndex, -1);
    await healthy('taa');

    await cdp.eval(`return ${P}.setAA('smaa');`);
    s = await state();
    eq('smaa mode', s.aa, 'smaa');
    eq('chain head', s.chain[0], 'render');
    check('no taa in chain', !s.chain.includes('taa'), s.chain.join('>'));
    check('smaa present', s.chain.includes('smaa'), s.chain.join('>'));
    await healthy('smaa');
  });

  await scenario('live E. a real resize follows logical size × DPR', async () => {
    for (const [w, h, dsf] of [[1024, 640, 1], [1024, 640, 2], [1440, 810, 2]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: dsf, mobile: false,
      });
      await sleep(150);                 // let the engine's own `resize` listener fire
      await cdp.eval(`return ${P}.resize(${w}, ${h});`);   // and drive the API directly
      const s = await state();
      const effW = Math.round(w * s.pixelRatio), effH = Math.round(h * s.pixelRatio);
      const tag = `${w}x${h}@${dsf}`;
      eq(`${tag}: effective w`, s.size.width, effW);
      eq(`${tag}: composer w`, s.composer.width, effW);
      eq(`${tag}: grade w`, s.grade.width, effW);
      eq(`${tag}: AO w`, s.broadAO.width, Math.max(2, Math.round(effW * 0.5)));
      eq(`${tag}: AO h`, s.broadAO.height, Math.max(2, Math.round(effH * 0.5)));
      eq(`${tag}: contact same size`, `${s.contactAO.width}x${s.contactAO.height}`,
        `${s.broadAO.width}x${s.broadAO.height}`);
      eq(`${tag}: shares g-buffer`, s.contactAO.sharesGBuffer, true);
      await healthy(tag);
    }
  });

  await scenario('live F. one illegal input leaves the state un-dirtied', async () => {
    const before = await state();
    await cdp.eval(`return ${P}.setQuality('ultra2');`);
    await cdp.eval(`return ${P}.setAA('fxaa');`);
    await cdp.eval(`return ${P}.resize(NaN, 720);`);
    const after = await state();
    eq('quality unchanged', after.quality, before.quality);
    eq('aa unchanged', after.aa, before.aa);
    eq('size unchanged', after.size, before.size);
    eq('AO size unchanged', after.broadAO.width, before.broadAO.width);
    check('error surfaced', after.lastError && after.lastError.method === 'resize',
      JSON.stringify(after.lastError));
    await healthy('after illegal inputs');

    // And a valid call restores a clean state (no stale failure).
    await cdp.eval(`return ${P}.setQuality('ultra');`);
    eq('valid call clears error', (await state()).lastError, null);
    // The next real frames must still render without a page error.
    await cdp.eval('window.__ENGINE.ctx.World.paused = false; return true;');
    await sleep(400);
    await cdp.eval('window.__ENGINE.ctx.World.paused = true; return true;');
    eq('render errors after recovery', cdp.errors.length, 0);
  });

  await scenario('live G. the page logged no console errors', async () => {
    eq('page exceptions', cdp.errors.length, 0);
    check('console.error entries', cdp.console.length === 0, cdp.console.slice(0, 3).join(' | '));
  });

} catch (e) {
  console.log('FAIL  harness error:', e && e.stack || e);
  results.push({ name: 'harness', checks: 0, failures: [String(e)] });
}

cleanup();

const failed = results.filter((r) => r.failures.length);
const total = results.reduce((n, r) => n + r.checks, 0);
console.log('');
if (failed.length) {
  console.log(`FAILED — ${failed.length}/${results.length} scenarios, ` +
    `${failed.reduce((n, r) => n + r.failures.length, 0)} failed checks of ${total}`);
  process.exit(1);
} else {
  console.log(`OK — ${results.length} scenarios, ${total} checks`);
}
