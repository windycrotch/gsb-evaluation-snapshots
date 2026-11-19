// The rules of a brew, as pure functions over the brew state (src/game/state.js createBrew()).
// No three.js, no DOM, no audio: the cauldron, the chart, the UI readout and the headless check
// all decide what the pot holds from these same functions, so what is shown is what is poured.
//
//   recompute(brew)                     contents -> mix / region / band / fit
//   addToPot(brew, state, id)           put an ingredient (or a Prime) in the pot
//   applyHands(brew, dt, hands)         bellows, damper and the ladle; the fire falls back
//   advanceBinding(brew, dt)            binding progress and the moment a potion is ready
//   bottlePot(brew, state)              pour the bound potion; refuses everything else
//   emptyPot(brew)                      the whole pot back to nothing
//   clearPot(brew)                      the shared reset (content, fire, heat, stirring)
//   readout(brew)                       the one reading the UI shows and tests compare
//   RULES                               every rate of fire and ladle, named
//   NO_MATCH                            the word the overlay shows when no region holds the mark
import { INGREDIENTS, POTIONS, OPUS, BREW, PRIME_ORDER, mixOf, regionAt, yieldFor, heatFit } from './data.js';
import { clamp, damp } from '../core/math.js';

// Every number of the fire and the ladle lives here, so a test can explain a brew afterwards.
export const RULES = {
  pumpRate: 0.55, // fire gained per second at the bellows
  damperRate: 0.5, // fire lost per second under the closed damper
  coolRate: 0.045, // fire lost per second with neither hand: the coals fall back, they do not go out
  heatLag: 0.55, // how fast the pot follows the fire (1/s)
  stirRise: 5, // how fast the ladle answers the hand (1/s)
  stirFall: 2.2, // how fast it slows when the hand stops (1/s)
  stirToBind: 0.08, // below this the pot is not being stirred at all
  outOfBandDecay: 0.07, // binding lost per second when the heat has left the band
  outOfRegionDecay: 0.3, // binding lost per second when the mixture has no region at all
};

const isPrime = (x) => String(x).startsWith('prime:');
const r3 = (v) => Math.round(v * 1000) / 1000;
const fail = (reason) => ({ ok: false, reason });

/** The word the overlay shows when the mixture lies in no potion's region. */
export const NO_MATCH = 'No match';

/** What the pot holds now: mixture point, potion region (if any), its heat band and the fit. */
export function recompute(b) {
  const plain = b.contents.filter((c) => !isPrime(c));
  const m = mixOf(plain);
  if (b.opus) {
    b.mix = OPUS.center.slice();
    b.region = null;
    b.band = OPUS.stages[Math.min(3, b.opus.stage)].heat;
  } else {
    b.mix = m.bary;
    b.region = regionAt(b.mix);
    b.band = b.region ? POTIONS[b.region.id].heat : null;
  }
  b.fit = b.band ? heatFit(b.heat, b.band) : null;
  return b;
}

/**
 * Put something in the pot. Ingredients are weighed on the chart (each one pulls the mark toward
 * its own corner, and a second measure of the same herb pulls it again, so repeats accumulate).
 * The three Primes are not weighed: they begin the Great Work.
 * Returns { ok, reason?, id, prime?, opusStarted?, consumed? }.
 */
export function addToPot(b, st, id) {
  if (!b.active) return fail('The pot is not before you.');
  if (b.ready) return fail('Bottle what is bound first.');
  if (b.opus) return fail('The Work has begun. It wants nothing else.');
  if (isPrime(id)) {
    const pid = id.slice(6);
    if (!st.inv.primes[pid] || st.inv.stone) return fail('That Prime is not yours to spend.');
    if (b.contents.includes(id)) return fail('That Prime is already in the pot.');
    if (b.contents.some((c) => !isPrime(c))) return fail('Empty the pot first. The Work wants nothing else in it.');
    b.contents.push(id);
    let opusStarted = false;
    if (PRIME_ORDER.every((p) => b.contents.includes('prime:' + p))) {
      b.opus = { stage: 0, progress: 0, done: false };
      b.progress = 0;
      opusStarted = true;
    }
    recompute(b);
    return { ok: true, id, prime: pid, opusStarted };
  }
  const ing = INGREDIENTS[id];
  if (!ing) return fail('That is not an ingredient.');
  if (!(st.inv.ingredients[id] > 0)) return fail('You carry no ' + ing.name + '.');
  if (b.contents.some((c) => isPrime(c))) return fail('The Primes are in the pot. Nothing else goes with them.');
  if (b.contents.length >= BREW.capacity) return fail('The pot is full.');
  if (--st.inv.ingredients[id] <= 0) delete st.inv.ingredients[id];
  if (b.mix) b.trail.push(b.mix.slice());
  if (b.trail.length > 12) b.trail.shift();
  const was = b.region && b.region.id;
  b.contents.push(id);
  recompute(b);
  // a change of region starts the binding over; a fuller mixture of the same region keeps most of it
  if (!b.region || b.region.id !== was) b.progress = 0;
  else b.progress *= 0.6;
  return { ok: true, id, ingredient: ing };
}

/**
 * The hands for one frame. `stirIn` is 0..1 how hard the ladle is being circled; `pump` is the
 * bellows, `damp` the damper. The fire rises under the bellows and falls back by itself when the
 * hand is taken away; the pot's heat lags the fire, so nothing snaps to zero.
 */
