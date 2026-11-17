#!/usr/bin/env node
/**
 * Browser acceptance check for the point-light budget (CFG.graphics.lightBudget).
 *
 * Drives the REAL game in a real browser: boots the vite dev build, waits for
 * `window.__EXILIUM_READY`, then reads `World.lightCull` exactly as the F3 panel does.
 *
 * Checks, in order:
 *   1. budget 20  -> `rungs` contains no 24/28/34; every sampled frame has shown === rung
 *                    and rung <= 20; offRung does not accumulate.
 *   2. budget 1   -> exactly one rung, shown === 1, no page error / crash.
 *   3. shadow     -> if the scene has a casting point light, it is visible on every
 *                    sampled frame, at both budgets; droppedInFrustum counts only others.
 *   4. culling off-> active lights visible, then back on and the rung is re-selected.
 *   5. legacy default (null) -> the full ladder is restored.
 *
 * Usage: node tools/lightbudget-check.mjs [--url http://127.0.0.1:5188] [--frames 20]
 *   Needs a running dev server and `puppeteer-core` (not a project dependency, same as
 *   tools/shoot.mjs): `npm i --no-save puppeteer-core`. Uses the system Chrome/Edge.
 * Exit code 0 = all checks passed.
 */
import puppeteer from 'puppeteer-core';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No Chrome/Chromium found; set CHROME_PATH.');
  process.exit(2);
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const url = arg('url', 'http://127.0.0.1:5188/');
const frameCount = Number(arg('frames', 20));

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  // A fresh, unique profile every run: a stale profile from an interrupted run otherwise
  // makes launch fail with "the browser is already running for <userDataDir>".
  userDataDir: mkdtempSync(join(tmpdir(), 'exilium-lb-')),
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800',
  ],
  protocolTimeout: 300000,
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 300)));
page.on('console', (m) => {
  const text = m.text().slice(0, 300);
  // The dev server has no favicon; a 404 for it is noise, not a page error.
  if (m.type() === 'error' && !/favicon\.ico/.test(text) && !/status of 404/.test(text)) {
    pageErrors.push('console: ' + text);
  }
});

const failures = [];
const check = (ok, label, detail = '') => {
  (ok ? console.log : console.error)(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures.push(label + (detail ? ': ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`boot ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  try {
    const s = await page.evaluate(() => ({ ready: !!window.__EXILIUM_READY, err: window.__EXILIUM_ERROR || null }));
    if (s.err) { console.error('boot error:', s.err); break; }
    ready = s.ready;
  } catch { /* main thread busy compiling shaders */ }
  if (!ready) await sleep(1000);
}
check(ready, 'game booted (window.__EXILIUM_READY)');
if (!ready) { await browser.close(); process.exit(1); }

/**
 * Sample N successive rendered frames. Each sample waits for an actual animation frame so
 * the numbers come from the live loop, not from whatever was true during boot.
 */
async function sample(n) {
  return page.evaluate(async (count) => {
    const out = [];
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < count; i++) {
      await raf();
      const W = window.__ENGINE?.ctx?.World; const lc = W?.lightCull;
      if (!lc) return { error: 'World.lightCull missing' };
      const s = lc.stats;
      let casters = 0, castersVisible = 0;
      const scene = W?.scene;
      scene.traverse((o) => {
        if (o.isPointLight && o.castShadow && o.intensity > 1e-3) {
          casters++; if (o.visible) castersVisible++;
        }
      });
      out.push({
        shown: s.shown, rung: s.rung, inFrustum: s.inFrustum, budget: s.budget,
        dropped: s.droppedInFrustum, offRung: s.offRung, live: s.live,
        rungs: lc.rungs, casters, castersVisible,
      });
    }
    return { samples: out };
  }, n);
}

/** Switch the budget, re-prewarm against the new ladder, then settle. */
async function setBudget(cap) {
  return page.evaluate(async (c) => {
    const lc = window.__ENGINE.ctx.World.lightCull;
    lc.setBudget(c);
    const pw = lc.prewarm();
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < 4; i++) await raf();
    return { rungs: lc.rungs, prewarm: pw };
  }, cap);
}

