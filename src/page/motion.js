// Motion helpers for scene pages. Everything is a pure function of time, so frames can be drawn in any order.
// Served by the render server and the viewer at /__motlab/motion.js:
//
//   const { ease, cubicBezier, spring, tween, stagger, prog, motionBlur } = await import('/__motlab/motion.js');
//
// Times are in seconds. An easing takes 0..1 and returns 0..1 (a spring or "back" ease may pass 1 on the way).

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, k) => a + (b - a) * k;
export const prog = (t, a, b) => clamp((t - a) / (b - a));   // 0..1 between seconds a and b

const { PI, cos, sin, pow, sqrt, exp } = Math;
const outBounce = k => {
  const n = 7.5625, d = 2.75;
  if (k < 1 / d) return n * k * k;
  if (k < 2 / d) return n * (k -= 1.5 / d) * k + 0.75;
  if (k < 2.5 / d) return n * (k -= 2.25 / d) * k + 0.9375;
  return n * (k -= 2.625 / d) * k + 0.984375;
};
const B = 1.70158, B2 = B * 1.525;
export const ease = {
  linear: k => k,
  inSine: k => 1 - cos(k * PI / 2), outSine: k => sin(k * PI / 2), inOutSine: k => 0.5 - 0.5 * cos(PI * k),
  inQuad: k => k * k, outQuad: k => 1 - (1 - k) * (1 - k), inOutQuad: k => k < 0.5 ? 2 * k * k : 1 - pow(-2 * k + 2, 2) / 2,
  inCubic: k => k * k * k, outCubic: k => 1 - pow(1 - k, 3), inOutCubic: k => k < 0.5 ? 4 * k * k * k : 1 - pow(-2 * k + 2, 3) / 2,
  inQuart: k => k ** 4, outQuart: k => 1 - pow(1 - k, 4), inOutQuart: k => k < 0.5 ? 8 * k ** 4 : 1 - pow(-2 * k + 2, 4) / 2,
  inExpo: k => k <= 0 ? 0 : pow(2, 10 * k - 10), outExpo: k => k >= 1 ? 1 : 1 - pow(2, -10 * k),
  inOutExpo: k => k <= 0 ? 0 : k >= 1 ? 1 : k < 0.5 ? pow(2, 20 * k - 10) / 2 : (2 - pow(2, -20 * k + 10)) / 2,
  inBack: k => (B + 1) * k ** 3 - B * k * k, outBack: k => 1 + (B + 1) * pow(k - 1, 3) + B * pow(k - 1, 2),
  inOutBack: k => k < 0.5 ? (pow(2 * k, 2) * ((B2 + 1) * 2 * k - B2)) / 2 : (pow(2 * k - 2, 2) * ((B2 + 1) * (k * 2 - 2) + B2) + 2) / 2,
  outBounce,
};

// A CSS cubic-bezier(x1, y1, x2, y2) as an easing function, e.g. cubicBezier(0.2, 0.8, 0.2, 1).
export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = s => ((ax * s + bx) * s + cx) * s, Y = s => ((ay * s + by) * s + cy) * s, dX = s => (3 * ax * s + 2 * bx) * s + cx;
  return k => {
    if (k <= 0) return 0; if (k >= 1) return 1;
    let s = k;
    for (let i = 0; i < 8; i++) { const e = X(s) - k, d = dX(s); if (Math.abs(e) < 1e-7) return Y(s); if (Math.abs(d) < 1e-6) break; s -= e / d; }
    let lo = 0, hi = 1; s = k;   // Newton did not settle: bisect
    for (let i = 0; i < 40; i++) { const x = X(s); if (Math.abs(x - k) < 1e-7) break; if (x < k) lo = s; else hi = s; s = (lo + hi) / 2; }
    return Y(s);
  };
}
Object.assign(ease, { css: cubicBezier(0.25, 0.1, 0.25, 1), cssIn: cubicBezier(0.42, 0, 1, 1), cssOut: cubicBezier(0, 0, 0.58, 1), cssInOut: cubicBezier(0.42, 0, 0.58, 1) });

