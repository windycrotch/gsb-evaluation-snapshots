// The serialisable game state and the brew pot state. Pure data + tiny helpers.
import { POTION_ORDER, BREW } from './data.js';
import { createPotState } from './brew-logic.js';

export const SAVE_VERSION = 1;

export function createState() {
  return {
    v: SAVE_VERSION,
    // 'title' | 'play' | 'brew' | 'book' | 'pause' | 'cutscene' | 'photo' | 'dead'
    mode: 'title',
    time: { day: 1, hour: 8.25 },
    player: { hp: 100, hpMax: 100, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, levity: 0, regen: 0 },
    inv: {
      ingredients: {}, // id -> count
      potions: {}, // id -> count
      selected: null, // potion id in hand
      primes: { salt: false, mercury: false, sulfur: false },
      stone: false,
    },
    known: {
      ingredients: {}, // seen at least once
      potions: {}, // brewed at least once
      charted: {}, // region inked on the chart (by lore or by brewing)
      lore: {}, // pages read
      lanterns: {}, // lanterns of the dead that have been lit
      regions: {},
    },
    quest: { stage: 'arrive', gathered: 0 },
    world: {
      gloom: { saltwood: 1, mere: 1, scar: 1 }, // 1 = under the Gloom, 0 = lifted
      flags: {}, // one-off world changes, e.g. 'bramble:gate': true
      picked: {}, // plant id -> game-seconds when it regrows
      athanor: 0, // 0 cold, 1 pilot flame, 2 relit by the Stone
      clock: 0, // total game seconds
    },
    stats: { seconds: 0, brewed: 0, thrown: 0, deaths: 0, picked: 0 },
  };
}

/**
 * State of the cauldron — one re-entrant pot of work. Its canonical shape and every rule live in
 * brew-logic.js (Node-testable); this thin wrapper keeps the name the rest of the game already
 * uses. The pot IS saved: walking away and coming back restores heat, stirring credit and contents.
 */
export function createBrew() {
  return createPotState();
}

export const count = (bag, id) => bag[id] || 0;
export function add(bag, id, n = 1, max = Infinity) {
  const v = Math.max(0, Math.min(max, (bag[id] || 0) + n));
  if (v === 0) delete bag[id];
  else bag[id] = v;
  return v;
}
export function hasAllPrimes(state) {
  const p = state.inv.primes;
  return p.salt && p.mercury && p.sulfur;
}
export function primeCount(state) {
  const p = state.inv.primes;
  return (p.salt ? 1 : 0) + (p.mercury ? 1 : 0) + (p.sulfur ? 1 : 0);
}
/** Potions the player currently carries, in belt order. */
export function beltOf(state) {
  return POTION_ORDER.filter((id) => (state.inv.potions[id] || 0) > 0);
}
export function canCarryMore(state, potionId) {
  return (state.inv.potions[potionId] || 0) < BREW.maxCarry;
}
