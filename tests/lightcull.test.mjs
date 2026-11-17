/**
 * Point-light budget — acceptance tests for src/render/lightcull.js.
 *
 * These drive the REAL module against a REAL THREE.Scene / PerspectiveCamera and a stub
 * renderer, so they exercise the production cull path (frustum tests, scoring, shadow
 * pinning, rung padding, prewarm) rather than a re-implementation of it.
 *
 * Run with:  npm test        (node --test tests/)
 *
 * Covered:
 *   normal    budget 20 -> ladder [12,16,20]; shown === rung === a rung <= 20, every frame
 *   boundary  budget < 12 (incl. 1) -> exactly one rung, never empty, shown <= budget
 *   negative  budget 0 / NaN / -5 / Infinity -> uncapped (lossless) ladder
 *   shadows   a shadow caster is visible at every budget, including budget 1; only
 *             non-shadow lights are counted in droppedInFrustum
 *   prewarm   only effective rungs are warmed, through World.pipeline.render (never
 *             renderer.render), and every light's original `visible` is restored
 *   toggle    disabling restores active lights and resets lastRung so re-enabling
 *             re-selects a rung from live demand
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import lightcull from '../src/render/lightcull.js';
import { World } from '../src/core/world.js';
import { CFG } from '../src/core/config.js';

const ALL_RUNGS = [12, 16, 20, 24, 28, 34];

/** The public surface the game (F3, main.js) talks to: World.lightCull. */
function api() { return World.lightCull; }

/* ------------------------------------------------------------------ harness */

/**
 * Point the module at a fresh scene. `composer: false` removes World.pipeline, which is
 * the composer-absent path prewarm must refuse to warm against. `budget` is written to
 * CFG before init so the boot path (CFG.graphics.lightBudget -> ladder) is what is tested.
 */
function setup({ composer = true, budget = null } = {}) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 1, 300);
  camera.position.set(0, 2, 0);
  camera.lookAt(0, 2, -1);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  const renderer = {
    info: { programs: { length: 0 } },
    compileCalls: 0,
    renderCalls: 0,
    compile() { this.compileCalls++; },
    render() { this.renderCalls++; },
  };
  const pipeline = { renderCalls: 0, render() { this.renderCalls++; } };
  World.pipeline = composer ? pipeline : null;
  CFG.graphics.lightBudget = budget;

  lightcull.init({ scene, camera, renderer, THREE, World, CFG });
  return { scene, camera, renderer, pipeline };
}

function addLight(scene, { x = 0, y = 2, z = -6, intensity = 100, distance = 30, castShadow = false, decay = 2 } = {}) {
  const l = new THREE.PointLight(0xffffff, intensity, distance, decay);
  l.position.set(x, y, z);
  l.castShadow = castShadow;
  l.visible = false;                    // pools create slots hidden; the cull owns them
  scene.add(l);
  return l;
}

/** `n` in-frustum lights with strictly descending irradiance (nearer = brighter). */
function addDemand(scene, n, { shadow = false } = {}) {
  const lights = [];
  for (let i = 0; i < n; i++) {
    lights.push(addLight(scene, {
      x: (i % 5) - 2, y: 2, z: -4 - i * 0.35,
      intensity: 400 - i * 5, distance: 30,
      castShadow: shadow && i === 0,
    }));
  }
  return lights;
}

/** Out-of-frustum lights, so a capped rung still has padding available. */
function addOffstage(scene, n) {
  const lights = [];
  for (let i = 0; i < n; i++) {
    // distance 2 -> the influence sphere stays outside the frustum at x = 200.
    lights.push(addLight(scene, { x: 200 + i, y: 2, z: -6, intensity: 50, distance: 2 }));
  }
  return lights;
}

function visibleCount(scene) {
  let n = 0;
  scene.traverse((o) => { if (o.isPointLight && o.visible) n++; });
  return n;
}

/** Run one cull frame and return a stats snapshot plus the frame's invariant check. */
function step() {
  lightcull.frame();
  return api().stats;
}

/* ------------------------------------------------------- ladder construction */

test('budget 20 keeps only rungs at or below the cap', () => {
  // The config is the boot path: init() must read CFG.graphics.lightBudget.
  setup({ budget: 20 });
  assert.deepEqual(api().rungs, [12, 16, 20]);
  assert.equal(api().stats.budget, 20);
});

