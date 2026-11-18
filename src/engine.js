// Fixed-step (128 Hz) simulation engine with a frame-time accumulator.
//
// Contract:
//   * frame(dt, input) adds dt to an accumulator, then runs whole
//     STEP_SECONDS physics steps; the leftover time stays for the next frame.
//     Rendering frame rate therefore never changes physics results.
//   * A frame's mouse displacement is split EVENLY across the physics steps
//     that frame drives. A frame that drives zero steps defers its mouse
//     displacement into the pool consumed by a later frame.
//   * The jump key is an edge. It fires at a 0-based tick offset within the
//     frame (offset 0 for live browser input; the scripted harness sets the
//     offset so an edge resolves on the same physical tick at every rate).
//   * renderState(alpha) interpolates display-only state between the last two
//     ticks; it never writes back into the simulation.

import {
  GRAVITY,
  GROUND_Z,
  JUMP_SPEED,
  MAX_GROUND_WISH_SPEED,
  MAX_STEPS_PER_FRAME,
  MOUSE_SENSITIVITY,
  STEP_SECONDS,
} from './constants.js';
import { accelerate, airAccelerate, applyFriction, wishDirection } from './physics.js';

const NO_KEYS = { forward: false, back: false, left: false, right: false };
const EPS = 1e-12;

function cloneKeys(k) {
  return {
    forward: !!k.forward,
    back: !!k.back,
    left: !!k.left,
    right: !!k.right,
  };
}

export class PhysicsEngine {
  /**
   * @param {object} [initial]
   * @param {{x:number,y:number,z:number}} [initial.position]
   * @param {{x:number,y:number,z:number}} [initial.velocity]
   * @param {number} [initial.yaw] radians
   * @param {boolean} [initial.autoHop] auto re-jump on the landing tick
   */
  constructor(initial = {}) {
    this.reset(initial);
  }

  reset(initial = {}) {
    const p = initial.position || { x: 0, y: 0, z: GROUND_Z };
    const v = initial.velocity || { x: 0, y: 0, z: 0 };
    this.pos = { x: p.x, y: p.y, z: p.z };
    this.vel = { x: v.x, y: v.y, z: v.z };
    this.yaw = initial.yaw ?? 0;
    this.autoHop = initial.autoHop ?? true;
    this.grounded = this.pos.z <= GROUND_Z + EPS && this.vel.z <= 0;

    this.accumulator = 0;       // unconsumed frame time, seconds
    this.pendingMouseDX = 0;    // mouse displacement not yet spread over ticks
    this.jumpQueued = false;    // unpressed jump edge waiting for its tick
    this.jumpOffset = 0;        // tick offset within a frame where the edge fires
    this.stepCount = 0;
    this.time = 0;

    this.current = this._snapshot(false, false, false);
    this.previous = this.current;
    this.lastFrame = { steps: 0, remainder: 0, perStepMouseDX: 0 };
  }

  _snapshot(landed, jumped, perStepMouseDX) {
    return {
      step: this.stepCount,
      time: this.time,
      position: { ...this.pos },
      velocity: { ...this.vel },
      // Horizontal speed is what bunny-hop chains actually accumulate.
      horizontalSpeed: Math.hypot(this.vel.x, this.vel.y),
      yaw: this.yaw,
      grounded: this.grounded,
      landed,        // this tick ended in a ground collision
      jumped,        // a jump (manual or auto) started this tick
      mouseDX: perStepMouseDX,
    };
  }

  /**
   * Advance one fixed 128 Hz tick. Input is the per-tick slice already
   * derived by frame() — callers should normally use frame(), not step().
   *
   * Fixed settlement order every tick:
   *   1. mouse look (yaw)
   *   2. wish direction from keys + yaw
   *   3. ground branch: jump check FIRST (a jumping tick skips friction),
   *      then friction, then ground acceleration; air branch: air accelerate
   *   4. gravity (air only)
   *   5. integrate position
   *   6. ground plane collision -> possible landing
   *   7. auto-hop: re-jump on the landing tick, direction untouched
   */
  step(tickInput) {
    const { mouseDX, keys, jumpPressed } = tickInput;
    this.previous = this.current;

    // 1. Mouse look.
    this.yaw += mouseDX * MOUSE_SENSITIVITY;

    // 2. Wish direction in world space.
    const wish = wishDirection(keys, this.yaw);

    let jumped = false;

    // 3. Movement branch, fixed order: jump check before friction on ground.
    // frame() owns edge timing (including within-frame offsets); step() only
    // trusts the explicit jumpPressed it is handed for this tick. A press
    // while airborne simply does nothing — no buffering, no ghost jump later.
    const wantsJump = jumpPressed;
    if (this.grounded) {
      if (wantsJump) {
        // Jump leaves the ground this tick; no friction is applied.
        this.grounded = false;
        this.vel.z = JUMP_SPEED;
        jumped = true;
        airAccelerate(this.vel, wish);
      } else {
        applyFriction(this.vel);
        accelerate(this.vel, wish, MAX_GROUND_WISH_SPEED);
      }
    } else {
      // Air: no friction, wish speed hard-capped at 30 u/s inside.
      airAccelerate(this.vel, wish);
    }

    // 4. Gravity for anything not supported by the ground. A resting player
    //    (z on the plane, no jump) stays supported and never sinks.
    if (!this.grounded) {
      this.vel.z -= GRAVITY * STEP_SECONDS;
    }

    // 5. Integrate.
    this.pos.x += this.vel.x * STEP_SECONDS;
    this.pos.y += this.vel.y * STEP_SECONDS;
    this.pos.z += this.vel.z * STEP_SECONDS;

    // 6. Flat ground-plane collision. Only a genuinely airborne body moving
    //    down through the plane counts as a landing; resting contact is not a
    //    landing and must not trigger auto-hop.
    let landed = false;
    if (!this.grounded && this.pos.z <= GROUND_Z) {
      this.pos.z = GROUND_Z;
      if (this.vel.z <= 0) {
        landed = true;
        this.vel.z = 0;
        this.grounded = true;
      }
    }

    // 7. Auto-hop does exactly one thing: re-jump on the landing tick.
    //    Horizontal velocity and yaw are deliberately untouched. A manual jump
    //    that already happened this tick takes priority, so it can't double up.
    if (landed && this.autoHop && !jumped) {
      this.grounded = false;
      this.vel.z = JUMP_SPEED;
      jumped = true;
    }

    this.stepCount += 1;
    this.time = this.stepCount * STEP_SECONDS;
    this.current = this._snapshot(landed, jumped, mouseDX);
    return this.current;
  }

