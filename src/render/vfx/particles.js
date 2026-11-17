import * as THREE from 'three';
import { LAYER, fxGlobals, FX_DEPTH_GLSL } from '../renderer.js';

// CPU-simulated, GPU-instanced particle systems. Everything renders with premultiplied alpha
// (ONE, ONE_MINUS_SRC_ALPHA) so additive fire and occluding smoke can share one pass.

const PREMULT = {
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  toneMapped: false,
};

function instancedQuads(max, attrs) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const out = {};
  for (const name in attrs) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(max * attrs[name]), attrs[name]);
    a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(name, a);
    out[name] = a;
  }
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return { g, a: out };
}

export const RAMP_GLSL = /* glsl */ `
vec3 fireRamp(float t) {
  t = clamp(t, 0.0, 1.7);
  vec3 c = mix(vec3(0.30, 0.015, 0.0), vec3(1.0, 0.13, 0.008), smoothstep(0.0, 0.35, t));
  c = mix(c, vec3(1.0, 0.42, 0.05), smoothstep(0.3, 0.7, t));
  c = mix(c, vec3(1.0, 0.82, 0.46), smoothstep(0.7, 1.25, t));
  return c * (0.12 + t * t * 9.0);
}
vec3 voltRamp(float t) {
  t = clamp(t, 0.0, 1.7);
  vec3 c = mix(vec3(0.015, 0.04, 0.5), vec3(0.05, 0.30, 1.0), smoothstep(0.0, 0.4, t));
  c = mix(c, vec3(0.40, 0.78, 1.0), smoothstep(0.4, 0.9, t));
  c = mix(c, vec3(0.9, 0.97, 1.0), smoothstep(0.9, 1.35, t));
  return c * (0.12 + t * t * 9.0);
}
vec3 ramp(float t, float kind) { return kind < 0.5 ? fireRamp(t) : voltRamp(t); }
`;

// ------------------------------------------------------------------------------------------------
// Puffs: soft "volumetric" billboards. A hot puff is emissive fire/plasma that cools into smoke.
// ------------------------------------------------------------------------------------------------
const PUFF_VERT = /* glsl */ `
attribute vec4 iPos;   // xyz, size
attribute vec4 iA;     // age01, seed, heat, ramp
attribute vec4 iC;     // smoke rgb, alpha
attribute vec2 iRot;   // rotation, vertical stretch
varying vec2 vUv;
varying vec4 vA;
varying vec4 vC;
varying float vSize;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  vA = iA; vC = iC; vSize = iPos.w;
  float c = cos(iRot.x), s = sin(iRot.x);
  vec2 q = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * iPos.w;
  q.y *= 1.0 + iRot.y;
  vec4 mv = viewMatrix * vec4(iPos.xyz, 1.0);
  mv.xy += q;
  gl_Position = projectionMatrix * mv;
}
`;
const PUFF_FRAG = /* glsl */ `
${FX_DEPTH_GLSL}
${RAMP_GLSL}
uniform sampler2D uNoise;
uniform vec3 uKeyDirV;
uniform vec3 uKeyCol;
uniform vec3 uAmb;
varying vec2 vUv;
varying vec4 vA;
varying vec4 vC;
varying float vSize;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float age = vA.x, seed = vA.y;
  float sph = sqrt(1.0 - r2);
  vec2 nuv = vUv * 0.40 + vec2(seed * 7.31, seed * 3.17);
  float n1 = texture2D(uNoise, nuv + vec2(0.0, -age * 0.16)).r;
  float n2 = texture2D(uNoise, nuv * 2.7 + vec2(age * 0.22, seed)).b;
  float n3 = texture2D(uNoise, nuv * 1.25 - vec2(age * 0.09, 0.0)).g;
  float n = n1 * 0.5 + n2 * 0.22 + n3 * 0.28;
  float dens = sph * (0.32 + 1.3 * n);
  float erode = mix(0.26, 1.04, pow(age, 1.1));
  float a = smoothstep(erode, erode + 0.3, dens) * smoothstep(0.0, 0.05, age);
  a *= depthFade(max(0.15, vSize * 0.45));
  if (a < 0.002) discard;
  float nn = smoothstep(0.22, 0.78, n);
  float heat = vA.z * pow(1.0 - age, 1.6) * (0.1 + 1.3 * nn * sph);
  vec3 emis = ramp(heat, vA.w) * step(0.001, vA.z);
  vec3 N = normalize(vec3(p + (vec2(n1, n2) - 0.5) * 1.3, sph + 0.3));
  float ndl = dot(N, uKeyDirV) * 0.5 + 0.5;
  vec3 smoke = vC.rgb * (uAmb + uKeyCol * ndl * ndl) + emis * 0.05;
  float hot = smoothstep(0.12, 0.85, heat);
  float sa = a * vC.a * (1.0 - hot);
  gl_FragColor = vec4(emis * a + smoke * sa, sa);
}
`;

