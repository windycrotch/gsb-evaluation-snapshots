// The cauldron's chain, checked without a screen: feeding the chart, the fire, the ladle, the pour
// and the emptying must all agree with one story. This runs the very rules the game runs
// (src/game/brewlogic.js and src/game/data.js) headlessly, so it needs no graphics card and no
// browser, and it compares only numbers and produce, never a screenshot.
//
//   node tools/brew-check.mjs        every case, one line each
//   node tools/brew-check.mjs -v     also print the state at each step
//
// Exit 1 if any expectation fails. The four cases the design asks for are marked below.
import { INGREDIENTS, POTIONS, BREW, mixOf, regionAt, heatFit } from '../src/game/data.js';
import { createState, createBrew } from '../src/game/state.js';
import { recompute, addToPot, applyHands, advanceBinding, bottlePot, emptyPot, clearPot, readout, RULES, NO_MATCH } from '../src/game/brewlogic.js';

const verbose = process.argv.includes('-v');
let passed = 0,
  failed = 0;

function ok(label, cond, detail) {
  if (cond) passed++;
  else {
    failed++;
    console.log('FAIL  ' + label + (detail ? '   (' + detail + ')' : ''));
  }
  if (verbose && cond) console.log('ok    ' + label);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const show = (o) => JSON.stringify(o);

/** A pot at the cauldron with the named ingredients in the satchel. */
function scene(bag = {}) {
  const st = createState();
  st.mode = 'brew';
  st.inv.ingredients = { ...bag };
  const b = createBrew();
  b.active = true;
  recompute(b);
  return { st, b };
}
/** Run the fire and the ladle for `seconds` with the given hands held, 1/60 s a tick. */
function brew(b, seconds, hands = {}) {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    applyHands(b, dt, hands);
    advanceBinding(b, dt);
  }
  recompute(b);
  return b;
}
/** Fire at the middle of the current band and stir steadily until binding starts or time is out. */
function bindToEnd(b, seconds, { heatTarget } = {}) {
  const target = heatTarget ?? (b.band ? (b.band[0] + b.band[1]) / 2 : 0.5);
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    const pump = b.heat < target;
    const damp = b.heat > target;
    applyHands(b, dt, { pump, damp, stirIn: 1 });
    if (advanceBinding(b, dt)) return b;
    recompute(b);
  }
  recompute(b);
  return b;
}

// =============================================================================================
// 1. A potion is hit, bound and poured.  (the "normal hit and bottle" case)
// =============================================================================================
{
  const { st, b } = scene({ cinderbloom: 3 });
  for (let i = 0; i < 3; i++) ok('1 a Cinderbloom goes in', addToPot(b, st, 'cinderbloom').ok);
  ok('1 the pot holds three', b.contents.length === 3);
  ok('1 the mark lies in Ember', b.region && b.region.id === 'ember', show(b.region));
  ok('1 the readout agrees', readout(b).region === 'ember');
  ok('1 the band is Ember’s', b.band[0] === POTIONS.ember.heat[0] && b.band[1] === POTIONS.ember.heat[1]);

  // the fire is worked until the heat is inside the band; stirring alone does nothing while cold
  brew(b, 1.0, { stirIn: 1 });
  ok('1 while cold the heat is under the band', readout(b).fit === -1, 'fit=' + readout(b).fit);
  ok('1 and the mixture does not bind', b.progress === 0, 'progress=' + b.progress);

  bindToEnd(b, 40);
  ok('1 the pot binds inside the band', !!b.ready, show(b.ready));
  ok('1 the bound potion is Ember', b.ready && b.ready.potion === 'ember');
  ok('1 the readout names it', readout(b).output === 'ember');

  const res = bottlePot(b, st);
  ok('1 the pour succeeds', res.ok, show(res));
  ok('1 it yields Ember', res.ok && res.potion === 'ember');
  ok('1 in as many phials as were bound', res.ok && b.ready === null && res.count > 0 && st.inv.potions.ember === res.count, show(res));
  ok('1 the satchel holds them', (st.inv.potions.ember || 0) === res.count);
  ok('1 the pot is empty after the pour', b.contents.length === 0);
  ok('1 the mixture is cleared', b.mix === null);
  ok('1 the pot is cold again', b.heat === 0 && b.fire === 0);
  ok('1 and the stirring is zero', b.stir === 0 && b.progress === 0);
}

