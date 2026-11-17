// Small math toolkit shared by the simulation (which must stay three.js-free) and presentation.

export const PI = Math.PI;
export const TAU = Math.PI * 2;

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const remap = (x, a, b, c, d) => c + (d - c) * sat((x - a) / (b - a));
export const smoothstep = (a, b, x) => {
  const t = sat((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
// Frame-rate independent exponential approach.
export const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));

export const angleDelta = (from, to) => {
  let d = (to - from) % TAU;
  if (d > PI) d -= TAU;
  if (d < -PI) d += TAU;
  return d;
};
export const dampAngle = (a, b, lambda, dt) => a + angleDelta(a, b) * (1 - Math.exp(-lambda * dt));
export const turnToward = (a, b, maxStep) => {
  const d = angleDelta(a, b);
  return a + clamp(d, -maxStep, maxStep);
};

export const ease = {
  outCubic: (t) => 1 - Math.pow(1 - sat(t), 3),
  inCubic: (t) => Math.pow(sat(t), 3),
  outQuint: (t) => 1 - Math.pow(1 - sat(t), 5),
  inQuad: (t) => sat(t) * sat(t),
  outQuad: (t) => 1 - (1 - sat(t)) * (1 - sat(t)),
  inOut: (t) => {
    t = sat(t);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  },
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * sat(t))),
  outBack: (t) => {
    const c1 = 1.70158, c3 = c1 + 1;
    t = sat(t);
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};

// 0 → 1 → 0 pulse over [a, b] with separate attack/release shaping.
export const pulse = (t, a, peak, b) => {
  if (t <= a || t >= b) return 0;
  return t < peak ? ease.outCubic((t - a) / (peak - a)) : 1 - ease.inOut((t - peak) / (b - peak));
};

// Deterministic PRNG (mulberry32). Everything random in sim and presentation goes through one of these.
export class RNG {
  constructor(seed = 1) {
    this.s = seed >>> 0 || 1;
  }
  next() {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) {
    return a + (b - a) * this.next();
  }
  int(a, b) {
    return Math.floor(this.range(a, b + 1));
  }
  sign() {
    return this.next() < 0.5 ? -1 : 1;
  }
  chance(p) {
    return this.next() < p;
  }
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }
}

export const hash1 = (n) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
};

// Smooth 1D value noise in [-1, 1]; used for camera shake and idle motion.
export const noise1 = (t, seed = 0) => {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash1(i + seed * 57.3), hash1(i + 1 + seed * 57.3), u) * 2 - 1;
};

// Critically damped-ish spring for secondary motion channels.
export class Spring {
  constructor(x = 0, stiffness = 180, damping = 22) {
    this.x = x;
    this.v = 0;
    this.k = stiffness;
    this.c = damping;
  }
  step(target, dt) {
    // Semi-implicit Euler, sub-stepped so stiff springs stay stable at any frame dt.
    const n = Math.max(1, Math.ceil(dt / 0.004));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (this.k * (target - this.x) - this.c * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  snap(x) {
    this.x = x;
    this.v = 0;
  }
}
