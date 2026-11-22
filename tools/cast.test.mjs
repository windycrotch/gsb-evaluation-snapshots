// Local, reproducible checks for cast atomicity / cooldown real-time behaviour
// (combat.js). Run:  node tools/cast.test.mjs
//
// combat.js is a browser module (canvas for blood decals, three for vectors). We provide
// the smallest DOM/THREE shims it needs at import time, drive its real init(), and then
// assert the task's cast requirements directly against World.combat and the player:
//
//   - a REJECTED cast (global cooldown, per-skill cooldown, no mana) costs no mana and
//     advances no cooldown;
//   - an ACCEPTED cast charges mana exactly once and starts the cooldowns;
//   - cooldown remaining never goes negative and does not wedge;
//   - cooldowns advance in REAL time: while the freeze deadline is in the future, a
//     cooldown still elapses because it reads the same real clock, not sim time.
import assert from 'node:assert';

// ---- minimal DOM shim (only what combat.js touches at import/init) ----------------
globalThis.document = globalThis.document || {
  createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({
      clearRect() {}, fillRect() {}, beginPath() {}, arc() {}, fill() {},
      createRadialGradient() { return { addColorStop() {} }; },
      set fillStyle(_) {}, get fillStyle() { return ''; },
    }),
  }),
};
if (!globalThis.performance) globalThis.performance = { now: () => Date.now() };

// ---- controllable real clock ------------------------------------------------------
let NOW = 100;                         // real seconds
globalThis.performance.now = () => NOW * 1000;

const THREE = await import('three');
const { World } = await import('../src/core/world.js');
const { bus, EV } = await import('../src/core/events.js');
const { Clock } = await import('../src/core/clock.js');
const combatMod = await import('../src/combat/combat.js');

let fails = 0, passes = 0;
function ok(cond, msg) { if (cond) { passes++; } else { fails++; console.error('  FAIL: ' + msg); } }

// ---- fake scene / player ----------------------------------------------------------
const scene = new THREE.Scene();
World.scene = scene;
World.time = 0;
World.stats = { kills: 0, level: 1, xp: 0, xpNext: 525 };
const player = {
  id: 1, kind: 'player', faction: 'player',
  pos: new THREE.Vector3(0, 0, 0), vel: new THREE.Vector3(),
  radius: 0.42, height: 1.8, hp: 1200, maxHp: 1200,
  mana: 420, maxMana: 420, alive: true, facing: 0, stagger: 0, armour: 10,
  _iframesUntil: 0, hurt() {},
};
World.player = player; World.add(player);

// The clock is the real-time source of truth; install it like the Engine would.
const clock = new Clock(1 / 60, () => NOW);
World.clock = clock;

await combatMod.default.init({ scene, THREE, World, bus, EV });

// A HUD/listener capturing committed casts, to prove exactly one charge per accepted cast.
let committed = [];
bus.on('combat:castCommitted', (p) => committed.push(p));

const S = (id) => World.combat; // façade
const glyph = (id) => World.combat.cooldown(id);

// ---------------------------------------------------------------------------
// 1) An ACCEPTED cast charges mana once and starts the cooldown.
// ---------------------------------------------------------------------------
{
  NOW = 200; player.mana = 420;
  committed = [];
  const before = player.mana;
  const okCast = World.combat.cast('groundSlam');        // cost 30, cd 2.4
  ok(okCast === true, 'groundSlam casts when ready');
  assert.equal(player.mana, before - 30, 'mana charged exactly once (30)');
  ok(committed.length === 1, 'exactly one committed-cast signal');
  const cd = glyph('groundSlam');
  ok(cd.remain > 2.0 && cd.remain <= 2.41, `groundSlam cooldown started (~2.4s), got ${cd.remain}`);
}

