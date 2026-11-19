// Pure cauldron logic: the single pot state every view and rule shares, and every transition it
// can make. No three.js, no DOM, no audio — plain data in, plain data out — so the whole life of a
// brew can be driven and checked from Node (see tests/brew-logic.test.mjs). The 3D Brewing class
// and the brew overlay both read and mutate THIS state; neither keeps progress of its own.
//
// A brew is one re-entrant pot of work:
//   addIngredient  -> the ordered mix point moves toward the new material
//   stepFire       -> the fire only rises while the bellows are held, only falls faster while the
//                     damper is held, and otherwise cools on its own (the "release" rule)
//   applyStirAngle -> signed ladle travel; binding only advances on a COMPLETE revolution, and the
//                     accumulated travel lives in the pot, so leaving and coming back never
//                     resets or doubles it
//   beginBottle / updateBottle / cancelBottle -> the two-phase, all-or-nothing bottling action
//   serializeBrew / restoreBrew -> the pot is part of the save
import { INGREDIENTS, POTIONS, OPUS, BREW, PRIME_ORDER, mixOf, regionAt, yieldFor, heatFit } from './data.js';
import { clamp } from '../core/math.js';

export const BREW_SAVE_VERSION = 1;

// result codes from addIngredient / beginBottle, so callers can choose sound and feedback
export const ADD = {
  OK: 'ok',
  NOT_ACTIVE: 'not-active',
  NOT_HELD: 'not-held',
  PRIME_DUP: 'prime-duplicate',
  PRIME_MIXED: 'prime-mixed',
  HERB_WITH_PRIMES: 'herb-with-primes',
  READY: 'ready',
  OPUS: 'opus',
  FULL: 'full',
  UNKNOWN: 'unknown',
};
export const BOTTLE = {
  BEGUN: 'begun', // the action is now in flight
  BUSY: 'busy', // a bottling is already in flight (idempotent same-frame re-trigger)
  EMPTY: 'empty', // nothing in the pot
  NOT_BOUND: 'not-bound', // mixture outside its target region, or not stirred to binding
  CARRY_FULL: 'carry-full', // the belt already holds the maximum of that phial
  STONE_TAKEN: 'stone-taken', // the Great Work is finished: taking clears the pot, no phial
};

/** A fresh, empty, cold pot. This is the canonical shape; createBrew() in state.js re-exports it. */
export function createPotState() {
  return {
    v: BREW_SAVE_VERSION,
    active: false, // whether the brew view is open (transient; the work itself survives without it)
    contents: [], // ingredient ids in entry order, or 'prime:salt' | 'prime:mercury' | 'prime:sulfur'
    mix: null, // [s, m, k] ordered fold of contents, null when empty
    trail: [], // earlier mix points, oldest first
    fire: 0.0, // 0..1 how hard the fire burns (bellows)
    heat: 0.0, // 0..1 temperature of the liquid (lags the fire)
    region: null, // { id, dist, quality, stars } when the mix sits inside a potion region
    band: null, // [lo, hi] heat band of that region (or of the current Opus stage)
    fit: null, // -1 too cold, 0 right, +1 too hot, null when no region
    stir: 0, // 0..1 smoothed stirring speed, presentation only — never drives binding
    progress: 0, // 0..1 binding progress of the current stage / potion
    ready: null, // { potion, stars, count } once bound and waiting to be bottled
    opus: null, // { stage: 0..3, progress: 0..1, done: false } during the Great Work
    hint: '', // one short line for the UI
    // --- re-entrancy bookkeeping, all part of the saved pot ---
    stirBank: 0, // signed, in turns: ladle travel not yet spent on binding (kept across leave/save)
    bottle: null, // null, or { potion, count, t } while a bottling action is in flight
  };
}

const invCount = (bag, id) => (bag && bag[id]) || 0;
const invAdd = (bag, id, n, max = Infinity) => {
  const v = Math.max(0, Math.min(max, (bag[id] || 0) + n));
  if (v === 0) delete bag[id];
  else bag[id] = v;
  return v;
};

