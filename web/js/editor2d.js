// Top-view editor: surface/mask display, element drawing, select/move/scale/rotate, freehand, region toggling.
import { applyTf, invTf, DEG } from "./geom.js";
import { t } from "./i18n.js";

export class Editor2D {
  constructor(canvas, app) {
    this.cv = canvas;
    this.g = canvas.getContext("2d");
    this.app = app;
    this.k = 4; this.cx = 90; this.cy = 90;
    this.tool = "select";
    this.drag = null;
    this.bg = null;
    this.shade = null;
    this.hover = null;
    this.spaceDown = false;
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    canvas.addEventListener("pointerup", (e) => this.onUp(e));
    canvas.addEventListener("pointercancel", (e) => this.onUp(e));
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("dblclick", (e) => this.onDbl(e));
    window.addEventListener("keydown", (e) => { if (e.code === "Space" && !isTyping(e)) { this.spaceDown = true; } });
    window.addEventListener("keyup", (e) => { if (e.code === "Space") this.spaceDown = false; });
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.cv.width = Math.max(10, Math.round(r.width * dpr));
    this.cv.height = Math.max(10, Math.round(r.height * dpr));
    this.W = r.width; this.H = r.height;
    this.render();
  }

  // ------------------------------------------------------------ coordinates
  toScreen(x, y) { return [this.W / 2 + (x - this.cx) * this.k, this.H / 2 - (y - this.cy) * this.k]; }
  toWorld(sx, sy) { return [this.cx + (sx - this.W / 2) / this.k, this.cy - (sy - this.H / 2) / this.k]; }
  evWorld(e) { const r = this.cv.getBoundingClientRect(); return this.toWorld(e.clientX - r.left, e.clientY - r.top); }
  evScreen(e) { const r = this.cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  fit() {
    const s = this.app.surf;
    if (!s) return;
    const b = s.maskArea > 1 ? s.maskBox : [s.x0, s.y0, s.x1, s.y1];
    const w = Math.max(5, b[2] - b[0]), h = Math.max(5, b[3] - b[1]);
    this.k = Math.min((this.W - 40) / w, (this.H - 40) / h);
    this.cx = (b[0] + b[2]) / 2; this.cy = (b[1] + b[3]) / 2;
    this.render();
  }

  // ------------------------------------------------------------ background
  setSurface(s) {
    this.surf = s;
    const { nx, ny, H, res, valid } = s;
    const shade = new Float32Array(nx * ny);
    const lx = -0.5, ly = 0.6, lz = 0.62;
    const ln = Math.hypot(lx, ly, lz);
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const k = j * nx + i;
        if (!valid[k]) continue;
        const hl = valid[k - 1] ? H[k - 1] : H[k], hr = valid[k + 1] ? H[k + 1] : H[k];
        const hd = valid[k - nx] ? H[k - nx] : H[k], hu = valid[k + nx] ? H[k + nx] : H[k];
        const dx = (hr - hl) / (2 * res), dy = (hu - hd) / (2 * res);
        const nn = Math.hypot(dx, dy, 1);
        const d = (-dx * lx - dy * ly + lz) / (nn * ln);
        shade[k] = Math.max(0, d);
      }
    }
    // height tint
    this.shade = shade;
    this.bgCanvas = new OffscreenCanvas(nx, ny);
    this.updateMask();
  }

  updateMask() {
    const s = this.surf;
    if (!s || !s.mask) return;
    const { nx, ny, valid, base, mask, labels, regionOff } = s;
    const img = new ImageData(nx, ny);
    const d = img.data;
    const zr = Math.max(0.1, s.zmax - s.zmin);
    for (let j = 0; j < ny; j++) {
      const row = (ny - 1 - j) * nx;
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i, q = (row + i) * 4;
        if (!valid[k]) { d[q + 3] = 0; continue; }
        const h = (s.H[k] - s.zmin) / zr;
        const v = 40 + 150 * this.shade[k] + 30 * h;
        let r = v, g = v, b = v;
        if (mask[k]) { r = v * 0.78 + 242 * 0.22 * (0.6 + 0.4 * this.shade[k]); g = v * 0.78 + 163 * 0.22; b = v * 0.78 + 58 * 0.22; }
        else if (base[k]) { r = v * 0.85 + 30; g = v * 0.8 + 18; b = v * 0.7; }
        else if (labels[k] >= 0 && regionOff[labels[k]] === 1) { r = v * 0.5 + 50; g = v * 0.4; b = v * 0.45; }
        else { r = v * 0.45; g = v * 0.5; b = v * 0.62; }
        d[q] = r; d[q + 1] = g; d[q + 2] = b; d[q + 3] = 255;
      }
    }
    this.bgCanvas.getContext("2d").putImageData(img, 0, 0);
    this.render();
  }

  // ------------------------------------------------------------ rendering
  render() {
    if (!this.W) return;
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this._render(); });
  }

  _render() {
    const g = this.g, dpr = this.dpr || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#0a0b0c";
    g.fillRect(0, 0, this.W, this.H);
    const s = this.surf;
    const app = this.app;
    // bed grid
    this.drawBed(g);
    if (s && this.bgCanvas) {
      const [sx0, sy0] = this.toScreen(s.x0 - s.res / 2, s.y1 + s.res / 2);
      g.imageSmoothingEnabled = this.k < 12;
      g.drawImage(this.bgCanvas, sx0, sy0, s.nx * s.res * this.k, s.ny * s.res * this.k);
    }
    // elements (world transform)
    g.save();
    g.setTransform(dpr * this.k, 0, 0, -dpr * this.k, dpr * (this.W / 2 - this.cx * this.k), dpr * (this.H / 2 + this.cy * this.k));
    g.lineCap = "round"; g.lineJoin = "round";
    const lw = app.params.line_width;
    const realW = app.showRealWidth;
    for (const el of app.elements) {
      if (!el.visible) continue;
      const b = app.built.get(el.id);
      if (!b) continue;
      if (!b.paths) b.paths = makePaths(b.clipped);
      const sel = el.id === app.selectedId;
      for (const [slot, path] of b.paths) {
        const col = app.slotColor(slot);
        const w = realW ? Math.max(lw, 1.1 / this.k) : 1.6 / this.k;
        g.strokeStyle = sel ? "rgba(242,163,58,0.9)" : "rgba(0,0,0,0.75)";
        g.lineWidth = w + (sel ? 2.4 : 1.4) / this.k;
        g.stroke(path);
        g.strokeStyle = col;
        g.lineWidth = w;
        g.stroke(path);
      }
    }
    // cuts of the last generation: where a stroke was split to print uphill
    const gen = app.gen;
    if (gen && !app.genStale && gen.stats?.cuts?.length) {
      const r = Math.max(0.22, 2.1 / this.k);
      for (const c of gen.stats.cuts) {
        g.beginPath(); g.arc(c.x, c.y, r * 1.9, 0, Math.PI * 2);
        g.fillStyle = "rgba(0,0,0,0.7)"; g.fill();
        g.beginPath(); g.arc(c.x, c.y, r, 0, Math.PI * 2);
        g.fillStyle = "#6fd3ff"; g.fill();
      }
    }
    g.restore();
    // drawing in progress
    if (this.drag?.type === "draw" && this.drag.pts.length > 1) {
      g.strokeStyle = app.slotColor(app.currentSlot());
      g.lineWidth = 2; g.beginPath();
      this.drag.world.forEach(([x, y], i) => { const [a, b] = this.toScreen(x, y); i ? g.lineTo(a, b) : g.moveTo(a, b); });
      g.stroke();
    }
    // selection handles
    const el = app.selected();
    if (el && el.visible) this.drawHandles(g, el);
    // region tool hint
    if (this.tool === "region" && this.hover) {
      g.fillStyle = "#f2a33a"; g.font = "11px monospace";
      g.fillText(t("canvas.regionHint"), this.hover[0] + 12, this.hover[1] - 10);
    }
  }

  drawBed(g) {
    const bed = this.app.meta?.bed;
    if (!bed) return;
    g.strokeStyle = "#1c1e21"; g.lineWidth = 1;
    const [bx0, by0] = this.toScreen(0, 0);
    for (let x = 0; x <= 180; x += 10) { const [a] = this.toScreen(x, 0); g.beginPath(); g.moveTo(a, this.toScreen(0, 180)[1]); g.lineTo(a, by0); g.stroke(); }
    for (let y = 0; y <= 180; y += 10) { const [, b] = this.toScreen(0, y); g.beginPath(); g.moveTo(bx0, b); g.lineTo(this.toScreen(180, 0)[0], b); g.stroke(); }
    g.strokeStyle = "#33363b";
    g.beginPath();
    bed.forEach(([x, y], i) => { const [a, b] = this.toScreen(x, y); i ? g.lineTo(a, b) : g.moveTo(a, b); });
    g.closePath(); g.stroke();
  }

  handleGeom(el) {
    const b = this.app.built.get(el.id);
    if (!b || !this.app.hasTf(el)) return null;
    if (!b.box) {
      // origin handle only (surface-wide pattern)
      const o = this.toScreen(el.tf.x, el.tf.y);
      const a = el.tf.rot * DEG;
      const rh = [o[0] + Math.cos(a) * 46, o[1] - Math.sin(a) * 46];
      return { origin: o, rot: rh, corners: null };
    }
    const [x0, y0, x1, y1] = b.box;
    const cw = applyTf([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], el.tf).map(([x, y]) => this.toScreen(x, y));
    const top = applyTf([[(x0 + x1) / 2, y1]], el.tf).map(([x, y]) => this.toScreen(x, y))[0];
    const ctr = this.toScreen(el.tf.x, el.tf.y);
    const dx = top[0] - ctr[0], dy = top[1] - ctr[1];
    const L = Math.hypot(dx, dy) || 1;
    const rot = [top[0] + (dx / L) * 24, top[1] + (dy / L) * 24];
    return { corners: cw, rot, top, origin: ctr };
  }

  drawHandles(g, el) {
    const h = this.handleGeom(el);
    if (!h) return;
    g.save();
    g.strokeStyle = "#f2a33a"; g.fillStyle = "#0e0f10"; g.lineWidth = 1;
    if (h.corners) {
      g.setLineDash([5, 4]);
      g.beginPath(); h.corners.forEach(([a, b], i) => (i ? g.lineTo(a, b) : g.moveTo(a, b))); g.closePath(); g.stroke();
      g.setLineDash([]);
      g.beginPath(); g.moveTo(h.top[0], h.top[1]); g.lineTo(h.rot[0], h.rot[1]); g.stroke();
      for (const [a, b] of h.corners) { g.fillRect(a - 4, b - 4, 8, 8); g.strokeRect(a - 4, b - 4, 8, 8); }
    } else {
      g.beginPath(); g.moveTo(h.origin[0], h.origin[1]); g.lineTo(h.rot[0], h.rot[1]); g.stroke();
      g.beginPath(); g.arc(h.origin[0], h.origin[1], 7, 0, 7); g.stroke();
      g.beginPath(); g.moveTo(h.origin[0] - 11, h.origin[1]); g.lineTo(h.origin[0] + 11, h.origin[1]);
      g.moveTo(h.origin[0], h.origin[1] - 11); g.lineTo(h.origin[0], h.origin[1] + 11); g.stroke();
    }
    g.beginPath(); g.arc(h.rot[0], h.rot[1], 5, 0, 7); g.fill(); g.stroke();
    g.restore();
  }

  // ------------------------------------------------------------ interaction
  onWheel(e) {
    e.preventDefault();
    const [sx, sy] = this.evScreen(e);
    const [wx, wy] = this.toWorld(sx, sy);
    const f = Math.exp(-e.deltaY * 0.0015);
    this.k = Math.max(0.5, Math.min(400, this.k * f));
    this.cx = wx - (sx - this.W / 2) / this.k;
    this.cy = wy + (sy - this.H / 2) / this.k;
    this.render();
  }

  hitElement(sx, sy) {
    const app = this.app;
    const [wx, wy] = this.toWorld(sx, sy);
    const g = this.g;
    for (let i = app.elements.length - 1; i >= 0; i--) {
      const el = app.elements[i];
      if (!el.visible) continue;
      const b = app.built.get(el.id);
      if (!b) continue;
      if (app.hasTf(el) && b.box) {
        const [lx, ly] = invTf([wx, wy], el.tf);
        const [x0, y0, x1, y1] = b.box;
        if (lx >= x0 && lx <= x1 && ly >= y0 && ly <= y1) return el;
        continue;
      }
      if (!b.paths) b.paths = makePaths(b.clipped);
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.lineWidth = 10 / this.k;
      for (const [, path] of b.paths) {
        // test in world coordinates
        if (g.isPointInStroke(path, wx, wy)) { g.restore(); return el; }
      }
      g.restore();
    }
    return null;
  }

  onDown(e) {
    this.cv.setPointerCapture(e.pointerId);
    const [sx, sy] = this.evScreen(e);
    const w = this.toWorld(sx, sy);
    const app = this.app;
    if (e.button === 1 || e.button === 2 || this.spaceDown) {
      this.drag = { type: "pan", sx, sy, cx: this.cx, cy: this.cy };
      return;
    }
    if (this.tool === "region") {
      app.toggleRegion(w);
      return;
    }
    if (this.tool === "draw") {
      const el = app.ensureDrawElement(w);
      this.drag = { type: "draw", el, pts: [invTf(w, el.tf)], world: [w] };
      return;
    }
    // select tool
    const el = app.selected();
    if (el && app.hasTf(el)) {
      const h = this.handleGeom(el);
      if (h) {
        if (Math.hypot(sx - h.rot[0], sy - h.rot[1]) < 9) {
          app.pushUndo();
          this.drag = { type: "rot", el, a0: Math.atan2(-(sy - h.origin[1]), sx - h.origin[0]), rot0: el.tf.rot };
          return;
        }
        if (h.corners) {
          for (const c of h.corners) if (Math.hypot(sx - c[0], sy - c[1]) < 9) {
            app.pushUndo();
            this.drag = { type: "scale", el, d0: Math.hypot(sx - h.origin[0], sy - h.origin[1]), s0: el.tf.s };
            return;
          }
        } else if (Math.hypot(sx - h.origin[0], sy - h.origin[1]) < 12) {
          app.pushUndo();
          this.drag = { type: "move", el, w0: w, x0: el.tf.x, y0: el.tf.y };
          return;
        }
      }
    }
    const hit = this.hitElement(sx, sy);
    if (hit) {
      app.select(hit.id);
      if (app.hasTf(hit)) {
        app.pushUndo();
        this.drag = { type: "move", el: hit, w0: w, x0: hit.tf.x, y0: hit.tf.y };
      }
      return;
    }
    app.select(null);
    this.drag = { type: "pan", sx, sy, cx: this.cx, cy: this.cy };
  }

  onMove(e) {
    const [sx, sy] = this.evScreen(e);
    const w = this.toWorld(sx, sy);
    this.hover = [sx, sy];
    this.app.cursorInfo(w);
    const d = this.drag;
    if (!d) { if (this.tool === "region") this.render(); return; }
    if (d.type === "pan") {
      this.cx = d.cx - (sx - d.sx) / this.k;
      this.cy = d.cy + (sy - d.sy) / this.k;
      this.render();
    } else if (d.type === "move") {
      let nx = d.x0 + (w[0] - d.w0[0]), ny = d.y0 + (w[1] - d.w0[1]);
      if (e.shiftKey) { nx = Math.round(nx); ny = Math.round(ny); }
      d.el.tf.x = nx; d.el.tf.y = ny;
      this.app.changed(d.el, { live: true });
    } else if (d.type === "rot") {
      const h = this.toScreen(d.el.tf.x, d.el.tf.y);
      const a = Math.atan2(-(sy - h[1]), sx - h[0]);
      let r = d.rot0 + (a - d.a0) / DEG;
      if (e.shiftKey) r = Math.round(r / 15) * 15;
      d.el.tf.rot = ((r % 360) + 540) % 360 - 180;
      this.app.changed(d.el, { live: true });
    } else if (d.type === "scale") {
      const h = this.toScreen(d.el.tf.x, d.el.tf.y);
      const dd = Math.hypot(sx - h[0], sy - h[1]);
      let s = Math.max(0.02, d.s0 * dd / Math.max(1, d.d0));
      if (e.shiftKey) s = Math.round(s * 20) / 20;
      d.el.tf.s = s;
      this.app.changed(d.el, { live: true });
    } else if (d.type === "draw") {
      const last = d.world[d.world.length - 1];
      if (Math.hypot(w[0] - last[0], w[1] - last[1]) * this.k > 2) {
        d.world.push(w);
        d.pts.push(invTf(w, d.el.tf));
        this.render();
      }
    }
  }

  onUp(e) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.type === "draw") {
      if (d.pts.length > 1) {
        this.app.pushUndo();
        d.el.props.strokes.push(d.pts);
        this.app.changed(d.el, { props: true });
      }
      this.render();
    } else if (d.type === "move" || d.type === "rot" || d.type === "scale") {
      this.app.changed(d.el);
    }
  }

  onDbl(e) {
    if (this.tool !== "select") return;
    const [sx, sy] = this.evScreen(e);
    const hit = this.hitElement(sx, sy);
    if (!hit) this.fit();
  }
}

export function makePaths(lines) {
  const by = new Map();
  for (const l of lines || []) {
    let p = by.get(l.slot);
    if (!p) { p = new Path2D(); by.set(l.slot, p); }
    const pts = l.pts;
    p.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
    if (l.closed) p.closePath();
  }
  return [...by.entries()];
}

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}
