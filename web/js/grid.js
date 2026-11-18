// Surface grid on the client: mask from angle/height/inset, regions, distance field, contours, sampling.

export class Surface {
  constructor(buf) {
    const dv = new DataView(buf);
    const hl = dv.getUint32(0, true);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
    Object.assign(this, meta);               // x0 y0 res nx ny sigma tip_r
    const n = this.nx * this.ny;
    let o = 4 + hl;
    this.H = new Float32Array(buf.slice(o, o + n * 4)); o += n * 4;
    this.ZN = new Float32Array(buf.slice(o, o + n * 4)); o += n * 4;
    this.S = new Uint8Array(buf.slice(o, o + n));       // half degrees
    this.n = n;
    this.valid = new Uint8Array(n);
    let zmin = Infinity, zmax = -Infinity;
    for (let i = 0; i < n; i++) {
      if (this.H[i] > -0.5) { this.valid[i] = 1; const z = this.H[i]; if (z < zmin) zmin = z; if (z > zmax) zmax = z; }
    }
    this.zmin = zmin; this.zmax = zmax;
    this.version = 0;
    this._footDist = null;
  }

  get x1() { return this.x0 + (this.nx - 1) * this.res; }
  get y1() { return this.y0 + (this.ny - 1) * this.res; }

  cellOf(x, y) {
    const i = Math.round((x - this.x0) / this.res), j = Math.round((y - this.y0) / this.res);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return -1;
    return j * this.nx + i;
  }

  // ---------------------------------------------------------------- mask
  computeMask(opt) {
    const { nx, ny, n, res } = this;
    const thr = Math.round(opt.angle * 2);
    const zmin = opt.zmin ?? -1;
    const base = new Uint8Array(n);
    for (let i = 0; i < n; i++) base[i] = this.valid[i] && this.S[i] <= thr && this.H[i] >= zmin ? 1 : 0;
    // connected regions (4-neighbourhood)
    const lab = new Int32Array(n).fill(-1);
    const stack = new Int32Array(n);
    const areas = [];
    let nl = 0;
    for (let s = 0; s < n; s++) {
      if (!base[s] || lab[s] >= 0) continue;
      let sp = 0, cnt = 0;
      stack[sp++] = s; lab[s] = nl;
      while (sp) {
        const c = stack[--sp]; cnt++;
        const x = c % nx;
        if (x > 0 && base[c - 1] && lab[c - 1] < 0) { lab[c - 1] = nl; stack[sp++] = c - 1; }
        if (x < nx - 1 && base[c + 1] && lab[c + 1] < 0) { lab[c + 1] = nl; stack[sp++] = c + 1; }
        if (c >= nx && base[c - nx] && lab[c - nx] < 0) { lab[c - nx] = nl; stack[sp++] = c - nx; }
        if (c < n - nx && base[c + nx] && lab[c + nx] < 0) { lab[c + nx] = nl; stack[sp++] = c + nx; }
      }
      areas.push(cnt * res * res);
      nl++;
    }
    const off = new Uint8Array(nl);
    for (let l = 0; l < nl; l++) if (areas[l] < (opt.minArea ?? 0)) off[l] = 2;
    for (const [x, y] of opt.exclude || []) {
      const c = this.cellOf(x, y);
      if (c >= 0 && lab[c] >= 0) off[lab[c]] = 1;
    }
    for (let i = 0; i < n; i++) if (base[i] && off[lab[i]]) base[i] = 0;
    // distance to the mask border (mm)
    const dist = edt(base, nx, ny, res);
    const inset = opt.inset ?? 0;
    const mask = new Uint8Array(n);
    let area = 0;
    let deep = -1, dmax = -1;
    for (let i = 0; i < n; i++) if (base[i] && dist[i] > inset) { mask[i] = 1; area++; if (dist[i] > dmax) { dmax = dist[i]; deep = i; } }
    this.deep = deep >= 0 ? [this.x0 + (deep % nx) * res, this.y0 + Math.floor(deep / nx) * res] : null;
    this.base = base; this.dist = dist; this.mask = mask; this.labels = lab; this.regionOff = off;
    this._mm = new Map();
    this.regionAreas = areas; this.inset = inset;
    this.maskArea = area * res * res;
    this.regionsOn = 0;
    this.regionsTotal = 0;
    for (let l = 0; l < nl; l++) { if (!off[l]) this.regionsOn++; if (off[l] !== 2) this.regionsTotal++; }
    this.version++;
    // bbox of mask
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (mask[j * nx + i]) {
      if (i < bx0) bx0 = i; if (i > bx1) bx1 = i; if (j < by0) by0 = j; if (j > by1) by1 = j;
    }
    this.maskBox = bx1 >= bx0 ? [this.x0 + bx0 * res, this.y0 + by0 * res, this.x0 + bx1 * res, this.y0 + by1 * res]
                              : [this.x0, this.y0, this.x1, this.y1];
  }