/** Recompute every derived field (mix point, region, band) from the ordered contents. */
export function recompute(pot) {
  const plain = pot.contents.filter((c) => !c.startsWith('prime:'));
  const m = mixOf(plain);
  pot.mix = m.bary;
  if (pot.opus) {
    pot.mix = OPUS.center.slice();
    pot.region = null;
    pot.band = OPUS.stages[Math.min(3, pot.opus.stage)].heat;
  } else {
    pot.region = pot.mix ? regionAt(pot.mix) : null;
    pot.band = pot.region ? POTIONS[pot.region.id].heat : null;
  }
  return pot;
}

/**
 * Put one material into the pot. Mutates the pot and, for ordinary ingredients, the inventory.
 * Primes are key items and are only marked consumed once the Work begins (as before).
 * Returns { code, id } ; `code === ADD.OK` means the pot changed.
 */
export function addIngredient(pot, inv, id) {
  if (!pot.active) return { code: ADD.NOT_ACTIVE, id };
  if (pot.ready) return { code: ADD.READY, id };
  if (pot.opus) return { code: ADD.OPUS, id };

  if (id.startsWith('prime:')) {
    const pid = id.slice(6);
    if (!inv.primes[pid] || inv.stone) return { code: ADD.NOT_HELD, id };
    if (pot.contents.includes(id)) return { code: ADD.PRIME_DUP, id };
    if (pot.contents.some((c) => !c.startsWith('prime:'))) return { code: ADD.PRIME_MIXED, id };
    pot.contents.push(id);
    let opusBegan = false;
    if (PRIME_ORDER.every((p) => pot.contents.includes('prime:' + p))) {
      // the three Primes together begin the Work
      pot.opus = { stage: 0, progress: 0, done: false };
      pot.progress = 0;
      pot.stirBank = 0;
      opusBegan = true;
    }
    recompute(pot);
    return { code: ADD.OK, id, opusBegan };
  }

  const ing = INGREDIENTS[id];
  if (!ing) return { code: ADD.UNKNOWN, id };
  if (invCount(inv.ingredients, id) <= 0) return { code: ADD.NOT_HELD, id };
  if (pot.contents.some((c) => c.startsWith('prime:'))) return { code: ADD.HERB_WITH_PRIMES, id };
  if (pot.contents.length >= BREW.capacity) return { code: ADD.FULL, id };

  invAdd(inv.ingredients, id, -1);
  if (pot.mix) {
    pot.trail.push(pot.mix.slice());
    if (pot.trail.length > 12) pot.trail.shift();
  }
  const was = pot.region && pot.region.id;
  pot.contents.push(id);
  recompute(pot);
  // a changed recipe does not inherit the old binding: a new region starts clean, the same region
  // keeps a bruised 40 % of its work
  if (!pot.region || pot.region.id !== was) pot.progress = 0;
  else pot.progress *= 0.6;
  pot.stirBank = 0;
  return { code: ADD.OK, id };
}

/**
 * One frame of fire. The fire changes ONLY from the two held controls:
 *   bellows held -> +0.55/s ; damper held -> -0.5/s ; neither -> natural cool at 0.045/s.
 * The liquid temperature eases toward the fire, so after release it keeps cooling on the same curve.
 */
export function stepFire(pot, dt, { bellows = false, damper = false } = {}) {
  pot.fire = clamp(pot.fire + (bellows ? 0.55 : 0) * dt - (damper ? 0.5 : 0.045) * dt, 0, 1);
  pot.heat += (pot.fire - pot.heat) * (1 - Math.exp(-0.55 * dt));
  return pot;
}

/**
 * Feed signed ladle travel (radians; positive and negative need not agree in sign between calls).
 * Travel is folded into stirBank in whole turns; only a COMPLETE revolution can later bind, and
 * the bank is saved with the pot so re-entering never resets or doubles it.
 * Returns the signed number of whole turns newly completed.
 */
export function applyStirAngle(pot, deltaRadians) {
  if (!deltaRadians) return 0;
  const before = pot.stirBank;
  pot.stirBank += deltaRadians / (Math.PI * 2);
  // whole turns crossed by this call, with the sign of the travel that crossed them
  const turns = Math.trunc(pot.stirBank) - Math.trunc(before);
  return turns;
}

