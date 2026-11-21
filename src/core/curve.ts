/**
 * Keyframe interpolation. Bezier segments are evaluated with the same 10-segment polyline approximation the
 * official Spine runtimes use, so what the editor shows is exactly what the game plays.
 */
import type { Curve, Key } from './model';

const BEZIER_SEGMENTS = 10;

/** Cached polylines: curve array -> per channel Float64Array(2 * (BEZIER_SEGMENTS + 1)) of (x,y) pairs in 0..1. */
const polyCache = new WeakMap<number[], Float64Array[]>();

/** Builds the polyline for one normalized bezier (x1,y1,x2,y2) the way Spine's CurveTimeline.setBezier does. */
function buildBezierPolyline(cx1: number, cy1: number, cx2: number, cy2: number): Float64Array {
  const out = new Float64Array((BEZIER_SEGMENTS + 1) * 2);
  // Key 1 is (0,0), key 2 is (1,1) in normalized space.
  const tmpx = (-cx1 * 2 + cx2) * 0.03;
  const tmpy = (-cy1 * 2 + cy2) * 0.03;
  const dddx = ((cx1 - cx2) * 3 + 1) * 0.006;
  const dddy = ((cy1 - cy2) * 3 + 1) * 0.006;
  let ddx = tmpx * 2 + dddx;
  let ddy = tmpy * 2 + dddy;
  let dx = cx1 * 0.3 + tmpx + dddx * 0.16666667;
  let dy = cy1 * 0.3 + tmpy + dddy * 0.16666667;
  let x = dx;
  let y = dy;
  out[0] = 0;
  out[1] = 0;
  for (let i = 2; i < BEZIER_SEGMENTS * 2; i += 2) {
    out[i] = x;
    out[i + 1] = y;
    dx += ddx;
    dy += ddy;
    ddx += dddx;
    ddy += dddy;
    x += dx;
    y += dy;
  }
  out[BEZIER_SEGMENTS * 2] = 1;
  out[BEZIER_SEGMENTS * 2 + 1] = 1;
  return out;
}

function polylineFor(curve: number[], channel: number): Float64Array {
  let list = polyCache.get(curve);
  if (!list) {
    list = [];
    polyCache.set(curve, list);
  }
  let p = list[channel];
  if (!p) {
    const i = channel * 4;
    p = buildBezierPolyline(curve[i], curve[i + 1], curve[i + 2], curve[i + 3]);
    list[channel] = p;
  }
  return p;
}

/** Evaluates a normalized polyline: returns y for the given x in 0..1. */
function evalPolyline(poly: Float64Array, x: number): number {
  const n = poly.length;
  for (let i = 2; i < n; i += 2) {
    if (poly[i] >= x) {
      const x0 = poly[i - 2];
      const y0 = poly[i - 1];
      const dx = poly[i] - x0;
      return dx > 0 ? y0 + ((x - x0) / dx) * (poly[i + 1] - y0) : poly[i + 1];
    }
  }
  return poly[n - 1];
}

/** y (0..1 progress) for a normalized bezier channel at time progress u. */
function evalBezierChannel(curve: number[], channel: number, u: number): number {
  return evalPolyline(polylineFor(curve, channel), u);
}

export function findKeyIndex(keys: ReadonlyArray<{ time: number }>, time: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].time <= time) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return idx;
}

/** Progress (0..1) of `time` between keys i and i+1 after applying the key's curve for `channel`. */
export function segmentProgress(curve: Curve | undefined, channel: number, u: number): number {
  if (curve === undefined) return u;
  if (curve === 'stepped') return 0;
  return evalBezierChannel(curve, channel, u);
}

/**
 * Samples a keyframe timeline. Returns false when `time` is before the first key (the caller then keeps the setup value).
 * `out` receives one number per channel.
 */
export function sampleKeys(keys: ReadonlyArray<Key>, time: number, out: number[]): boolean {
  const i = findKeyIndex(keys, time);
  if (i < 0) return false;
  const k = keys[i];
  const n = k.value.length;
  if (i === keys.length - 1 || k.curve === 'stepped') {
    for (let c = 0; c < n; c++) out[c] = k.value[c];
    return true;
  }
  const k2 = keys[i + 1];
  const dt = k2.time - k.time;
  const u = dt > 0 ? (time - k.time) / dt : 0;
  for (let c = 0; c < n; c++) {
    const p = segmentProgress(k.curve, c, u);
    out[c] = k.value[c] + (k2.value[c] - k.value[c]) * p;
  }
  return true;
}

/** Linear progress between two scalar keys for deform-style timelines (single shared curve = channel 0). */
export function deformProgress(k: Key, u: number): number {
  return segmentProgress(k.curve, 0, u);
}

/** Normalized bezier -> absolute control points for one channel (what Spine JSON stores). */
export function curveToAbsolute(
  curve: number[],
  channel: number,
  t1: number,
  v1: number,
  t2: number,
  v2: number,
): [number, number, number, number] {
  const i = channel * 4;
  const dt = t2 - t1;
  const dv = v2 - v1;
  return [t1 + curve[i] * dt, v1 + curve[i + 1] * dv, t1 + curve[i + 2] * dt, v1 + curve[i + 3] * dv];
}

/** Absolute control points -> normalized. */
export function curveFromAbsolute(c: ArrayLike<number>, t1: number, v1: number, t2: number, v2: number): [number, number, number, number] {
  const dt = t2 - t1;
  const dv = v2 - v1;
  const x1 = dt !== 0 ? (c[0] - t1) / dt : 0;
  const x2 = dt !== 0 ? (c[2] - t1) / dt : 1;
  const y1 = dv !== 0 ? (c[1] - v1) / dv : x1;
  const y2 = dv !== 0 ? (c[3] - v1) / dv : x2;
  return [x1, y1, x2, y2];
}

export const CURVE_PRESETS: Record<string, [number, number, number, number]> = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
  /** Flat handles at both ends: the value holds at each key and moves between them. */
  flat: [1 / 3, 0, 2 / 3, 1],
  overshoot: [0.34, 1.56, 0.64, 1],
  anticipate: [0.36, 0, 0.66, -0.56],
};

/** Builds a curve array with the same preset applied to `channels` channels. */
export function presetCurve(p: [number, number, number, number], channels: number): number[] {
  const out: number[] = [];
  for (let c = 0; c < channels; c++) out.push(...p);
  return out;
}
