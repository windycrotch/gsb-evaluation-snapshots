// Pure Source-style movement functions. No DOM, no state mutation of anything
// other than the velocity vector handed in — these are the exact arithmetic the
// fixed-step engine runs, exposed separately so the rules are unit-testable.
//
// Reference order (the public Source movement model):
//   on ground:  JumpCheck (jump leaves before friction) -> Friction -> WalkMove
//   in air:     AirMove (no friction)
// Friction and the jump therefore settle in a fixed order every tick.

import {
  AIR_ACCELERATE,
  GROUND_ACCELERATE,
  GROUND_FRICTION,
  MAX_AIR_WISH_SPEED,
  STEP_SECONDS,
  STOP_SPEED,
} from './constants.js';

/**
 * Source friction: only ever *removes* horizontal speed, never adds it.
 * speed * max(1 - friction*dt, 0), with the stop-speed floor.
 * @param {{x:number,y:number}} vel horizontal velocity, mutated in place
 */
export function applyFriction(vel) {
  const speed = Math.hypot(vel.x, vel.y);
  if (speed === 0) return;
  const control = Math.max(speed, STOP_SPEED);
  const drop = control * GROUND_FRICTION * STEP_SECONDS;
  const scale = Math.max(speed - drop, 0) / speed;
  vel.x *= scale;
  vel.y *= scale;
}

/**
 * Source accelerate: wish speed in the player's wish direction is capped, but
 * the per-tick *gain* is not. When the wish direction is angled sideways to the
 * current velocity, addspeed stays positive even far above the wish cap, which
 * is the whole bunny-hop mechanic: sideways strafing keeps accumulating speed.
 *
 * @param {{x:number,y:number}} vel horizontal velocity, mutated in place
 * @param {{x:number,y:number}} wishDir unit wish-direction vector (zero if no keys)
 * @param {number} wishSpeed magnitude of the wish velocity, already capped by caller
 */
export function accelerate(vel, wishDir, wishSpeed) {
  if (wishSpeed === 0 || (wishDir.x === 0 && wishDir.y === 0)) return;
  // Current speed projected onto the wish direction.
  const currentSpeed = vel.x * wishDir.x + vel.y * wishDir.y;
  // How much additional speed in that direction the cap allows this tick.
  // NOTE: no clamp on the magnitude of the resulting velocity itself — a
  // sideways wishdir keeps addspeed > 0 at any total speed.
  const addspeed = wishSpeed - currentSpeed;
  if (addspeed <= 0) return;
  let accelspeed = GROUND_ACCELERATE * wishSpeed * STEP_SECONDS;
  if (accelspeed > addspeed) accelspeed = addspeed;
  vel.x += accelspeed * wishDir.x;
  vel.y += accelspeed * wishDir.y;
}

/**
 * Air movement: identical accelerate math, except the wish-speed magnitude is
 * hard-capped at 30 u/s. The cap is on the *wish* (desired) velocity, not on
 * the player's actual velocity, so real per-tick gains still accumulate.
 */
export function airAccelerate(vel, wishDir) {
  if (wishDir.x === 0 && wishDir.y === 0) return;
  const wishSpeed = MAX_AIR_WISH_SPEED;
  const currentSpeed = vel.x * wishDir.x + vel.y * wishDir.y;
  const addspeed = wishSpeed - currentSpeed;
  if (addspeed <= 0) return;
  let accelspeed = AIR_ACCELERATE * wishSpeed * STEP_SECONDS;
  if (accelspeed > addspeed) accelspeed = addspeed;
  // accelspeed itself is uncapped by total velocity; only addspeed bounds it.
  vel.x += accelspeed * wishDir.x;
  vel.y += accelspeed * wishDir.y;
}

/**
 * Build the ground/air wish-direction unit vector from movement keys and yaw.
 * Coordinates: +x is "north"/forward at yaw 0, +y is east. Positive yaw turns
 * clockwise (toward +y), matching a mouse moving right (positive movementX).
 *
 * @param {{forward:boolean,back:boolean,left:boolean,right:boolean}} keys
 * @param {number} yaw view yaw in radians
 * @returns {{x:number,y:number}} normalized wish dir, or {x:0,y:0} with no keys
 */
export function wishDirection(keys, yaw) {
  let f = 0;
  let s = 0;
  if (keys.forward) f += 1;
  if (keys.back) f -= 1;
  if (keys.right) s += 1;
  if (keys.left) s -= 1;
  if (f === 0 && s === 0) return { x: 0, y: 0 };
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  // forward = (cos, sin); right = 90 deg clockwise = (sin, -cos), so at
  // yaw 0: W -> +x, D -> +y, S -> -x, A -> -y.
  const wx = f * cos + s * sin;
  const wy = f * sin + s * cos;
  const len = Math.hypot(wx, wy);
  return { x: wx / len, y: wy / len };
}
