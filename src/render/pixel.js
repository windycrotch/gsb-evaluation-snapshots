// Immediate-mode pixel drawing into an ImageData buffer.
// Everything works in integer logical pixels; the canvas is scaled up by CSS
// with `image-rendering: pixelated`, so every draw call lands on a real pixel.

const COLOR_CACHE = new Map();

export function parseColor(c) {
  if (typeof c !== 'string') return c;
  let v = COLOR_CACHE.get(c);
  if (v) return v;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 255;
  if (c[0] === '#') {
    const h = c.slice(1);
    if (h.length === 3) {
      r = parseInt(h[0] + h[0], 16);
      g = parseInt(h[1] + h[1], 16);
      b = parseInt(h[2] + h[2], 16);
    } else {
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
      if (h.length >= 8) a = parseInt(h.slice(6, 8), 16);
    }
  }
  v = [r, g, b, a];
  COLOR_CACHE.set(c, v);
  return v;
}

export function mix(a, b, t) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  const k = Math.max(0, Math.min(1, t));
  return [
    Math.round(ca[0] + (cb[0] - ca[0]) * k),
    Math.round(ca[1] + (cb[1] - ca[1]) * k),
    Math.round(ca[2] + (cb[2] - ca[2]) * k),
    Math.round(ca[3] + (cb[3] - ca[3]) * k),
  ];
}

export function withAlpha(c, alpha) {
  const p = parseColor(c);
  return [p[0], p[1], p[2], Math.round(255 * Math.max(0, Math.min(1, alpha)))];
}

export function shade(c, amount) {
  const p = parseColor(c);
  if (amount >= 0) return mix(p, [255, 255, 255, p[3]], amount);
  return mix(p, [0, 0, 0, p[3]], -amount);
}

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

export function bayer(x, y) {
  return BAYER[((y % 4) + 4) % 4][((x % 4) + 4) % 4] / 16;
}

export class Pixel {
  constructor(canvas, w, h) {
    this.canvas = canvas;
    this.w = w;
    this.h = h;
    canvas.width = w;
    canvas.height = h;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.ctx.imageSmoothingEnabled = false;
    this.image = this.ctx.createImageData(w, h);
    this.data = this.image.data;
    this.clips = [];
    this.cx0 = 0;
    this.cy0 = 0;
    this.cx1 = w;
    this.cy1 = h;
    this.ox = 0;
    this.oy = 0;
  }

  clear() {
    this.data.fill(0);
  }

  pushClip(x, y, w, h) {
    this.clips.push([this.cx0, this.cy0, this.cx1, this.cy1]);
    this.cx0 = Math.max(this.cx0, Math.round(x));
    this.cy0 = Math.max(this.cy0, Math.round(y));
    this.cx1 = Math.min(this.cx1, Math.round(x + w));
    this.cy1 = Math.min(this.cy1, Math.round(y + h));
    return this;
  }

  popClip() {
    const c = this.clips.pop();
    if (c) [this.cx0, this.cy0, this.cx1, this.cy1] = c;
    return this;
  }

  /** Shift every subsequent draw call (used for shake / squash offsets). */
  pushOffset(dx, dy) {
    const prev = [this.ox, this.oy];
    this.ox += Math.round(dx);
    this.oy += Math.round(dy);
    return prev;
  }

  setOffset(dx, dy) {
    this.ox = Math.round(dx);
    this.oy = Math.round(dy);
  }

  px(x, y, color) {
    const px = (x | 0) + this.ox;
    const py = (y | 0) + this.oy;
    if (px < this.cx0 || px >= this.cx1 || py < this.cy0 || py >= this.cy1) return;
    const c = parseColor(color);
    const a = c[3];
    if (a <= 0) return;
    const i = (py * this.w + px) * 4;
    const d = this.data;
    if (a >= 255) {
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = 255;
      return;
    }
    const sa = a / 255;
    const da = d[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    d[i] = Math.round((c[0] * sa + d[i] * da * (1 - sa)) / oa);
    d[i + 1] = Math.round((c[1] * sa + d[i + 1] * da * (1 - sa)) / oa);
    d[i + 2] = Math.round((c[2] * sa + d[i + 2] * da * (1 - sa)) / oa);
    d[i + 3] = Math.round(oa * 255);
  }

  /** Additive light: brightens whatever is already there. Great for bloom. */
  add(x, y, color, amount = 1) {
    const px = (x | 0) + this.ox;
    const py = (y | 0) + this.oy;
    if (px < this.cx0 || px >= this.cx1 || py < this.cy0 || py >= this.cy1) return;
    const c = parseColor(color);
    const i = (py * this.w + px) * 4;
    const d = this.data;
    if (d[i + 3] === 0) return;
    d[i] = Math.min(255, d[i] + c[0] * amount);
    d[i + 1] = Math.min(255, d[i + 1] + c[1] * amount);
    d[i + 2] = Math.min(255, d[i + 2] + c[2] * amount);
  }

  rect(x, y, w, h, color) {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x0 + i, y0 + j, color);
  }