  /**
   * Consume one renderer frame.
   * @param {object} frameInput
   * @param {number} frameInput.dt frame duration in seconds
   * @param {number} frameInput.mouseDX horizontal mouse displacement this frame
   * @param {object} [frameInput.keys] held movement keys
   * @param {boolean} [frameInput.jumpPressed] jump edge fired this frame
   * @param {number} [frameInput.jumpTickOffset] 0-based tick offset within the frame where the edge fires (harness use; live input uses 0)
   * @returns {{steps:number, remainder:number, perStepMouseDX:number, records:object[]}}
   */
  frame(frameInput) {
    const dt = Math.min(Math.max(frameInput.dt, 0), MAX_STEPS_PER_FRAME * STEP_SECONDS);
    const keys = cloneKeys(frameInput.keys || NO_KEYS);

    this.accumulator += dt;
    this.pendingMouseDX += frameInput.mouseDX || 0;
    // Jump edges carry their position WITHIN the frame (0-based tick offset).
    // The harness buckets the same canonical tick schedule at every renderer
    // rate, so an edge on tick 32 lands at offset 0 at 128 Hz (one-tick frame)
    // and offset 1 at 64 Hz (frame covering ticks 31..32) — both resolve on
    // physical tick 32. Live browser input always uses offset 0.
    if (frameInput.jumpPressed) {
      this.jumpQueued = true;
      this.jumpOffset = Math.min(
        Math.max(Math.floor(frameInput.jumpTickOffset || 0), 0),
        MAX_STEPS_PER_FRAME - 1,
      );
    }

    let steps = Math.floor(this.accumulator / STEP_SECONDS + EPS);
    if (steps > MAX_STEPS_PER_FRAME) steps = MAX_STEPS_PER_FRAME;

    // Even split of the pooled mouse displacement across every driven tick.
    const perStepMouseDX = steps > 0 ? this.pendingMouseDX / steps : 0;
    const records = [];

    for (let i = 0; i < steps; i++) {
      // The edge fires only when the tick index reaches its stored offset;
      // checking the offset first means a queued edge cannot fire early.
      const jumpPressed = this.jumpQueued && i === this.jumpOffset;
      if (jumpPressed) this.jumpQueued = false;
      records.push(this.step({ mouseDX: perStepMouseDX, keys, jumpPressed }));
    }
    // An edge whose offset lies beyond this (short) frame waits for the next
    // frame; its offset is re-based to the remaining ticks there.
    if (this.jumpQueued && this.jumpOffset >= steps) {
      this.jumpOffset -= steps;
    }

    // Whole steps are consumed; leftover time (and, if no tick ran, the mouse
    // displacement and any jump edge) carry over to the next frame unchanged.
    this.accumulator -= steps * STEP_SECONDS;
    if (steps > 0) this.pendingMouseDX = 0;

    this.lastFrame = { steps, remainder: this.accumulator, perStepMouseDX };
    return { ...this.lastFrame, records };
  }

  /**
   * Display-only interpolated state between the previous and current tick.
   * alpha in [0,1] is accumulator / STEP_SECONDS. Pure: the sim is untouched,
   * so interpolation can never alter the physics trajectory.
   */
  renderState(alpha) {
    const a = Math.min(Math.max(alpha, 0), 1);
    const p = this.previous;
    const c = this.current;
    // Shortest-path yaw interpolation.
    let dYaw = c.yaw - p.yaw;
    while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
    while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
    return {
      position: {
        x: p.position.x + (c.position.x - p.position.x) * a,
        y: p.position.y + (c.position.y - p.position.y) * a,
        z: p.position.z + (c.position.z - p.position.z) * a,
      },
      velocity: { ...c.velocity },
      horizontalSpeed: c.horizontalSpeed,
      yaw: p.yaw + dYaw * a,
      grounded: c.grounded,
      step: c.step,
    };
  }

  get alpha() {
    return this.accumulator / STEP_SECONDS;
  }
}
