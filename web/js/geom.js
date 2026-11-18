// Small 2D geometry toolbox (polylines as arrays of [x, y]).

export const DEG = Math.PI / 180;

export function applyTf(pts, tf) {
  const c = Math.cos((tf.rot || 0) * DEG), s = Math.sin((tf.rot || 0) * DEG), k = tf.s ?? 1;
  return pts.map(([x, y]) => [tf.x + k * (c * x - s * y), tf.y + k * (s * x + c * y)]);
}

export function invTf(p, tf) {
  const c = Math.cos(-(tf.rot || 0) * DEG), s = Math.sin(-(tf.rot || 0) * DEG), k = tf.s ?? 1;
  const x = (p[0] - tf.x) / k, y = (p[1] - tf.y) / k;
  return [c * x - s * y, s * x + c * y];
}

export function polyLength(p) {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return L;
}

export function bbox(lines) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of lines) for (const [x, y] of (l.pts || l)) {
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

// Ramer-Douglas-Peucker
export function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let t = ((px - ax) * dx + (py - ay) * dy) / L2;
      t = Math.max(0, Math.min(1, t));
      const qx = ax + t * dx - px, qy = ay + t * dy - py;
      const d = qx * qx + qy * qy;
      if (d > md) { md = d; mi = i; }
    }
    if (md > t2) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export function chaikin(pts, iters = 1, closed = false) {
  let p = pts;
  for (let it = 0; it < iters; it++) {
    if (p.length < 3) return p;
    const q = closed ? [] : [p[0]];
    const n = p.length;
    const m = closed ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const a = p[i], b = p[(i + 1) % n];
      q.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      q.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    if (!closed) q.push(p[n - 1]);
    p = q;
  }
  return p;
}

// Resample a polyline to (roughly) uniform spacing.
export function resample(pts, step, closed = false) {
  if (pts.length < 2 || !(step > 0)) return pts;
  const src = closed ? [...pts, pts[0]] : pts;
  const out = [src[0]];
  let carry = 0;
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1], b = src[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    if (L === 0) continue;
    let t = step - carry;
    while (t <= L) { out.push([a[0] + dx * t / L, a[1] + dy * t / L]); t += step; }
    carry = L - (t - step);
  }
  const last = src[src.length - 1];
  if (closed) { if (out.length > 2 && Math.hypot(out[out.length - 1][0] - last[0], out[out.length - 1][1] - last[1]) < step * 0.5) out.pop(); }
  else if (Math.hypot(out[out.length - 1][0] - last[0], out[out.length - 1][1] - last[1]) > 1e-6) out.push(last);
  return out;
}

// Taubin (λ|μ) smoothing: removes small wiggles without shrinking the shape.
// strength 0..1 (λ), iters = passes. Endpoints of open lines stay fixed.
export function smoothPolyline(pts, strength = 0.5, iters = 0, closed = false, step = 0) {
  if (!(iters > 0) || !(strength > 0) || pts.length < 3) return pts;
  let p = step > 0 ? resample(pts, step, closed) : pts.map(q => [q[0], q[1]]);
  const n = p.length;
  if (n < 3) return p;
  // Gaussian kernel over arc length: strength 1 ≈ σ 1 mm (needs uniform resampling).
  const sig = step > 0 ? Math.max(0.6, Math.min(strength, 1) * 1.0 / step) : 0.6 + strength * 2;
  const R = Math.min(Math.ceil(sig * 3), closed ? Math.floor((n - 1) / 2) : n);
  const w = []; for (let k = 0; k <= R; k++) w.push(Math.exp(-0.5 * (k / sig) ** 2));
  const lam = 0.7, mu = -lam;   // λ|−λ: gain 1−λ²k² ≤ 1 → never amplifies, shrink only 2nd order
  const pass = (f) => {
    const q = new Array(n);
    for (let i = 0; i < n; i++) {
      if (!closed && (i === 0 || i === n - 1)) { q[i] = p[i]; continue; }
      let sx = p[i][0] * w[0], sy = p[i][1] * w[0], sw = w[0];
      for (let k = 1; k <= R; k++) {
        for (const j of [i - k, i + k]) {
          let jj = j;
          if (closed) jj = ((j % n) + n) % n; else if (j < 0 || j >= n) continue;
          sx += p[jj][0] * w[k]; sy += p[jj][1] * w[k]; sw += w[k];
        }
      }
      q[i] = [p[i][0] + f * (sx / sw - p[i][0]), p[i][1] + f * (sy / sw - p[i][1])];
    }
    p = q;
  };
  for (let it = 0; it < iters; it++) { pass(lam); pass(mu); }
  return p;
}

// Clip polyline by an inside(x,y) predicate, sampling with the given step.
export function clipBy(pts, inside, step, closed = false) {
  const out = [];
  const P = closed ? pts.concat([pts[0]]) : pts;
  if (P.length < 2) return out;
  let prev = inside(P[0][0], P[0][1]);
  let cur = prev ? [P[0]] : null;
  let all = prev;
  for (let k = 1; k < P.length; k++) {
    const [ax, ay] = P[k - 1], [bx, by] = P[k];
    const m = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let s = 1; s <= m; s++) {
      const t = s / m, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
      const inn = inside(x, y);
      if (inn !== prev) {
        all = false;
        if (inn) cur = [[x, y]]; else { if (cur) { cur.push([x, y]); if (cur.length > 1) out.push(cur); } cur = null; }
        prev = inn;
      }
    }
    if (prev && cur) cur.push([bx, by]);
  }
  if (cur && cur.length > 1) out.push(cur);
  if (closed && all && out.length === 1) out[0].closed = true;
  return out;
}

// Hatch a region given by inside(x,y) inside a bbox, lines at angle (deg) with spacing.
export function hatch(inside, box, spacing, angle, step, trim = 0, serpentine = true) {
  const [x0, y0, x1, y1] = box;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const R = Math.hypot(x1 - x0, y1 - y0) / 2 + spacing;
  const a = angle * DEG, dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
  const lines = [];
  let row = 0;
  for (let o = -Math.floor(R / spacing) * spacing; o <= R; o += spacing, row++) {
    const runs = [];
    let start = null;
    const n = Math.ceil((2 * R) / step);
    for (let i = 0; i <= n; i++) {
      const t = -R + i * step;
      const x = cx + nx * o + dx * t, y = cy + ny * o + dy * t;
      const inn = x >= x0 && x <= x1 && y >= y0 && y <= y1 && inside(x, y);
      if (inn && start === null) start = t;
      if ((!inn || i === n) && start !== null) {
        const end = inn ? t : t - step;
        const t0 = start + trim, t1 = end - trim;
        if (t1 - t0 > step * 0.5) runs.push([[cx + nx * o + dx * t0, cy + ny * o + dy * t0], [cx + nx * o + dx * t1, cy + ny * o + dy * t1]]);
        start = null;
      }
    }
    if (serpentine && row % 2) runs.reverse().forEach(r => r.reverse());
    lines.push(...runs);
  }
  return lines;
}

export function circle(cx, cy, r, n = 0) {
  const m = n || Math.max(12, Math.ceil(2 * Math.PI * r / 0.25));
  const out = [];
  for (let i = 0; i <= m; i++) { const t = (i / m) * 2 * Math.PI; out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  return out;
}

export function hexToRgb(h) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(h || "#888888");
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [136, 136, 136];
}

export function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}
