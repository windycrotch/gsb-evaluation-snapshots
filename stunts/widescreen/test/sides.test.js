// Checks of the widescreen cockpit's memory (stunts/widescreen/sides.js), run without the game and
// without a browser: synthetic 320x200 frames stand in for the snapshots of the screen main.js takes
// each frame. Run from anywhere:
//   node stunts/widescreen/test/sides.test.js
// Exits 0 when every check passes, 1 otherwise. The four scenes are the ones the page had wrong:
// a normal race, changing cars, the Replay Menu there and back, and frames stopping and resuming.
'use strict';
const S = require('../sides.js');

const KEY = 233, W = 320, H = 200;   // (KEY: the see-through colour the 3D view shows through)
const rgb = new Uint32Array(256);
for (let i = 0; i < 256; i++) rgb[i] = 0xFF000000 | (i * 0x010101);

// a race frame as main.js's snapshot would hold it: the roof strip and the 3D view's rows (see-through)
// above the dashboard, the dashboard's own colours below `top`; dashRow marks the rows the 3D view
// doesn't reach across (roof and dash), as frame() works them out
function raceFrame(code, { top = 150, roofTop = 0, base = 40, popup = false } = {}) {
  const scr = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    scr[y * W + x] = y < roofTop ? 7 : y < top ? KEY : base + ((x * 7 + y * 3) % 5);
  // a pop-up over the dash (the gear change's, the replay panel): a solid box across the sampled columns
  if (popup) for (let y = top; y < Math.min(H, top + 30); y++) for (let x = 0; x < W; x++) scr[y * W + x] = 200;
  const dashRow = new Uint8Array(H);
  for (let y = 0; y < H; y++) dashRow[y] = (y < roofTop || y >= top) ? 1 : 0;
  return S.extract(scr, rgb, KEY, code, dashRow, S.DASH_COLS[code] || { l: 0, r: 318 });
}
// the same frame N times over (a still picture), through pick
function still(state, sample, env, n) { let last; for (let i = 0; i < n; i++) last = S.pick(state, sample, env); return last; }

let passed = 0, failed = 0;
function ok(cond, name) { if (cond) { passed++; console.log('  ok   ' + name); } else { failed++; console.error('  FAIL ' + name); } }
function section(s) { console.log('\n' + s); }

// 1. a normal race: the sides are the frame's own until the dash is remembered; a pop-up over the dash
// is never carried out to the sides
section('1. a normal race');
{
  const st = S.createState(), env = { race: 1, racing: true, replay: false };
  const f = raceFrame('COUN', { top: 150, base: 40 });
  ok(S.pick(st, f, env) === f, 'before the dash is remembered, the sides come from the same frame as the centre');
  ok(!st.cars.COUN, 'nothing remembered from one frame');
  still(st, raceFrame('COUN', { top: 150, base: 40 }), env, 59);
  ok(!st.cars.COUN, 'not yet remembered before a full second of still frames');
  S.pick(st, raceFrame('COUN', { top: 150, base: 40 }), env);
  ok(!!st.cars.COUN, 'remembered once the picture stood still a second');
  ok(S.learnedTop(st, 'COUN') === 150, 'the remembered dash height is the car\'s own');
  const pop = raceFrame('COUN', { top: 150, base: 40, popup: true });
  const got = S.pick(st, pop, env);
  ok(got === st.cars.COUN, 'a pop-up over the dash is not carried out to the sides');
  ok(got.top === 150, 'the dash height stays the remembered one under a pop-up');
}

// 2. changing cars: the new car's sides are its own frame's, the old car's memory is dropped — at a new
// race, and on a car-code change even within one
section('2. changing cars');
{
  const st = S.createState(), env1 = { race: 1, racing: true, replay: false };
  still(st, raceFrame('COUN', { top: 150, base: 40 }), env1, 70);
  ok(!!st.cars.COUN, 'the first car remembered in its race');
  const audi = raceFrame('AUDI', { top: 120, base: 90 });
  const got = S.pick(st, audi, { race: 2, racing: true, replay: false });
  ok(got === audi, 'the next race with another car starts from that frame, not the old car\'s memory');
  ok(!st.cars.COUN, 'the old car\'s memory is dropped with the race');
  ok(got.top === 120, 'the new car\'s own dash height, not the old car\'s');
  still(st, raceFrame('AUDI', { top: 120, base: 90 }), { race: 2, racing: true, replay: false }, 70);
  ok(!!st.cars.AUDI, 'the new car remembered in its own race');
  const jag = raceFrame('JAGU', { top: 160, base: 120 });
  const got2 = S.pick(st, jag, { race: 2, racing: true, replay: false });
  ok(got2 === jag && !st.cars.AUDI, 'a car-code change within a race, too, drops what was the other car\'s');
}