const PS = 24; // puff stride
export class Puffs {
  constructor(scene, max = 3500) {
    this.max = max;
    this.d = new Float32Array(max * PS);
    this.n = 0;
    const { g, a } = instancedQuads(max, { iPos: 4, iA: 4, iC: 4, iRot: 2 });
    this.g = g; this.a = a;
    this.uniforms = {
      ...fxGlobals,
      uKeyDirV: { value: new THREE.Vector3(0, 1, 0) },
      uKeyCol: { value: new THREE.Color(0.55, 0.62, 0.8) },
      uAmb: { value: new THREE.Color(0.14, 0.15, 0.2) },
    };
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: PUFF_VERT, fragmentShader: PUFF_FRAG, uniforms: this.uniforms, ...PREMULT }));
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.FX);
    this.mesh.renderOrder = 10;
    scene.add(this.mesh);
    this.order = new Uint16Array(max);
    this.key = new Float32Array(max);
    // scratch spawn descriptor (filled by callers, then emit())
    this.o = {};
    this.reset();
  }
  reset() {
    Object.assign(this.o, { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, s0: 0.5, s1: 1.5, rot: 0, rotV: 0, seed: 0, heat: 0, ramp: 0, r: 0.1, g: 0.1, b: 0.1, a: 0.5, drag: 1.5, buoy: 0, turb: 0, stretch: 0, amb: 0 });
    return this.o;
  }
  emit() {
    if (this.n >= this.max) return;
    const o = this.o, d = this.d, i = this.n++ * PS;
    d[i] = o.x; d[i + 1] = o.y; d[i + 2] = o.z; d[i + 3] = o.vx; d[i + 4] = o.vy; d[i + 5] = o.vz;
    d[i + 6] = 0; d[i + 7] = o.life; d[i + 8] = o.s0; d[i + 9] = o.s1; d[i + 10] = o.rot; d[i + 11] = o.rotV;
    d[i + 12] = o.seed; d[i + 13] = o.heat; d[i + 14] = o.ramp; d[i + 15] = o.r; d[i + 16] = o.g; d[i + 17] = o.b;
    d[i + 18] = o.a; d[i + 19] = o.drag; d[i + 20] = o.buoy; d[i + 21] = o.turb; d[i + 22] = o.stretch || 0; d[i + 23] = o.amb || 0;
  }
  // drop everything except ambient scenery puffs
  clearCombat() {
    const d = this.d;
    let n = 0;
    for (let k = 0; k < this.n; k++) if (d[k * PS + 23] > 0.5) { if (n !== k) d.copyWithin(n * PS, k * PS, k * PS + PS); n++; }
    this.n = n;
  }
  update(dt, camera, t) {
    const d = this.d;
    let n = this.n;
    for (let k = 0; k < n; k++) {
      const i = k * PS;
      d[i + 6] += dt / d[i + 7];
      if (d[i + 6] >= 1) {
        n--;
        d.copyWithin(i, n * PS, n * PS + PS);
        k--;
        continue;
      }
      const drag = Math.exp(-d[i + 19] * dt);
      const tb = d[i + 21];
      if (tb > 0) {
        const s = d[i + 12] * 40;
        d[i + 3] += Math.sin(t * 3.1 + s + d[i + 1]) * tb * dt;
        d[i + 5] += Math.cos(t * 2.7 + s * 1.3 + d[i]) * tb * dt;
      }
      d[i + 3] *= drag; d[i + 4] = d[i + 4] * drag + d[i + 20] * dt; d[i + 5] *= drag;
      d[i] += d[i + 3] * dt; d[i + 1] += d[i + 4] * dt; d[i + 2] += d[i + 5] * dt;
      if (d[i + 1] < 0.05 && d[i + 4] < 0) { d[i + 1] = 0.05; d[i + 4] *= -0.2; }
      d[i + 10] += d[i + 11] * dt;
    }
    this.n = n;
    this.g.instanceCount = n;
    if (!n) return;
    // back-to-front so smoke occludes correctly
    const e = camera.matrixWorldInverse.elements;
    const order = this.order, key = this.key;
    for (let k = 0; k < n; k++) {
      const i = k * PS;
      order[k] = k;
      key[k] = e[2] * d[i] + e[6] * d[i + 1] + e[10] * d[i + 2];
    }
    const view = order.subarray(0, n);
    view.sort((a, b) => key[a] - key[b]);
    const P = this.a.iPos.array, A = this.a.iA.array, C = this.a.iC.array, R = this.a.iRot.array;
    for (let k = 0; k < n; k++) {
      const i = view[k] * PS, j = k * 4;
      const age = d[i + 6];
      const g = 1 - (1 - age) * (1 - age) * (1 - age);
      P[j] = d[i]; P[j + 1] = d[i + 1]; P[j + 2] = d[i + 2]; P[j + 3] = d[i + 8] + (d[i + 9] - d[i + 8]) * g;
      A[j] = age; A[j + 1] = d[i + 12]; A[j + 2] = d[i + 13]; A[j + 3] = d[i + 14];
      C[j] = d[i + 15]; C[j + 1] = d[i + 16]; C[j + 2] = d[i + 17]; C[j + 3] = d[i + 18];
      R[k * 2] = d[i + 10]; R[k * 2 + 1] = d[i + 22];
    }
    for (const k in this.a) {
      const at = this.a[k];
      at.clearUpdateRanges();
      at.addUpdateRange(0, n * at.itemSize);
      at.needsUpdate = true;
    }
    this.uniforms.uKeyDirV.value.set(-0.3, 0.85, 0.42).normalize().transformDirection(camera.matrixWorldInverse);
  }
}