  regionAt(x, y) {
    const c = this.cellOf(x, y);
    if (c < 0) return -1;
    return this.labels ? this.labels[c] : -1;
  }

  footDist() {
    if (!this._footDist) this._footDist = edt(this.valid, this.nx, this.ny, this.res);
    return this._footDist;
  }

  // ---------------------------------------------------------------- contours
  isolines(field, level) {
    const lines = marchingSquares(field, this.nx, this.ny, level);
    const { x0, y0, res } = this;
    return lines.map(l => ({ closed: l.closed, pts: l.pts.map(([i, j]) => [x0 + i * res, y0 + j * res]) }));
  }

  // ---------------------------------------------------------------- sampling
  inMask(x, y) {
    const c = this.cellOf(x, y);
    return c >= 0 && this.mask[c] === 1;
  }

  zAt(x, y) {   // conservative nozzle surface (max of 4 cells)
    const fx = (x - this.x0) / this.res, fy = (y - this.y0) / this.res;
    const i = Math.floor(fx), j = Math.floor(fy);
    if (i < 0 || j < 0 || i >= this.nx - 1 || j >= this.ny - 1) return NaN;
    const k = j * this.nx + i;
    const m = Math.max(this.ZN[k], this.ZN[k + 1], this.ZN[k + this.nx], this.ZN[k + this.nx + 1]);
    return m > -0.5 ? m : NaN;
  }

  // mask eroded by an extra margin (mm) relative to the global inset; cached per 0.01 mm
  maskMargin(m) {
    const thr = this.inset + Math.max(0, m);
    const key = Math.round(thr * 100);
    this._mm ??= new Map();
    const hit = this._mm.get(key);
    if (hit) return hit;
    const mk = new Uint8Array(this.n);
    for (let i = 0; i < this.n; i++) if (this.base[i] && this.dist[i] > thr) mk[i] = 1;
    this._mm.set(key, mk);
    if (this._mm.size > 24) this._mm.delete(this._mm.keys().next().value);
    return mk;
  }

  inMaskOf(mask, x, y) {
    const c = this.cellOf(x, y);
    return c >= 0 && mask[c] === 1;
  }

  // Clip polyline to the mask; returns list of polylines (open)
  clip(pts, closed = false) { return this.clipTo(this.mask, pts, closed); }

  clipTo(mask, pts, closed = false) {
    const out = [];
    if (pts.length < 2) return out;
    const P = closed ? pts.concat([pts[0]]) : pts;
    const step = this.res * 0.5;
    let cur = null;
    const flush = () => { if (cur && cur.length >= 2) out.push(cur); cur = null; };
    const inside = (x, y) => this.inMaskOf(mask, x, y);
    let prevIn = inside(P[0][0], P[0][1]);
    if (prevIn) cur = [P[0]];
    let allIn = prevIn;
    for (let k = 1; k < P.length; k++) {
      const [ax, ay] = P[k - 1], [bx, by] = P[k];
      const L = Math.hypot(bx - ax, by - ay);
      const m = Math.max(1, Math.ceil(L / step));
      for (let s = 1; s <= m; s++) {
        const t = s / m, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        const inn = inside(x, y);
        if (inn !== prevIn) {
          allIn = false;
          if (inn) cur = [[x, y]];
          else { if (cur) cur.push([x, y]); flush(); }
          prevIn = inn;
        }
      }
      if (prevIn && cur) cur.push([bx, by]);
    }
    flush();
    if (closed && allIn && out.length === 1) { out[0].closed = true; }
    // join wrap-around of closed loops
    if (closed && !allIn && out.length >= 2) {
      const f = out[0], l = out[out.length - 1];
      if (f[0] === P[0] || (Math.abs(f[0][0] - P[0][0]) < 1e-9 && Math.abs(f[0][1] - P[0][1]) < 1e-9)) {
        const last = l[l.length - 1];
        if (Math.hypot(last[0] - P[0][0], last[1] - P[0][1]) < 1e-6) { out.pop(); out[0] = l.concat(f.slice(1)); }
      }
    }
    return out;
  }
}

