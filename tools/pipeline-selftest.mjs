#!/usr/bin/env node
/**
 * EXILIUM — post-processing pipeline acceptance harness.
 *
 *   node tools/pipeline-selftest.mjs          # or: npm test
 *   node tools/pipeline-selftest.mjs --verbose
 *
 * WHY A NODE HARNESS AND NOT A SCREENSHOT TEST
 * --------------------------------------------
 * Every defect this file guards against is a STATE defect, not a shading defect:
 * a pass left enabled after its dependency was switched off, a half-res target
 * left at the previous tier's size, a stale temporal accumulation surviving a
 * mode change. All of them produce the same three symptoms the player reports —
 * "the picture went dark", "there's a ghost", "the contact shadow vanished" —
 * and all of them are decidable from the live pass objects without drawing a
 * pixel. Screenshot diffs would be slower, flakier (SwiftShader, procedural
 * levels) and would not say WHICH invariant broke.
 *
 * So this harness drives the REAL `src/render/pipeline.js` with the REAL
 * three.js passes and a stub renderer, and asserts the invariants the pipeline
 * itself publishes as `World.pipeline.selfTest()`. The same oracle runs in the
 * browser via `World.pipeline.selfTest()` (see tools/pipeline-browser-check.mjs),
 * so "passes here" and "passes in the game" mean the same thing.
 *
 * WHAT IS AND IS NOT COVERED
 * --------------------------
 * Covered: chain composition, per-tier enable flags, sample counts, every
 *          half-res/composer/grade/SMAA target size against the effective
 *          (logical × DPR) backing store, g-buffer sharing identity, temporal
 *          history invalidation, and rejected-input hygiene.
 * Not covered: actual pixels / GPU behaviour. Those are `tools/capture.js` and
 *          `tools/analyze.mjs`'s job.
 */

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// DOM surface. three's SMAAPass preloads its area/search lookup tables via
// `new Image()`; nothing in the state machine needs them decoded, and no render
// happens here, so a no-op shim is sufficient and keeps this dependency-free.
// ---------------------------------------------------------------------------
globalThis.Image = class {
  constructor() { this._src = ''; this.onload = null; }
  set src(v) { this._src = v; }
  get src() { return this._src; }
};

const ROOT = new URL('../', import.meta.url);
const { World } = await import(new URL('src/core/world.js', ROOT).href);
const { QUALITY } = await import(new URL('src/core/config.js', ROOT).href);
const pipeline = (await import(new URL('src/render/pipeline.js', ROOT).href)).default;

// ---------------------------------------------------------------------------
// Stub renderer. Only the surface the pipeline touches: pixel ratio, logical
// size, toneMappingExposure. `getSize` reports the logical CSS size, exactly as
// WebGLRenderer does — the pipeline multiplies by its own pixel ratio.
// ---------------------------------------------------------------------------
function makeRenderer(width, height, pixelRatio) {
  return {
    _w: width, _h: height, _pr: pixelRatio,
    toneMappingExposure: 1.17,
    getPixelRatio() { return this._pr; },
    setPixelRatio(p) { this._pr = p; },
    getSize(v = new THREE.Vector2()) { v.set(this._w, this._h); return v; },
    setSize(w, h) { this._w = w; this._h = h; },
  };
}

/** Simulate the browser's DPR changing (window dragged between displays). */
function setDevicePixelRatio(v) { globalThis.devicePixelRatio = v; }

function boot({ width = 1280, height = 720, dpr = 2 } = {}) {
  setDevicePixelRatio(dpr);
  globalThis.innerWidth = width;
  globalThis.innerHeight = height;
  const renderer = makeRenderer(width, height, Math.min(dpr, 1)); // engine applies the cap
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, width / height, 1, 260);
  pipeline.dispose();
  pipeline.init({
    THREE, World, scene, camera, renderer,
    canvas: null, bus: {}, EV: {}, CFG: {},
  });
  return { P: World.pipeline, renderer, scene, camera };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
const verbose = process.argv.includes('--verbose');
const results = [];
let current = null;

