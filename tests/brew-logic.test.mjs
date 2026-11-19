// Node-only tests for the pure cauldron rules (src/game/brew-logic.js). No browser, no three.js:
//   node --test tests/
//
// Coverage asked for in the brief: a normal bottle, a repeated bottle, an empty-pot bottle,
// leave-then-reenter restoration, and leaving in the middle of a bottling — plus the supporting
// rules (ordered mix, repeated ingredients, held-only fire, whole-turn stirring).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BREW } from '../src/game/data.js';
import {
  ADD,
  BOTTLE,
  createPotState,
  addIngredient,
  stepFire,
  applyStirAngle,
  stepBinding,
  beginBottle,
  updateBottle,
  cancelBottle,
  commitBottle,
  emptyPot,
  serializeBrew,
  restoreBrew,
} from '../src/game/brew-logic.js';

const TAU = Math.PI * 2;

function makeInv(ingredients = {}, potions = {}, primes = {}) {
  return { ingredients: { ...ingredients }, potions: { ...potions }, primes: { salt: false, mercury: false, sulfur: false, ...primes }, stone: false, selected: null };
}
/** A pot standing open at the bench. */
function openPot() {
  const pot = createPotState();
  pot.active = true;
  return pot;
}
/** Drive the heat to the middle of the current band and hold it there. */
function heatToBand(pot, target, steps = 200, dt = 0.05) {
  for (let i = 0; i < steps; i++) {
    const mid = (target[0] + target[1]) / 2;
    stepFire(pot, dt, { bellows: pot.heat < mid - 0.01, damper: pot.heat > mid + 0.01 });
  }
  assert.ok(pot.heat >= target[0] && pot.heat <= target[1], `heat ${pot.heat} not inside band ${target}`);
}
/** Complete `turns` full signed revolutions, one revolution per call, with binding stepped between. */
function stirTurns(pot, turns, dt = 0.05) {
  for (let i = 0; i < turns; i++) {
    const crossed = applyStirAngle(pot, Math.sign(turns || 1) * TAU);
    assert.equal(crossed, Math.sign(turns || 1), 'one whole revolution counts as one turn');
    stepBinding(pot, dt);
  }
}

// ----------------------------------------------------------------------------- ordered mixture
test('adding order moves the mix point; the same two ingredients swapped end elsewhere', () => {
  const invA = makeInv({ cinderbloom: 2, saltwort: 2 });
  const a = openPot();
  assert.equal(addIngredient(a, invA, 'cinderbloom').code, ADD.OK);
  assert.equal(addIngredient(a, invA, 'saltwort').code, ADD.OK);

  const invB = makeInv({ cinderbloom: 2, saltwort: 2 });
  const b = openPot();
  assert.equal(addIngredient(b, invB, 'saltwort').code, ADD.OK);
  assert.equal(addIngredient(b, invB, 'cinderbloom').code, ADD.OK);

  assert.notDeepEqual(a.mix, b.mix, '[a,b] and [b,a] must land on different mix points');
  // the first ingredient owns the corner; the second only pulls partway
  assert.deepEqual(a.contents, ['cinderbloom', 'saltwort']);
  assert.ok(a.mix[0] > b.mix[0], 'the pot that got sulfur-heavy cinderbloom first stays more sulfur');
});

test('repeating one ingredient pulls by the same rule every time and is capped by capacity', () => {
  const inv = makeInv({ cinderbloom: 12 });
  const pot = openPot();
  const mixes = [];
  for (let i = 0; i < BREW.capacity; i++) {
    const r = addIngredient(pot, inv, 'cinderbloom');
    assert.equal(r.code, ADD.OK);
    mixes.push(pot.mix.slice());
  }
  // every repeat moves the point toward the cinderbloom corner, never past it
  for (let i = 1; i < mixes.length; i++) {
    assert.ok(mixes[i][0] >= mixes[i - 1][0], 'repeats keep pulling toward the corner');
    assert.ok(mixes[i][0] <= 0.86 + 1e-9, 'a pull can never overshoot the ingredient point');
  }
  assert.equal(pot.contents.length, BREW.capacity);
  assert.equal(addIngredient(pot, inv, 'cinderbloom').code, ADD.FULL);
  // the refused ninth changed nothing: inventory untouched beyond the eight spent
  assert.equal(inv.ingredients.cinderbloom, 4);
});

test('a repeated Prime is refused with an explicit rule and never enters the pot twice', () => {
  const inv = makeInv({}, {}, { salt: true, mercury: true, sulfur: true });
  const pot = openPot();
  assert.equal(addIngredient(pot, inv, 'prime:salt').code, ADD.OK);
  assert.equal(addIngredient(pot, inv, 'prime:salt').code, ADD.PRIME_DUP);
  assert.deepEqual(pot.contents, ['prime:salt']);
});