export function applyHands(b, dt, hands = {}) {
  if (!(dt > 0)) return b;
  const stirIn = clamp(hands.stirIn || 0, 0, 1);
  const pump = !!hands.pump;
  const damper = !!hands.damp;
  b.stir = damp(b.stir, stirIn, stirIn > b.stir ? RULES.stirRise : RULES.stirFall, dt);
  b.fire = clamp(b.fire + (pump ? RULES.pumpRate : 0) * dt - (damper ? RULES.damperRate : RULES.coolRate) * dt, 0, 1);
  b.heat += (b.fire - b.heat) * (1 - Math.exp(-RULES.heatLag * dt));
  return b;
}

/**
 * Binding: it grows only while the heat is inside the band of the target potion and the ladle is
 * moving, and it decays slowly when the fire has left the band. Returns the new {potion, stars,
 * count} the moment the pot is bound, otherwise null. The Great Work runs its own four stages.
 */
export function advanceBinding(b, dt) {
  if (b.opus) return null;
  b.fit = b.band ? heatFit(b.heat, b.band) : null;
  if (b.region && !b.ready && b.contents.length) {
    if (b.fit === 0) {
      if (b.stir > RULES.stirToBind) b.progress = Math.min(1, b.progress + (dt / BREW.bindSeconds) * (0.3 + b.stir));
    } else b.progress = Math.max(0, b.progress - dt * RULES.outOfBandDecay);
    if (b.progress >= 1) {
      b.progress = 1;
      b.ready = { potion: b.region.id, stars: b.region.stars, count: yieldFor(b.region.stars) };
      return { ...b.ready };
    }
  } else if (!b.region) b.progress = Math.max(0, b.progress - dt * RULES.outOfRegionDecay);
  return null;
}

/**
 * Pour the pot. It succeeds only when something is bound and the mixture still lies in that
 * potion's region; otherwise nothing is produced and a reason comes back for the player to read.
 * A pour empties the pot: contents, fire, heat and stirring all go back to nothing.
 */
export function bottlePot(b, st) {
  if (b.opus) return fail(b.opus.done ? 'The Stone is taken from the pot, not poured.' : 'The Work is not finished.');
  if (!b.contents.length) return fail('The pot is empty. There is nothing to bottle.');
  if (!b.region) {
    b.ready = null;
    b.progress = 0;
    return fail('The mixture is in no region of the chart. It makes no potion.');
  }
  if (!b.ready) return fail('It has not bound yet. Keep the fire in its band and stir.');
  // the mixture must still be where the binding happened: if anything has moved the mark out of
  // the bound potion's region since (a further herb, or a region the pot has left), it must bind again
  const where = regionAt(b.mix);
  if (!where || where.id !== b.ready.potion) {
    b.ready = null;
    b.progress = 0;
    b.region = where;
    b.band = where ? POTIONS[where.id].heat : null;
    b.fit = b.band ? heatFit(b.heat, b.band) : null;
    return fail('The mixture has moved. It must bind again.');
  }
  const potion = b.ready.potion;
  const stars = b.ready.stars;
  const have = st.inv.potions[potion] || 0;
  const count = Math.min(b.ready.count, BREW.maxCarry - have);
  if (count <= 0) return fail('You cannot carry more ' + POTIONS[potion].name + '.');
  st.inv.potions[potion] = have + count;
  st.stats.brewed += count;
  const first = !st.known.potions[potion];
  st.known.potions[potion] = true;
  st.known.charted[potion] = true;
  if (!st.inv.selected) st.inv.selected = potion;
  const out = { ok: true, potion, stars, count, first, total: st.inv.potions[potion] };
  clearPot(b);
  return out;
}

/**
 * Empty the pot. This is the one reset: what was put in, how hot the pot was and how far the
 * ladle had stirred it all go back to nothing. Refused once the Stone is made.
 */
export function emptyPot(b) {
  if (b.opus && b.opus.done) return fail('The Stone is in the pot. It is not yours to throw away.');
  const had = b.contents.length;
  clearPot(b);
  return { ok: true, had };
}

/** The shared reset. `active` is left alone: whether you are standing at the pot is not a brew. */
export function clearPot(b) {
  b.contents = [];
  b.trail = [];
  b.mix = null;
  b.region = null;
  b.band = null;
  b.fit = null;
  b.fire = 0;
  b.heat = 0;
  b.stir = 0;
  b.progress = 0;
  b.ready = null;
  b.opus = null;
  b.hint = '';
  return b;
}

/**
 * One reading of the pot, in the words and numbers the overlay shows. `matched` says whether the
 * mixture lies in a potion region; `output` is what a pour would give right now (null if nothing).
 * The overlay displays this and the headless check asserts on it, so the two cannot drift apart.
 */
export function readout(b) {
  const region = b.region;
  const fit = b.band ? heatFit(b.heat, b.band) : null;
  return {
    mix: b.mix ? [r3(b.mix[0]), r3(b.mix[1]), r3(b.mix[2])] : null,
    region: region ? region.id : null,
    name: region ? POTIONS[region.id].name : null,
    matched: !!region,
    band: b.band ? [r3(b.band[0]), r3(b.band[1])] : null,
    heat: r3(b.heat),
    fire: r3(b.fire),
    fit, // -1 too cold, 0 in band, +1 too hot, null no band
    inBand: fit === 0,
    progress: r3(b.progress),
    stirring: r3(b.stir),
    bound: !!b.ready,
    output: b.ready ? b.ready.potion : null,
    count: b.ready ? b.ready.count : 0,
    contents: b.contents.slice(),
  };
}