test('a budget below the smallest rung keeps exactly one usable rung', () => {
  setup();
  // 1 is the acceptance case; 5 and 11 are the gap between "below the ladder" and "on it".
  for (const cap of [1, 2, 5, 11]) {
    api().setBudget(cap);
    assert.deepEqual(api().rungs, [cap], `cap ${cap} must leave one rung`);
    assert.ok(api().rungs.length >= 1, 'ladder must never be empty');
    assert.ok(api().rungs.every((r) => r <= cap), 'no rung may exceed the cap');
  }
});

test('a fractional budget floors into a whole-light rung', () => {
  setup();
  api().setBudget(0.5);
  assert.deepEqual(api().rungs, [1]);
  api().setBudget(6.9);
  assert.deepEqual(api().rungs, [6]);
});

test('non-positive, non-finite or absent budgets mean uncapped', () => {
  setup();
  for (const cap of [null, 0, -5, NaN, Infinity, '20']) {
    api().setBudget(cap);
    assert.deepEqual(api().rungs, ALL_RUNGS, `cap ${String(cap)} must be lossless`);
  }
});

/* --------------------------------------------------------- normal-path cull */

test('budget 20 never selects a rung above 20 and shown always equals rung', () => {
  const { scene } = setup();
  CFG.graphics.lightBudget = null;
  api().setBudget(20);
  assert.deepEqual(api().rungs, [12, 16, 20]);

  // One shadow caster among the demand, plus offstage padding.
  const demand = addDemand(scene, 40, { shadow: true });
  addOffstage(scene, 40);

  const first = api().stats.offRung;
  for (let n = 1; n <= 40; n++) {
    // Toggle demand by making lights above `n` non-emitting.
    for (let i = 0; i < demand.length; i++) demand[i].intensity = i < n ? 400 - i * 5 : 0;
    api().invalidate();
    const s = step();

    assert.ok([12, 16, 20].includes(s.rung), `rung ${s.rung} outside capped ladder at demand ${n}`);
    assert.ok(s.rung <= 20, `rung ${s.rung} exceeded budget at demand ${n}`);
    assert.equal(s.shown, s.rung, `shown !== rung at demand ${n}`);
    assert.equal(s.offRung, first, `offRung accumulated at demand ${n}`);
  }
});

test('shown is exact on the uncapped ladder too (losslessness preserved)', () => {
  const { scene } = setup();
  api().setBudget(null);
  const demand = addDemand(scene, 34, { shadow: true });
  addOffstage(scene, 20);
  const first = api().stats.offRung;
  for (let n = 1; n <= 34; n++) {
    for (let i = 0; i < demand.length; i++) demand[i].intensity = i < n ? 400 - i * 5 : 0;
    api().invalidate();
    const s = step();
    assert.ok(ALL_RUNGS.includes(s.rung));
    assert.equal(s.shown, s.rung);
    assert.equal(s.offRung, first);
  }
});

/* -------------------------------------------------------------- boundaries */

test('budget 1 yields one rung, one shown light, and does not throw', () => {
  const { scene } = setup();
  api().setBudget(1);
  assert.deepEqual(api().rungs, [1]);
  const demand = addDemand(scene, 20, { shadow: true });
  addOffstage(scene, 20);
  const shadow = demand[0];

  const s = step();
  assert.equal(s.rung, 1);
  assert.equal(s.shown, 1, 'exactly one light is submitted at budget 1');
  assert.equal(visibleCount(scene), 1);
  assert.equal(shadow.visible, true, 'the shadow caster takes the single slot');
  assert.equal(s.droppedInFrustum, 19, 'the other 19 in-frustum lights are counted');
});

test('a scene with no shadow caster still fills the budget with the brightest lights', () => {
  const { scene } = setup();
  api().setBudget(1);
  const demand = addDemand(scene, 6);
  addOffstage(scene, 6);
  const s = step();
  assert.equal(s.shown, 1);
  assert.equal(s.rung, 1);
  // Brightest = nearest = demand[0] (score intensity/dist^2, both descending in i).
  assert.equal(demand[0].visible, true);
  for (let i = 1; i < demand.length; i++) assert.equal(demand[i].visible, false);
  assert.equal(s.droppedInFrustum, 5);
});