test('adding without the ingredient in hand changes nothing', () => {
  const inv = makeInv();
  const pot = openPot();
  assert.equal(addIngredient(pot, inv, 'cinderbloom').code, ADD.NOT_HELD);
  assert.deepEqual(pot.contents, []);
});

// ----------------------------------------------------------------------------- fire and heat
test('fire rises only while the bellows are held and cools on release; the damper forces it down', () => {
  const pot = openPot();
  for (let i = 0; i < 40; i++) stepFire(pot, 0.05, { bellows: true });
  const hot = pot.fire;
  assert.ok(hot > 0.5, 'held bellows build the fire');
  for (let i = 0; i < 40; i++) stepFire(pot, 0.05, {}); // both released
  assert.ok(pot.fire < hot, 'after release the existing cooling rule brings the fire down');
  const cooled = pot.fire;
  for (let i = 0; i < 20; i++) stepFire(pot, 0.05, { damper: true });
  assert.ok(pot.fire < cooled, 'the held damper drops the fire faster');
});

// ----------------------------------------------------------------------------- stirring turns
test('binding advances only on complete revolutions; partial circles and reversals bind nothing', () => {
  const inv = makeInv({ mirrorlily: 3 });
  const pot = openPot();
  for (const id of ['mirrorlily', 'mirrorlily', 'mirrorlily']) addIngredient(pot, inv, id);
  heatToBand(pot, pot.band);

  // three half circles forward and back: net zero, no completed turn, no progress
  applyStirAngle(pot, Math.PI);
  applyStirAngle(pot, -Math.PI);
  stepBinding(pot, 0.05);
  assert.equal(pot.progress, 0);
  assert.equal(pot.ready, null);

  // a full revolution minus a sliver still binds nothing
  applyStirAngle(pot, TAU - 0.01);
  stepBinding(pot, 0.05);
  assert.equal(pot.progress, 0);

  // the missing sliver completes the first turn: one bindTurns-th of the work
  applyStirAngle(pot, 0.02);
  stepBinding(pot, 0.05);
  assert.ok(Math.abs(pot.progress - 1 / BREW.bindTurns) < 1e-9);
});

test('stirring while the heat is outside the band banks no binding; the turn waits for the right fire', () => {
  const inv = makeInv({ mirrorlily: 3 });
  const pot = openPot();
  for (const id of ['mirrorlily', 'mirrorlily', 'mirrorlily']) addIngredient(pot, inv, id);
  // cold pot: band for levity is 0.2..0.5
  assert.notEqual(pot.fit, 0);
  stirTurns(pot, 2);
  assert.equal(pot.progress, 0, 'turns out of band cannot bind');
  heatToBand(pot, pot.band);
  // the banked whole turns were not consumed while cold; now in band they pay out
  stepBinding(pot, 0.05);
  assert.ok(pot.progress > 0, 'banked turns settle once the heat is right');
});

// ----------------------------------------------------------------------------- the five paths
test('normal bottle: bound mixture in its region bottles once, clears the pot and settles inventory once', () => {
  const inv = makeInv({ mirrorlily: 3 });
  const stats = { brewed: 0 };
  const pot = openPot();
  for (const id of ['mirrorlily', 'mirrorlily', 'mirrorlily']) addIngredient(pot, inv, id);
  heatToBand(pot, pot.band);
  stirTurns(pot, BREW.bindTurns);
  assert.ok(pot.ready, 'three full revolutions in band bind the potion');
  assert.equal(pot.ready.potion, 'levity');
  const yieldN = pot.ready.count;

  assert.equal(beginBottle(pot, inv).code, BOTTLE.BEGUN);
  // not committed before the action runs its course
  assert.equal(inv.potions.levity || 0, 0);
  assert.deepEqual(pot.contents.length, 3);

  // frames before the deadline change nothing
  for (let t = 0; t < BREW.bottleSeconds - 0.1; t += 0.1) assert.equal(updateBottle(pot, 0.1), null);
  const due = updateBottle(pot, 0.2); // crosses bottleSeconds
  assert.ok(due && due.potion === 'levity');
  const done = commitBottle(pot, inv, stats);
  assert.deepEqual(done, { potion: 'levity', count: yieldN });
  assert.equal(inv.potions.levity, yieldN);
  assert.equal(stats.brewed, yieldN);
  assert.deepEqual(pot.contents, []);
  assert.equal(pot.ready, null);
  assert.equal(pot.bottle, null);
  assert.equal(pot.progress, 0);
});

