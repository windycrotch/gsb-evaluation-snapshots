/* Sedona Sunset — lateral confinement of the walk.
 *
 * The brief is a walk *up a wash between canyon walls*, and until this existed
 * the walls were scenery you passed through. Twenty-five metres of strafing —
 * sixteen seconds — put you inside the cliff, looking at its unlit maroon
 * interior; fifty put you on top of it on a bald plain; eighty out of the mouth
 * ran off the end of the built world entirely. A curious player reached the
 * first of those in under a minute.
 *
 * ── why a corridor and not mesh collision ─────────────────────────────────
 *
 * The wash already has a centreline and a width, and both are authored data
 * rather than something that has to be recovered: `WashPath` is the authority
 * for (s, u), and `Terrain.frame().ws` is the cross-section's talus toe, i.e.
 * the exact place the floor stops being floor. Confining |u| against that is a
 * table read and two multiplies per frame, against a BVH over a couple of
 * million triangles for the mesh alternative — and it has three properties the
 * mesh version does not:
 *
 *   - It cannot be climbed. A wall you collide with is a wall you can walk up
 *     if it has a talus pile against it, and this one has aprons all the way
 *     along both sides.
 *   - It cannot leak. There is no tunnelling case, no missing back face, and
 *     nothing to go wrong at the seam between the wall curtain and the apron.
 *   - It degrades softly. Velocity is bled off over the last metre and a half
 *     instead of being stopped dead against a plane, so what a player feels at
 *     the edge is the ground refusing rather than a box.
 *
 * ── where the limit sits ──────────────────────────────────────────────────
 *
 * Per side, per metre of arc length, the lesser of two readings:
 *
 *   - `frame().ws` plus a metre and a half. This is the wash's own width and it
 *     is what makes the corridor open out where the wash opens out and close
 *     down to a few metres at the head, without a hard-coded number anywhere.
 *   - Where the height field first stands `WALL_RISE` above the floor, less a
 *     clearance. This is the same question `rock.js` asks to seat the foot of
 *     the cliff, so it tracks the actual rock. It is a cap and not the primary
 *     reading, because `ws` can run past the toe on one side where the wall has
 *     been eaten into a bay.
 *
 * `WALL_RISE` is 4.5 m and that number is doing real work. Cut banks in this
 * wash reach 3.0 m, so a threshold anywhere below about 3.5 finds the bank
 * crest instead of the wall and pulls the corridor in to five or six metres in
 * places the wash is genuinely thirty across — which is the "invisible wall in
 * the playable middle" failure, arrived at from the cautious direction.
 *
 * ── what a player is allowed to feel ──────────────────────────────────────
 *
 * Nothing, while walking the walk. The player walks the centreline, where |u|
 * is zero and the nearest limit is the better part of ten metres away; measured
 * over the whole route the narrowest headroom is printed by
 * `tools/_corridor.mjs`. The limit is only reachable by deliberately walking at
 * a wall, which is exactly the population it is for.
 *
 * Determinism is preserved because the correction is applied to *velocity*, and
 * velocity is rebuilt from the key state every frame. At rest it is identically
 * zero, so the render loop is still a fixed point; `walkTo` places the player on
 * the centreline, so no capture ever touches this code path.
 */
import * as THREE from 'three';
/* The per-frame half of this file — `corridorAt` and `confine` — lives in
   confine.js, which imports nothing, so that src/motion.js can be loaded and
   driven in a bare Node process. Re-exported here so the existing callers and
   tools keep importing from one place. */
import { BAND, confine, corridorAt } from './confine.js';
export { BAND, confine, corridorAt };

/* Table spacing. One metre is far finer than anything in the cross-section —
   the narrowest term in `frame()` has a 30 m wavelength — so the table is a
   faithful sampling of the limit rather than an approximation of it. */
const STEP = 1.0;

/* Ground standing this far above the wash floor is the foot of a wall. Above
   the 3.0 m the cut banks reach; see the note at the top of the file. */
const WALL_RISE = 4.5;
/* How far short of that ground the limit sits, so the player is stopped on the
   floor rather than with their face in the slope. */
const CLEAR = 1.5;
/* Slack on the cross-section's own talus toe. The toe is where the floor ends,
   and standing on the very bottom of the apron is still standing in the wash. */
const SLACK = 1.5;

