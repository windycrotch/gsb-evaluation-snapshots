// Public, fixed Source-style tuning constants.
// Units: Source units (u). Time: seconds. The simulation never reads these
// from the DOM or from user input, so every platform simulates identically.

// Fixed simulation step: 128 Hz. Renderers may run at any frame rate; the
// accumulator in engine.js consumes frame time in whole STEP_SECONDS chunks.
export const TICK_RATE = 128;
export const STEP_SECONDS = 1 / TICK_RATE;

// Player/wish tuning (Source defaults, adapted to the 128 Hz step).
export const GRAVITY = 800;            // u/s^2, applied every airborne tick
export const JUMP_SPEED = 300;         // u/s, instantaneous upward velocity on jump
export const STOP_SPEED = 100;         // u/s, friction threshold (sv_stopspeed)
export const GROUND_FRICTION = 4;      // friction coefficient (sv_friction)
export const GROUND_ACCELERATE = 10;   // ground accel coefficient (sv_accelerate)
export const AIR_ACCELERATE = 100;     // air accel coefficient (sv_airaccelerate)
export const MAX_AIR_WISH_SPEED = 30;  // u/s, the hard air wish-speed cap (sv_air_max_wishspeed)
export const MAX_GROUND_WISH_SPEED = 320; // u/s, normal max ground run speed

// Mouse look: radians of yaw per pixel of horizontal mouse displacement.
// The sample/test harness uses the same constant, making results reproducible.
export const MOUSE_SENSITIVITY = 0.0022;

// Defensive clamp so a stuttering render frame cannot queue hundreds of ticks.
export const MAX_STEPS_PER_FRAME = 64;

// Flat test ground plane: z == GROUND_Z (player origin, no capsule in the
// minimal model — vertical motion is a point mass colliding with one plane).
export const GROUND_Z = 0;
