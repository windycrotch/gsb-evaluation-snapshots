// Simulation constants. The sim is pure data + numbers (no three.js) so it can run headless,
// be replayed deterministically, and later be driven by networked inputs.

export const ARENA_R = 17; // playable radius (fighters are clamped inside, the barrier sits here)
export const GRAVITY = 34;
export const FIGHTER_R = 0.85; // body collision radius
export const CHEST_Y = 1.05; // height of the hurt sphere centre
export const HURT_R = 1.0;

export const MAX_HP = 100;
export const MAX_ENERGY = 100;
export const MAX_STAMINA = 100;

export const BTN = {
  LIGHT: 1,
  HEAVY: 2,
  S1: 4,
  S2: 8,
  ULT: 16,
  BLOCK: 32,
  DASH: 64,
  JUMP: 128,
};

export const ST = {
  IDLE: 0, // grounded, free (standing or moving)
  AIR: 1, // jumping / falling, free
  DASH: 2,
  ATTACK: 3, // any move (normals, specials, ultimate)
  BLOCK: 4,
  HIT: 5, // grounded hitstun
  LAUNCH: 6, // airborne knockback
  DOWN: 7, // on the floor
  GETUP: 8,
  STUN: 9, // parried / guard broken
  CLASH: 10, // locked in a beam struggle
  KO: 11,
  WIN: 12,
  INTRO: 13,
};

export const DIFFICULTIES = ['easy', 'normal', 'hard', 'nightmare'];