function scenario(name, fn) {
  current = { name, checks: 0, failures: [] };
  try { fn(); } catch (e) { current.failures.push(`THREW ${e && e.stack || e}`); }
  results.push(current);
  const ok = current.failures.length === 0;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}  (${current.checks} checks)`);
  for (const f of current.failures) console.log(`        ✗ ${f}`);
  current = null;
}

function check(label, cond, detail) {
  if (!current) throw new Error('check() outside a scenario');
  current.checks++;
  if (!cond) current.failures.push(detail ? `${label}: ${detail}` : label);
  else if (verbose) console.log(`        · ${label}`);
}

function eq(label, got, want) {
  check(label, got === want, `got ${fmt(got)}, want ${fmt(want)}`);
}
function fmt(v) { return typeof v === 'object' ? JSON.stringify(v) : String(v); }

/** The pipeline's own invariant oracle — the authoritative check on every step. */
function healthy(P) {
  const errs = P.selfTest();
  check('selfTest() clean', errs.length === 0, errs.join(' | '));
  return errs;
}

const AO_SCALE = 0.5;
const expectAO = (s) => ({
  w: Math.max(2, Math.round(s.size.width * AO_SCALE)),
  h: Math.max(2, Math.round(s.size.height * AO_SCALE)),
});

// ===========================================================================
// A. Fresh boot
// ===========================================================================
scenario('A. boot: chain assembled, tiers applied from config', () => {
  const { P } = boot({ width: 1280, height: 720, dpr: 2 });
  const s = P.getState();
  eq('ready', s.ready, true);
  eq('quality', s.quality, 'ultra');
  eq('aa', s.aa, 'smaa');
  eq('pixelRatio', s.pixelRatio, 1);           // engine caps DPR at maxPixelRatio (1)
  eq('effective width', s.size.width, 1280);
  eq('effective height', s.size.height, 720);
  eq('chain', s.chain.join('>'), 'render>broadAO>contactAO>bloom>output>grade>smaa');
  eq('broad AO enabled', s.broadAO.enabled, true);
  eq('contact AO enabled', s.contactAO.enabled, true);
  eq('contact shares g-buffer', s.contactAO.sharesGBuffer, true);
  eq('broad samples', s.broadAO.samples, 16);
  eq('contact samples', s.contactAO.samples, 16);
  eq('broad AO width', s.broadAO.width, 640);
  eq('contact AO width', s.contactAO.width, 640);
  eq('composer width', s.composer.width, 1280);
  eq('grade width', s.grade.width, 1280);
  eq('smaa width', s.smaa.width, 1280);
  eq('no error at boot', s.lastError, null);
  healthy(P);
});

// ===========================================================================
// B. Quality tiers — enable, samples and half-res size move TOGETHER
// ===========================================================================
scenario('B. quality tiers keep broad+contact enable/samples/size in lockstep', () => {
  const { P } = boot({ width: 1600, height: 900, dpr: 2 });
  const mat = (P) => expectAO(P.getState());

  for (const [tier, aoOn, samples] of [
    ['medium', false, 9], ['high', true, 9], ['ultra', true, 16], ['medium', false, 9],
  ]) {
    P.setQuality(tier);
    const s = P.getState();
    eq(`${tier}: quality`, s.quality, tier);
    eq(`${tier}: broad enabled`, s.broadAO.enabled, aoOn);
    eq(`${tier}: contact enabled (follows broad)`, s.contactAO.enabled, aoOn);
    eq(`${tier}: broad samples`, s.broadAO.samples, samples);
    eq(`${tier}: contact samples track broad`, s.contactAO.samples, samples);
    eq(`${tier}: AO size == eff*0.5`, `${s.broadAO.width}x${s.broadAO.height}`,
      `${mat(P).w}x${mat(P).h}`);
    eq(`${tier}: contact size == broad size`, `${s.contactAO.width}x${s.contactAO.height}`,
      `${s.broadAO.width}x${s.broadAO.height}`);
    eq(`${tier}: g-buffer still shared`, s.contactAO.sharesGBuffer, true);
    healthy(P);
  }

  // Unknown tier is REJECTED, not silently coerced — an acceptance test that only
  // reads back `quality` must not be able to mistake a failed switch for a pass.
  const before = P.getState();
  P.setQuality('cinematic');
  const after = P.getState();
  eq('bogus tier: quality unchanged', after.quality, before.quality);
  eq('bogus tier: broad unchanged', after.broadAO.enabled, before.broadAO.enabled);
  eq('bogus tier: samples unchanged', after.broadAO.samples, before.broadAO.samples);
  check('bogus tier: lastError recorded',
    after.lastError && after.lastError.method === 'setQuality',
    fmt(after.lastError));
  healthy(P);
  // A subsequent valid call clears the error — no stale failure lingers.
  P.setQuality('ultra');
  eq('valid call clears lastError', P.getState().lastError, null);
});

// ===========================================================================
// C. Boundary: broad AO off must take contact with it, and restore it
// ===========================================================================
scenario('C. broad-AO off disables contact (no stale shared g-buffer)', () => {
  const { P } = boot({ width: 1280, height: 720, dpr: 1 });

  P.setBroadAO(false);
  let s = P.getState();
  eq('broad off', s.broadAO.enabled, false);
  // THE defect: contact left enabled reads a g-buffer nothing refreshes any more —
  // a frozen dark band stuck to the geometry ("the shadow ghosted / the picture
  // went dark"). It must be OFF, not merely untouched.
  eq('contact off with broad', s.contactAO.enabled, false);
  eq('contact request remembered', s.contactAO.requested, true);
  healthy(P);

  P.setBroadAO(true);
  s = P.getState();
  eq('broad back on', s.broadAO.enabled, true);
  eq('contact resumes from remembered request', s.contactAO.enabled, true);
  eq('g-buffer shared again', s.contactAO.sharesGBuffer, true);
  healthy(P);

  // Turning contact off explicitly, then broad off/on, must NOT resurrect contact.
  P.setContactAO(false);
  P.setBroadAO(false);
  P.setBroadAO(true);
  s = P.getState();
  eq('explicit contact-off survives a broad round trip', s.contactAO.enabled, false);
  eq('broad still on', s.broadAO.enabled, true);
  healthy(P);

  // Quality tier 'medium' also sheds AO; contact must not survive into 'high'
  // when the user had turned it off.
  P.setQuality('high');
  eq('contact stays off through tier change', P.getState().contactAO.enabled, false);
  P.setContactAO(true);
  eq('contact can be re-enabled', P.getState().contactAO.enabled, true);
  healthy(P);
});

// ===========================================================================
// D. Resize, including a device-pixel-ratio change
// ===========================================================================
scenario('D. resize re-derives composer/grade/AO sizes from logical size × DPR', () => {
  const { P, renderer } = boot({ width: 1280, height: 720, dpr: 1 });

  const sizes = [
    { w: 1024, h: 768, dpr: 1 },
    { w: 1024, h: 768, dpr: 2 },   // dragged to a Retina display: same CSS size, 2x store
    { w: 1920, h: 1080, dpr: 2 },
    { w: 800, h: 600, dpr: 1 },
  ];

  for (const { w, h, dpr } of sizes) {
    setDevicePixelRatio(dpr);
    renderer.setPixelRatio(Math.min(dpr, 1)); // engine applies the cap before calling us
    renderer.setSize(w, h);
    P.resize(w, h);

    const s = P.getState();
    const effW = Math.round(w * s.pixelRatio), effH = Math.round(h * s.pixelRatio);
    const tag = `${w}x${h}@${dpr}`;
    eq(`${tag}: effective width`, s.size.width, effW);
    eq(`${tag}: effective height`, s.size.height, effH);
    eq(`${tag}: composer width`, s.composer.width, effW);
    eq(`${tag}: composer height`, s.composer.height, effH);
    eq(`${tag}: grade width`, s.grade.width, effW);
    eq(`${tag}: SMAA width`, s.smaa.width, effW);
    eq(`${tag}: AO width`, s.broadAO.width, Math.max(2, Math.round(effW * AO_SCALE)));
    eq(`${tag}: AO height`, s.broadAO.height, Math.max(2, Math.round(effH * AO_SCALE)));
    eq(`${tag}: contact on same target`, `${s.contactAO.width}x${s.contactAO.height}`,
      `${s.broadAO.width}x${s.broadAO.height}`);
    eq(`${tag}: contact still shares g-buffer`, s.contactAO.sharesGBuffer, true);
    healthy(P);
  }

  // Continuous resize (a drag) must stay consistent every step, not just at the end.
  for (let w = 900; w <= 1400; w += 37) {
    renderer.setSize(w, Math.round(w * 0.6));
    P.resize(w, Math.round(w * 0.6));
  }
  healthy(P);
  eq('chain intact after a resize sweep', P.getState().chain.length, 7);

  // Invalid sizes are rejected and leave the previous geometry intact.
  const before = P.getState();
  P.resize(NaN, 720);
  P.resize(0, 720);
  P.resize(1280, -1);
  const after = P.getState();
  eq('invalid resize: size unchanged', `${after.size.width}x${after.size.height}`,
    `${before.size.width}x${before.size.height}`);
  eq('invalid resize: composer unchanged', after.composer.width, before.composer.width);
  check('invalid resize: lastError recorded',
    after.lastError && after.lastError.method === 'resize', fmt(after.lastError));
  healthy(P);
});

// ===========================================================================
// E. AA switching — rebuild the chain, drop temporal history
// ===========================================================================
scenario('E. AA mode rebuilds the chain and never reuses stale accumulation', () => {
  const { P } = boot({ width: 1600, height: 900, dpr: 2 });

  // rapid switching: the timing case the report calls out. Each transition must
  // land on a fully-formed chain, with no SMAA left installed under TAA.
  for (let i = 0; i < 6; i++) {
    P.setAA('taa');
    let s = P.getState();
    eq(`taa #${i}: mode`, s.aa, 'taa');
    eq(`taa #${i}: chain starts with taa`, s.chain[0], 'taa');
    check(`taa #${i}: no smaa pass in chain`, !s.chain.includes('smaa'), s.chain.join('>'));
    eq(`taa #${i}: smaa disabled`, s.smaa.enabled, false);
    eq(`taa #${i}: no accumulation queued`, s.taa.accumulateIndex, -1);
    eq(`taa #${i}: not accumulating`, s.taa.accumulating, false);
    eq(`taa #${i}: AO size still half`, s.broadAO.width, 800);
    healthy(P);

    P.setAA('smaa');
    s = P.getState();
    eq(`smaa #${i}: mode`, s.aa, 'smaa');
    eq(`smaa #${i}: chain starts with render`, s.chain[0], 'render');
    check(`smaa #${i}: no taa pass in chain`, !s.chain.includes('taa'), s.chain.join('>'));
    eq(`smaa #${i}: smaa re-enabled`, s.smaa.enabled, true);
    eq(`smaa #${i}: smaa target sized`, s.smaa.width, 1600);
    healthy(P);
  }

  // Switching to the SAME mode must be a no-op (no needless rebuild/thrash).
  const same = P.getState();
  P.setAA('smaa');
  eq('same-mode switch keeps the chain', P.getState().chain.join('>'), same.chain.join('>'));
  healthy(P);

  // Unknown AA is rejected, leaving the chain exactly as it was.
  P.setAA('taa');
  const before = P.getState();
  P.setAA('msaa');
  const after = P.getState();
  eq('bogus AA: mode unchanged', after.aa, before.aa);
  eq('bogus AA: chain unchanged', after.chain.join('>'), before.chain.join('>'));
  check('bogus AA: lastError recorded',
    after.lastError && after.lastError.method === 'setAA', fmt(after.lastError));
  healthy(P);
  P.setAA('smaa');
});

