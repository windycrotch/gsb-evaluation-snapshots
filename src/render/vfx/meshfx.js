import * as THREE from 'three';
import { LAYER, fxGlobals, FX_DEPTH_GLSL } from '../renderer.js';
import { PREMULT, RAMP_GLSL } from './particles.js';
import { RNG } from '../../core/math.js';

const _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

// ------------------------------------------------------------------------------------------------
// Lightning: jagged branching ribbons, re-rolled several times a second so they crawl and flicker.
// ------------------------------------------------------------------------------------------------
const BOLT_VERT = /* glsl */ `
attribute vec2 aUv;
attribute vec3 aCol;
varying vec2 vUv;
varying vec3 vCol;
void main() {
  vUv = aUv; vCol = aCol;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;
const BOLT_FRAG = /* glsl */ `
${FX_DEPTH_GLSL}
varying vec2 vUv;
varying vec3 vCol;
void main() {
  float d = abs(vUv.x);
  float core = smoothstep(0.2, 0.0, d);
  float glow = exp(-d * d * 8.0) - 0.0003;
  float f = depthFade(0.12);
  vec3 col = vCol * glow + vec3(dot(vCol, vec3(0.34))) * core * 1.6;
  gl_FragColor = vec4(max(col, 0.0) * f, 0.0);
}
`;

export class Lightning {
  constructor(scene, maxQuads = 3200) {
    this.maxQuads = maxQuads;
    this.bolts = [];
    this.rng = new RNG(4242);
    const g = (this.g = new THREE.BufferGeometry());
    this.pos = new Float32Array(maxQuads * 12);
    this.uv = new Float32Array(maxQuads * 8);
    this.col = new Float32Array(maxQuads * 12);
    const idx = new Uint32Array(maxQuads * 6);
    for (let q = 0; q < maxQuads; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 2, q * 4 + 1, q * 4 + 3], q * 6);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aUv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aCol', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: BOLT_VERT, fragmentShader: BOLT_FRAG, uniforms: { ...fxGlobals }, ...PREMULT, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.FX);
    this.mesh.renderOrder = 16;
    scene.add(this.mesh);
  }

  clear() { this.bolts.length = 0; }

  // a, b: {x,y,z} (kept by reference, so a moving endpoint is followed on each re-roll)
  strike(a, b, { width = 0.14, life = 0.25, r = 0.35, g = 0.7, b: bl = 1.0, intensity = 14, jag = 0.2, branches = 2, regen = 0.045, levels = 5 } = {}) {
    const bolt = { a, b, width, life, age: 0, r, g, bl, intensity, jag, branches, regen, regenT: 0, levels, lines: [], flick: 1 };
    this.bolts.push(bolt);
    return bolt;
  }

  _path(a, b, jag, levels, out) {
    let pts = [a.x, a.y, a.z, b.x, b.y, b.z];
    const rng = this.rng;
    for (let l = 0; l < levels; l++) {
      const next = [];
      for (let i = 0; i < pts.length - 3; i += 3) {
        const ax = pts[i], ay = pts[i + 1], az = pts[i + 2], bx = pts[i + 3], by = pts[i + 4], bz = pts[i + 5];
        const len = Math.hypot(bx - ax, by - ay, bz - az) * jag;
        next.push(ax, ay, az, (ax + bx) / 2 + rng.range(-len, len), (ay + by) / 2 + rng.range(-len, len), (az + bz) / 2 + rng.range(-len, len));
      }
      next.push(pts[pts.length - 3], pts[pts.length - 2], pts[pts.length - 1]);
      pts = next;
    }
    out.push(pts);
    return pts;
  }

  _regen(bolt) {
    const lines = (bolt.lines = []);
    const rng = this.rng;
    const main = this._path(bolt.a, bolt.b, bolt.jag, bolt.levels, []);
    lines.push({ pts: main, w: 1, k: 1 });
    const n = main.length / 3;
    const len = Math.hypot(bolt.b.x - bolt.a.x, bolt.b.y - bolt.a.y, bolt.b.z - bolt.a.z);
    for (let i = 0; i < bolt.branches; i++) {
      const s = rng.int(Math.floor(n * 0.15), Math.floor(n * 0.8)) * 3;
      const dx = main[s + 3] - main[s], dy = main[s + 4] - main[s + 1], dz = main[s + 5] - main[s + 2];
      const dl = Math.hypot(dx, dy, dz) || 1;
      const bl = len * rng.range(0.14, 0.34);
      const from = { x: main[s], y: main[s + 1], z: main[s + 2] };
      const to = {
        x: from.x + (dx / dl) * bl * 0.7 + rng.range(-bl, bl) * 0.6,
        y: from.y + (dy / dl) * bl * 0.7 + rng.range(-bl, bl) * 0.6,
        z: from.z + (dz / dl) * bl * 0.7 + rng.range(-bl, bl) * 0.6,
      };
      lines.push({ pts: this._path(from, to, bolt.jag * 1.2, Math.max(2, bolt.levels - 2), []), w: 0.55, k: 0.5 });
    }
    bolt.flick = rng.range(0.55, 1.0);
  }

  update(dt, camera) {
    const cam = camera.position;
    let q = 0;
    const pos = this.pos, uv = this.uv, col = this.col, maxQ = this.maxQuads;
    for (let bi = this.bolts.length - 1; bi >= 0; bi--) {
      const bolt = this.bolts[bi];
      bolt.age += dt;
      if (bolt.age >= bolt.life || bolt.dead) { this.bolts.splice(bi, 1); continue; }
      bolt.regenT -= dt;
      if (bolt.regenT <= 0) { this._regen(bolt); bolt.regenT = bolt.regen; }
      const fade = Math.pow(1 - bolt.age / bolt.life, 0.6) * bolt.flick * bolt.intensity;
      for (const line of bolt.lines) {
        const p = line.pts, w = bolt.width * line.w * 0.5, k = fade * line.k;
        const cr = bolt.r * k, cg = bolt.g * k, cb = bolt.bl * k;
        let px = 0, py = 0, pz = 0, has = false;
        for (let i = 0; i < p.length - 3 && q < maxQ; i += 3) {
          const ax = p[i], ay = p[i + 1], az = p[i + 2], bx = p[i + 3], by = p[i + 4], bz = p[i + 5];
          // side vector: perpendicular to the segment and to the view ray
          _a.set(bx - ax, by - ay, bz - az);
          _b.set(cam.x - ax, cam.y - ay, cam.z - az);
          _c.crossVectors(_a, _b).normalize().multiplyScalar(w);
          const o = q * 12, u = q * 8;
          // reuse the previous segment's end offsets so the ribbon stays continuous at joints
          const sx = has ? px : _c.x, sy = has ? py : _c.y, sz = has ? pz : _c.z;
          pos[o] = ax - sx; pos[o + 1] = ay - sy; pos[o + 2] = az - sz;
          pos[o + 3] = ax + sx; pos[o + 4] = ay + sy; pos[o + 5] = az + sz;
          pos[o + 6] = bx - _c.x; pos[o + 7] = by - _c.y; pos[o + 8] = bz - _c.z;
          pos[o + 9] = bx + _c.x; pos[o + 10] = by + _c.y; pos[o + 11] = bz + _c.z;
          px = _c.x; py = _c.y; pz = _c.z; has = true;
          uv[u] = -1; uv[u + 2] = 1; uv[u + 4] = -1; uv[u + 6] = 1;
          for (let v = 0; v < 4; v++) { col[o + v * 3] = cr; col[o + v * 3 + 1] = cg; col[o + v * 3 + 2] = cb; }
          q++;
        }
      }
    }
    const g = this.g;
    g.setDrawRange(0, q * 6);
    if (q) {
      for (const name of ['position', 'aUv', 'aCol']) {
        const at = g.attributes[name];
        at.clearUpdateRanges();
        at.addUpdateRange(0, q * 4 * at.itemSize);
        at.needsUpdate = true;
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Ribbon trails (dashes, projectiles, fists).
// ------------------------------------------------------------------------------------------------
const TRAIL_FRAG = /* glsl */ `
${FX_DEPTH_GLSL}
${RAMP_GLSL}
uniform sampler2D uNoise;
uniform float uTime;
varying vec2 vUv;   // x: side -1..1, y: 0 head .. 1 tail
varying vec3 vCol;  // heat, ramp, seed
void main() {
  float d = abs(vUv.x);
  float n = texture2D(uNoise, vec2(vUv.y * 0.9 - uTime * 0.6 + vCol.z, vUv.x * 0.22 + vCol.z)).r;
  float body = (1.0 - d) * (1.0 - d);
  float tail = pow(1.0 - vUv.y, 1.6);
  float a = body * tail * smoothstep(0.15 + vUv.y * 0.55, 0.75, n + 0.35 * (1.0 - d));
  a *= depthFade(0.2);
  gl_FragColor = vec4(ramp(vCol.x * (0.35 + 0.65 * tail) * (0.5 + n), vCol.y) * a, 0.0);
}
`;
export class Trails {
  constructor(scene, maxQuads = 900) {
    this.maxQuads = maxQuads;
    this.list = [];
    const g = (this.g = new THREE.BufferGeometry());
    this.pos = new Float32Array(maxQuads * 12);
    this.uv = new Float32Array(maxQuads * 8);
    this.col = new Float32Array(maxQuads * 12);
    const idx = new Uint32Array(maxQuads * 6);
    for (let q = 0; q < maxQuads; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 2, q * 4 + 1, q * 4 + 3], q * 6);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aUv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aCol', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: BOLT_VERT, fragmentShader: TRAIL_FRAG, uniforms: { ...fxGlobals }, ...PREMULT, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.FX);
    this.mesh.renderOrder = 15;
    scene.add(this.mesh);
    this.seed = 0;
  }
  clear() { this.list.length = 0; }
  start({ width = 0.5, life = 0.3, heat = 1.2, ramp = 0, up = false } = {}) {
    const t = { width, life, heat, ramp, up, pts: [], ended: false, seed: (this.seed += 0.37) % 1 };
    this.list.push(t);
    return t;
  }
  push(t, x, y, z) {
    const p = t.pts, n = p.length;
    if (n && Math.hypot(p[n - 1].x - x, p[n - 1].y - y, p[n - 1].z - z) < 0.04) return;
    p.push({ x, y, z, age: 0 });
    if (p.length > 40) p.shift();
  }
  update(dt, camera) {
    const cam = camera.position, pos = this.pos, uv = this.uv, col = this.col;
    let q = 0;
    for (let ti = this.list.length - 1; ti >= 0; ti--) {
      const t = this.list[ti], p = t.pts;
      for (const pt of p) pt.age += dt;
      while (p.length && p[0].age > t.life) p.shift();
      if (t.ended && p.length < 2) { this.list.splice(ti, 1); continue; }
      let px = 0, py = 0, pz = 0, has = false;
      for (let i = p.length - 1; i > 0 && q < this.maxQuads; i--) {
        const A = p[i], B = p[i - 1];
        if (t.up) _c.set(0, t.width * 0.5, 0);
        else {
          _a.set(B.x - A.x, B.y - A.y, B.z - A.z);
          _b.set(cam.x - A.x, cam.y - A.y, cam.z - A.z);
          _c.crossVectors(_a, _b).normalize().multiplyScalar(t.width * 0.5);
        }
        const o = q * 12, u = q * 8;
        const sx = has ? px : _c.x, sy = has ? py : _c.y, sz = has ? pz : _c.z;
        pos[o] = A.x - sx; pos[o + 1] = A.y - sy; pos[o + 2] = A.z - sz;
        pos[o + 3] = A.x + sx; pos[o + 4] = A.y + sy; pos[o + 5] = A.z + sz;
        pos[o + 6] = B.x - _c.x; pos[o + 7] = B.y - _c.y; pos[o + 8] = B.z - _c.z;
        pos[o + 9] = B.x + _c.x; pos[o + 10] = B.y + _c.y; pos[o + 11] = B.z + _c.z;
        px = _c.x; py = _c.y; pz = _c.z; has = true;
        const ya = A.age / t.life, yb = B.age / t.life;
        uv[u] = -1; uv[u + 1] = ya; uv[u + 2] = 1; uv[u + 3] = ya; uv[u + 4] = -1; uv[u + 5] = yb; uv[u + 6] = 1; uv[u + 7] = yb;
        for (let v = 0; v < 4; v++) { col[o + v * 3] = t.heat; col[o + v * 3 + 1] = t.ramp; col[o + v * 3 + 2] = t.seed; }
        q++;
      }
    }
    const g = this.g;
    g.setDrawRange(0, q * 6);
    if (q) for (const name of ['position', 'aUv', 'aCol']) {
      const at = g.attributes[name];
      at.clearUpdateRanges();
      at.addUpdateRange(0, q * 4 * at.itemSize);
      at.needsUpdate = true;
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Ground quads: scorch/crack decals (scene layer) and flash rings / telegraphs (fx layer).
// ------------------------------------------------------------------------------------------------
const GROUND_VERT = /* glsl */ `
attribute vec4 iPos;  // xyz, radius
attribute vec4 iA;    // t (seconds or progress), mode, seed, intensity
attribute vec3 iC;
varying vec2 vP;
varying vec4 vA;
varying vec3 vC;
varying float vR;
void main() {
  vP = position.xy; vA = iA; vC = iC; vR = iPos.w;
  vec3 wp = iPos.xyz + vec3(position.x, 0.0, position.y) * iPos.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;
const DECAL_FRAG = /* glsl */ `
${RAMP_GLSL}
uniform sampler2D uNoise;
varying vec2 vP;
varying vec4 vA;
varying vec3 vC;
varying float vR;
void main() {
  float r = length(vP);
  if (r > 1.0) discard;
  float age = vA.x, seed = vA.z;
  vec2 uv = vP * vR * 0.11 + seed * 7.0;
  float n1 = texture2D(uNoise, uv).r;
  float n2 = texture2D(uNoise, uv * 2.6 + 0.4).b;
  float ang = atan(vP.y, vP.x) / 6.2831853;
  // radial fractures: iso-lines of an angular noise field, plus a few ring fractures
  float an = texture2D(uNoise, vec2(ang * 2.0 + seed, r * 0.22 + seed)).r + n2 * 0.12;
  float lines = abs(fract(an * 9.0) - 0.5);
  float wdt = 0.045 + 0.05 * (1.0 - r);
  float radial = smoothstep(wdt, 0.0, lines);
  float ringc = smoothstep(0.03, 0.0, abs(fract(n1 * 5.0 + r * 1.3) - 0.5)) * 0.7;
  float mask = smoothstep(1.0, 0.25, r + (n1 - 0.5) * 0.35);
  float crack = clamp(max(radial, ringc) * mask, 0.0, 1.0);
  float heat = exp(-age * 1.25) * vA.w;
  float pool = exp(-r * r * 7.0) * heat * 1.1;
  vec3 emis = ramp(heat * crack * 1.5 + pool * (0.5 + n2), vA.y) * step(0.01, heat);
  float life = 1.0 - smoothstep(9.0, 14.0, age);
  float dark = (smoothstep(1.0, 0.15, r + (n2 - 0.5) * 0.5) * 0.62 + crack * 0.38) * life * smoothstep(0.0, 0.08, age + 0.05);
  gl_FragColor = vec4(emis * life + vC * 0.012 * dark, dark);
}
`;
const GROUNDFX_FRAG = /* glsl */ `
${FX_DEPTH_GLSL}
uniform sampler2D uNoise;
uniform float uTime;
varying vec2 vP;
varying vec4 vA;
varying vec3 vC;
varying float vR;
void main() {
  float r = length(vP);
  if (r > 1.0) discard;
  float p = vA.x, mode = vA.y, seed = vA.z;
  float ang = atan(vP.y, vP.x);
  float n = texture2D(uNoise, vec2(ang * 0.5 + seed, r * 0.6 - uTime * 0.2 + seed)).r;
  float I = 0.0;
  if (mode < 0.5) {
    // expanding flash ring
    float front = 0.1 + 0.88 * (1.0 - pow(1.0 - p, 2.6));
    I = exp(-pow((r - front) / (0.035 + 0.05 * p), 2.0)) * (1.0 - p) * (1.0 - p) * (0.55 + n);
    I += exp(-r * r * 18.0) * pow(1.0 - p, 6.0) * 2.0;
  } else if (mode < 1.5) {
    // storm call: target ring that tightens as the strike comes
    float edge = exp(-pow((r - 0.96) / 0.014, 2.0));
    float inner = exp(-pow((r - mix(0.92, 0.12, p * p)) / 0.02, 2.0));
    float ticks = smoothstep(0.35, 0.5, abs(fract(ang * 1.9099 + uTime * 0.6) - 0.5)) * step(0.8, r) * step(r, 0.94);
    float fill = (1.0 - r) * 0.12 * p;
    I = (edge + inner * (0.4 + p) + ticks * 0.35 + fill) * (0.35 + 0.9 * p) * (0.8 + 0.2 * sin(uTime * 50.0));
  } else if (mode < 2.5) {
    // eruption: the floor glows and splits before it bursts
    float lines = smoothstep(0.07, 0.0, abs(fract(n * 6.0 + r) - 0.5));
    I = (lines * 1.3 + exp(-r * r * 5.0) * 0.8) * smoothstep(1.0, 0.5, r) * p * p * 1.6;
  } else {
    // soft pulsing pool of light
    I = exp(-r * r * 4.0) * (0.6 + 0.6 * n) * p;
  }
  I *= vA.w * depthFade(0.3);
  gl_FragColor = vec4(vC * I, 0.0);
}
`;
export class GroundQuads {
  constructor(scene, max, decal) {
    this.max = max;
    this.items = [];
    const g = (this.g = new THREE.InstancedBufferGeometry());
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 2, 1, 0, 3, 2]);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aC = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos); g.setAttribute('iA', this.aA); g.setAttribute('iC', this.aC);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    const mat = new THREE.ShaderMaterial({
      vertexShader: GROUND_VERT, fragmentShader: decal ? DECAL_FRAG : GROUNDFX_FRAG, uniforms: { ...fxGlobals }, ...PREMULT,
      depthTest: decal, polygonOffset: decal, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(decal ? LAYER.SCENE : LAYER.FX);
    this.mesh.renderOrder = decal ? 2 : 8;
    this.decal = decal;
    scene.add(this.mesh);
  }
  clear() { this.items.length = 0; }
  // decal: t counts seconds up to 'life'. fx: t is progress 0..1 over 'life' (or driven externally via item.p)
  add(x, z, radius, { mode = 0, life = 1, r = 1, g = 1, b = 1, intensity = 1, seed = 0, y = 0.012 } = {}) {
    const it = { x, y, z, radius, mode, life, t: 0, r, g, b, intensity, seed, dead: false };
    if (this.items.length >= this.max) this.items.shift();
    this.items.push(it);
    return it;
  }
  update(dt) {
    const P = this.aPos.array, A = this.aA.array, C = this.aC.array;
    let n = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      if (it.t >= it.life || it.dead) this.items.splice(i, 1);
    }
    for (const it of this.items) {
      const j = n * 4;
      P[j] = it.x; P[j + 1] = it.y + n * 0.0004; P[j + 2] = it.z; P[j + 3] = it.radius;
      A[j] = this.decal ? it.t : it.t / it.life; A[j + 1] = it.mode; A[j + 2] = it.seed; A[j + 3] = it.intensity;
      C[n * 3] = it.r; C[n * 3 + 1] = it.g; C[n * 3 + 2] = it.b;
      n++;
    }
    this.g.instanceCount = n;
    this.aPos.needsUpdate = this.aA.needsUpdate = this.aC.needsUpdate = true;
  }
}