test('repeated bottle triggers in the same frame settle at most once', () => {
  const inv = makeInv({ mirrorlily: 3 });
  const pot = openPot();
  for (const id of ['mirrorlily', 'mirrorlily', 'mirrorlily']) addIngredient(pot, inv, id);
  heatToBand(pot, pot.band);
  stirTurns(pot, BREW.bindTurns);
  const yieldN = pot.ready.count;

  // three triggers before any frame advances: one BEGUN, the rest BUSY, no inventory movement
  assert.equal(beginBottle(pot, inv).code, BOTTLE.BEGUN);
  assert.equal(beginBottle(pot, inv).code, BOTTLE.BUSY);
  assert.equal(beginBottle(pot, inv).code, BOTTLE.BUSY);
  assert.equal(inv.potions.levity || 0, 0);

  // run the single in-flight action to its one settlement
  let committed = false;
  for (let i = 0; i < 20 && !committed; i++) {
    if (updateBottle(pot, 0.1)) {
      commitBottle(pot, inv, { brewed: 0 });
      committed = true;
    }
  }
  assert.ok(committed);
  assert.equal(inv.potions.levity, yieldN, 'exactly one settlement ever reaches the belt');
  // the pot is empty now, so another attempt is an empty-pot refusal, not a second settlement
  assert.equal(beginBottle(pot, inv).code, BOTTLE.EMPTY);
});

test('empty-pot bottling is refused and leaves the empty pot exactly as it was', () => {
  const inv = makeInv();
  const pot = openPot();
  const res = beginBottle(pot, inv);
  assert.equal(res.code, BOTTLE.EMPTY);
  assert.equal(pot.bottle, null);
  assert.deepEqual(pot.contents, []);
  assert.deepEqual(inv.potions, {});
});

test('bottling an unbound mixture fails visibly (rule level) and keeps every ingredient', () => {
  const inv = makeInv({ mirrorlily: 3 });
  const pot = openPot();
  for (const id of ['mirrorlily', 'mirrorlily', 'mirrorlily']) addIngredient(pot, inv, id);
  // in region and in heat, but never stirred to binding
  heatToBand(pot, pot.band);
  assert.equal(pot.ready, null);
  assert.equal(beginBottle(pot, inv).code, BOTTLE.NOT_BOUND);
  assert.equal(pot.bottle, null);
  assert.deepEqual(pot.contents, ['mirrorlily', 'mirrorlily', 'mirrorlily']);
  assert.equal(inv.potions.levity || 0, 0);
});

test('leave and re-enter: heat, stirring credit, progress and contents come back identical', () => {
  const inv = makeInv({ mirrorlily: 4 });
  const pot = openPot();
  for (let i = 0; i < 3; i++) addIngredient(pot, inv, 'mirrorlily');
  heatToBand(pot, pot.band);
  stirTurns(pot, 2); // two of three turns bound, one turn of fractional travel still in the bank
  applyStirAngle(pot, TAU * 0.4);
  const before = serializeBrew(pot);

  // walk away: the bench closes, the save is written, then a fresh session restores it
  pot.active = false;
  const revived = restoreBrew(JSON.parse(JSON.stringify(before)));
  assert.equal(revived.active, false, 'the view itself is never restored as open');
  assert.deepEqual(revived.contents, pot.contents);
  assert.ok(Math.abs(revived.heat - pot.heat) < 1e-12);
  assert.ok(Math.abs(revived.fire - pot.fire) < 1e-12);
  assert.ok(Math.abs(revived.progress - pot.progress) < 1e-12);
  assert.ok(Math.abs(revived.stirBank - pot.stirBank) < 1e-12, 'fractional stirring travel survives');
  assert.deepEqual(revived.band, pot.band);
  assert.equal(revived.region.id, pot.region.id);

  // re-open and finish: the remaining turn plus the banked 0.4 need 0.6 more to complete turn three
  revived.active = true;
  applyStirAngle(revived, TAU * 0.6);
  stepBinding(revived, 0.05);
  assert.ok(revived.ready, 're-entered pot reaches binding without redoing the lost work');
});

