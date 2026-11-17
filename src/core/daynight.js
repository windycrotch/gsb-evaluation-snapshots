// Day/night clock: one observable value giving the position in the day, where 0 and 1 are both
// midnight and 0.5 is noon. It advances once per game frame (not from the wall clock), so indoor
// maps keep time as well, and a stalled frame or a backgrounded tab can only ever credit a bounded
// slice of time instead of skipping hours of sky in one step.
(function (G) {
  'use strict';

  // A full day maps onto 24 real hours, as the game's sky always has: 1 real second = 1 in-game
  // minute. Time comes from elapsed frames, though, never from reading the clock again.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const FRAME_MS = 1000 / 60;
  // A frame that represents more than this (a stall, a tab restored after minutes) only advances
  // the clock by this much. Time never catches up in one jump.
  const MAX_STEP_MS = 250;

  const wrap = v => { v %= 1; return v < 0 ? v + 1 : v; };

  // Start where the player's own local clock is, so the first screen matches the room, then drift
  // from there by frames alone.
  let day;
  try {
    const d = new Date();
    day = wrap((d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400);
  } catch (e) { day = 9 / 24; }
  if (!(day >= 0 && day < 1)) day = 9 / 24;

  // Read the current time of day: 0 = midnight, 0.5 = noon. Ticking always keeps it in [0, 1).
  function get() { return day; }
  // Set the time of day for debugging and tests. Values outside [0, 1] are clamped to the ends of
  // the day, so a round trip of any in-range value reads back exactly what was set.
  function set(v) {
    v = +v;
    if (!isFinite(v)) return day;
    day = v <= 0 ? 0 : v >= 1 ? 1 : v;
    return day;
  }
  // How much real time one frame is allowed to represent, given the raw gap since the last one.
  // A normal frame earns its own gap; a stall (and a tab restored after being hidden, which fires
  // no frames at all) earns at most MAX_STEP_MS instead of the whole gap.
  function credit(rawMs) {
    rawMs = +rawMs;
    if (!(rawMs > 0)) return FRAME_MS;
    return rawMs > MAX_STEP_MS ? MAX_STEP_MS : rawMs;
  }
  // Advance by one frame's worth of real time; the same cap applies again, so no path can skip
  // ahead. Called from the main loop (src/core/engine.js) once per step, whatever the map is.
  function tick(ms) {
    day = wrap(day + credit(ms) / DAY_MS);
    return day;
  }

  G.dayNight = { DAY_MS, FRAME_MS, MAX_STEP_MS, get, set, tick, credit };

  // Public debug/test surface: read and set the time of day as a number in [0, 1].
  G.getTimeOfDay = get;
  G.setTimeOfDay = set;

  // Derived visual phase used by the renderers: `night` 0..1 and `dusk` 0..1.
  G.timeOfDay = function () {
    const opt = G.state && G.state.options;
    if (opt && opt.dayNight === false) return { night: 0, dusk: 0 };
    const h = day * 24;
    const night = h >= 20 || h < 5 ? 1 : h >= 18 ? (h - 18) / 2 : h < 7 ? 1 - (h - 5) / 2 : 0;
    const dusk = h >= 16.5 && h < 20 ? Math.sin(Math.min(1, (h - 16.5) / 3) * Math.PI) : h >= 5 && h < 7.5 ? Math.sin(((h - 5) / 2.5) * Math.PI) * 0.7 : 0;
    return { night: Math.max(0, Math.min(1, night)), dusk };
  };
})(window.G);