// A damped spring from 0 to 1, solved exactly (no stepping), so spring(cfg)(t) is the same in any frame order.
// stiffness, damping and mass as in Remotion and Framer Motion; velocity in units per second at t = 0.
// spring(cfg).duration is when it stays within 0.1% of 1 for good.
export function spring({ stiffness = 100, damping = 10, mass = 1, velocity = 0 } = {}) {
  const w0 = sqrt(stiffness / mass), zeta = damping / (2 * sqrt(stiffness * mass)), v0 = velocity, x0 = -1;
  let f;   // the offset from 1 is x(t), with x(0) = -1 and x'(0) = velocity
  if (Math.abs(zeta - 1) < 1e-9) {
    f = t => 1 + exp(-w0 * t) * (x0 + (v0 + w0 * x0) * t);
  } else if (zeta < 1) {
    const wd = w0 * sqrt(1 - zeta * zeta), A = x0, Bc = (v0 + zeta * w0 * x0) / wd;
    f = t => 1 + exp(-zeta * w0 * t) * (A * cos(wd * t) + Bc * sin(wd * t));
  } else {
    const r = sqrt(zeta * zeta - 1), s1 = -w0 * (zeta - r), s2 = -w0 * (zeta + r), c2 = (v0 - s1 * x0) / (s2 - s1), c1 = x0 - c2;
    f = t => 1 + c1 * exp(s1 * t) + c2 * exp(s2 * t);
  }
  const fn = t => t <= 0 ? 0 : f(t);
  let settle = 0; for (let t = 0; t < 30; t += 1 / 240) if (Math.abs(f(t) - 1) > 1e-3) settle = t;   // last time it was off by more than 0.1%
  fn.duration = settle + 1 / 240;
  return fn;
}

// Keyframes: tween(t, [[0, 0], [0.5, 100, ease.outCubic], [2, [1, 2]]]). Each key is [time, value, easing into it].
// Values are numbers or arrays of numbers (a position, a colour as [r, g, b]). Before the first key and after the last,
// the value holds.
export function tween(t, keys) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1, e = ease.inOutCubic] = keys[i];
    if (t < t1) {
      const [t0, v0] = keys[i - 1], k = e((t - t0) / (t1 - t0));
      return Array.isArray(v0) ? v0.map((a, j) => lerp(a, v1[j], k)) : lerp(v0, v1, k);
    }
  }
  return keys[keys.length - 1][1];
}

// Start time of item i in a staggered group: stagger(i, 0.06, 0.4). from 'end' or 'center' reorders the wave.
export function stagger(i, each, start = 0, { n = 0, from = 'start' } = {}) {
  const k = from === 'end' ? n - 1 - i : from === 'center' ? Math.abs(i - (n - 1) / 2) : i;
  return start + k * each;
}

// Motion blur: draws the frame `samples` times across the shutter and averages them on `canvas`.
// draw(time) must draw a whole frame onto `canvas` (opaque), and may be async. shutter is in seconds: half a frame
// (0.5 / fps) is the film look, and 8 to 12 samples hide the steps on fast moves (5 shows ghost copies).
let acc = null;
export async function motionBlur(canvas, t, draw, { samples = 8, shutter = 0.5 / 30, from = 0, to = Infinity } = {}) {
  if (samples <= 1) return draw(t);
  if (!acc || acc.width !== canvas.width || acc.height !== canvas.height) acc = Object.assign(document.createElement('canvas'), { width: canvas.width, height: canvas.height });
  const a = acc.getContext('2d'), c = canvas.getContext('2d');
  a.setTransform(1, 0, 0, 1, 0, 0);
  for (let i = 0; i < samples; i++) {
    await draw(clamp(t + (i / (samples - 1) - 0.5) * shutter, from, to));
    a.globalAlpha = 1 / (i + 1); a.drawImage(canvas, 0, 0);
  }
  a.globalAlpha = 1;
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'copy'; c.drawImage(acc, 0, 0); c.restore();
}