// ===========================================================================
// F. Interleaved stress — resize during TAA, tier change during resize
// ===========================================================================
scenario('F. interleaved resize x AA x quality keeps every invariant', () => {
  const { P, renderer } = boot({ width: 1280, height: 720, dpr: 1 });
  const seq = [
    () => P.setAA('taa'),
    () => { renderer.setSize(1000, 700); P.resize(1000, 700); },
    () => P.setQuality('high'),
    () => P.setAA('smaa'),
    () => P.setQuality('medium'),
    () => { setDevicePixelRatio(2); renderer.setPixelRatio(1); P.resize(1000, 700); },
    () => P.setAA('taa'),
    () => P.setQuality('ultra'),
    () => { renderer.setSize(1440, 810); P.resize(1440, 810); },
    () => P.setAA('smaa'),
  ];
  for (let i = 0; i < seq.length; i++) {
    seq[i]();
    const errs = P.selfTest();
    check(`step ${i + 1} invariant`, errs.length === 0, errs.join(' | '));
  }
  const s = P.getState();
  eq('final quality', s.quality, 'ultra');
  eq('final aa', s.aa, 'smaa');
  eq('final AO half of effective', s.broadAO.width, Math.round(s.size.width * AO_SCALE));
  healthy(P);

  // The oracle is not vacuous — it must CATCH a real desync.
  const gtao = P.composer.passes.find((p) => p === World.pipeline.composer.passes[1]);
  eq('sanity: step-2 pass is broad AO', gtao.width, s.broadAO.width);
  const saved = gtao.width;
  gtao.width = saved + 7;              // hand-corrupt, as a half-applied resize would
  const caught = P.selfTest();
  check('oracle catches a corrupted AO size', caught.length > 0, fmt(caught));
  gtao.width = saved;
  healthy(P);
});