/**
 * One frame of binding. Consumes completed ladle turns only while the heat sits in the band;
 * outside the band (or with no named mixture) no turn is spent and the work instead relaxes.
 * Returns { ready, stageAdvanced, opusDone } describing any transition made this frame.
 */
export function stepBinding(pot, dt) {
  const out = { ready: false, stageAdvanced: false, opusDone: false };
  if (pot.ready) {
    pot.fit = pot.band ? heatFit(pot.heat, pot.band) : null;
    return out;
  }
  if (pot.opus) return stepOpus(pot, dt, out);

  pot.fit = pot.band ? heatFit(pot.heat, pot.band) : null;
  if (pot.region && pot.contents.length) {
    if (pot.fit === 0) {
      if (pot.stirBank !== 0) {
        // each full revolution in the band is one bindTurns-th of the work
        const spend = Math.trunc(pot.stirBank);
        pot.stirBank -= spend;
        pot.progress = clamp(pot.progress + Math.abs(spend) / BREW.bindTurns, 0, 1);
      }
    } else {
      pot.progress = Math.max(0, pot.progress - dt * 0.07);
    }
    if (pot.progress >= 1) {
      pot.progress = 1;
      pot.ready = { potion: pot.region.id, stars: pot.region.stars, count: yieldFor(pot.region.stars) };
      pot.stirBank = 0;
      out.ready = true;
    }
  } else if (!pot.region) {
    pot.progress = Math.max(0, pot.progress - dt * 0.3);
  }
  return out;
}

function stepOpus(pot, dt, out) {
  const o = pot.opus;
  if (o.done) {
    pot.hint = 'The Stone.';
    return out;
  }
  const stage = OPUS.stages[o.stage];
  pot.band = stage.heat;
  pot.fit = heatFit(pot.heat, stage.heat);
  if (pot.fit === 0 && pot.stirBank !== 0) {
    const spend = Math.trunc(pot.stirBank);
    pot.stirBank -= spend;
    o.progress = clamp(o.progress + Math.abs(spend) / BREW.bindTurns, 0, 1);
  } else if (pot.fit !== 0) {
    o.progress = Math.max(0, o.progress - dt * 0.04);
  }
  pot.progress = o.progress;
  if (o.progress >= 1) {
    if (o.stage < 3) {
      o.stage++;
      o.progress = 0;
      pot.progress = 0;
      pot.stirBank = 0;
      recompute(pot);
      out.stageAdvanced = true;
    } else {
      o.done = true;
      o.progress = 1;
      pot.progress = 1;
      pot.stirBank = 0;
      out.opusDone = true;
    }
  }
  return out;
}

/**
 * Begin bottling. The check is the whole rule in one place: the pot must hold a bound, named
 * mixture (the mix point inside its target region AND stirred through to binding), and the belt
 * must have room. On success the action is recorded as in flight but changes NOTHING yet —
 * commitBottle() is the only thing that moves inventory and clears the pot.
 * Re-triggers while one is in flight return BOTTLE.BUSY and never settle twice.
 *
 * A finished Great Work has no phial: its Stone was already granted when opus.done flipped, so
 * "Take" just clears the spent pot straight away (BOTTLE.STONE_TAKEN), with no in-flight window.
 */
export function beginBottle(pot, inv) {
  if (pot.bottle) return { code: BOTTLE.BUSY, bottle: pot.bottle };
  if (pot.opus && pot.opus.done) {
    pot.contents = [];
    pot.trail = [];
    pot.opus = null;
    pot.ready = null;
    pot.progress = 0;
    pot.stirBank = 0;
    recompute(pot);
    return { code: BOTTLE.STONE_TAKEN };
  }
  if (!pot.contents.length) return { code: BOTTLE.EMPTY };
  if (!pot.ready) return { code: BOTTLE.NOT_BOUND };
  const { potion, count: n } = pot.ready;
  const have = invCount(inv.potions, potion);
  const got = Math.min(n, BREW.maxCarry - have);
  if (got <= 0) return { code: BOTTLE.CARRY_FULL, potion };
  pot.bottle = { potion, count: got, t: 0 };
  return { code: BOTTLE.BEGUN, bottle: pot.bottle };
}