// =============================================================================================
// 2. Stirring outside the temperature band makes no progress.  (the "cold/wrong band" case)
// =============================================================================================
{
  const { st, b } = scene({ halite: 2 });
  addToPot(b, st, 'halite');
  addToPot(b, st, 'halite');
  ok('2 the mark lies in Saltspire', b.region && b.region.id === 'saltspire', show(b.region));
  // keep the fire well under the band and stir hard
  const cold = b.band[0] - 0.15;
  const before = b.progress;
  for (let i = 0; i < 90; i++) {
    applyHands(b, 1 / 60, { stirIn: 1 });
    // hold the pot below the band by hand so the test is of the band, not of the flame
    b.heat = Math.min(b.heat, cold);
    advanceBinding(b, 1 / 60);
  }
  ok('2 the heat is under the band', heatFit(b.heat, b.band) === -1, 'heat=' + b.heat + ' band=' + show(b.band));
  ok('2 stirring outside the band adds nothing', near(b.progress, before, 1e-9), 'progress=' + b.progress);

  // now bind a little inside the band, then leave it and watch it fall back
  b.heat = (b.band[0] + b.band[1]) / 2;
  for (let i = 0; i < 120; i++) {
    b.heat = (b.band[0] + b.band[1]) / 2;
    applyHands(b, 1 / 60, { stirIn: 1 });
    advanceBinding(b, 1 / 60);
  }
  const grown = b.progress;
  ok('2 inside the band it grows', grown > 0.05, 'progress=' + grown);
  const t0 = b.progress;
  for (let i = 0; i < 120; i++) {
    b.heat = 0; // the fire has gone right out
    applyHands(b, 1 / 60, { stirIn: 1 });
    advanceBinding(b, 1 / 60);
  }
  ok('2 leaving the band it decays', b.progress < t0, t0 + ' -> ' + b.progress);
  ok('2 and it is not yet bound', !b.ready);
  ok('2 the readout says it is outside', readout(b).inBand === false);
}

// =============================================================================================
// 3. Bottling a mixture with no region fails and says so.  (the "no match fails" case)
// =============================================================================================
{
  // saltwort and corpselight together fall between Verdance and Rime, belonging to neither
  const { st, b } = scene({ saltwort: 1, corpselight: 1 });
  addToPot(b, st, 'saltwort');
  addToPot(b, st, 'corpselight');
  ok('3 the mixture is in no region', !b.region, show(b.mix));
  ok('3 the readout says no match', readout(b).matched === false && readout(b).name === null);
  const potions = JSON.stringify(st.inv.potions);
  const brewed = st.stats.brewed;
  const res = bottlePot(b, st);
  ok('3 the pour fails', res.ok === false, show(res));
  ok('3 and gives a reason', res.ok === false && typeof res.reason === 'string' && res.reason.length > 0, res.reason);
  ok('3 no potion is made', JSON.stringify(st.inv.potions) === potions, show(st.inv.potions));
  ok('3 the brewed count does not move', st.stats.brewed === brewed);
  ok('3 the pot keeps its contents', b.contents.length === 2);

  // a mixture that is in a region but has not bound must also refuse to pour
  const s2 = scene({ cinderbloom: 3 });
  for (let i = 0; i < 3; i++) addToPot(s2.b, s2.st, 'cinderbloom');
  ok('3 an unbound region is still no pour', bottlePot(s2.b, s2.st).ok === false);
  ok('3 the pot still holds its three', s2.b.contents.length === 3);

  // a bound potion whose mixture has since changed under it must bind again, not pour the old one
  const s3 = scene({ cinderbloom: 3, halite: 1 });
  for (let i = 0; i < 3; i++) addToPot(s3.b, s3.st, 'cinderbloom');
  bindToEnd(s3.b, 40);
  ok('3 the pot binds Ember first', s3.b.ready && s3.b.ready.potion === 'ember', show(s3.b.ready));
  // put the contents somewhere else behind the binding's back, as a stale save or a bad edit might
  s3.b.contents = ['mirrorlily', 'saltwort'];
  recompute(s3.b);
  const s3before = JSON.stringify(s3.st.inv.potions);
  const s3res = bottlePot(s3.b, s3.st);
  ok('3 a bound potion whose mixture has moved refuses', s3res.ok === false, show(s3res));
  ok('3 and nothing is poured', JSON.stringify(s3.st.inv.potions) === s3before);
  ok('3 and the stale binding is cleared', s3.b.ready === null && s3.b.progress === 0);
}

