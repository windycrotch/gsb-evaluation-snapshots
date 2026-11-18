/* Sedona Sunset — the walk, as a pure state machine.
 *
 * Everything that decides where the player is, how fast they are going,
 * whether they are in the air, how far the eye has dipped and where they are
 * looking now lives here, and nothing else in the project computes any of it.
 * `src/main.js` owns the keyboard, the scene and the camera, and every frame
 * it hands this module a fixed time step, the set of keys held down, and a
 * function that answers "what is the ground height at (x, z)?". It gets back a
 * complete, plain-JavaScript description of the walker.
 *
 * ── why it is split out ──────────────────────────────────────────────────
 *
 * Because a thing that can only be exercised by holding keys in a booted
 * browser cannot be tested, and the requirements on this movement are all
 * statements about sequences of frames: that standing still and pressing
 * nothing is a fixed point, that holding Space is one jump and not a pogo
 * stick, that a key held through a landing cannot re-trigger, that a step of
 * zero or negative time changes nothing, that a non-finite ground sample is
 * refused rather than propagated into the camera, that the dip the landing
 * hands the camera reaches exactly zero in finite time. All of those are
 * properties of `stepMotion` and are proven frame by frame in
 * `test/motion.test.mjs`, in Node, in under a second.
 *
 * ── the contract, precisely ──────────────────────────────────────────────
 *
 *   const { state, camera, error } =
 *     stepMotion(prevState, { dt, keys, yaw, pitch, groundAt, corridor, path });
 *
 * `state` holds only what the physics needs (position, velocity, airborne
 * flag, dip, bob phase, yaw, pitch, key-latch). `camera` holds what the eye
 * needs from it and nothing else — eye height above the feet, the dip, the
 * pitch — so that a consumer cannot accidentally use one as the other. The eye
 * offset and the pitch are computed independently and neither can move the
 * other; that is the requirement and it is also just true of the arithmetic.
 *
 * `error` is null on a good frame. When the height sampler returns a
 * non-finite number it is `'ground'`, the state is returned exactly as it
 * arrived (position, velocity, airborne flag and all), and the camera fields
 * describe the last good position — a NaN can never reach the eye.
 *
 * ── what has to stay true of the game, and is therefore here ─────────────
 *
 * The determinant, restated from main.js's original comments because it is the
 * thing most easily lost in a refactor: the render loop must be a fixed point
 * when no key is held. Velocity snaps to zero below a threshold rather than
 * decaying forever, the dip snaps to zero once it is small enough, and the
 * ground clamp is absolute rather than a spring. If any of those become
 * asymptotic, two identical capture requests stop producing identical pixels.
 */

/* ── imports ──────────────────────────────────────────────────────────────
 * One import, and it transitively imports nothing: the corridor arithmetic is
 * kept dependency-free in confine.js precisely so this file is loadable and
 * testable in a bare Node process. */
import { confine } from './confine.js';

/* ── the numbers ──────────────────────────────────────────────────────────
 * Every one of these is a property of a person walking, not a tuning knob, and
 * the comments say which measurement each is. They are exported so the tests
 * can assert against the same values the game uses rather than a copy. */

/** Metres per second on foot. A real walking pace; the brief asks for a walk. */
export const WALK_SPEED = 1.55;
/** Shift. A jog, about what you'd break into to cover ground. */
export const JOG_SPEED = 4.2;
/** Shift + Ctrl. A frank cheat for covering the wash quickly. */
export const SPRINT_SPEED = 12;
/** Eye height above the ground underfoot, metres. */
export const EYE = 1.65;

/** Gravity, m/s². */
export const G = 9.81;
/** Standing jump apex, metres. */
export const JUMP_H = 0.45;
/** v0 = sqrt(2 g h). Written this way so changing the apex cannot silently
 *  desynchronise it from gravity. */
export const JUMP_V = Math.sqrt(2 * G * JUMP_H);
/** Rate of the critically damped approach to the target ground velocity. */
export const ACCEL = 12;
/** Below this the horizontal speed is snapped to zero. A decaying exponential
 *  never arrives, and a never-resting player breaks pixel-identical recapture. */