// ------------------------------------------------------------------------------------------------
// Debris: bouncing rubble (lit, shadow-casting) and hot voxel cubes that cool as they scatter.
// ------------------------------------------------------------------------------------------------
export class Debris {
  constructor(scene, max, hot) {
    this.max = max;
    this.hot = hot;
    this.items = [];
    let geo, mat;
    if (hot) {
      geo = new THREE.BoxGeometry(1, 1, 1);
      mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    } else {
      geo = new THREE.DodecahedronGeometry(0.5, 0);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * 1.25, p.getY(i) * 0.7, p.getZ(i) * (0.9 + 0.3 * Math.sin(i * 1.7)));
      geo.computeVertexNormals();
      mat = new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.85, metalness: 0.0, flatShading: true });
    }
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = !hot;
    this.mesh.receiveShadow = !hot;
    if (hot) this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    scene.add(this.mesh);
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.s = new THREE.Vector3();
    this.p = new THREE.Vector3();
    this.e = new THREE.Euler();
  }
  clear() { this.items.length = 0; }
  spawn(x, y, z, vx, vy, vz, size, life, r = 1, g = 0.4, b = 0.1, heat = 8) {
    if (this.items.length >= this.max) this.items.shift();
    this.items.push({ x, y, z, vx, vy, vz, size, life, t: 0, rx: vx * 0.7 + 1, ry: vy * 0.3, rz: vz * 0.7 - 1, ax: x * 3.1, ay: z * 2.3, az: y, r, g, b, heat, rest: false });
  }
  update(dt) {
    const it = this.items;
    for (let i = it.length - 1; i >= 0; i--) {
      const d = it[i];
      d.t += dt;
      if (d.t >= d.life) { it.splice(i, 1); continue; }
      if (!d.rest) {
        d.vy -= 30 * dt;
        d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
        d.ax += d.rx * dt; d.ay += d.ry * dt; d.az += d.rz * dt;
        const floor = d.size * 0.3;
        if (d.y < floor) {
          d.y = floor;
          if (d.vy < -2.5) { d.vy *= -0.36; d.vx *= 0.6; d.vz *= 0.6; d.rx *= 0.6; d.rz *= 0.6; }
          else { d.vy = 0; d.vx *= Math.exp(-6 * dt); d.vz *= Math.exp(-6 * dt); d.rx *= Math.exp(-6 * dt); d.rz *= Math.exp(-6 * dt); d.ry *= Math.exp(-6 * dt); if (Math.abs(d.vx) + Math.abs(d.vz) < 0.15) d.rest = true; }
        }
      }
    }
    const n = Math.min(it.length, this.max);
    for (let i = 0; i < n; i++) {
      const d = it[i];
      const k = d.size * Math.min(1, (d.life - d.t) / 0.45) * Math.min(1, d.t / 0.04 + 0.4);
      this.e.set(d.ax, d.ay, d.az);
      this.q.setFromEuler(this.e);
      this.m.compose(this.p.set(d.x, d.y, d.z), this.q, this.s.set(k, k, k));
      this.mesh.setMatrixAt(i, this.m);
      if (this.hot) {
        const h = d.heat * Math.exp(-d.t * 2.2) + 0.02;
        this.mesh.instanceColor.setXYZ(i, d.r * h, d.g * h, d.b * h);
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.hot) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ------------------------------------------------------------------------------------------------
// Slash arcs: a crescent of energy that sweeps along a swing.
// ------------------------------------------------------------------------------------------------
const SLASH_VERT = /* glsl */ `
uniform float uAge;
varying vec2 vUv;
void main() {
  float ang = atan(position.y, position.x);
  float rad = length(position.xy);
  vUv = vec2(ang / 2.9, (rad - 0.5) / 0.5);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const SLASH_FRAG = /* glsl */ `
${FX_DEPTH_GLSL}
${RAMP_GLSL}
uniform sampler2D uNoise;
uniform float uAge;
uniform float uRamp;
uniform float uHeat;
uniform float uSeed;
varying vec2 vUv;
void main() {
  float head = uAge * 1.55;
  float t = head - vUv.x;
  float n = texture2D(uNoise, vec2(vUv.x * 0.8 + uSeed, vUv.y * 0.35 + uSeed * 3.0)).r;
  float sweep = smoothstep(0.0, 0.04, t) * exp(-t * (3.2 + n * 3.0));
  float edge = pow(clamp(vUv.y, 0.0, 1.0), 7.0) * smoothstep(1.0, 0.94, vUv.y);
  float thin = smoothstep(0.45, 1.0, vUv.y) * smoothstep(0.35, 0.7, n);
  float a = sweep * (edge * 1.5 + thin * 0.16) * (1.0 - uAge * uAge);
  a *= smoothstep(0.0, 0.05, vUv.x) * smoothstep(1.0, 0.9, vUv.x) * depthFade(0.15);
  gl_FragColor = vec4(ramp(uHeat * (0.45 + n * 0.9) * (0.4 + sweep), uRamp) * a, 0.0);
}
`;
export class Slashes {
  constructor(scene, n = 10) {
    this.pool = [];
    const geo = new THREE.RingGeometry(0.5, 1.0, 56, 1, 0, 2.9);
    for (let i = 0; i < n; i++) {
      const u = { ...fxGlobals, uAge: { value: 1 }, uRamp: { value: 0 }, uHeat: { value: 1 }, uSeed: { value: i * 0.37 } };
      const m = new THREE.Mesh(geo, new THREE.ShaderMaterial({ vertexShader: SLASH_VERT, fragmentShader: SLASH_FRAG, uniforms: u, ...PREMULT, side: THREE.DoubleSide }));
      m.visible = false;
      m.frustumCulled = false;
      m.layers.set(LAYER.FX);
      m.renderOrder = 13;
      scene.add(m);
      this.pool.push({ m, u, age: 1, life: 0.2 });
    }
    this.next = 0;
  }
  clear() { for (const s of this.pool) { s.m.visible = false; s.age = 1; } }
  // pos: centre; yaw: facing; tilt: 0 = horizontal sweep, PI/2 = vertical; dir: +1/-1 sweep direction
  spawn(x, y, z, yaw, { tilt = 0, roll = 0, size = 2, life = 0.2, ramp = 0, heat = 1.3, dir = 1 } = {}) {
    const s = this.pool[this.next++ % this.pool.length];
    s.age = 0; s.life = life;
    s.u.uRamp.value = ramp; s.u.uHeat.value = heat;
    const m = s.m;
    m.visible = true;
    m.position.set(x, y, z);
    m.scale.set(size * dir, size, size);
    // ring lies in XY; lay it flat (XZ), centre the 166° arc on the facing direction, then tilt
    m.rotation.set(0, 0, 0);
    m.rotateY(yaw);
    m.rotateZ(roll);
    m.rotateX(-Math.PI / 2 + tilt);
    m.rotateZ(Math.PI / 2 - 1.45);
    return s;
  }
  update(dt) {
    for (const s of this.pool) {
      if (!s.m.visible) continue;
      s.age += dt / s.life;
      s.u.uAge.value = s.age;
      if (s.age >= 1) s.m.visible = false;
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Orbs: flash spheres, guard shields, plasma balls (charge-ups, the beam clash core).
// ------------------------------------------------------------------------------------------------
const ORB_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying vec3 vL;
void main() {
  vL = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;
const ORB_FRAG = /* glsl */ `
${FX_DEPTH_GLSL}
${RAMP_GLSL}
uniform sampler2D uNoise;
uniform float uTime;
uniform float uAge;     // 0..1
uniform float uKind;    // 0 flash shell, 1 shield, 2 plasma ball
uniform float uRamp;
uniform float uHeat;
uniform vec3 uTint;
varying vec3 vN;
varying vec3 vV;
varying vec3 vL;
float hexd(vec2 p) {
  p.x *= 1.1547; p.y += mod(floor(p.x), 2.0) * 0.5;
  p = abs(fract(p) - 0.5);
  return abs(max(p.x * 1.5 + p.y, p.y * 2.0) - 1.0);
}
void main() {
  float ndv = abs(dot(normalize(vN), normalize(vV)));
  float fres = pow(1.0 - ndv, 2.5);
  vec2 suv = vec2(atan(vL.z, vL.x) / 6.2831853, vL.y * 0.5);
  float f = depthFade(0.3);
  vec3 col; float a = 0.0;
  if (uKind < 0.5) {
    float I = (fres * 0.55 + 0.03) * pow(1.0 - uAge, 2.0);
    col = ramp(uHeat * (0.5 + fres), uRamp) * I;
  } else if (uKind < 1.5) {
    float hx = smoothstep(0.1, 0.0, hexd(suv * vec2(20.0, 10.0)));
    float front = smoothstep(0.1, 0.95, vL.z);
    float I = (hx * (0.5 + fres * 1.5) + fres * 0.18) * front * front * (1.0 - uAge) * (1.0 - uAge);
    col = uTint * I * uHeat * 2.2;
  } else {
    float n = texture2D(uNoise, suv * vec2(2.0, 1.2) + vec2(uTime * 0.35, -uTime * 0.5)).r;
    float n2 = texture2D(uNoise, suv * vec2(5.0, 3.0) - vec2(uTime * 0.6, uTime * 0.2)).b;
    float core = pow(ndv, 1.4);
    float swirl = smoothstep(0.3, 0.75, n * 0.65 + n2 * 0.35);
    float h = uHeat * (0.18 + pow(core, 2.2) * 1.25 + swirl * (0.55 + fres * 0.6));
    col = ramp(h, uRamp) * (0.3 + core * 0.7) * smoothstep(0.0, 0.55, ndv);
    a = core * core * 0.5;
  }
  gl_FragColor = vec4(col * f, a * f);
}
`;
export class Orbs {
  constructor(scene, n = 10) {
    this.pool = [];
    const geo = new THREE.SphereGeometry(1, 40, 24);
    for (let i = 0; i < n; i++) {
      const u = { ...fxGlobals, uAge: { value: 0 }, uKind: { value: 0 }, uRamp: { value: 0 }, uHeat: { value: 1 }, uTint: { value: new THREE.Color(1, 1, 1) } };
      const m = new THREE.Mesh(geo, new THREE.ShaderMaterial({ vertexShader: ORB_VERT, fragmentShader: ORB_FRAG, uniforms: u, ...PREMULT }));
      m.visible = false;
      m.frustumCulled = false;
      m.layers.set(LAYER.FX);
      m.renderOrder = 11;
      scene.add(m);
      this.pool.push({ m, u, age: 0, life: 0, s0: 1, s1: 1, held: false });
    }
  }
  _get() {
    let best = this.pool[0];
    for (const o of this.pool) { if (!o.m.visible) return o; if (!o.held && (best.held || o.age > best.age)) best = o; }
    return best;
  }
  // kind: 0 flash shell, 1 shield, 2 plasma. life = 0 → held until release()
  spawn(x, y, z, { kind = 0, s0 = 0.5, s1 = 3, life = 0.25, ramp = 0, heat = 1.2, tint = null, yaw = 0 } = {}) {
    const o = this._get();
    o.age = 0; o.life = life; o.s0 = s0; o.s1 = s1; o.held = life === 0;
    o.u.uKind.value = kind; o.u.uRamp.value = ramp; o.u.uHeat.value = heat; o.u.uAge.value = 0;
    if (tint) o.u.uTint.value.copy(tint);
    o.m.position.set(x, y, z);
    o.m.rotation.set(0, yaw, 0);
    o.m.scale.setScalar(s0);
    o.m.visible = true;
    return o;
  }
  release(o) { if (o) { o.held = false; o.m.visible = false; } }
  clear() { for (const o of this.pool) { o.held = false; o.m.visible = false; } }
  update(dt) {
    for (const o of this.pool) {
      if (!o.m.visible || o.held) continue;
      o.age += dt / o.life;
      if (o.age >= 1) { o.m.visible = false; continue; }
      o.u.uAge.value = o.age;
      const e = 1 - Math.pow(1 - o.age, 3);
      o.m.scale.setScalar(o.s0 + (o.s1 - o.s0) * e);
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Beams: the ultimates. A turbulent sheath around a white-hot core, stretched along +Z.
// ------------------------------------------------------------------------------------------------
const BEAM_VERT = /* glsl */ `
uniform sampler2D uNoise;
uniform float uTime;
uniform float uLen;
uniform float uRadius;
uniform float uWobble;
uniform float uFlow;
varying vec3 vN;
varying vec3 vV;
varying vec2 vUv;
void main() {
  // unit cylinder along +Y in object space: y in [0,1]
  float z = position.y;
  float ang = atan(position.z, position.x);
  float nz = texture2D(uNoise, vec2(ang / 6.2831853 * 2.0, z * uLen * 0.045 - uTime * uFlow * 0.25)).r;
  float grow = smoothstep(0.0, 0.035, z) * (0.55 + 0.45 * smoothstep(0.0, 0.2, z));
  float tip = 1.0 + 0.35 * smoothstep(0.93, 1.0, z);
  float r = uRadius * grow * tip * (1.0 + (nz - 0.5) * uWobble);
  vec3 p = vec3(cos(ang) * r, z * uLen, sin(ang) * r);
  vUv = vec2(ang / 6.2831853, z);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vN = normalize(normalMatrix * vec3(cos(ang), 0.0, sin(ang)));
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;
const BEAM_FRAG = /* glsl */ `
${FX_DEPTH_GLSL}
${RAMP_GLSL}
uniform sampler2D uNoise;
uniform float uTime;
uniform float uLen;
uniform float uHeat;
uniform float uRamp;
uniform float uFlow;
uniform float uCore;   // 1 = solid core, 0 = wispy sheath
uniform float uAlpha;
varying vec3 vN;
varying vec3 vV;
varying vec2 vUv;
void main() {
  float ndv = abs(dot(normalize(vN), normalize(vV)));
  float along = vUv.y * uLen;
  float n1 = texture2D(uNoise, vec2(vUv.x * 2.0, along * 0.05 - uTime * uFlow * 0.5)).r;
  float n2 = texture2D(uNoise, vec2(vUv.x * 5.0 + 0.3, along * 0.14 - uTime * uFlow * 0.9)).b;
  float streak = n1 * 0.65 + n2 * 0.35;
  float f = depthFade(0.4) * smoothstep(0.0, 0.02, vUv.y) * uAlpha;
  vec3 col;
  if (uCore > 0.5) {
    float body = pow(ndv, 0.8);
    col = ramp(uHeat * (0.75 + streak * 0.5), uRamp) * body;
  } else {
    float body = pow(ndv, 1.6) * smoothstep(0.28, 0.72, streak + ndv * 0.25);
    float rim = pow(1.0 - ndv, 2.0) * 0.5;
    col = ramp(uHeat * (0.35 + streak * 0.95), uRamp) * (body + rim * streak);
  }
  gl_FragColor = vec4(col * f, 0.0);
}
`;
export class Beam {
  constructor(scene, ramp) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    const geo = new THREE.CylinderGeometry(1, 1, 1, 40, 96, true);
    geo.translate(0, 0.5, 0);
    const mk = (core, radius, heat, wobble, flow) => {
      const u = {
        ...fxGlobals, uLen: { value: 1 }, uRadius: { value: radius }, uWobble: { value: wobble }, uFlow: { value: flow },
        uHeat: { value: heat }, uRamp: { value: ramp }, uCore: { value: core }, uAlpha: { value: 1 },
      };
      const m = new THREE.Mesh(geo, new THREE.ShaderMaterial({ vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, uniforms: u, ...PREMULT, side: THREE.DoubleSide }));
      m.frustumCulled = false;
      m.layers.set(LAYER.FX);
      m.renderOrder = 9;
      m.rotation.x = Math.PI / 2; // +Y → +Z
      this.group.add(m);
      return u;
    };
    const fire = ramp === 0;
    this.sheath2 = mk(0, fire ? 1.75 : 1.45, fire ? 0.6 : 0.58, fire ? 0.7 : 0.35, fire ? 5.5 : 9);
    this.sheath = mk(0, fire ? 1.25 : 1.0, fire ? 0.8 : 0.78, fire ? 0.45 : 0.22, fire ? 8 : 13);
    this.core = mk(1, fire ? 0.6 : 0.5, 0.98, 0.12, 16);
    this.alpha = 0;
    this.baseR = [this.sheath2.uRadius.value, this.sheath.uRadius.value, this.core.uRadius.value];
  }
  set(ox, oy, oz, yaw, len, on, dt, scale = 1) {
    this.alpha += ((on ? 1 : 0) - this.alpha) * Math.min(1, dt * (on ? 30 : 9));
    this.group.visible = this.alpha > 0.01;
    if (!this.group.visible) return;
    this.group.position.set(ox, oy, oz);
    this.group.rotation.y = yaw;
    const us = [this.sheath2, this.sheath, this.core];
    us.forEach((u, i) => {
      u.uLen.value = Math.max(0.5, len);
      u.uAlpha.value = this.alpha;
      u.uRadius.value = this.baseR[i] * scale * (0.35 + 0.65 * this.alpha);
    });
  }
}