  frame(x, y, w, h, color) {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    for (let i = 0; i < w; i++) {
      this.px(x0 + i, y0, color);
      this.px(x0 + i, y0 + h - 1, color);
    }
    for (let j = 1; j < h - 1; j++) {
      this.px(x0, y0 + j, color);
      this.px(x0 + w - 1, y0 + j, color);
    }
  }

  hline(x, y, w, color) {
    for (let i = 0; i < w; i++) this.px(x + i, y, color);
  }

  vline(x, y, h, color) {
    for (let j = 0; j < h; j++) this.px(x, y + j, color);
  }

  /** Rounded rectangle with hand-tuned pixel corners (r = 1..4). */
  rrect(x, y, w, h, r, color, mode = 'fill') {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    const cut = (i, j) => {
      const dx = i < r ? r - i : i >= w - r ? i - (w - 1 - r) : 0;
      const dy = j < r ? r - j : j >= h - r ? j - (h - 1 - r) : 0;
      if (!dx || !dy) return false;
      return dx + dy > r;
    };
    if (mode === 'fill') {
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          if (cut(i, j)) continue;
          this.px(x0 + i, y0 + j, color);
        }
      }
      return;
    }
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (cut(i, j)) continue;
        const edge =
          cut(i - 1, j) || cut(i + 1, j) || cut(i, j - 1) || cut(i, j + 1) ||
          i === 0 || j === 0 || i === w - 1 || j === h - 1;
        if (edge) this.px(x0 + i, y0 + j, color);
      }
    }
  }

  circle(cx, cy, r, color) {
    const r2 = (r + 0.35) * (r + 0.35);
    for (let j = -r; j <= r; j++) {
      for (let i = -r; i <= r; i++) {
        if (i * i + j * j <= r2) this.px(cx + i, cy + j, color);
      }
    }
  }

  ring(cx, cy, r, color, thickness = 1) {
    const outer = (r + 0.35) * (r + 0.35);
    const inner = (r - thickness + 0.35) * (r - thickness + 0.35);
    for (let j = -r; j <= r; j++) {
      for (let i = -r; i <= r; i++) {
        const d = i * i + j * j;
        if (d <= outer && d > inner) this.px(cx + i, cy + j, color);
      }
    }
  }

  /** Filled ellipse; useful for eyes and mouths. */
  ellipse(cx, cy, rx, ry, color) {
    if (rx <= 0 || ry <= 0) return;
    for (let j = -ry; j <= ry; j++) {
      for (let i = -rx; i <= rx; i++) {
        const v = (i * i) / ((rx + 0.3) * (rx + 0.3)) + (j * j) / ((ry + 0.3) * (ry + 0.3));
        if (v <= 1) this.px(cx + i, cy + j, color);
      }
    }
  }

  line(x0, y0, x1, y1, color) {
    let ax = Math.round(x0);
    let ay = Math.round(y0);
    const bx = Math.round(x1);
    const by = Math.round(y1);
    const dx = Math.abs(bx - ax);
    const dy = Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1;
    const sy = ay < by ? 1 : -1;
    let err = dx - dy;
    for (let guard = 0; guard < 4096; guard++) {
      this.px(ax, ay, color);
      if (ax === bx && ay === by) break;
      const e2 = err * 2;
      if (e2 > -dy) {
        err -= dy;
        ax += sx;
      }
      if (e2 < dx) {
        err += dx;
        ay += sy;
      }
    }
  }

  /** Dithered vertical gradient. */
  vgrad(x, y, w, h, top, bottom, steps = 0) {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    for (let j = 0; j < h; j++) {
      let t = h > 1 ? j / (h - 1) : 0;
      if (steps > 1) t = Math.round(t * (steps - 1)) / (steps - 1);
      const base = mix(top, bottom, t);
      const next = mix(top, bottom, Math.min(1, t + 1 / Math.max(1, h - 1)));
      for (let i = 0; i < w; i++) {
        const use = bayer(x0 + i, y0 + j) < 0.5 ? base : next;
        this.px(x0 + i, y0 + j, use);
      }
    }
  }

  /** Copy of the current buffer, used to cache the static shell artwork. */
  snapshot() {
    return new Uint8ClampedArray(this.data);
  }

  blit(snap) {
    this.data.set(snap);
  }

  /** Post-process: displace whole rows sideways. Used for the glitch effect. */
  shiftRows(x, y, w, h, offsetFor) {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const w0 = Math.min(w, this.w - x0);
    const row = new Uint8ClampedArray(w0 * 4);
    for (let j = 0; j < h; j++) {
      const yy = y0 + j;
      if (yy < 0 || yy >= this.h) continue;
      const dx = offsetFor(j) | 0;
      if (!dx) continue;
      const start = (yy * this.w + x0) * 4;
      row.set(this.data.subarray(start, start + w0 * 4));
      for (let i = 0; i < w0; i++) {
        const src = i - dx;
        const di = start + i * 4;
        if (src < 0 || src >= w0) continue;
        this.data[di] = row[src * 4];
        this.data[di + 1] = row[src * 4 + 1];
        this.data[di + 2] = row[src * 4 + 2];
        this.data[di + 3] = row[src * 4 + 3];
      }
    }
  }

  commit() {
    this.ctx.putImageData(this.image, 0, 0);
  }
}
