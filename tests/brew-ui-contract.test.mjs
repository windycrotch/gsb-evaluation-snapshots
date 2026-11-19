// Integration-shape tests: drive the pure pot through the same decisions the overlay
// (src/ui/brew.js) and the 3D driver (src/game/brewing.js) make, and assert the fields the UI
// branches on every frame. This guards the contract "one pot state, two views" without a browser:
// the overlay has no progress of its own, so if these fields behave, its render cannot diverge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BREW } from '../src/game/data.js';
import { createPotState, addIngredient, stepFire, applyStirAngle, stepBinding, beginBottle, updateBottle, commitBottle, cancelBottle, serializeBrew, restoreBrew, BOTTLE } from '../src/game/brew-logic.js';

const TAU = Math.PI * 2;
const makeInv = (ingredients = {}) => ({ ingredients: { ...ingredients }, potions: {}, primes: { salt: false, mercury: false, sulfur: false }, stone: false, selected: null });
const heatIn = (pot, band, dt = 0.05) => {
  for (let i = 0; i < 240; i++) stepFire(pot, dt, { bellows: pot.heat < (band[0] + band[1]) / 2 - 0.01, damper: pot.heat > (band[0] + band[1]) / 2 + 0.01 });
};
const bind = (pot, dt = 0.05) => {
  for (let i = 0; i < BREW.bindTurns; i++) {
    applyStirAngle(pot, TAU);
    stepBinding(pot, dt);
  }
};

/** The exact per-frame reads ui/brew.js makes to decide the Bottle key state. */
function bottleKeyState(pot, opus) {
  const bottling = !!pot.bottle;
  const canBottle = (!!pot.ready || !!(opus && opus.done)) && !bottling;
  return { bottling, canBottle, disabled: !canBottle, label: bottling ? 'Bottling…' : 'Bottle' };
}

test('overlay bottle key tracks the shared pot through begin, busy, commit and empty', () => {
  const inv = makeInv({ mirrorlily: 3 });
  const pot = createPotState();
  pot.active = true;
  for (const id of ['mirrorlily', 'mirrorlily', 'mirrorlily']) addIngredient(pot, inv, id);

  // before binding: key disabled, nothing in flight
  assert.deepEqual(bottleKeyState(pot, pot.opus), { bottling: false, canBottle: false, disabled: true, label: 'Bottle' });

  heatIn(pot, pot.band);
  bind(pot);
  assert.ok(pot.ready);
  assert.deepEqual(bottleKeyState(pot, pot.opus), { bottling: false, canBottle: true, disabled: false, label: 'Bottle' });

  beginBottle(pot, inv);
  // while in flight the key shows busy and is disabled — a second click cannot settle again
  const busy = bottleKeyState(pot, pot.opus);
  assert.equal(busy.bottling, true);
  assert.equal(busy.canBottle, false);
  assert.equal(busy.label, 'Bottling…');
  assert.equal(beginBottle(pot, inv).code, BOTTLE.BUSY);

  for (let i = 0; i < 12; i++) if (updateBottle(pot, 0.1)) break;
  commitBottle(pot, inv, { brewed: 0 });
  // committed: empty pot disables the key again
  assert.deepEqual(bottleKeyState(pot, pot.opus), { bottling: false, canBottle: false, disabled: true, label: 'Bottle' });
});

test('overlay gauge inputs (heat/fire/band/fit) are the pure pot values, including after restore', () => {
  const inv = makeInv({ cinderbloom: 1, saltwort: 1 });
  const pot = createPotState();
  pot.active = true;
  addIngredient(pot, inv, 'cinderbloom');
  addIngredient(pot, inv, 'saltwort');
  for (let i = 0; i < 30; i++) stepFire(pot, 0.05, { bellows: true });
  stepBinding(pot, 0.05); // assigns fit for the current band, exactly as the per-frame driver does
  const snapshot = { heat: pot.heat, fire: pot.fire, band: pot.band.slice(), fit: pot.fit, region: pot.region && pot.region.id };

  const back = restoreBrew(JSON.parse(JSON.stringify(serializeBrew(pot))));
  assert.equal(back.heat, snapshot.heat);
  assert.equal(back.fire, snapshot.fire);
  assert.deepEqual(back.band, snapshot.band);
  assert.equal(back.fit, snapshot.fit);
  assert.equal(back.region.id, snapshot.region);
  // the gauge's in/out-of-band class derivation gives the same answer on the restored pot
  const fitClass = (p) => (p.band ? (p.heat < p.band[0] ? 'is-cold' : p.heat > p.band[1] ? 'is-hot' : 'is-in') : null);
  assert.equal(fitClass(back), fitClass(pot));
});

test('leave/re-enter keeps the binding fraction: overlay progress bar never jumps or doubles', () => {
  const inv = makeInv({ mirrorlily: 3 });
  const pot = createPotState();
  pot.active = true;
  for (const id of ['mirrorlily', 'mirrorlily', 'mirrorlily']) addIngredient(pot, inv, id);
  heatIn(pot, pot.band);
  bind(pot); // 3/3 turns -> ready
  assert.equal(pot.progress, 1);

  // walk away at the bound state and come back
  const back = restoreBrew(JSON.parse(JSON.stringify(serializeBrew(pot))));
  assert.equal(back.progress, 1, 'progress is exactly preserved, not reset and not advanced');
  assert.ok(back.ready && back.ready.potion === 'levity', 'the bound record survives the round trip');
  // a frame after re-entry changes nothing by itself (no phantom settling)
  stepBinding(back, 0.05);
  assert.equal(back.progress, 1);
  assert.ok(back.ready);
});

test('cancelling a bottling leaves the overlay in the pre-bottle state, deterministically', () => {
  const inv = makeInv({ mirrorlily: 3 });
  const pot = createPotState();
  pot.active = true;
  for (const id of ['mirrorlily', 'mirrorlily', 'mirrorlily']) addIngredient(pot, inv, id);
  heatIn(pot, pot.band);
  bind(pot);
  beginBottle(pot, inv);
  updateBottle(pot, BREW.bottleSeconds / 2);
  assert.ok(pot.bottle);
  cancelBottle(pot);
  // mirrors what Brewing.leave() then Brewing.enter() would present
  assert.ok(pot.ready && pot.ready.potion === 'levity', 'the bound potion is kept, not settled');
  assert.equal(pot.contents.length, 3);
  assert.equal(pot.bottle, null);
  assert.deepEqual(inv.potions, {});
});