/* ---------------------------------------------------------------- shadows */

test('the shadow caster is never culled, at any budget, even out of frustum', () => {
  for (const cap of [1, 5, 12, 16, 20, null]) {
    const { scene } = setup();
    api().setBudget(cap);
    // The shadow caster sits well outside the frustum: it must still be shown.
    const shadow = addLight(scene, { x: 400, y: 2, z: -6, intensity: 900, distance: 3, castShadow: true });
    addDemand(scene, 30);
    addOffstage(scene, 30);

    const s = step();
    assert.equal(shadow.visible, true, `shadow hidden at cap ${String(cap)}`);
    assert.equal(s.shown, s.rung, `shown !== rung at cap ${String(cap)}`);
  }
});

test('droppedInFrustum counts only non-shadow lights pushed out by the budget', () => {
  const { scene } = setup();
  api().setBudget(12);
  const demand = addDemand(scene, 20, { shadow: true });
  addOffstage(scene, 20);
  const shadow = demand[0];

  const s = step();
  assert.equal(s.rung, 12);
  assert.equal(s.shown, 12);
  assert.equal(shadow.visible, true);
  // 20 in frustum, one of them protected; the shadow takes one of the 12 slots, so
  // 19 compete for 11 and exactly 8 are dropped — and none of them is the shadow.
  assert.equal(s.droppedInFrustum, 8);
  let visibleNonShadow = 0;
  for (const l of demand) if (l !== shadow && l.visible) visibleNonShadow++;
  assert.equal(visibleNonShadow, 11);
});

test('a spent pool slot holding the shadow flag does not force six empty cube faces', () => {
  const { scene } = setup();
  api().setBudget(20);
  const spentShadow = addLight(scene, { intensity: 0, distance: 20, castShadow: true });
  addDemand(scene, 30);
  addOffstage(scene, 30);

  step();
  // Not emitting -> parked, not a live shadow caster. With enough padding to reach the
  // rung the parked slot stays hidden; if it is ever needed for the count it is used.
  assert.equal(spentShadow.visible, false);
});

/* ----------------------------------------------------------------- prewarm */

test('prewarm compiles only the effective rungs, through the composer', () => {
  const { scene, renderer, pipeline } = setup();
  api().setBudget(20);
  addDemand(scene, 40, { shadow: true });
  addOffstage(scene, 20);
  // Deliberately odd visible flags, to prove prewarm restores rather than "fixes" them.
  const original = [];
  scene.traverse((o) => { if (o.isPointLight) { o.visible = original.length % 3 === 0; original.push({ l: o, v: o.visible }); } });

  const res = api().prewarm();

  assert.deepEqual(res.rungs, [12, 16, 20]);
  assert.equal(renderer.compileCalls, 3, 'one compile per effective rung, no more');
  assert.equal(pipeline.renderCalls, 3, 'renders must go through the composer');
  assert.equal(renderer.renderCalls, 0, 'never render straight to the canvas (colour space)');
  for (const { l, v } of original) assert.equal(l.visible, v, 'original visible flags restored');
});

test('prewarm keeps the shadow caster in the first N for every rung', () => {
  // The composer stub records which lights were visible on each prewarm render. Every rung
  // must include the shadow caster, because `numPointShadows` is part of the program key and
  // the cull never hides it — otherwise the prewarmed variant is not the one the game uses.
  const { scene, pipeline } = setup();
  api().setBudget(20);
  // Add the shadow caster LAST so a naive "as collected" order would miss it.
  addDemand(scene, 20);
  const shadow = addLight(scene, { x: 0, y: 2, z: -6, intensity: 500, distance: 30, castShadow: true });

  const seen = [];
  pipeline.render = () => {
    let visible = 0, shadowVisible = false;
    scene.traverse((o) => {
      if (!o.isPointLight || !o.visible) return;
      visible++;
      if (o === shadow) shadowVisible = true;
    });
    seen.push({ visible, shadowVisible });
  };

  api().prewarm();
  assert.equal(seen.length, 3, 'one render per rung');
  for (const r of seen) {
    assert.equal(r.shadowVisible, true, 'the shadow caster must be visible in every prewarmed rung');
  }
});