// 3. the Replay Menu and back: the menu's frames (the race's clock stopped, or a replay playing) are
// never learned as the cockpit; back driving with the clock running, the same race's memory still serves;
// a restarted race reuses nothing
section('3. the Replay Menu and back');
{
  const st = S.createState(), env = { race: 10, racing: true, replay: false };
  still(st, raceFrame('LANC', { top: 140, base: 60 }), env, 70);
  const learned = st.cars.LANC;
  ok(!!learned, 'the dash remembered before the menu');
  const menu = raceFrame('LANC', { top: 100, base: 150 });   // the menu panel where the dashboard was
  const last = still(st, menu, { race: 10, racing: false, replay: false }, 100);
  ok(st.cars.LANC === learned, 'the menu over the paused race (clock stopped) is never learned as the cockpit');
  ok(last === menu, 'while the menu shows, the sides follow the frame on screen, not the memory');
  still(st, raceFrame('LANC', { top: 110, base: 170 }), { race: 10, racing: true, replay: true }, 100);
  ok(st.cars.LANC === learned, 'a replay playing is never learned as the cockpit');
  const back = S.pick(st, raceFrame('LANC', { top: 140, base: 60 }), env);
  ok(back === learned, 'back driving, the clock running again, the same race keeps its memory');
  const re = raceFrame('LANC', { top: 140, base: 60 });
  const gotRe = S.pick(st, re, { race: 11, racing: true, replay: false });
  ok(gotRe === re && !st.cars.LANC, 'restarted from the menu (the clock began over), nothing of the old run is reused');
}

// 4. frames stopping and resuming: a stall resets the stillness count, the sides follow the visible
// frame while frames are stopped, and the count is worked out afresh from the frames after the stall
section('4. dropped frames and resume');
{
  const st = S.createState(), env = { race: 20, racing: true, replay: false };
  still(st, raceFrame('PMIN', { top: 130, base: 30 }), env, 40);
  ok(!st.cars.PMIN, 'not yet remembered before the stall');
  const dlg = raceFrame('PMIN', { top: 130, base: 30, popup: true });   // a dialog over the stalled picture
  ok(S.pick(st, dlg, { race: 20, racing: false, replay: false }) === dlg, 'frames stopped: the sides follow the visible frame, not a memory');
  ok(st.stable === 0, 'the stillness count starts over after a stall');
  still(st, raceFrame('PMIN', { top: 130, base: 30 }), env, 60);
  ok(!st.cars.PMIN, 'the count from before the stall is not carried over it');
  S.pick(st, raceFrame('PMIN', { top: 130, base: 30 }), env);
  ok(!!st.cars.PMIN, 'remembered once still again for a full second after resuming');
}

// 5. bad frames never throw, and a frame with no dashboard is never remembered (so "no dash" is never learned)
section('5. bad frames');
{
  const st = S.createState(), env = { race: 1, racing: true, replay: false };
  let threw = false;
  try {
    still(st, S.extract(new Uint8Array(W * H), rgb, KEY, 'XXXX', new Uint8Array(H), { l: 0, r: 318 }), env, 100);   // a blank screen
    still(st, S.extract(new Uint8Array(W * H).fill(KEY), rgb, KEY, 'XXXX', new Uint8Array(H).fill(1), { l: 0, r: 318 }), env, 100);   // all see-through
    still(st, S.extract(new Uint8Array(W * H).fill(255), rgb, KEY, '\0\0\0\0', new Uint8Array(H), { l: 0, r: 318 }), env, 100);   // garbage
  } catch (e) { threw = true; console.error(e); }
  ok(!threw, 'extract and pick never throw on garbage frames');
  ok(Object.keys(st.cars).length === 0, 'a frame with no dashboard is never remembered');
  ok(S.learnedTop(st, 'XXXX') === 0, 'no remembered height for a car never learned');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