/* ------------------------------------------------------------------ 1. cap 20 */
const r20 = await setBudget(20);
check(JSON.stringify(r20.rungs) === JSON.stringify([12, 16, 20]), 'budget 20 -> ladder [12,16,20]', JSON.stringify(r20.rungs));
check(!r20.rungs.some((r) => r > 20), 'budget 20 -> no rung above 20');
check(r20.prewarm && r20.prewarm.rungs && r20.prewarm.rungs.every((r) => r <= 20),
  'prewarm warmed only effective rungs', JSON.stringify(r20.prewarm?.rungs));

const s20 = await sample(frameCount);
check(!s20.error, 'World.lightCull.stats readable', s20.error || '');
if (s20.samples) {
  const bad = s20.samples.filter((s) => s.shown !== s.rung);
  check(bad.length === 0, `shown === rung on all ${s20.samples.length} frames`,
    bad.slice(0, 3).map((s) => `shown ${s.shown} rung ${s.rung}`).join(', '));
  const over = s20.samples.filter((s) => s.rung > 20);
  check(over.length === 0, 'no frame exceeds the 20-light budget', over.map((s) => s.rung).join(','));
  const rungsSeen = [...new Set(s20.samples.map((s) => s.rung))];
  check(rungsSeen.every((r) => [12, 16, 20].includes(r)), 'rungs observed stay on the capped ladder', rungsSeen.join('/'));
  const off0 = s20.samples[0].offRung;
  check(s20.samples.every((s) => s.offRung === off0), 'offRung does not accumulate', `offRung ${s20.samples.at(-1).offRung}`);
  const cast = s20.samples.filter((s) => s.casters > 0);
  if (cast.length) {
    check(cast.every((s) => s.castersVisible === s.casters), 'shadow casters visible at budget 20',
      `casters ${cast[0].casters}, visible ${cast[0].castersVisible}`);
  } else {
    console.log('SKIP  no shadow-casting point light in the live scene at budget 20');
  }
  console.log('      budget-20 samples:', s20.samples.slice(0, 5).map((s) => `${s.shown}/${s.inFrustum}@${s.rung}`).join(' '));
}

/* --------------------------------------------------- 1b. synthetic high demand */
/**
 * The spawn scene legitimately demands only ~9 in-frustum lights, so rung 12 is never
 * exercised above the cap. Add a burst of real PointLights around the player — the same
 * shape a dense spell fight produces — and verify the cap from the renderer's own frame.
 * `World.lightCull.invalidate()` is the documented hook a system calls after adding lights.
 */
const stress = await page.evaluate(async () => {
  const W = window.__ENGINE.ctx.World;
  const lc = W.lightCull;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const THREE = window.__ENGINE.ctx.THREE;
  const p = W.player?.pos || new THREE.Vector3(0, 0, 0);
  const added = [];
  // 34 in-frustum lights around the player, one of which casts a shadow.
  for (let i = 0; i < 34; i++) {
    const a = (i / 34) * Math.PI * 2;
    const l = new THREE.PointLight(0xffffff, 60 - i, 26, 2);
    l.position.set(p.x + Math.cos(a) * 3, p.y + 2.2, p.z + Math.sin(a) * 3);
    l.castShadow = i === 0;
    l.visible = false;
    W.scene.add(l);
    added.push(l);
  }
  lc.invalidate();
  for (let i = 0; i < 3; i++) await raf();

  const frames = [];
  for (let i = 0; i < 12; i++) {
    await raf();
    const s = lc.stats;
    let casters = 0, castersVisible = 0;
    W.scene.traverse((o) => {
      if (o.isPointLight && o.castShadow && o.intensity > 1e-3) { casters++; if (o.visible) castersVisible++; }
    });
    frames.push({ rung: s.rung, shown: s.shown, inFrustum: s.inFrustum, dropped: s.droppedInFrustum, casters, castersVisible, offRung: s.offRung });
  }
  // Clean up so later phases run against the real scene.
  for (const l of added) W.scene.remove(l);
  lc.invalidate();
  for (let i = 0; i < 3; i++) await raf();
  return frames;
});
check(stress.every((f) => f.rung <= 20), 'high demand -> rung stays at or below 20', stress.map((f) => f.rung).join(','));
check(stress.every((f) => f.shown === f.rung), 'high demand -> shown === rung every frame', stress.map((f) => `${f.shown}/${f.rung}`).join(' '));
check(stress.some((f) => f.rung === 20), 'high demand -> actually reaches the 20 rung', [...new Set(stress.map((f) => f.rung))].join('/'));
check(stress.every((f) => f.dropped > 0), 'high demand -> surplus in-frustum lights counted in droppedInFrustum', stress.map((f) => f.dropped).join(','));
check(stress.every((f) => f.casters === 0 || f.castersVisible === f.casters), 'high demand -> shadow caster visible', stress.map((f) => `${f.castersVisible}/${f.casters}`).join(' '));
check(stress.every((f) => f.dropped <= f.inFrustum - Math.max(1, f.casters)), 'high demand -> the shadow caster is not counted as dropped',
  stress.map((f) => `drop ${f.dropped}, in ${f.inFrustum}, casters ${f.casters}`).join(' | '));