export const REST_SNAP = 0.004;

/* The landing dip. A critically damped spring given an initial *velocity*
 * rather than a displacement: the impact hands the eye downward speed and the
 * legs arrest it, so the dip has a rise time and the amplitude scales with how
 * hard you land — peak dip is about 0.37 * v0 / w.
 *
 * Critical damping means no overshoot: the eye returns to level and does not
 * bounce past it. It is on height and not pitch, deliberately; the arrival
 * lift in main.js owns a bounded budget of pitch and a second writer to the
 * same quantity would compose into something neither of them describes. */
export const SETTLE_W = 8;
/** Fraction of impact speed the eye takes on. */
export const SETTLE_TRANSFER = 0.25;
/** m/s, so no fall can dip more than about 7 cm. */
export const SETTLE_VMAX = 1.5;
/** The dip is declared zero once it and its rate are both under this. */
export const SETTLE_EPS = 1e-4;

/* Head bob. Phase advances with distance walked, not with time, so it is a
 * function of where you are and not of how long you took to get there. */
export const BOB_AMP = 0.032;
export const BOB_RATE = 5.4;

/* ── keys ──────────────────────────────────────────────────────────────────
 * A plain object of the key codes the game listens for. Missing keys are
 * "up"; any truthy value is "down". The set that matters is small and fixed. */
export const KEY = Object.freeze({
  FORWARD: 'KeyW',
  BACK: 'KeyS',
  LEFT: 'KeyA',
  RIGHT: 'KeyD',
  SHIFT: 'ShiftLeft',
  CTRL: 'ControlLeft',
  JUMP: 'Space',
});

const isDown = (keys, code, alt) =>
  !!(keys && (keys[code] || (alt && keys[alt])));

/** A fresh, canonical rest state. `yaw` 0 looks straight down −Z (up-wash);
 *  `pitch` 0 is level. `y` should be the ground height at (x, z) — the caller
 *  knows the terrain, so this does not sample it. */
export function createState(x = 0, y = 0, z = 0, yaw = 0, pitch = 0) {
  return {
    x, y, z,
    vx: 0, vy: 0, vz: 0,
    air: false,
    settle: 0, settleV: 0,
    bob: 0, bobPhase: 0,
    yaw, pitch,
    /* The Space latch. `jumpHeld` is the previous frame's key state and is what
     * makes "one jump per press" a property of the step rather than of the
     * browser's key-repeat timing. It lives in the state so a driven replay is
     * reproducible from the state alone. */
    jumpHeld: false,
  };
}

/** Deep copy, so a caller can step without mutating the state it passed in and
 *  a rejected (non-finite) frame can be returned as the exact same values. */
export function cloneState(s) {
  return {
    x: s.x, y: s.y, z: s.z,
    vx: s.vx, vy: s.vy, vz: s.vz,
    air: s.air,
    settle: s.settle, settleV: s.settleV,
    bob: s.bob, bobPhase: s.bobPhase,
    yaw: s.yaw, pitch: s.pitch,
    jumpHeld: s.jumpHeld,
  };
}

/**
 * The eye, derived from a state. `eye` is the height of the eye above the
 * feet: standing eye height plus bob minus the landing dip. `pitch` is the
 * state's pitch, untouched by any of the above.
 */
export function cameraOf(state) {
  return {
    eye: EYE + state.bob - state.settle,
    bob: state.bob,
    settle: state.settle,
    pitch: state.pitch,
    yaw: state.yaw,
  };
}

const finite = Number.isFinite;

/**
 * One frame of the walk.
 *
 * @param {object}  prev   the state from the last frame (not mutated)
 * @param {object}  input
 * @param {number}  input.dt        seconds; must be finite and > 0 to move
 * @param {object}  [input.keys]    key-code → down, e.g. { KeyW: true }
 * @param {number}  [input.yaw]     facing, radians; defaults to prev.yaw
 * @param {number}  [input.pitch]   look angle, radians; defaults to prev.pitch
 * @param {function} input.groundAt (x, z) → ground height, metres
 * @param {object}  [input.corridor] confinement tables from corridor.js
 * @param {object}  [input.path]     the WashPath, needed only with a corridor
 * @returns {{ state: object, camera: object, error: string|null, hit: number }}
 */