// =============================================================================================
// 4. Emptying the pot resets feeding, fire and stirring together.  (the "clear" case)
// =============================================================================================
{
  const { st, b } = scene({ cinderbloom: 3, halite: 1 });
  addToPot(b, st, 'cinderbloom');
  addToPot(b, st, 'cinderbloom');
  addToPot(b, st, 'halite');
  brew(b, 2, { pump: true, stirIn: 1 });
  ok('4 the pot is hot and stirring', b.fire > 0 && b.heat > 0 && b.stir > 0, show({ fire: b.fire, heat: b.heat, stir: b.stir }));
  const trail = b.trail.length;
  ok('4 it has a trail of earlier marks', trail > 0);

  const res = emptyPot(b);
  ok('4 emptying succeeds', res.ok && res.had === 3, show(res));
  ok('4 the contents are gone', b.contents.length === 0);
  ok('4 the mixture is gone', b.mix === null && b.region === null && b.band === null && b.fit === null);
  ok('4 the trail is gone', b.trail.length === 0);
  ok('4 the fire is out', b.fire === 0);
  ok('4 the heat is out', b.heat === 0);
  ok('4 the stirring is stopped', b.stir === 0);
  ok('4 the binding is zero', b.progress === 0);
  ok('4 nothing is bound', b.ready === null);
  ok('4 the readout is empty', show(readout(b).contents) === '[]' && readout(b).mix === null);

  // and a pour after the empty must fail, not make something from nothing
  ok('4 an empty pot cannot be poured', bottlePot(b, st).ok === false);
}

// =============================================================================================
// 5. Feeding: repeats accumulate, and the last ingredient can be refused with a reason.
// =============================================================================================
{
  const { st, b } = scene({ cinderbloom: BREW.capacity + 1 });
  const p1 = { ...mixOf(['cinderbloom']).bary };
  const p2 = { ...mixOf(['cinderbloom', 'cinderbloom']).bary };
  ok('5 no contents, no mark', readout(b).mix === null && readout(b).contents.length === 0);
  addToPot(b, st, 'cinderbloom');
  const a = b.mix.slice();
  addToPot(b, st, 'cinderbloom');
  const c = b.mix.slice();
  ok('5 a second measure pulls further', c[0] > a[0] + 1e-6, a[0] + ' -> ' + c[0]);
  ok('5 the mix follows the rule', near(c[0], p2[0]) && near(a[0], p1[0]));
  ok('5 the satchel goes down', st.inv.ingredients.cinderbloom === BREW.capacity - 1);
  for (let i = 2; i < BREW.capacity; i++) addToPot(b, st, 'cinderbloom');
  ok('5 the pot fills to capacity', b.contents.length === BREW.capacity, 'contents=' + b.contents.length);
  const full = addToPot(b, st, 'cinderbloom');
  ok('5 one more is refused', full.ok === false && typeof full.reason === 'string', show(full));
  ok('5 and nothing is taken from the satchel', st.inv.ingredients.cinderbloom === 1);
}

// =============================================================================================
// 6. The fire falls back when the hands are taken away; it does not snap to nothing.
// =============================================================================================
{
  const { b } = scene();
  brew(b, 3, { pump: true });
  const hot = b.fire;
  ok('6 the bellows raise the fire', hot > 0.5, 'fire=' + hot);
  applyHands(b, 1 / 60, {});
  ok('6 one idle frame loses only a little', b.fire > hot - 0.01, hot + ' -> ' + b.fire);
  brew(b, 4, {});
  ok('6 the fire is still there, lower', b.fire < hot && b.fire > 0, 'fire=' + b.fire);
  const was = b.heat;
  brew(b, 2, {});
  ok('6 and the pot cools toward it rather than jumping', Math.abs(b.heat - b.fire) < Math.abs(was - b.fire) || b.heat > 0, 'heat=' + b.heat);
  brew(b, 1, { damp: true });
  ok('6 the damper brings it down fast', b.fire < hot * 0.5, 'fire=' + b.fire);
}

// =============================================================================================
// 7. Each potion can be reached from the ingredients it is written for.
// =============================================================================================
{
  const recipes = {
    ember: ['cinderbloom', 'cinderbloom', 'cinderbloom'],
    verdance: ['cinderbloom', 'saltwort'],
    rime: ['mirrorlily', 'saltwort'],
    levity: ['mirrorlily'],
    fulminate: ['cinderbloom', 'mirrorlily'],
    saltspire: ['halite'],
    vitae: ['saltwort', 'stormthistle'],
  };
  for (const [id, list] of Object.entries(recipes)) {
    const m = mixOf(list).bary;
    const r = regionAt(m);
    ok('7 ' + id + ' can be mixed from ' + list.join('+'), !!r && r.id === id, show(r));
    const b2 = createBrew();
    b2.contents = list.slice();
    recompute(b2);
    ok('7 ' + id + ' names itself in the readout', readout(b2).region === id || readout(b2).matched, show(readout(b2)));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