/* The march only has to answer "is there rock closer than the cross-section
   says", so it stops at the reading it is capping and never walks the full
   width of the corridor. That is most of the cost of building these tables. */
const MARCH_DS = 0.5;
const R_MIN = 5.0, R_MAX = 26.0;
/* Box radius in table cells. The two readings above are both noisy at the metre
   scale — one is an fbm sum, the other a threshold crossing on a rough surface
   — and an unsmoothed limit would catch and release as you slid along it. */
const SMOOTH = 3;

/* The soft band's width, `BAND`, is defined in confine.js alongside the
   arithmetic that uses it, because motion.js reads it too.
 *
 * Tried and rejected: a wider band while airborne, on the reasoning that a
   player in flight cannot steer away and so the band has to do its whole job
   against a fixed velocity. It works as arithmetic — the closest approach on a
   route jumped end to end goes from 1.63 m to 3.11 m — and it is wrong as
   design. Bleeding velocity 4 m out means jumping anywhere near a wall curves
   your arc, and the walker felt it on 1940 frames where it had felt nothing at
   all before. It also put the limit permanently out of reach, stopping the
   turbo tests 1.5 m short. Trading "3 cm from a threshold" for "the corridor
   now steers you in mid-air" is the wrong way round: the first is a thin margin
   on a benign outcome, the second is the exact intrusion this file exists to
   avoid. The margin was addressed in the test instead. */
/* How fast the player is returned if they are somehow already outside — the
   corridor narrowing ahead of them as they walk up-wash is the ordinary way
   that happens. Slow enough to read as being eased back rather than shoved. */
const RESTORE = 1.4;

/* How far behind the start of the walk a player may go. The path table itself
   runs out at z = 20, about twelve metres back, and the wall curtain's columns
   are stacked on the axis behind that — so the mouth has a real back to it and
   this stops short of where it stops being real. */
const S_BACK = -8.0;
/* And how far up. `WashPath.length` is 332.3 m and the head of the walk is the
   drainage col at about 330; `rock.js` ends its curtain six metres inside the
   same length for the same reason. */
const S_HEAD_MARGIN = 2.0;

function march(terrain, px, pz, nx, nz, want, max) {
  for (let a = MARCH_DS; a < max; a += MARCH_DS) {
    if (terrain.heightAt(px + nx * a, pz + nz * a) >= want) return a;
  }
  return max;
}

function boxSmooth(a) {
  const n = a.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0, w = 0;
    for (let k = -SMOOTH; k <= SMOOTH; k++) {
      const j = i + k < 0 ? 0 : i + k > n - 1 ? n - 1 : i + k;
      acc += a[j]; w++;
    }
    out[i] = acc / w;
  }
  return out;
}

/**
 * Build the corridor tables. Pure JavaScript over the height field, so it runs
 * headless in `tools/_corridor.mjs` and in `tools/_bootprobe.mjs` exactly as it
 * runs in the page.
 */
export function buildCorridor(path, terrain) {
  const sMin = S_BACK;
  const sMax = path.length - S_HEAD_MARGIN;
  const n = Math.ceil((sMax + 6 - sMin) / STEP) + 1;
  const rawL = new Float32Array(n), rawR = new Float32Array(n);

  const p = new THREE.Vector3(), q = {}, f = {};
  for (let i = 0; i < n; i++) {
    const s = sMin + i * STEP;
    path.posAt(s, p);
    path.atZ(p.z, q);
    terrain.frame(p.x, p.z, q, f);
    const th = path.headingAt(s);
    /* The wash's right-hand normal at this station, which is the +u direction
       `WashPath.uOf` measures against. */
    const nx = Math.cos(th), nz = Math.sin(th);
    const want = terrain.heightAt(p.x, p.z) + WALL_RISE;
    const wide = f.ws + SLACK;
    const reach = wide + CLEAR;
    const clampR = (d) => {
      const v = Math.min(wide, d - CLEAR);
      return v < R_MIN ? R_MIN : v > R_MAX ? R_MAX : v;
    };
    rawR[i] = clampR(march(terrain, p.x, p.z, nx, nz, want, reach));
    rawL[i] = clampR(march(terrain, p.x, p.z, -nx, -nz, want, reach));
  }

  return { sMin, sMax, step: STEP, n, L: boxSmooth(rawL), R: boxSmooth(rawR) };
}