/**
 * Advance an in-flight bottling. Returns the action record { potion, count, t } on the single
 * frame it becomes due (still recorded on the pot — nothing has moved yet), otherwise null.
 * The caller then settles it exactly once through commitBottle(pot, inv, stats).
 */
export function updateBottle(pot, dt) {
  const a = pot.bottle;
  if (!a) return null;
  a.t += dt;
  if (a.t < BREW.bottleSeconds) return null;
  return a;
}

/** Apply a finished bottling: inventory and stats once, then the pot is emptied once. */
export function commitBottle(pot, inv, stats) {
  const a = pot.bottle;
  if (!a) return null;
  invAdd(inv.potions, a.potion, a.count, BREW.maxCarry);
  if (stats) stats.brewed = (stats.brewed || 0) + a.count;
  if (inv && !inv.selected) inv.selected = a.potion;
  const done = { potion: a.potion, count: a.count };
  pot.bottle = null;
  pot.contents = [];
  pot.trail = [];
  pot.ready = null;
  pot.progress = 0;
  pot.stirBank = 0;
  recompute(pot);
  return done;
}

/** Abandon an in-flight bottling (the player left the pot): nothing applied, nothing lost. */
export function cancelBottle(pot) {
  if (!pot.bottle) return false;
  pot.bottle = null;
  return true;
}

/** Empty the pot by hand; the contents are spent (the inventory is not recredited). */
export function emptyPot(pot) {
  if (pot.opus && pot.opus.done) return false;
  if (!pot.contents.length) return false;
  cancelBottle(pot);
  pot.contents = [];
  pot.trail = [];
  pot.ready = null;
  pot.progress = 0;
  pot.stirBank = 0;
  pot.opus = null;
  recompute(pot);
  return true;
}

// -------------------------------------------------------------------------------- persistence
/** Plain JSON-ready copy of the pot. An in-flight bottling is deliberately dropped: a save can
 * never straddle the commit, so on reload that action simply never happened. */
export function serializeBrew(pot) {
  const json = {
    v: BREW_SAVE_VERSION,
    contents: pot.contents.slice(),
    trail: pot.trail.map((p) => p.slice()),
    fire: pot.fire,
    heat: pot.heat,
    stir: pot.stir,
    progress: pot.progress,
    ready: pot.ready ? { ...pot.ready } : null,
    opus: pot.opus ? { ...pot.opus } : null,
    hint: pot.hint,
    stirBank: pot.stirBank || 0,
    active: false, // the brew view is always closed inside a save
  };
  return json;
}

/**
 * Rebuild a pot from saved data, migrating older shapes and recomputing every derived field, so
 * heat, stirring credit and the materials in the pot are exactly what they were when saved.
 * Missing fields fall back to the fresh-pot defaults rather than throwing.
 */
export function restoreBrew(saved) {
  const pot = createPotState();
  if (saved && typeof saved === 'object') {
    if (Array.isArray(saved.contents)) pot.contents = saved.contents.slice();
    if (Array.isArray(saved.trail)) pot.trail = saved.trail.map((p) => p.slice());
    for (const k of ['fire', 'heat', 'stir', 'progress']) if (typeof saved[k] === 'number') pot[k] = saved[k];
    if (saved.ready && typeof saved.ready === 'object') pot.ready = { ...saved.ready };
    if (saved.opus && typeof saved.opus === 'object') pot.opus = { ...saved.opus };
    if (typeof saved.hint === 'string') pot.hint = saved.hint;
    if (typeof saved.stirBank === 'number') pot.stirBank = saved.stirBank;
    pot.fire = clamp(pot.fire, 0, 1);
    pot.heat = clamp(pot.heat, 0, 1);
    pot.progress = clamp(pot.progress, 0, 1);
  }
  pot.bottle = null; // never restored: see serializeBrew
  pot.active = false;
  recompute(pot);
  // a bound pot keeps its ready record; otherwise re-derive fit for the restored band
  pot.fit = pot.band ? heatFit(pot.heat, pot.band) : null;
  if (pot.opus) pot.progress = pot.opus.progress;
  return pot;
}
