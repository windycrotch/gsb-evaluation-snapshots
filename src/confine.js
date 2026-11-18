/* Sedona Sunset — the wash's soft walls, dependency-free.
 *
 * This is the arithmetic half of `corridor.js`: everything that runs on the
 * player's velocity and position each frame. It lives in its own module, with no
 * imports at all, for one reason — the motion step in `src/motion.js` has to be
 * loadable in a bare Node process with no `three` and no DOM, so that the walk
 * can be driven frame by frame and tested without booting the scene. The tables
 * are still built by `corridor.js` (which needs `THREE.Vector3`); this file only
 * reads them.
 *
 * The reasoning behind the corridor — why a soft limit on the cross-section
 * rather than mesh collision, where the limit sits, and what a player is allowed
 * to feel — is in the header of `src/corridor.js` and is not repeated here.
 *
 * ── what "soft" means, exactly ────────────────────────────────────────────
 *
 * Every limit here is applied to *one component of velocity*: the component
 * pointing outward through that limit. The tangential component is never
 * touched. So at a side wall your sideways speed is bled off over the last
 * `BAND` metres while your walking speed up the wash is unchanged; at the head
 * or the mouth of the walk the along-wash component is bled off while
 * sidestepping is unchanged. A hard clamp would kill both and read as a box.
 */

/* Width of the soft zone, in metres. Walk into it and the outward half of your
   velocity is bled off across it, reaching zero at the limit itself. */
export const BAND = 1.6;
/* How fast the player is returned if they are somehow already outside — the
   corridor narrowing ahead of them as they walk up-wash is the ordinary way
   that happens. Slow enough to read as being eased back rather than shoved. */
const RESTORE = 1.4;

/**
 * Half-width of the corridor at arc length `s`, on `side` (+1 right, −1 left).
 * Pure table interpolation with both ends clamped. Rule 9 in CONTRACT.md is
 * about exactly this shape of accessor: the sample index is clamped at both
 * ends, and the `- 1.001` leaves the +1 neighbour inside the array.
 */
export function corridorAt(cor, s, side) {
  const a = side > 0 ? cor.R : cor.L;
  let f = (s - cor.sMin) / cor.step;
  f = f < 0 ? 0 : f > cor.n - 1.001 ? cor.n - 1.001 : f;
  const i = f | 0, t = f - i;
  return a[i] + (a[i + 1] - a[i]) * t;
}

/**
 * One frame of confinement, applied to the body's velocity before it is
 * integrated. `q` is the path frame already looked up for this position, so
 * this costs no extra table read.
 *
 * Mutates `body.vx`, `body.vz`, `body.x`, `body.z`, and returns a mask of which
 * limits engaged — 1 lateral, 2 along the wash. The game ignores it;
 * `tools/_walktest.mjs` needs the two apart, because a nudge at the head of the
 * walk is the walk ending and a nudge in the middle of it is a defect.
 *
 * `body` is deliberately duck-typed rather than a `player` object: `motion.js`
 * passes its own state straight through, and a test can pass a two-field stub.
 */
export function confine(cor, path, body, q, dt) {
  let hit = 0;
  const sin = Math.sin(q.th), cos = Math.cos(q.th);
  /* The wash's own frame at the body: right is +u, forward is +s. */
  const rx = cos, rz = sin;
  const fx = sin, fz = -cos;

  const u = (body.x - q.x) * cos;
  const side = u >= 0 ? 1 : -1;

  /* ── lateral ── */
  const lim = corridorAt(cor, q.s, side);
  const au = u < 0 ? -u : u;
  const t = (au - (lim - BAND)) / BAND;
  if (t > 0) {
    const g = t > 1 ? 1 : t;
    /* Outward-signed component of the velocity, in the corridor's own frame.
       Only this component is cut; the along-wash component is left alone. */
    const vOut = (body.vx * rx + body.vz * rz) * side;
    if (vOut > 0) {
      const cut = vOut * g;
      body.vx -= cut * side * rx;
      body.vz -= cut * side * rz;
      hit |= 1;
    }
    if (au > lim) {
      const back = Math.min(au - lim, RESTORE * dt);
      body.x -= back * side * rx;
      body.z -= back * side * rz;
      hit |= 1;
    }
  }

  /* ── along the wash ───────────────────────────────────────────────────────
   * The same treatment at both ends of the walk. Without it, turning round at
   * the start and walking gets you out of the mouth and onto ground the scene
   * never intended to be stood on — the walls simply end — and it is the
   * cheaper of the two failures to fix because there is nothing to collide
   * with there at all. Only the outward (along-wash) component is cut; a
   * sidestep at the head or the mouth is untouched. */
  for (const [edge, dir] of [[cor.sMin, -1], [cor.sMax, 1]]) {
    const d = (q.s - edge) * dir;          // positive = past the edge
    const ts = (d + BAND) / BAND;
    if (ts <= 0) continue;
    const g = ts > 1 ? 1 : ts;
    const vOut = (body.vx * fx + body.vz * fz) * dir;
    if (vOut > 0) {
      const cut = vOut * g;
      body.vx -= cut * dir * fx;
      body.vz -= cut * dir * fz;
      hit |= 2;
    }
    if (d > 0) {
      const back = Math.min(d, RESTORE * dt);
      body.x -= back * dir * fx;
      body.z -= back * dir * fz;
      hit |= 2;
    }
  }
  return hit;
}