/* ------------------------------------------------------------------- 2. cap 1 */
const r1 = await setBudget(1);
check(JSON.stringify(r1.rungs) === JSON.stringify([1]), 'budget 1 -> single rung [1]', JSON.stringify(r1.rungs));
const s1 = await sample(Math.min(frameCount, 12));
check(!s1.error, 'budget 1 still readable (no crash)', s1.error || '');
if (s1.samples) {
  check(s1.samples.every((s) => s.rung === 1), 'budget 1 -> every frame uses rung 1', s1.samples.map((s) => s.rung).join(','));
  check(s1.samples.every((s) => s.shown === 1), 'budget 1 -> exactly one light shown', s1.samples.map((s) => s.shown).join(','));
  const cast = s1.samples.filter((s) => s.casters > 0);
  if (cast.length) {
    check(cast.every((s) => s.castersVisible === s.casters), 'shadow caster survives a 1-light budget',
      `casters ${cast[0].casters}, visible ${cast[0].castersVisible}`);
    check(cast.every((s) => s.dropped <= s.inFrustum - s.casters),
      'droppedInFrustum counts only non-shadow lights', `dropped ${cast[0].dropped}, inFrustum ${cast[0].inFrustum}`);
  }
  console.log('      budget-1 samples:', s1.samples.slice(0, 5).map((s) => `${s.shown}/${s.inFrustum}@${s.rung}`).join(' '));
}

/* ------------------------------------------------------- 3. toggle off and on */
const toggled = await page.evaluate(async () => {
  const lc = window.__ENGINE.ctx.World.lightCull;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  lc.setBudget(20);
  for (let i = 0; i < 3; i++) await raf();
  const rungOn = lc.stats.rung;

  lc.setEnabled(false);
  await raf();
  let hiddenActive = 0, active = 0;
  window.__ENGINE.ctx.World.scene.traverse((o) => {
    if (o.isPointLight && o.intensity > 1e-3) { active++; if (!o.visible) hiddenActive++; }
  });

  lc.setEnabled(true);
  for (let i = 0; i < 3; i++) await raf();
  return { rungOn, active, hiddenActive, rungAfter: lc.stats.rung, shown: lc.stats.shown };
});
check(toggled.hiddenActive === 0, 'culling off -> every active light visible', `${toggled.hiddenActive}/${toggled.active} hidden`);
check(toggled.rungAfter >= 1 && toggled.shown === toggled.rungAfter,
  'culling back on -> rung re-selected and shown === rung', `rung ${toggled.rungAfter}, shown ${toggled.shown}`);

/* ------------------------------------------------------- 4. restore lossless */
const rNull = await setBudget(null);
check(rNull.rungs.length === 6 && rNull.rungs.at(-1) === 34, 'budget null -> full lossless ladder restored', JSON.stringify(rNull.rungs));

check(pageErrors.length === 0, 'no page/console errors', pageErrors.slice(0, 3).join(' | '));

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