test('leaving mid-bottle cancels it whole: nothing in the belt, nothing lost from the pot', () => {
  const inv = makeInv({ mirrorlily: 3 });
  const pot = openPot();
  for (const id of ['mirrorlily', 'mirrorlily', 'mirrorlily']) addIngredient(pot, inv, id);
  heatToBand(pot, pot.band);
  stirTurns(pot, BREW.bindTurns);
  const ready = { ...pot.ready };

  assert.equal(beginBottle(pot, inv).code, BOTTLE.BEGUN);
  assert.ok(updateBottle(pot, 0.2) === null, 'partway through the bottling action');
  assert.ok(cancelBottle(pot), 'leave() abandons the in-flight action');

  assert.equal(pot.bottle, null);
  assert.deepEqual(pot.contents, ['mirrorlily', 'mirrorlily', 'mirrorlily'], 'the pot keeps everything');
  assert.deepEqual(inv.potions, {}, 'no phial was ever moved');
  assert.deepEqual(pot.ready, ready, 'the bound potion is still waiting to be bottled');

  // the player can still bottle it properly afterwards
  assert.equal(beginBottle(pot, inv).code, BOTTLE.BEGUN);
  for (let i = 0; i < 10; i++) if (updateBottle(pot, 0.1)) break;
  const done = commitBottle(pot, inv, { brewed: 0 });
  assert.equal(done.potion, 'levity');
});

test('an in-flight bottling is never serialized, so a save cannot straddle a commit', () => {
  const inv = makeInv({ mirrorlily: 3 });
  const pot = openPot();
  for (const id of ['mirrorlily', 'mirrorlily', 'mirrorlily']) addIngredient(pot, inv, id);
  heatToBand(pot, pot.band);
  stirTurns(pot, BREW.bindTurns);
  beginBottle(pot, inv);
  const saved = serializeBrew(pot);
  assert.equal(saved.bottle, undefined);
  const revived = restoreBrew(saved);
  assert.equal(revived.bottle, null);
  assert.ok(revived.ready, 'the bound work is intact; only the unfinished action vanished');
});

test('restoring a legacy/partial pot fills defaults instead of throwing', () => {
  const legacy = { contents: ['cinderbloom'], heat: 0.3 }; // no stirBank, no bottle, old shape
  const pot = restoreBrew(legacy);
  assert.deepEqual(pot.contents, ['cinderbloom']);
  assert.equal(pot.heat, 0.3);
  assert.equal(pot.stirBank, 0);
  assert.equal(pot.bottle, null);
  assert.ok(pot.mix, 'derived mix point is recomputed on restore');
  assert.ok(pot.region, 'derived region is recomputed on restore');
});

test('emptyPot spends the contents and clears every binding artefact', () => {
  const inv = makeInv({ mirrorlily: 2 });
  const pot = openPot();
  addIngredient(pot, inv, 'mirrorlily');
  addIngredient(pot, inv, 'mirrorlily');
  assert.ok(emptyPot(pot));
  assert.deepEqual(pot.contents, []);
  assert.equal(pot.mix, null);
  assert.equal(pot.region, null);
  assert.equal(pot.progress, 0);
  assert.equal(pot.stirBank, 0);
  assert.equal(emptyPot(pot), false, 'emptying an already empty pot does nothing');
});

test('a belt full of that phial refuses bottling without touching the pot', () => {
  const inv = makeInv({ mirrorlily: 3 }, { levity: BREW.maxCarry });
  const pot = openPot();
  for (const id of ['mirrorlily', 'mirrorlily', 'mirrorlily']) addIngredient(pot, inv, id);
  heatToBand(pot, pot.band);
  stirTurns(pot, BREW.bindTurns);
  assert.equal(beginBottle(pot, inv).code, BOTTLE.CARRY_FULL);
  assert.equal(pot.bottle, null);
  assert.equal(pot.contents.length, 3);
});

test('taking the finished Stone clears the spent pot immediately without touching the potion belt', () => {
  const inv = makeInv();
  inv.primes = { salt: true, mercury: true, sulfur: true };
  const pot = openPot();
  for (const p of ['sulfur', 'mercury', 'salt']) assert.equal(addIngredient(pot, inv, 'prime:' + p).code, ADD.OK);
  assert.ok(pot.opus, 'the three Primes begin the Great Work');
  // walk the four stages: right heat, three turns each
  for (let stage = 0; stage < 4; stage++) {
    heatToBand(pot, pot.band);
    stirTurns(pot, BREW.bindTurns);
  }
  assert.ok(pot.opus.done, 'the Work reaches Rubedo completion');
  const res = beginBottle(pot, inv);
  assert.equal(res.code, BOTTLE.STONE_TAKEN);
  assert.deepEqual(pot.contents, []);
  assert.equal(pot.opus, null);
  assert.equal(pot.bottle, null, 'no in-flight action: the Stone path is immediate');
  assert.deepEqual(inv.potions, {}, 'no phial is ever produced by the Work');
});