// Exact Euclidean distance transform (Felzenszwalb). Distance from each 1-cell to the nearest 0-cell, in mm.
export function edt(bin, nx, ny, res) {
  const INF = 1e20;
  const f = new Float64Array(Math.max(nx, ny));
  const d = new Float64Array(Math.max(nx, ny));
  const v = new Int32Array(Math.max(nx, ny));
  const z = new Float64Array(Math.max(nx, ny) + 1);
  const g = new Float64Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) g[i] = bin[i] ? INF : 0;
  const pass = (len) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s;
      while (true) {
        const r = v[k];
        s = ((f[q] + q * q) - (f[r] + r * r)) / (2 * q - 2 * r);
        if (s <= z[k]) { k--; if (k < 0) { k = 0; break; } } else break;
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const r = v[k];
      d[q] = (q - r) * (q - r) + f[r];
    }
  };
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) f[y] = g[y * nx + x];
    pass(ny);
    for (let y = 0; y < ny; y++) g[y * nx + x] = d[y];
  }
  const out = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) f[x] = g[y * nx + x];
    pass(nx);
    for (let x = 0; x < nx; x++) out[y * nx + x] = Math.sqrt(d[x]) * res;
  }
  return out;
}

// Marching squares with segment stitching. Returns [{pts:[[i,j],..], closed}] in cell coordinates.
export function marchingSquares(F, nx, ny, level) {
  const segA = [], segB = [];   // edge keys
  const pos = new Map();         // edge key -> [i, j]
  const ek = (i, j, vert) => ((j * nx + i) * 2 + (vert ? 1 : 0));
  const interp = (i0, j0, i1, j1, a, b) => {
    const t = (level - a) / (b - a);
    return [i0 + (i1 - i0) * t, j0 + (j1 - j0) * t];
  };
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const k = j * nx + i;
      const a = F[k], b = F[k + 1], c = F[k + nx + 1], d = F[k + nx];
      let idx = 0;
      if (a > level) idx |= 1; if (b > level) idx |= 2; if (c > level) idx |= 4; if (d > level) idx |= 8;
      if (idx === 0 || idx === 15) continue;
      // edges: 0 bottom (i,j)-(i+1,j)  1 right (i+1,j)-(i+1,j+1)  2 top (i,j+1)-(i+1,j+1)  3 left (i,j)-(i,j+1)
      const E = [ek(i, j, 0), ek(i + 1, j, 1), ek(i, j + 1, 0), ek(i, j, 1)];
      const P = (e) => {
        const key = E[e];
        if (!pos.has(key)) {
          let p;
          if (e === 0) p = interp(i, j, i + 1, j, a, b);
          else if (e === 1) p = interp(i + 1, j, i + 1, j + 1, b, c);
          else if (e === 2) p = interp(i, j + 1, i + 1, j + 1, d, c);
          else p = interp(i, j, i, j + 1, a, d);
          pos.set(key, p);
        }
        return key;
      };
      const add = (e1, e2) => { segA.push(P(e1)); segB.push(P(e2)); };
      switch (idx) {
        case 1: case 14: add(3, 0); break;
        case 2: case 13: add(0, 1); break;
        case 3: case 12: add(3, 1); break;
        case 4: case 11: add(1, 2); break;
        case 6: case 9: add(0, 2); break;
        case 7: case 8: add(3, 2); break;
        case 5: case 10: {
          const ctr = (a + b + c + d) / 4 > level;
          if ((idx === 5) === ctr) { add(3, 2); add(0, 1); } else { add(3, 0); add(1, 2); }
          break;
        }
      }
    }
  }
  // stitch
  const adj = new Map();
  for (let s = 0; s < segA.length; s++) {
    for (const key of [segA[s], segB[s]]) {
      const l = adj.get(key); if (l) l.push(s); else adj.set(key, [s]);
    }
  }
  const used = new Uint8Array(segA.length);
  const lines = [];
  const other = (s, key) => (segA[s] === key ? segB[s] : segA[s]);
  for (let s0 = 0; s0 < segA.length; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const fwd = [segA[s0], segB[s0]];
    // extend forward
    for (let dir = 0; dir < 2; dir++) {
      const arr = dir === 0 ? fwd : null;
      let key = dir === 0 ? fwd[fwd.length - 1] : fwd[0];
      const back = [];
      while (true) {
        const l = adj.get(key); let nxt = -1;
        if (l) for (const s of l) if (!used[s]) { nxt = s; break; }
        if (nxt < 0) break;
        used[nxt] = 1;
        key = other(nxt, key);
        if (dir === 0) arr.push(key); else back.push(key);
      }
      if (dir === 1 && back.length) fwd.unshift(...back.reverse());
    }
    const closed = fwd.length > 3 && fwd[0] === fwd[fwd.length - 1];
    lines.push({ closed, pts: fwd.map(k => pos.get(k)) });
  }
  return lines;
}
