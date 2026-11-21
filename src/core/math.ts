/** Small math helpers shared by core, renderer and editor. Angles are degrees, y axis points up (Spine convention). */

/**
 * Spine's `MathUtils.PI`: a float32 pi. The official runtimes convert degrees with it (radDeg = 180 / PI), so using the
 * same constants keeps knife-edge cases identical (e.g. a folded two-bone IK sits exactly on a ±180° wrap).
 */
export const SPINE_PI = 3.1415927;
export const DEG2RAD = SPINE_PI / 180;
export const RAD2DEG = 180 / SPINE_PI;
export const INV_PI2 = 1 / (SPINE_PI * 2);
export const EPS = 0.00001;
/** Two times or values closer than this are the same one (keys, markers, loop ends). */
export const SAME_EPS = 1e-6;
export const EPS2 = EPS * EPS;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function atan2Deg(y: number, x: number): number {
  return Math.atan2(y, x) * RAD2DEG;
}

export function signum(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** Wraps degrees into (-180, 180]. */
export function wrapAngle(deg: number): number {
  deg %= 360;
  if (deg > 180) deg -= 360;
  else if (deg <= -180) deg += 360;
  return deg;
}

/** Squared distance from point p to segment ab. */
export function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = clamp(t, 0, 1);
  const x = ax + dx * t - px;
  const y = ay + dy * t - py;
  return x * x + y * y;
}

/** Barycentric point-in-triangle test. */
export function pointInTriangle(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

export function pointInPolygon(px: number, py: number, poly: ArrayLike<number>): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2],
      yi = poly[i * 2 + 1];
    const xj = poly[j * 2],
      yj = poly[j * 2 + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 2x3 affine matrix: world = [a b; c d] * p + [x y]. Same layout Spine uses for bone world transforms. */
export interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  x: number;
  y: number;
}

export function matApply(m: Mat, px: number, py: number, out: [number, number] = [0, 0]): [number, number] {
  out[0] = m.a * px + m.b * py + m.x;
  out[1] = m.c * px + m.d * py + m.y;
  return out;
}

export function matInvert(m: Mat): Mat {
  const det = m.a * m.d - m.b * m.c;
  const id = Math.abs(det) <= EPS2 ? 0 : 1 / det;
  const a = m.d * id;
  const b = -m.b * id;
  const c = -m.c * id;
  const d = m.a * id;
  return { a, b, c, d, x: -(a * m.x + b * m.y), y: -(c * m.x + d * m.y) };
}

/** Returns parent * child. */
export function matMul(p: Mat, c: Mat): Mat {
  return {
    a: p.a * c.a + p.b * c.c,
    b: p.a * c.b + p.b * c.d,
    c: p.c * c.a + p.d * c.c,
    d: p.c * c.b + p.d * c.d,
    x: p.a * c.x + p.b * c.y + p.x,
    y: p.c * c.x + p.d * c.y + p.y,
  };
}

export function parseNumberExpr(src: string, current: number): number | null {
  // Tiny safe evaluator for numeric fields: supports + - * / ( ) , `v` (current value) and a leading operator (+=, -=, *=, /=).
  // the signs of the keyboard and the ones people type from a calculator: × ÷ and the true minus
  let s = src.trim().replace(/,/g, '.').replace(/×/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-');
  if (!s) return null;
  const m = /^([+\-*/])=\s*(.+)$/.exec(s);
  if (m) s = `v ${m[1]} (${m[2]})`;
  if (!/^[0-9a-zv+\-*/().\s]*$/i.test(s)) return null;
  const tokens = s.match(/\d*\.?\d+(?:e[+-]?\d+)?|[a-z]+|[+\-*/()]/gi);
  if (!tokens) return null;
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const parseExpr = (): number => {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const parseTerm = (): number => {
    let v = parseUnary();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const r = parseUnary();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const parseUnary = (): number => {
    if (peek() === '-') {
      next();
      return -parseUnary();
    }
    if (peek() === '+') {
      next();
      return parseUnary();
    }
    return parseAtom();
  };
  const parseAtom = (): number => {
    const t = next();
    if (t === undefined) throw new Error('eof');
    if (t === '(') {
      const v = parseExpr();
      if (next() !== ')') throw new Error('paren');
      return v;
    }
    if (/^[a-z]+$/i.test(t)) {
      const name = t.toLowerCase();
      if (name === 'v' || name === 'value') return current;
      if (name === 'pi') return Math.PI;
      throw new Error('ident');
    }
    const n = Number(t);
    if (Number.isNaN(n)) throw new Error('num');
    return n;
  };
  try {
    const v = parseExpr();
    if (pos !== tokens.length || !Number.isFinite(v)) return null;
    return v;
  } catch {
    return null;
  }
}
