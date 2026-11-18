// 3D view: surface mesh, original toolpaths, live design projection, generated G-code with playback.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

export class View3D {
  constructor(host, app) {
    this.host = host;
    this.app = app;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setClearColor(0x0a0b0c);
    host.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 3000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener("change", () => this.render());
    this.scene.add(new THREE.HemisphereLight(0xdfe6ee, 0x30281c, 1.4));
    const dl = new THREE.DirectionalLight(0xffffff, 1.6);
    dl.position.set(-60, 80, 160);
    this.scene.add(dl);
    this.groups = {};
    for (const k of ["bed", "surface", "orig", "design", "gcode", "travel", "marker", "coll", "cuts", "retr"]) {
      this.groups[k] = new THREE.Group();
      this.scene.add(this.groups[k]);
    }
    this.mats = [];
    new ResizeObserver(() => this.resize()).observe(host);
    this.visible = false;
    this.animate = this.animate.bind(this);
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    if (r.width < 2) return;
    this.renderer.setSize(r.width, r.height, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    for (const m of this.mats) m.resolution.set(r.width, r.height);
    this.render();
  }

  setVisible(v) {
    this.visible = v;
    if (v) { this.resize(); requestAnimationFrame(this.animate); }
  }

  animate() {
    if (!this.visible) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.animate);
  }

  render() { if (this.visible) this.renderer.render(this.scene, this.camera); }

  clear(name) {
    const g = this.groups[name];
    for (const c of [...g.children]) {
      g.remove(c);
      if (c === this.headGroup) continue;      // reused across generations
      c.geometry?.dispose();
      if (c.material && !this.mats.includes(c.material)) c.material.dispose?.();
    }
  }

  fatMaterial(width, opts = {}) {
    const m = new LineMaterial({ linewidth: width, worldUnits: true, vertexColors: true, ...opts });
    const r = this.host.getBoundingClientRect();
    m.resolution.set(r.width || 800, r.height || 600);
    this.mats.push(m);
    if (this.mats.length > 40) this.mats.shift();
    return m;
  }