test('prewarm refuses to warm without a composer instead of using the wrong colour space', () => {
  const { scene, renderer, pipeline } = setup({ composer: false });
  api().setBudget(20);
  addDemand(scene, 20, { shadow: true });
  const original = [];
  scene.traverse((o) => { if (o.isPointLight) { o.visible = original.length % 2 === 0; original.push({ l: o, v: o.visible }); } });

  const res = api().prewarm();
  assert.equal(res.skipped, 'no-composer');
  assert.equal(renderer.renderCalls, 0);
  assert.equal(pipeline.renderCalls, 0);
  for (const { l, v } of original) assert.equal(l.visible, v, 'visible flags restored on the bail-out path');
});

test('prewarm after a runtime budget change warms the new ladder', () => {
  const { scene, renderer, pipeline } = setup();
  api().setBudget(null);
  addDemand(scene, 34, { shadow: true });
  const full = api().prewarm();
  assert.deepEqual(full.rungs, ALL_RUNGS);
  assert.equal(pipeline.renderCalls, ALL_RUNGS.length);

  api().setBudget(1);
  const capped = api().prewarm();
  assert.deepEqual(capped.rungs, [1]);
  assert.equal(renderer.compileCalls, ALL_RUNGS.length + 1);
  assert.equal(pipeline.renderCalls, ALL_RUNGS.length + 1);
});

/* ------------------------------------------------------------------ toggles */

test('disabling restores active lights and re-enabling re-selects a rung', () => {
  const { scene } = setup();
  api().setBudget(null);                 // full ladder, so a rung CHANGE is observable
  const demand = addDemand(scene, 20, { shadow: true });
  addOffstage(scene, 20);
  const parked = addLight(scene, { intensity: 0, distance: 10 });

  assert.equal(step().rung, 20);
  assert.ok(demand.some((l) => l.visible));
  assert.equal(parked.visible, false);

  api().setEnabled(false);
  assert.equal(api().enabled, false);
  for (const l of demand) {
    if (l.intensity > 1e-3) assert.equal(l.visible, true, 'active light hidden while culling is off');
  }
  assert.equal(parked.visible, false, 'a spent slot stays hidden');

  // While disabled, `frame()` must not touch visibility.
  const before = demand.map((l) => l.visible);
  lightcull.frame();
  assert.deepEqual(demand.map((l) => l.visible), before);

  // Demand falls while culling is off. Re-enabling must re-derive the rung from the NEW
  // demand (16), not inherit the 20 that was current when it was switched off.
  for (let i = 0; i < demand.length; i++) demand[i].intensity = i < 16 ? 300 - i : 0;
  const changesBefore = api().stats.rungChanges;
  api().setEnabled(true);
  const s = step();
  assert.equal(s.rung, 16, 'the rung follows live demand after re-enabling');
  assert.equal(s.shown, s.rung);
  assert.ok(api().stats.rungChanges > changesBefore, 'lastRung was reset, so the selection counts');
});

test('re-enabling after a demand drop selects the lower rung, not the stale one', () => {
  const { scene } = setup();
  api().setBudget(null);
  const demand = addDemand(scene, 20, { shadow: true });
  addOffstage(scene, 20);

  assert.equal(step().rung, 20);
  api().setEnabled(false);

  // Demand collapses while culling is off (the shadow keeps a slot).
  for (const l of demand) l.intensity = l.castShadow ? 300 : 0;
  api().setEnabled(true);
  const s = step();
  assert.equal(s.rung, 12, 'smallest rung that fits the new demand');
  assert.equal(s.shown, s.rung);
});

/* ------------------------------------------------------- invalid view matrix */

test('a non-finite view matrix bails out instead of silently shading every light', () => {
  const { scene, camera } = setup();
  api().setBudget(20);
  addDemand(scene, 10);
  const s0 = step();
  assert.ok(s0.shown > 0);
  const visibleBefore = visibleCount(scene);

  camera.projectionMatrix.elements[0] = NaN;
  lightcull.frame();
  assert.equal(visibleCount(scene), visibleBefore, 'visibility untouched when the cull bails');
});