// ------------------------------------------------------------------------------------------------
// Sparks: velocity-stretched hot streaks with gravity and floor bounces.
// ------------------------------------------------------------------------------------------------
const SPARK_VERT = /* glsl */ `
attribute vec4 iPos;  // xyz, width
attribute vec4 iVel;  // xyz, stretch
attribute vec4 iA;    // age01, heat, ramp, seed
varying vec2 vUv;
varying vec4 vA;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  vA = iA;
  vec3 v = iVel.xyz;
  float sp = length(v);
  vec3 dir = sp > 1e-4 ? v / sp : vec3(0.0, 1.0, 0.0);
  vec3 toCam = normalize(cameraPosition - iPos.xyz);
  vec3 side = normalize(cross(dir, toCam));
  float w = iPos.w * (1.0 - iA.x * 0.6);
  float len = max(w, min(sp * iVel.w, 1.5));
  vec3 wp = iPos.xyz + side * position.x * w + dir * (position.y - 0.6) * len;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;
const SPARK_FRAG = /* glsl */ `
${FX_DEPTH_GLSL}
${RAMP_GLSL}
varying vec2 vUv;
varying vec4 vA;
void main() {
  if (depthFade(0.08) <= 0.0) discard;
  float w = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float body = pow(w, 1.6) * smoothstep(0.0, 0.2, vUv.y) * smoothstep(1.0, 0.82, vUv.y) * (0.25 + 0.75 * vUv.y);
  float flick = 0.75 + 0.25 * sin(vA.w * 91.0 + vA.x * 60.0);
  float heat = vA.y * (1.0 - vA.x * vA.x) * flick;
  gl_FragColor = vec4(ramp(heat, vA.z) * body * 2.2, 0.0);
}
`;
const SS = 14;
export class Sparks {
  constructor(scene, max = 5000) {
    this.max = max;
    this.d = new Float32Array(max * SS);
    this.n = 0;
    const { g, a } = instancedQuads(max, { iPos: 4, iVel: 4, iA: 4 });
    this.g = g; this.a = a;
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG, uniforms: { ...fxGlobals }, ...PREMULT }));
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.FX);
    this.mesh.renderOrder = 12;
    scene.add(this.mesh);
  }
  clear() { this.n = 0; this.g.instanceCount = 0; }
  // x,y,z, vx,vy,vz, life, width, heat, ramp, gravity, drag, stretch
  emit(x, y, z, vx, vy, vz, life, width, heat, ramp, grav = 22, drag = 0.8, stretch = 0.02) {
    if (this.n >= this.max) return;
    const d = this.d, i = this.n++ * SS;
    d[i] = x; d[i + 1] = y; d[i + 2] = z; d[i + 3] = vx; d[i + 4] = vy; d[i + 5] = vz;
    d[i + 6] = 0; d[i + 7] = life; d[i + 8] = width; d[i + 9] = heat; d[i + 10] = ramp; d[i + 11] = grav; d[i + 12] = drag; d[i + 13] = stretch;
  }
  update(dt) {
    const d = this.d;
    let n = this.n;
    const P = this.a.iPos.array, V = this.a.iVel.array, A = this.a.iA.array;
    for (let k = 0; k < n; k++) {
      const i = k * SS;
      d[i + 6] += dt / d[i + 7];
      if (d[i + 6] >= 1) { n--; d.copyWithin(i, n * SS, n * SS + SS); k--; continue; }
      const drag = Math.exp(-d[i + 12] * dt);
      d[i + 3] *= drag; d[i + 5] *= drag;
      d[i + 4] = d[i + 4] * drag - d[i + 11] * dt;
      d[i] += d[i + 3] * dt; d[i + 1] += d[i + 4] * dt; d[i + 2] += d[i + 5] * dt;
      if (d[i + 1] < 0.03 && d[i + 4] < 0) { d[i + 1] = 0.03; d[i + 4] *= -0.38; d[i + 3] *= 0.62; d[i + 5] *= 0.62; }
      const j = k * 4;
      P[j] = d[i]; P[j + 1] = d[i + 1]; P[j + 2] = d[i + 2]; P[j + 3] = d[i + 8];
      V[j] = d[i + 3]; V[j + 1] = d[i + 4]; V[j + 2] = d[i + 5]; V[j + 3] = d[i + 13];
      A[j] = d[i + 6]; A[j + 1] = d[i + 9]; A[j + 2] = d[i + 10]; A[j + 3] = (k * 0.6180339) % 1;
    }
    this.n = n;
    this.g.instanceCount = n;
    for (const k in this.a) {
      const at = this.a[k];
      at.clearUpdateRanges();
      at.addUpdateRange(0, n * at.itemSize);
      at.needsUpdate = true;
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Glows: additive flares, embers, flash cards. Optional 4-point star and anamorphic stretch.
// ------------------------------------------------------------------------------------------------
const GLOW_VERT = /* glsl */ `
attribute vec4 iPos;   // xyz, size
attribute vec4 iC;     // rgb (HDR), star
attribute vec2 iS;     // stretch x, fade (0..1 remaining)
varying vec2 vUv;
varying vec4 vC;
varying float vFade;
varying float vSize;
void main() {
  vUv = position.xy;
  vC = iC; vFade = iS.y; vSize = iPos.w;
  vec4 mv = viewMatrix * vec4(iPos.xyz, 1.0);
  mv.xy += position.xy * iPos.w * vec2(iS.x, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;
const GLOW_FRAG = /* glsl */ `
${FX_DEPTH_GLSL}
varying vec2 vUv;
varying vec4 vC;
varying float vFade;
varying float vSize;
void main() {
  float d2 = dot(vUv, vUv);
  if (d2 > 1.0) discard;
  float g = exp(-d2 * 5.5) - 0.004;
  g += exp(-d2 * 40.0) * 1.6;
  if (vC.a > 0.5) {
    vec2 a = abs(vUv);
    float st = exp(-a.y * 46.0) * (1.0 - a.x) + exp(-a.x * 46.0) * (1.0 - a.y);
    g += st * 0.9 * (1.0 - d2);
  }
  g *= vFade * depthFade(max(0.2, vSize * 0.3));
  gl_FragColor = vec4(vC.rgb * max(g, 0.0), 0.0);
}
`;
const GS = 19;
export class Glows {
  constructor(scene, max = 1500) {
    this.max = max;
    this.d = new Float32Array(max * GS);
    this.n = 0;
    const { g, a } = instancedQuads(max, { iPos: 4, iC: 4, iS: 2 });
    this.g = g; this.a = a;
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, uniforms: { ...fxGlobals }, ...PREMULT }));
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.FX);
    this.mesh.renderOrder = 14;
    scene.add(this.mesh);
  }
  // fadePow: >1 = hold then drop, <1 = spike then linger
  emit(x, y, z, size0, size1, life, r, g, b, { star = 0, stretch = 1, vx = 0, vy = 0, vz = 0, fadePow = 1, drag = 0, turb = 0, amb = 0 } = {}) {
    if (this.n >= this.max) return;
    const d = this.d, i = this.n++ * GS;
    d[i] = x; d[i + 1] = y; d[i + 2] = z; d[i + 3] = vx; d[i + 4] = vy; d[i + 5] = vz;
    d[i + 6] = 0; d[i + 7] = life; d[i + 8] = size0; d[i + 9] = size1; d[i + 10] = r; d[i + 11] = g; d[i + 12] = b;
    d[i + 13] = star; d[i + 14] = fadePow; d[i + 15] = drag; d[i + 16] = turb; d[i + 17] = stretch; d[i + 18] = amb;
  }
  clearCombat() {
    const d = this.d;
    let n = 0;
    for (let k = 0; k < this.n; k++) if (d[k * GS + 18] > 0.5) { if (n !== k) d.copyWithin(n * GS, k * GS, k * GS + GS); n++; }
    this.n = n;
  }
  update(dt, t) {
    const d = this.d;
    let n = this.n;
    const P = this.a.iPos.array, C = this.a.iC.array, S = this.a.iS.array;
    for (let k = 0; k < n; k++) {
      const i = k * GS;
      d[i + 6] += dt / d[i + 7];
      if (d[i + 6] >= 1) { n--; d.copyWithin(i, n * GS, n * GS + GS); k--; continue; }
      const turb = d[i + 16], drag = d[i + 15];
      if (turb > 0) {
        d[i + 3] += Math.sin(t * 2.3 + d[i + 1] * 1.7 + k) * turb * dt;
        d[i + 5] += Math.cos(t * 1.9 + d[i] * 1.3 + k * 2.0) * turb * dt;
      }
      if (drag > 0) { const q = Math.exp(-drag * dt); d[i + 3] *= q; d[i + 4] *= q; d[i + 5] *= q; }
      d[i] += d[i + 3] * dt; d[i + 1] += d[i + 4] * dt; d[i + 2] += d[i + 5] * dt;
      const age = d[i + 6], j = k * 4;
      const stretch = d[i + 17], star = d[i + 13];
      P[j] = d[i]; P[j + 1] = d[i + 1]; P[j + 2] = d[i + 2]; P[j + 3] = d[i + 8] + (d[i + 9] - d[i + 8]) * (1 - (1 - age) * (1 - age));
      C[j] = d[i + 10]; C[j + 1] = d[i + 11]; C[j + 2] = d[i + 12]; C[j + 3] = star;
      S[k * 2] = Math.max(1, stretch); S[k * 2 + 1] = Math.pow(1 - age, d[i + 14]);
    }
    this.n = n;
    this.g.instanceCount = n;
    for (const k in this.a) {
      const at = this.a[k];
      at.clearUpdateRanges();
      at.addUpdateRange(0, n * at.itemSize);
      at.needsUpdate = true;
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Shocks: screen-space refraction (shockwave rings + heat haze), drawn into the distortion buffer.
// ------------------------------------------------------------------------------------------------
const SHOCK_VERT = /* glsl */ `
attribute vec4 iPos;  // xyz, radius
attribute vec4 iA;    // age01, strength, ground(0/1), haze(0/1)
varying vec2 vP;
varying vec4 vA;
varying vec2 vDir;
void main() {
  vP = position.xy; vA = iA;
  vec4 c = projectionMatrix * viewMatrix * vec4(iPos.xyz, 1.0);
  vec4 clip;
  if (iA.z > 0.5) {
    vec3 wp = iPos.xyz + vec3(position.x, 0.0, position.y) * iPos.w;
    clip = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  } else {
    vec4 mv = viewMatrix * vec4(iPos.xyz, 1.0);
    mv.xy += position.xy * iPos.w;
    clip = projectionMatrix * mv;
  }
  vDir = clip.xy / max(clip.w, 1e-4) - c.xy / max(c.w, 1e-4);
  gl_Position = clip;
}
`;
const SHOCK_FRAG = /* glsl */ `
${FX_DEPTH_GLSL}
uniform sampler2D uNoise;
uniform float uTime;
varying vec2 vP;
varying vec4 vA;
varying vec2 vDir;
void main() {
  float r = length(vP);
  if (r > 1.0) discard;
  float age = vA.x;
  vec2 dir = normalize(vDir + 1e-6);
  vec2 off;
  if (vA.w > 0.5) {
    vec2 n = texture2D(uNoise, vP * 0.35 + vec2(0.0, -uTime * 0.35) + age).rb - 0.5;
    off = n * (1.0 - r) * (1.0 - age) * vA.y;
  } else {
    float front = 0.12 + 0.86 * (1.0 - pow(1.0 - age, 2.2));
    float w = 0.10;
    float ring = exp(-pow((r - front) / w, 2.0));
    off = dir * ring * (1.0 - age) * (1.0 - age) * vA.y * smoothstep(1.0, 0.9, r);
  }
  off *= depthFade(0.5);
  gl_FragColor = vec4(off, 0.0, 0.0);
}
`;
const HS = 10;
export class Shocks {
  constructor(scene, max = 48) {
    this.max = max;
    this.d = new Float32Array(max * HS);
    this.n = 0;
    const { g, a } = instancedQuads(max, { iPos: 4, iA: 4 });
    this.g = g; this.a = a;
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
      vertexShader: SHOCK_VERT, fragmentShader: SHOCK_FRAG, uniforms: { ...fxGlobals }, transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, toneMapped: false, side: THREE.DoubleSide,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.DISTORT);
    scene.add(this.mesh);
  }
  clear() { this.n = 0; this.g.instanceCount = 0; }
  // ring: expanding refraction front; haze: wobbling heat shimmer
  emit(x, y, z, radius, life, strength, { ground = false, haze = false, vy = 0 } = {}) {
    if (this.n >= this.max) return;
    const d = this.d, i = this.n++ * HS;
    d[i] = x; d[i + 1] = y; d[i + 2] = z; d[i + 3] = radius; d[i + 4] = 0; d[i + 5] = life; d[i + 6] = strength; d[i + 7] = ground ? 1 : 0; d[i + 8] = haze ? 1 : 0; d[i + 9] = vy;
  }
  update(dt) {
    const d = this.d;
    let n = this.n;
    const P = this.a.iPos.array, A = this.a.iA.array;
    for (let k = 0; k < n; k++) {
      const i = k * HS;
      d[i + 4] += dt / d[i + 5];
      if (d[i + 4] >= 1) { n--; d.copyWithin(i, n * HS, n * HS + HS); k--; continue; }
      d[i + 1] += d[i + 9] * dt;
      const j = k * 4;
      P[j] = d[i]; P[j + 1] = d[i + 1]; P[j + 2] = d[i + 2]; P[j + 3] = d[i + 3];
      A[j] = d[i + 4]; A[j + 1] = d[i + 6]; A[j + 2] = d[i + 7]; A[j + 3] = d[i + 8];
    }
    this.n = n;
    this.g.instanceCount = n;
    for (const k in this.a) {
      const at = this.a[k];
      at.clearUpdateRanges();
      at.addUpdateRange(0, n * at.itemSize);
      at.needsUpdate = true;
    }
  }
}

export { PREMULT };