export function stepMotion(prev, input) {
  const { dt, keys, groundAt } = input || {};
  const yaw = input && finite(input.yaw) ? input.yaw : prev.yaw;
  const pitch = input && finite(input.pitch) ? input.pitch : prev.pitch;
  const corridor = input && input.corridor;
  const path = input && input.path;

  /* A step that cannot move the body must not move anything else either, and
   * must not look at the ground: a caller who passes dt <= 0 has no interest
   * in terrain, and calling the sampler would let a NaN there reject a frame
   * that was never going to be simulated. This also keeps the jump latch as it
   * was, so a pause cannot eat a keypress. */
  if (!finite(dt) || dt <= 0) {
    const state = cloneState(prev);
    state.yaw = yaw;
    state.pitch = pitch;
    return { state, camera: cameraOf(state), error: null, hit: 0 };
  }

  /* ── the ground, once, after the move ───────────────────────────────────
   * The sampler is the one input that can hand us nonsense and it is also the
   * most expensive thing here (a full cross-section of the height field), so it
   * is asked exactly once per frame, at the column the player will occupy —
   * the same single lookup the grounded clamp has always done. Its answer is
   * checked before it is used. A refused frame is the *whole* previous state,
   * unchanged — including velocity and the airborne flag — so a single bad
   * sample cannot turn into a slow drift onto a hole. */
  const s = cloneState(prev);
  s.yaw = yaw;
  s.pitch = pitch;

  /* ── ground velocity ────────────────────────────────────────────────────
   * Forward is (sin yaw, −cos yaw), right is (cos yaw, sin yaw) — the same
   * convention the camera's yaw uses, so "forward" on the keyboard is the
   * direction the eye is pointing in the horizontal plane. */
  const f = (isDown(keys, KEY.FORWARD) ? 1 : 0) - (isDown(keys, KEY.BACK) ? 1 : 0);
  const r = (isDown(keys, KEY.RIGHT) ? 1 : 0) - (isDown(keys, KEY.LEFT) ? 1 : 0);
  const sprintHeld = isDown(keys, KEY.SHIFT, 'ShiftRight');
  const turbo = sprintHeld && isDown(keys, KEY.CTRL, 'ControlRight');
  const speed = turbo ? SPRINT_SPEED : sprintHeld ? JOG_SPEED : WALK_SPEED;

  let ax = 0, az = 0;
  if (f || r) {
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    ax = sy * f + cy * r;
    az = -cy * f + sy * r;
    const l = Math.hypot(ax, az) || 1;
    ax = ax / l * speed; az = az / l * speed;
  }

  /* Critically damped approach to the target velocity, on the ground only.
   * Airborne, the horizontal velocity is left exactly as the takeoff left it:
   * no air steering. That is both what a body does and the reason a jump
   * cannot be used to round the corridor. */
  if (!s.air) {
    const k = 1 - Math.exp(-ACCEL * dt);
    s.vx += (ax - s.vx) * k;
    s.vz += (az - s.vz) * k;
    if (!f && !r && Math.hypot(s.vx, s.vz) < REST_SNAP) { s.vx = 0; s.vz = 0; }
  }

  /* ── jump ───────────────────────────────────────────────────────────────
   * Only on the frame the key goes from up to down. The latch is in the state,
   * so holding Space is one jump and a key still down when you land is not a
   * second one — the rearm is the *release*, not the touchdown. This is the
   * whole of the anti-bunny-hop and it is a single boolean.
   *
   * The takeoff is also where a standstill jump gets its forward speed. A
   * person standing still who jumps forward is choosing a takeoff velocity
   * with their legs, not steering in the air; without it, jumping while
   * holding forward leaves the ground at one frame of acceleration (~0.15
   * m/s) and lands where it started. `max` with the speed already carried
   * means this can only ever raise a standstill to a walk, never add to a jog
   * or a sprint. */
  const jumpNow = isDown(keys, KEY.JUMP);
  if (jumpNow && !s.jumpHeld && !s.air) {
    s.air = true;
    s.vy = JUMP_V;
    const l = Math.hypot(ax, az);
    if (l) {
      const v = Math.max(Math.hypot(s.vx, s.vz), WALK_SPEED);
      s.vx = ax / l * v;
      s.vz = az / l * v;
    }
  }
  s.jumpHeld = jumpNow;

  /* ── confinement ────────────────────────────────────────────────────────
   * Runs airborne too, and it acts on velocity before integration, so it is a
   * pure function of the state and identically inert at rest. See confine.js
   * for why a soft limit on the cross-section and not collision. */
  let hit = 0;
  if (corridor && path && typeof path.atZ === 'function') {
    hit = confine(corridor, path, s, path.atZ(s.z, qFrame), dt);
  }

  s.x += s.vx * dt;
  s.z += s.vz * dt;

  /* ── vertical ───────────────────────────────────────────────────────────
   * The landing test is against the height under where you *now* are, not
   * where you took off. So an arc over rising ground lands early on the slope,
   * an arc over a drop falls the extra distance, and a jump that comes down on
   * terrain higher than its takeoff point simply lands sooner — no special
   * case, and no way for the ground clamp and the airborne branch to disagree:
   * both read the one sample `g1`. */
  const g1 = sample(groundAt, s.x, s.z);
  if (!finite(g1)) {
    /* The new column is unusable. Stay where we were rather than move onto a
     * hole: the previous position's ground was already known to be finite. */
    const state = cloneState(prev);
    state.yaw = yaw;
    state.pitch = pitch;
    return { state, camera: cameraOf(state), error: 'ground', hit: 0 };
  }

  if (s.air) {
    s.vy -= G * dt;
    s.y += s.vy * dt;
    if (s.y <= g1) {
      /* The impact is handed to the dip as a *speed*, so it scales with the
       * fall. `-vy` is positive on the way down. */
      const impact = -s.vy;
      s.y = g1;
      s.air = false;
      s.vy = 0;
      arrest(s, impact);
    }
  } else {
    s.y = g1;
  }

  /* ── the dip ────────────────────────────────────────────────────────────
   * A critically damped spring, integrated semi-implicitly at this step, and
   * snapped to exact zero once it is small enough that no eye could tell —
   * because "returns to zero in finite time" is a requirement of the contract
   * and a decaying exponential only approaches it. */
  if (s.settle || s.settleV) {
    const a = -SETTLE_W * SETTLE_W * s.settle - 2 * SETTLE_W * s.settleV;
    s.settleV += a * dt;
    s.settle += s.settleV * dt;
    if (Math.abs(s.settle) < SETTLE_EPS && Math.abs(s.settleV) < SETTLE_EPS) {
      s.settle = 0; s.settleV = 0;
    }
  }

  /* ── bob ────────────────────────────────────────────────────────────────
   * No head bob in the air: a body in flight is not taking steps. At rest the
   * phase and the offset both go to exactly zero, so a still frame is still. */
  const sp = s.air ? 0 : Math.hypot(s.vx, s.vz);
  if (sp < REST_SNAP) { s.bob = 0; }
  else {
    s.bobPhase += dt * sp * BOB_RATE;
    s.bob = Math.sin(s.bobPhase) * BOB_AMP;
  }

  return { state: s, camera: cameraOf(s), error: null, hit };
}

/** The knee bend: hand the eye a fraction of the impact speed. */
function arrest(s, impact) {
  if (!(impact > 0)) return;
  s.settleV += Math.min(impact, SETTLE_VMAX / SETTLE_TRANSFER) * SETTLE_TRANSFER;
}

/** Ask the sampler, and treat a throw the same as a non-finite answer: both
 *  mean "this frame cannot be simulated", and neither may escape to the eye. */
function sample(groundAt, x, z) {
  try { return groundAt(x, z); } catch (e) { return NaN; }
}

/* One scratch frame for the corridor lookup, so a step allocates no path
 * object. Module-level and reused; `atZ` fills it completely. */
const qFrame = {};