// ===========================================================================
// G. Sample-tier API hygiene
// ===========================================================================
scenario('G. setAOSamples drives both passes and rejects out-of-range values', () => {
  const { P } = boot({ width: 1280, height: 720, dpr: 1 });
  for (const n of [1, 8, 16, 24, 32]) {
    P.setAOSamples(n);
    const s = P.getState();
    eq(`samples ${n}: broad`, s.broadAO.samples, n);
    eq(`samples ${n}: contact`, s.contactAO.samples, n);
    healthy(P);
  }
  for (const bad of [0, -4, 33, NaN, 'nine', null]) {
    const before = P.getState().broadAO.samples;
    P.setAOSamples(bad);
    const after = P.getState();
    eq(`samples ${fmt(bad)}: rejected`, after.broadAO.samples, before);
    check(`samples ${fmt(bad)}: error recorded`,
      after.lastError && after.lastError.method === 'setAOSamples', fmt(after.lastError));
    healthy(P);
  }
});

// ===========================================================================
// H. Booting straight into a non-default tier keeps both AO counts matched
// ===========================================================================
scenario('H. boot honours a non-ultra QUALITY level without desyncing AO samples', () => {
  const saved = QUALITY.level;
  QUALITY.level = 'high';
  try {
    const { P } = boot({ width: 1280, height: 720, dpr: 1 });
    const s = P.getState();
    eq('booted into high', s.quality, 'high');
    eq('broad samples from tier', s.broadAO.samples, 9);
    eq('contact samples matched to broad', s.contactAO.samples, 9);
    eq('broad on', s.broadAO.enabled, true);
    eq('contact on', s.contactAO.enabled, true);
    healthy(P);
  } finally {
    QUALITY.level = saved;
  }
});

// ===========================================================================
// Report
// ===========================================================================
const failed = results.filter((r) => r.failures.length);
const totalChecks = results.reduce((n, r) => n + r.checks, 0);
console.log('');
if (failed.length) {
  console.log(`FAILED — ${failed.length}/${results.length} scenarios, ` +
    `${failed.reduce((n, r) => n + r.failures.length, 0)} failed checks of ${totalChecks}`);
  process.exitCode = 1;
} else {
  console.log(`OK — ${results.length} scenarios, ${totalChecks} checks`);
}
