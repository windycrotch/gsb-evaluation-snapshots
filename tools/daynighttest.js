// Day/night clock tests. Runs the game with no browser and no network (tools/headless.js):
//   node tools/daynighttest.js
// Covers: set/get round trip, frame-by-frame advance within [0,1), time passing while indoors and
// continuing outdoors afterwards, and the per-frame cap after a very long frame gap.
'use strict';
const assert = require('assert');
const H = require('./headless.js');

let failures = 0, passes = 0;
function test(name, fn) {
  try { fn(); passes++; console.log('ok   ' + name); }
  catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + (e && e.message ? e.message : e)); }
}

// A fresh game on an outdoor map, with time pinned so nothing depends on the real clock.
function fresh() {
  const ctx = H.loadGame({ search: '?map=PalletTown&x=5&y=8' });
  const G = ctx.G;
  G.boot();
  G.noEncounters = true;
  G.setTimeOfDay(0.5);
  return G;
}

const CAP = () => 250 / (24 * 60 * 60 * 1000); // the largest a single frame may move the clock

test('time of day reads back exactly what was set', () => {
  const G = fresh();
  for (const v of [0, 0.25, 0.5, 0.75, 0.999]) {
    G.setTimeOfDay(v);
    assert.strictEqual(G.getTimeOfDay(), v, 'set/get round trip for ' + v);
  }
  // out of range values clamp to the ends of the day rather than wrapping silently
  G.setTimeOfDay(-1); assert.strictEqual(G.getTimeOfDay(), 0);
  G.setTimeOfDay(2); assert.strictEqual(G.getTimeOfDay(), 1);
});

test('the clock advances every frame, monotonically and inside [0,1)', () => {
  const G = fresh();
  G.setTimeOfDay(0.4);
  let prev = G.getTimeOfDay();
  for (let i = 0; i < 240; i++) {
    G.engine.step();
    const now = G.getTimeOfDay();
    assert.ok(now > prev, 'frame ' + i + ' went backwards: ' + prev + ' -> ' + now);
    assert.ok(now >= 0 && now < 1, 'frame ' + i + ' left [0,1): ' + now);
    prev = now;
  }
  // 240 frames should be roughly 4 seconds of a 24-hour day
  const elapsed = prev - 0.4;
  const expected = 240 * (1000 / 60) / (24 * 60 * 60 * 1000);
  assert.ok(Math.abs(elapsed - expected) < expected * 0.05, 'rate drifted: ' + elapsed + ' vs ' + expected);
});

test('time keeps ticking indoors and is advanced when back outside', () => {
  const G = fresh();
  G.setTimeOfDay(0.3);
  assert.ok(G.ow.map.outdoor, 'test starts outdoors');
  const outsideBefore = G.getTimeOfDay();

  G.ow.load('RedsHouse1F', 3, 6, 'down');
  assert.ok(!G.ow.map.outdoor, 'inside RedsHouse1F is an interior');
  const insideBefore = G.getTimeOfDay();
  H.runFrames(G, 300);
  const insideAfter = G.getTimeOfDay();
  assert.ok(insideAfter > insideBefore, 'time must advance indoors');

  G.ow.load('PalletTown', 5, 8, 'down');
  assert.ok(G.ow.map.outdoor, 'back outside');
  const outsideAfter = G.getTimeOfDay();
  assert.ok(outsideAfter > outsideBefore, 'time after coming back out must have moved on');
  assert.ok(outsideAfter >= insideAfter, 'time never goes backwards across a warp');
});

test('a very long frame gap only credits a bounded slice', () => {
  const G = fresh();
  G.setTimeOfDay(0.5);
  const before = G.getTimeOfDay();
  G.engine.step(60 * 60 * 1000); // one frame standing in for a whole hour
  const delta = G.getTimeOfDay() - before;
  assert.ok(delta > 0, 'the frame still advances time a little');
  assert.ok(delta <= CAP() + 1e-12, 'frame advanced ' + delta + ', cap is ' + CAP());
  // a simulated tab that was hidden for hours is the same story, frame after frame
  let last = G.getTimeOfDay(), max = 0;
  for (let i = 0; i < 5; i++) {
    G.engine.step(6 * 60 * 60 * 1000);
    max = Math.max(max, G.getTimeOfDay() - last);
    last = G.getTimeOfDay();
  }
  assert.ok(max <= CAP() + 1e-12, 'a restored tab skipped ' + max + ' of a day in one frame');
});

test('the clock wraps around midnight without leaving [0,1)', () => {
  const G = fresh();
  G.setTimeOfDay(1 - 1e-7); // a hair before midnight, inside one frame's worth of a day
  G.engine.step(); // crosses 1
  const now = G.getTimeOfDay();
  assert.ok(now >= 0 && now < 0.01, 'wrapped value sits just after midnight: ' + now);
});

test('night phase follows the set time of day', () => {
  const G = fresh();
  G.setTimeOfDay(0.5); // noon
  assert.strictEqual(G.timeOfDay().night, 0, 'noon is not night');
  G.setTimeOfDay(0); // midnight
  assert.strictEqual(G.timeOfDay().night, 1, 'midnight is night');
  G.setTimeOfDay(18.5 / 24); // dusk
  const dusk = G.timeOfDay();
  assert.ok(dusk.night > 0 && dusk.night < 1, 'dusk is a partial night: ' + dusk.night);
});

test('indoor maps get no sky lighting or night grading', () => {
  const G = fresh();
  const changed = (name, outdoor, tsFile) => {
    const s = new G.gfx.Surface(320, 180);
    s.clear(G.gfx.hex('#404040'));
    const ow = { map: { name, outdoor, tsFile }, t: 100, render: { lights: [] }, neighbors: [] };
    G.setTimeOfDay(0.5);           // noon: build the map's particle state, no grading
    G.ambient(s, ow, 0, 0);
    const noon = new Uint32Array(s.data);
    G.setTimeOfDay(0);             // midnight
    G.ambient(s, ow, 0, 0);
    let n = 0;
    for (let i = 0; i < noon.length; i++) if (s.data[i] !== noon[i]) n++;
    return n;
  };
  // control: the same screen outdoors is graded heavily at midnight, so the check below can fail
  assert.ok(changed('PalletTown', true, 'overworld') > 1000, 'outdoor midnight must darken the screen');
  assert.strictEqual(changed('RedsHouse1F', false, 'interior'), 0, 'an interior was graded by the sky at midnight');
});

test('a long gap earns at most the cap, so a restored tab cannot jump the sky', () => {
  const G = fresh();
  G.setTimeOfDay(0.5);
  const d = G.dayNight;
  assert.strictEqual(d.credit(1000 / 60), 1000 / 60, 'a normal frame earns its own gap');
  assert.strictEqual(d.credit(250), 250, 'a short stall is still credited in full');
  assert.strictEqual(d.credit(6 * 60 * 60 * 1000), 250, 'a six-hour gap is capped');
  assert.strictEqual(d.credit(600000), 250, 'a ten-minute hidden tab is capped');
});

test('the ?hour= debug link sets the clock', () => {
  const G = H.loadGame({ search: '?map=PalletTown&x=5&y=8&hour=18' }).G;
  G.boot();
  assert.ok(Math.abs(G.getTimeOfDay() - 18 / 24) < 1e-9, 'hour 18 should be three quarters through the day');
  assert.ok(G.timeOfDay().dusk > 0.9, '18:00 is the height of dusk');
});

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
