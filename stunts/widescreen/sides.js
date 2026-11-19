// The widescreen cockpit's memory (used by main.js's drawCurve): which rows of the 4:3 picture are the
// dashboard, and which columns of it are plain panel, carried out to the window's sides so the cockpit
// reads as one wide one. Kept apart from the drawing, as pure functions of a frame's snapshot, so the
// rules can be checked without the game (widescreen/test/sides.test.js):
//   - the sides and the centre picture come from the one snapshot of the screen, taken once per frame;
//     until a car's dash is remembered, the sides are the frame's own columns, nothing older
//   - a car's dash is remembered only while the picture stands still in a race under way: never in a
//     replay, and never while the race's clock is stopped (a menu or dialog over the paused race stops
//     it, so the menu's frame is never learned as the cockpit)
//   - the memory is per car and per race: another car's code, or the race's clock starting over, drops
//     it — one car's dash is never drawn beside another car, nor a finished race's beside a new one
'use strict';
const StuntsSides = (() => {
  // each car's dashboard: a column near each edge, picked by hand, that runs through plain panel only (no
  // gauges, vents or switches); its pixels and its neighbour's (the grain) are carried out to the sides.
  // Unknown (add-on) cars: the outermost columns (main.js's fallback, { l: 0, r: 318 })
  const DASH_COLS = { ANSX: { l: 5, r: 243 }, AUDI: { l: 33, r: 317 }, COUN: { l: 46, r: 314 }, FGTO: { l: 10, r: 301 }, JAGU: { l: 68, r: 294 },
    LANC: { l: 32, r: 269 }, LM02: { l: 7, r: 316 }, P962: { l: 1, r: 318 }, PC04: { l: 0, r: 244 }, PMIN: { l: 0, r: 310 }, VETT: { l: 42, r: 318 } };
  const COLS = ['l0', 'l1', 'r0', 'r1', 'e0', 'e1', 'f0', 'f1'];   // the columns a sample keeps: the dash's two per side, the roof strip's two per side
  // a second of identical frames at the display's pace: the picture is still, nothing is drawn over the dash
  const STABLE_FRAMES = 60;

  function createState() {
    return {
      cars: Object.create(null),   // car code -> the remembered sample (of this race only)
      race: -1,                    // the race those belong to (main.js counts the races as their clocks start over)
      code: null,                  // the car code last seen
      last: null,                  // the last frame's sample, for the stillness count
      stable: 0,                   // consecutive frames identical to it
    };
  }

  // two samples the same, pixel for pixel, in every column kept
  function sameSample(a, b) {
    if (!a || !b || a.code !== b.code || a.top !== b.top || a.roof !== b.roof) return false;
    for (const k of COLS) { const p = a[k], q = b[k]; for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false; }
    return true;
  }

  // one frame's sample, from the same snapshot of the screen the centre picture shows (main.js's scr):
  // the dashboard's top row and the roof strip's bottom (from dashRow, the rows the 3D view doesn't reach
  // across), and the plain-panel columns with their neighbours, as colours (see-through read as black)
  function extract(scr, rgb, KEY, code, dashRow, cols) {
    let top = 200; while (top > 0 && dashRow[top - 1]) top--;
    let roof = 0; while (roof < top && dashRow[roof]) roof++;
    const colOf = c => { const a = new Uint32Array(200); for (let y = 0; y < 200; y++) { const v = scr[y * 320 + c]; a[y] = v === KEY ? 0 : rgb[v]; } return a; };
    return { code, top, roof, l0: colOf(cols.l), l1: colOf(cols.l + 1), r0: colOf(cols.r), r1: colOf(cols.r - 1), e0: colOf(0), e1: colOf(1), f0: colOf(319), f1: colOf(318) };
  }

  // Which sample to draw the sides with this frame. now: this frame's, from extract. env:
  // { race: the race's number, racing: the race view live with its clock running, replay: a replay showing }
  function pick(state, now, env) {
    env = env || {};
    // not a race under way (a menu or dialog over the paused race, a replay, frames stopped): nothing is
    // learned, and nothing remembered is drawn — the sides follow the frame on screen, so where the centre
    // shows a menu the sides never keep a cockpit the race left behind
    if (!env.racing || env.replay) { state.last = null; state.stable = 0; return now; }
    if (env.race !== state.race || now.code !== state.code) {
      // a new race or another car: nothing from before is this car's — not the dashes remembered, and not
      // the stillness count (the frames it stood still for were the other car's, or the other race's)
      state.race = env.race; state.code = now.code;
      state.cars = Object.create(null); state.last = null; state.stable = 0;
    }
    state.stable = sameSample(state.last, now) ? state.stable + 1 : 0;
    state.last = now;
    // the first steady view only, on the start line: never replaced, a pop-up held up as long can't creep in
    // (only a real dash: the remembered setting turns it on before the game has drawn it, and "no dash" was learned)
    if (!state.cars[now.code] && state.stable >= STABLE_FRAMES && now.top < 190 && now.top > 60) state.cars[now.code] = now;
    return state.cars[now.code] || now;
  }

  // the remembered dash top for a car (0: none), for the rows above it carried out solid (drowning's water)
  function learnedTop(state, code) { const c = state.cars && state.cars[code]; return c ? c.top : 0; }

  return { DASH_COLS, STABLE_FRAMES, createState, sameSample, extract, pick, learnedTop };
})();
if (typeof self !== 'undefined') self.StuntsSides = StuntsSides;   // (a classic script: main.js finds it here)
if (typeof module !== 'undefined' && module.exports) module.exports = StuntsSides;   // (the checks, node)