// ---------------------------------------------------------------------------
// 2) A REJECTED cast on per-skill cooldown: no mana, no cooldown advance.
// ---------------------------------------------------------------------------
{
  const manaBefore = player.mana;
  const cdBefore = glyph('groundSlam').remain;
  NOW += 0.05;                                            // a hair later, still cooling
  committed = [];
  const okCast = World.combat.cast('groundSlam');
  ok(okCast === false, 'groundSlam rejected while on cooldown');
  assert.equal(player.mana, manaBefore, 'rejected cast spends NO mana');
  ok(committed.length === 0, 'rejected cast emits no committed signal');
  // Cooldown may have ELAPSED (real time), but must not have been pushed out.
  ok(glyph('groundSlam').remain <= cdBefore + 1e-9, 'rejected cast does not extend the cooldown');
}

// ---------------------------------------------------------------------------
// 3) Rejected on global cooldown (different skill, GCD still running): no spend.
// ---------------------------------------------------------------------------
{
  // Use a cheap instant skill right after a cast so GCD is active but its own cd isn't.
  NOW = 300; player.mana = 420;
  World.combat.cast('cleave');                             // free, sets GCD 0.22
  NOW += 0.05;                                             // still within GCD
  const manaBefore = player.mana;
  const cdBefore = glyph('fireball').remain;
  committed = [];
  const okCast = World.combat.cast('fireball');
  ok(okCast === false, 'fireball rejected inside the global cooldown');
  assert.equal(player.mana, manaBefore, 'GCD rejection spends NO mana (fireball costs 18)');
  ok(glyph('fireball').remain <= cdBefore + 1e-9, 'GCD rejection does not start fireball cooldown');
}

// ---------------------------------------------------------------------------
// 4) Rejected on insufficient mana: no spend, no cooldown.
// ---------------------------------------------------------------------------
{
  NOW = 400; player.mana = 5;                              // fireball needs 18
  const cdBefore = glyph('fireball').remain;
  committed = [];
  const okCast = World.combat.cast('fireball');
  ok(okCast === false, 'fireball rejected without mana');
  assert.equal(player.mana, 5, 'mana rejection leaves mana untouched');
  ok(glyph('fireball').remain <= cdBefore + 1e-9, 'mana rejection does not start cooldown');
}

// ---------------------------------------------------------------------------
// 5) Cooldown advances in REAL time even while the freeze deadline is in the future.
// ---------------------------------------------------------------------------
{
  NOW = 500; player.mana = 420;
  World.combat.cast('groundSlam');                        // starts a 2.4s cooldown
  clock.reset();
  clock.request(70);                                      // 70 ms freeze deadline
  ok(clock.frozen === true, 'clock reports frozen right after a 70 ms request');
  const cd0 = glyph('groundSlam').remain;
  NOW += 1.0;                                             // 1 real second passes
  const cd1 = glyph('groundSlam').remain;
  ok(Math.abs((cd0 - cd1) - 1.0) < 0.02, `cooldown elapsed ~1.0s of REAL time through the freeze (got ${(cd0 - cd1).toFixed(3)})`);
  ok(cd1 >= 0, 'cooldown remaining never negative');
}

// ---------------------------------------------------------------------------
// 6) After a level rebuild, cooldowns and the committed store are clean: a fresh cast
//    is immediately accepted and charged once.
// ---------------------------------------------------------------------------
{
  NOW = 600; player.mana = 420;
  World.combat.cast('groundSlam');                        // now on cooldown
  bus.emit(EV.LEVEL_READY, { level: {} });                // rebuild
  ok(glyph('groundSlam').remain === 0, 'cooldown table cleared on level rebuild');
  player.mana = 420;
  const before = player.mana;
  const okCast = World.combat.cast('groundSlam');
  ok(okCast === true, 'a cast is immediately available after a rebuild');
  assert.equal(player.mana, before - 30, 'post-rebuild cast charges exactly once');
}

// ---------------------------------------------------------------------------
console.log(`\n${passes} passed, ${fails} failed`);
if (fails) process.exit(1);