  // ------------------------------------------------------------ bed + surface
  setSurface(s) {
    this.surf = s;
    this.clear("bed");
    const bed = new THREE.Mesh(new THREE.PlaneGeometry(180, 180), new THREE.MeshBasicMaterial({ color: 0x15171a }));
    bed.position.set(90, 90, -0.01);
    this.groups.bed.add(bed);
    const grid = new THREE.GridHelper(180, 18, 0x2a2d31, 0x1f2124);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(90, 90, 0);
    this.groups.bed.add(grid);

    this.clear("surface");
    const f = Math.max(1, Math.ceil(Math.sqrt((s.nx * s.ny) / 260000)));
    this.dsf = f;
    const nx = Math.floor((s.nx - 1) / f) + 1, ny = Math.floor((s.ny - 1) / f) + 1;
    const pos = new Float32Array(nx * ny * 3);
    const ok = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = (j * f) * s.nx + i * f, q = j * nx + i;
      pos[q * 3] = s.x0 + i * f * s.res; pos[q * 3 + 1] = s.y0 + j * f * s.res;
      if (s.valid[k]) { pos[q * 3 + 2] = s.H[k]; ok[q] = 1; } else pos[q * 3 + 2] = 0;
    }
    const idx = [];
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      if (ok[a] && ok[b] && ok[d]) idx.push(a, b, d);
      if (ok[a] && ok[d] && ok[c]) idx.push(a, d, c);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(nx * ny * 3), 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.surfMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.0, side: THREE.DoubleSide }));
    this.surfDims = [nx, ny];
    this.groups.surface.add(this.surfMesh);
    this.updateMask();
    this.home();
  }

  updateMask() {
    const s = this.surf;
    if (!s || !this.surfMesh || !s.mask) return;
    const [nx, ny] = this.surfDims, f = this.dsf;
    const col = this.surfMesh.geometry.getAttribute("color");
    const base = this.app.surfaceColor();
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = (j * f) * s.nx + i * f, q = j * nx + i;
      let c;
      if (s.mask[k]) c = [base[0] * 0.75 + 0.95 * 0.25, base[1] * 0.75 + 0.64 * 0.25, base[2] * 0.75 + 0.23 * 0.25];
      else if (s.base[k]) c = [base[0] * 0.9, base[1] * 0.85, base[2] * 0.8];
      else c = [base[0] * 0.45, base[1] * 0.48, base[2] * 0.55];
      col.setXYZ(q, c[0], c[1], c[2]);
    }
    col.needsUpdate = true;
    this.render();
  }

  home() {
    const s = this.surf;
    if (!s) return;
    const b = s.maskArea > 1 ? s.maskBox : [s.x0, s.y0, s.x1, s.y1];
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, cz = (s.zmin + s.zmax) / 2;
    const span = Math.max(b[2] - b[0], b[3] - b[1], 20);
    this.controls.target.set(cx, cy, cz);
    this.camera.position.set(cx - span * 0.15, cy - span * 1.05, cz + span * 0.85);
    this.controls.update();
    this.render();
  }

  top() {
    const t = this.controls.target;
    const s = this.surf;
    const span = s ? Math.max(s.x1 - s.x0, s.y1 - s.y0) : 100;
    this.camera.position.set(t.x, t.y - 0.01, t.z + span * 1.6);
    this.controls.update();
    this.render();
  }

  // ------------------------------------------------------------ original toolpaths
  setOriginal(tp, colors) {
    this.clear("orig");
    if (!tp || !tp.n) return;
    const n = tp.n;
    const pos = new Float32Array(n * 6), col = new Float32Array(n * 6);
    const c = new THREE.Color();
    const zmax = tp.zmax;
    for (let i = 0; i < n; i++) {
      const o = i * 5, z = tp.seg[o + 4];
      pos.set([tp.seg[o], tp.seg[o + 1], z, tp.seg[o + 2], tp.seg[o + 3], z], i * 6);
      c.set(colors[tp.fil[i]] || "#888888");
      const k = 0.35 + 0.65 * Math.max(0, 1 - (zmax - z) / 3);
      col.set([c.r * k, c.g * k, c.b * k, c.r * k, c.g * k, c.b * k], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.groups.orig.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 })));
    this.render();
  }

  // ------------------------------------------------------------ design preview (before generation)
  setDesign(lines, lw, offset) {
    this.clear("design");
    const s = this.surf;
    if (!s || !lines.length) { this.render(); return; }
    const pos = [], col = [];
    const c = new THREE.Color();
    for (const l of lines) {
      c.set(this.app.slotColor(l.slot));
      const P = densify(l.pts, 0.3);
      let prev = null;
      for (const [x, y] of P) {
        const z = s.zAt(x, y);
        const cur = isFinite(z) ? [x, y, z + offset] : null;
        if (prev && cur) { pos.push(...prev, ...cur); col.push(c.r, c.g, c.b, c.r, c.g, c.b); }
        prev = cur;
      }
    }
    if (!pos.length) return;
    const geo = new LineSegmentsGeometry();
    geo.setPositions(pos);
    geo.setColors(col);
    this.groups.design.add(new LineSegments2(geo, this.fatMaterial(lw)));
    this.render();
  }

  // ------------------------------------------------------------ generated G-code
  // flags (Uint8Array per move): 1 = runs downhill, 2 = coast, 4 = wipe;
  // retracts: [[x,y,z]] where the nozzle retracted
  setGcode(moves, lw, travelOn, flags = null, retracts = null, opts = {}) {
    this.clear("gcode"); this.clear("travel"); this.clear("marker"); this.clear("retr");
    this.moves = moves; this.flags = flags; this.retracts = retracts; this.lw = lw;
    if (opts.touches !== undefined) this.touches = opts.touches;
    this.downOn = opts.down ?? this.downOn ?? false;
    const n = moves.length / 9;
    const ep = [], ec = [], tp = [], wp = [];
    this.prefE = new Int32Array(n + 1);
    this.prefT = new Int32Array(n + 1);
    this.prefW = new Int32Array(n + 1);
    const c = new THREE.Color(), red = new THREE.Color(0xff3b30);
    for (let i = 0; i < n; i++) {
      const o = i * 9, kind = moves[o];
      this.prefE[i + 1] = this.prefE[i];
      this.prefT[i + 1] = this.prefT[i];
      this.prefW[i + 1] = this.prefW[i];
      if (kind === 0) {
        if (this.downOn && flags && (flags[i] & 1)) c.copy(red);
        else c.set(this.app.slotColor(moves[o + 1]));
        ep.push(moves[o + 2], moves[o + 3], moves[o + 4], moves[o + 5], moves[o + 6], moves[o + 7]);
        ec.push(c.r, c.g, c.b, c.r, c.g, c.b);
        this.prefE[i + 1]++;
      } else if (kind === 1) {
        tp.push(moves[o + 2], moves[o + 3], moves[o + 4], moves[o + 5], moves[o + 6], moves[o + 7]);
        this.prefT[i + 1]++;
      } else if (kind === 3) {          // wipe / coast: along the bead without material
        wp.push(moves[o + 2], moves[o + 3], moves[o + 4] + 0.02, moves[o + 5], moves[o + 6], moves[o + 7] + 0.02);
        this.prefW[i + 1]++;
      }
    }
    if (wp.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(wp), 3));
      this.wLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xf2a33a, transparent: true, opacity: 0.9, depthTest: false }));
      this.groups.retr.add(this.wLines);
    } else this.wLines = null;
    if (retracts?.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(retracts.flat()), 3));
      this.groups.retr.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xf2a33a, size: 4, sizeAttenuation: false, depthTest: false })));
    }
    if (this.touches?.length) {          // touch-off points: a vertical tick down to the surface
      const pos = [];
      for (const [x, y, z] of this.touches) pos.push(x, y, z, x, y, z + 3, x - 1, y, z, x + 1, y, z, x, y - 1, z, x, y + 1, z);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
      this.groups.retr.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x7dff9a, depthTest: false })));
    }
    if (opts.retr != null) this.groups.retr.visible = opts.retr;
    if (ep.length) {
      const geo = new LineSegmentsGeometry();
      geo.setPositions(ep); geo.setColors(ec);
      this.gLines = new LineSegments2(geo, this.fatMaterial(lw));
      this.groups.gcode.add(this.gLines);
    } else this.gLines = null;
    if (tp.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(tp), 3));
      this.tLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x5d8fd6, transparent: true, opacity: 0.55 }));
      this.groups.travel.add(this.tLines);
    } else this.tLines = null;
    this.groups.travel.visible = travelOn;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.8, 2.4, 16), new THREE.MeshStandardMaterial({ color: 0xf2a33a, emissive: 0x442200 }));
    cone.rotation.x = -Math.PI / 2;
    cone.geometry.translate(0, -1.2, 0);
    this.cone = cone;
    this.groups.marker.add(cone);
    if (this.headGroup) this.groups.marker.add(this.headGroup);
    this.collMoves = null;
    this.setPlay(n);
  }

  // ------------------------------------------------------------ print head (X-ray) + collisions
  // head: raw PancakeSlicer JSON (boxes in nozzle-tip frame, mm) or null
  setHead(head) {
    if (this.headGroup) {
      this.headGroup.parent?.remove(this.headGroup);
      this.headGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    }
    this.headGroup = null; this.headBoxes = [];
    if (head && head.boxes?.length) {
      const g = new THREE.Group();
      const boxes = head.boxes.slice();
      const tr = head.nozzle?.tip_flat_radius || 0.2;
      boxes.push({ name: "nozzle_tip", min: [-tr * 0.7, -tr * 0.7, 0], max: [tr * 0.7, tr * 0.7, 0.05], nozzle: true });
      for (const b of boxes) {
        let [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
        if (b.infinite_x) { x0 = -110; x1 = 110; }
        if (b.infinite_y) { y0 = -110; y1 = 110; }
        const sx = Math.max(0.02, x1 - x0), sy = Math.max(0.02, y1 - y0), sz = Math.max(0.02, z1 - z0);
        const geo = new THREE.BoxGeometry(sx, sy, sz);
        geo.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
        const base = b.nozzle ? 0xf2a33a : (b.duct ? 0x5d8fd6 : 0x9aa4b0);
        const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: base, transparent: true, opacity: b.nozzle ? 0.35 : 0.07, depthWrite: false }));
        const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: base, transparent: true, opacity: b.nozzle ? 0.9 : 0.35, depthWrite: false }));
        fill.renderOrder = edge.renderOrder = 10;
        fill.userData.base = edge.userData.base = base;
        g.add(fill, edge);
        this.headBoxes.push([fill, edge]);
      }
      g.visible = false;
      this.headGroup = g;
      if (this.moves) this.groups.marker.add(g);
    }
    if (this.moves) this.setPlay(this.playI ?? this.moves.length / 9);
  }

  setXray(on) { this.xray = on; if (this.moves) this.setPlay(this.playI ?? 0); }

  // pts: [{x,y,z,rise,len}] – where a stroke was cut to print both halves uphill
  setCuts(pts) {
    this.clear("cuts");
    if (!pts?.length) { this.render(); return; }
    const pos = [];
    for (const c of pts) {
      const x = c.x || 0, y = c.y || 0, z = c.z || 0;
      pos.push(x, y, z - 0.9, x, y, z + 0.9);       // vertical tick
      pos.push(x - 0.7, y, z, x + 0.7, y, z);       // horizontal tick
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    this.groups.cuts.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x6fd3ff, transparent: true, opacity: 0.95, depthTest: false })));
    this.render();
  }

  // coll: {moves:[{i,depth,boxes}], markers:[[x,y,z]]} or null
  setCollisions(coll) {
    this.clear("coll");
    this.collMoves = new Map((coll?.moves || []).map(m => [m.i, m]));
    const pts = coll?.markers || [];
    if (pts.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts.flat()), 3));
      this.groups.coll.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xff3b30, size: 5, sizeAttenuation: false, depthTest: false })));
    }
    if (this.moves) this.setPlay(this.playI ?? this.moves.length / 9);
  }

  _colorHead(hits) {
    for (let k = 0; k < this.headBoxes.length; k++) {
      const red = hits && hits.has(k);
      for (const o of this.headBoxes[k]) {
        o.material.color.setHex(red ? 0xff3b30 : o.userData.base);
      }
      this.headBoxes[k][0].material.opacity = red ? 0.45 : (this.headBoxes[k][0].userData.base === 0xf2a33a ? 0.35 : 0.07);
      this.headBoxes[k][1].material.opacity = red ? 1 : (this.headBoxes[k][1].userData.base === 0xf2a33a ? 0.9 : 0.35);
    }
  }

  setPlay(i) {
    if (!this.moves) return;
    const n = this.moves.length / 9;
    i = Math.max(0, Math.min(n, i | 0));
    if (this.gLines) this.gLines.geometry.instanceCount = this.prefE[i];
    if (this.tLines) this.tLines.geometry.setDrawRange(0, this.prefT[i] * 2);
    if (this.wLines) this.wLines.geometry.setDrawRange(0, this.prefW[i] * 2);
    this.playI = i;
    const useHead = !!(this.headGroup && this.xray);
    const tool = useHead ? this.headGroup : this.cone;
    if (this.cone) this.cone.visible = false;
    if (this.headGroup) this.headGroup.visible = false;
    if (tool) {
      if (i > 0 && i < n) {
        const o = (i - 1) * 9;
        tool.visible = true;
        tool.position.set(this.moves[o + 5], this.moves[o + 6], this.moves[o + 7]);
        if (useHead) this._colorHead(this.collMoves?.get(i - 1) ? new Set(this.collMoves.get(i - 1).boxes) : null);
        else if (this.cone) this.cone.material.color.setHex(this.collMoves?.get(i - 1) ? 0xff3b30 : 0xf2a33a);
      }
    }
    this.render();
  }

  show(name, v) { this.groups[name].visible = v; this.render(); }

  // red = extrusion that runs downhill on the surface
  setDown(on) {
    this.downOn = on;
    if (!this.moves) return;
    const i = this.playI, travelOn = this.groups.travel.visible, retrOn = this.groups.retr.visible;
    const coll = this.collMoves;
    this.setGcode(this.moves, this.lw, travelOn, this.flags, this.retracts, { down: on, retr: retrOn });
    this.collMoves = coll;
    this.setPlay(i ?? this.moves.length / 9);
  }
}

function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const m = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= m; k++) out.push([ax + ((bx - ax) * k) / m, ay + ((by - ay) * k) / m]);
  }
  return out;
}
