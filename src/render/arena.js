import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { LAYER, fxGlobals, FX_DEPTH_GLSL } from './renderer.js';
import { RNG, TAU } from '../core/math.js';
import { ARENA_R } from '../sim/constants.js';

export const SUN_DIR = new THREE.Vector3(-1, 0.07, -0.42).normalize();
export const WARM = new THREE.Color(1.0, 0.36, 0.1);
export const COOL = new THREE.Color(0.16, 0.5, 1.0);

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww; // pinned to the far plane, ignores camera translation
}
`;

const SKY_FRAG = /* glsl */ `
varying vec3 vDir;
uniform sampler2D uNoise;
uniform float uTime;
uniform vec3 uSun;
uniform vec4 uFlash; // xyz dir, w intensity
float cloudN(vec2 uv, float t) {
  vec2 w = vec2(t * 0.0035, t * 0.0012);
  float n = texture2D(uNoise, uv * 0.040 + w).r;
  n += texture2D(uNoise, uv * 0.097 - w * 1.7).a * 0.5;
  n += texture2D(uNoise, uv * 0.29 + w * 2.6).b * 0.24;
  return n / 1.74;
}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec2 dh = normalize(d.xz + 1e-5);
  vec2 sh = normalize(uSun.xz);
  float sunAmt = max(dot(dh, sh), 0.0);
  float coolAmt = max(-dot(dh, sh), 0.0);
  vec3 zen = vec3(0.006, 0.010, 0.026);
  vec3 hor = vec3(0.030, 0.050, 0.090);
  vec3 col = mix(hor, zen, pow(clamp(h, 0.0, 1.0), 0.42));
  // Low sun burning through a slit under the storm deck on one side...
  float band = exp(-abs(h - 0.035) * 8.0);
  col += vec3(1.0, 0.30, 0.07) * pow(sunAmt, 2.5) * band * 1.9;
  col += vec3(1.0, 0.62, 0.30) * pow(sunAmt, 40.0) * exp(-abs(h - 0.045) * 26.0) * 9.0;
  // ...and cold electric dusk on the other.
  col += vec3(0.03, 0.20, 0.52) * pow(coolAmt, 1.6) * exp(-abs(h - 0.05) * 5.0) * 0.85;

  // Storm deck: two parallax layers projected on a dome.
  float hh = max(h, 0.0);
  vec2 cuv = d.xz / (hh + 0.16) * 3.2;
  float n = cloudN(cuv, uTime);
  float dens = smoothstep(0.40, 0.66, n);
  float n2 = cloudN(cuv + sh * 1.4, uTime);
  float shade = clamp((n - n2) * 2.4 + 0.42, 0.0, 1.0); // facing the sun -> lit edge
  vec3 cDark = vec3(0.010, 0.014, 0.026);
  vec3 cWarm = vec3(1.0, 0.36, 0.11) * (0.25 + 2.2 * pow(sunAmt, 2.0)) * exp(-hh * 2.2);
  vec3 cCool = vec3(0.06, 0.16, 0.36) * (0.5 + 1.2 * coolAmt) * exp(-hh * 1.4);
  vec3 cloudCol = cDark + (cWarm + cCool) * shade * (1.0 - dens * 0.55);
  // sheet lightning inside the deck
  float fl = uFlash.w * pow(max(dot(d, normalize(uFlash.xyz)), 0.0), 6.0);
  cloudCol += vec3(0.55, 0.72, 1.0) * fl * (0.35 + n * 1.6) * 5.0;
  float cover = dens * smoothstep(0.0, 0.10, h);
  col = mix(col, cloudCol, cover * 0.94);
  // stars in the gaps
  vec3 sp = floor(d * 240.0);
  float st = fract(sin(dot(sp, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  col += vec3(0.8, 0.9, 1.0) * step(0.9985, st) * (1.0 - cover) * smoothstep(0.1, 0.5, h) * 1.4;
  // below the horizon: the cloud sea haze
  vec3 below = mix(vec3(0.020, 0.030, 0.052), vec3(0.50, 0.17, 0.05) * 0.5, pow(sunAmt, 3.0) * 0.8);
  below += vec3(0.01, 0.06, 0.16) * pow(coolAmt, 2.0);
  col = mix(col, below, smoothstep(0.03, -0.06, h));
  gl_FragColor = vec4(col, 1.0);
}
`;

const CLOUDSEA_FRAG = /* glsl */ `
varying vec3 vW;
uniform sampler2D uNoise;
uniform float uTime;
uniform vec3 uSun;
uniform vec3 uCam;
void main() {
  vec2 p = vW.xz * 0.006;
  vec2 w = vec2(uTime * 0.003, uTime * 0.001);
  float n = texture2D(uNoise, p + w).r * 0.6 + texture2D(uNoise, p * 2.7 - w).a * 0.3 + texture2D(uNoise, p * 7.0 + w * 2.0).b * 0.1;
  float n2 = texture2D(uNoise, p + w + normalize(uSun.xz) * 0.02).r * 0.6 + texture2D(uNoise, (p + normalize(uSun.xz) * 0.02) * 2.7 - w).a * 0.3;
  float lit = clamp((n - n2 / 0.9) * 5.0 + 0.5, 0.0, 1.0);
  vec2 dh = normalize(vW.xz - uCam.xz + 1e-4);
  float sunAmt = max(dot(dh, normalize(uSun.xz)), 0.0);
  float coolAmt = max(-dot(dh, normalize(uSun.xz)), 0.0);
  vec3 base = vec3(0.012, 0.018, 0.034) * (0.5 + n);
  vec3 warm = vec3(1.0, 0.33, 0.09) * pow(sunAmt, 2.0) * 0.55;
  vec3 cool = vec3(0.05, 0.16, 0.36) * coolAmt * 0.35;
  vec3 col = base + (warm + cool) * lit * smoothstep(0.3, 0.75, n);
  float dist = length(vW - uCam);
  vec3 haze = mix(vec3(0.020, 0.030, 0.052), vec3(0.50, 0.17, 0.05) * 0.5, pow(sunAmt, 3.0) * 0.8) + vec3(0.01, 0.06, 0.16) * pow(coolAmt, 2.0);
  col = mix(col, haze, 1.0 - exp(-dist * 0.0045));
  gl_FragColor = vec4(col, 1.0);
}
`;

const BARRIER_FRAG = /* glsl */ `
${FX_DEPTH_GLSL}
varying vec3 vW;
uniform float uTime;
uniform vec4 uHits[4];   // xyz position, w age (seconds, <0 = off)
uniform vec3 uHitCol[4];
float hex(vec2 p) {
  p.x *= 1.1547; p.y += mod(floor(p.x), 2.0) * 0.5;
  p = abs(fract(p) - 0.5);
  return abs(max(p.x * 1.5 + p.y, p.y * 2.0) - 1.0);
}
void main() {
  float ang = atan(vW.z, vW.x);
  vec2 uv = vec2(ang * ${ARENA_R.toFixed(1)} * 0.55, vW.y * 0.55);
  float hx = smoothstep(0.10, 0.0, hex(uv));
  vec3 col = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    float age = uHits[i].w;
    if (age < 0.0) continue;
    float d = distance(vW, uHits[i].xyz);
    float ring = exp(-pow((d - age * 22.0) * 0.55, 2.0));
    float core = exp(-d * 0.55) * exp(-age * 5.0);
    float fade = exp(-age * 2.6);
    col += uHitCol[i] * (ring * (0.25 + hx * 2.2) * fade * 2.2 + core * (0.6 + hx * 3.0) * 4.0);
  }
  col *= depthFade(0.6) * smoothstep(9.0, 2.0, vW.y);
  gl_FragColor = vec4(col, 0.0);
}
`;

function stoneTextures(seed = 7) {
  // CPU fbm → bump + roughness detail shared by all stone props.
  const N = 256, rng = new RNG(seed);
  const grid = (n) => { const g = new Float32Array(n * n); for (let i = 0; i < g.length; i++) g[i] = rng.next(); return g; };
  const octs = [8, 16, 32, 64, 128].map((n) => ({ n, g: grid(n) }));
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let v = 0, a = 0.5, tot = 0;
    for (const o of octs) {
      const fx = (x / N) * o.n, fy = (y / N) * o.n;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const g = (i, j) => o.g[((j + o.n) % o.n) * o.n + ((i + o.n) % o.n)];
      v += a * ((g(x0, y0) * (1 - sx) + g(x0 + 1, y0) * sx) * (1 - sy) + (g(x0, y0 + 1) * (1 - sx) + g(x0 + 1, y0 + 1) * sx) * sy);
      tot += a; a *= 0.55;
    }
    v /= tot;
    const ridge = 1 - Math.abs(v * 2 - 1);
    const b = Math.max(0, Math.min(255, (v * 0.6 + ridge * 0.4) * 255));
    const i = (y * N + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = b;
    data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

function makeFloorMaterial(reflUniforms, shared) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, reflUniforms, shared);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
varying vec3 vWPos;
uniform sampler2D uReflTex;
uniform mat4 uReflMatrix;
uniform float uReflOn;
uniform sampler2D uNoise;
uniform float uTime;
uniform float uPulse;
uniform vec3 uWarm;
uniform vec3 uCool;
vec3 fAlb; float fRough; vec3 fN; vec3 fEmis; float fWet;
float fhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void floorPattern(vec3 wp) {
  vec2 p = wp.xz;
  float r = length(p);
  float ang = atan(p.y, p.x);
  const float RW = 2.45;
  float ri = floor(r / RW), rf = fract(r / RW);
  float segs = ri < 0.5 ? 1.0 : floor(ri * 5.0 + 3.0);
  float a = ang / 6.2831853 + 0.5 + fhash(vec2(ri, 3.0));
  float sf = fract(a * segs), si = floor(a * segs);
  float dR = min(rf, 1.0 - rf) * RW;
  float dA = ri < 0.5 ? 9.0 : min(sf, 1.0 - sf) * 6.2831853 * r / segs;
  if (ri < 0.5) dR = (1.0 - rf) * RW;
  float d = min(dR, dA);
  float aa = fwidth(r) * 1.5 + 0.004;
  float grout = 1.0 - smoothstep(0.022, 0.022 + aa + 0.03, d);
  float rnd = fhash(vec2(ri * 7.0 + 1.0, si));
  float n1 = texture2D(uNoise, p * 0.021).r;
  float n2 = texture2D(uNoise, p * 0.13).b;
  float n3 = texture2D(uNoise, p * 0.55).g;
  float n4 = texture2D(uNoise, p * 1.9).r;
  // puddles gather in the low-frequency dips
  float pud = smoothstep(0.54, 0.63, n1 * 0.75 + texture2D(uNoise, p * 0.06 + 0.3).a * 0.45 + (n2 - 0.5) * 0.12);
  fWet = pud;
  vec3 stone = mix(vec3(0.030, 0.032, 0.038), vec3(0.085, 0.082, 0.080), rnd * 0.55 + n2 * 0.45);
  stone *= 0.72 + n3 * 0.5;
  stone = mix(stone, stone * vec3(1.15, 0.92, 0.80), smoothstep(0.55, 0.9, n4) * 0.5); // mineral staining
  stone = mix(stone, vec3(0.008), grout * 0.9);
  fAlb = stone * mix(1.0, 0.55, pud);
  fRough = mix(0.34 + rnd * 0.22 + (n3 - 0.5) * 0.3 + (n4 - 0.5) * 0.2, 0.035, pud);
  fRough = clamp(mix(fRough, 0.8, grout * (1.0 - pud)), 0.03, 1.0);
  // height: bevel into grout + pitted micro relief, turned into a world-space normal via screen derivatives
  float hgt = smoothstep(0.0, 0.11, d) * 0.035 + (n3 * 0.016 + n4 * 0.007) * (1.0 - pud);
  hgt = mix(hgt, 0.030 + sin(r * 3.0 - uTime * 1.6 + n2 * 9.0) * 0.0006, pud);
  vec2 px = dFdx(p), py = dFdy(p);
  float hx = dFdx(hgt), hy = dFdy(hgt);
  float det = px.x * py.y - px.y * py.x;
  vec2 g = abs(det) > 1e-9 ? vec2(hx * py.y - hy * px.y, -hx * py.x + hy * px.x) / det : vec2(0.0);
  float nfade = 1.0 / (1.0 + length(px) * 40.0 + length(py) * 40.0);
  g = clamp(g, -3.0, 3.0) * nfade * 2.2;
  fN = normalize(vec3(-g.x, 1.0, -g.y));
  // energy inlays: the arena is split down the middle, one colour per corner
  float side = smoothstep(-0.6, 0.6, p.x);
  vec3 ecol = mix(uWarm, uCool, side);
  float ring1 = 1.0 - smoothstep(0.022, 0.022 + aa, abs(r - ${(ARENA_R - 0.35).toFixed(2)}));
  float ring2 = 1.0 - smoothstep(0.014, 0.014 + aa, abs(r - 4.9));
  float seam = (1.0 - smoothstep(0.010, 0.010 + aa, abs(p.x))) * step(r, 4.9);
  float run = 0.55 + 0.45 * sin(ang * 10.0 * (side * 2.0 - 1.0) - uTime * 1.3);
  float inlay = ring1 * (0.5 + 0.5 * run) + ring2 * 0.55 + seam * 0.35;
  fEmis = ecol * inlay * (1.1 + uPulse * 7.0);
  fAlb = mix(fAlb, vec3(0.01), min(inlay, 1.0));
}`)
      .replace('#include <map_fragment>', '#include <map_fragment>\nfloorPattern(vWPos);\ndiffuseColor.rgb = fAlb;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = fRough;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize((viewMatrix * vec4(fN, 0.0)).xyz);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += fEmis;')
      .replace('#include <lights_fragment_maps>', /* glsl */ `#include <lights_fragment_maps>
if (uReflOn > 0.5) {
  vec4 rc = uReflMatrix * vec4(vWPos, 1.0);
  vec2 ruv = rc.xy / rc.w + fN.xz * 0.045;
  float lod = pow(material.roughness, 0.6) * 6.5;
  vec3 pr = textureLod(uReflTex, clamp(ruv, 0.001, 0.999), lod).rgb;
  radiance = pr;
}`);
  };
  return mat;
}

export class Arena {
  constructor(scene, renderer, { lightsPool = 6 } = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    const rng = new RNG(1234);
    this.shared = {
      uNoise: fxGlobals.uNoise,
      uTime: fxGlobals.uTime,
      uPulse: { value: 0 },
      uWarm: { value: WARM.clone() },
      uCool: { value: COOL.clone() },
    };

    // --- sky -------------------------------------------------------------------------------
    this.skyUniforms = { uNoise: fxGlobals.uNoise, uTime: fxGlobals.uTime, uSun: { value: SUN_DIR }, uFlash: { value: new THREE.Vector4(0, 1, 0, 0) } };
    const skyMat = new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: this.skyUniforms, side: THREE.BackSide, depthWrite: false, fog: false });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    this.group.add(sky);

    // --- image based lighting from the same sky + two coloured key sources -------------------
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(sky.geometry, skyMat));
    const blob = (col, pos, s, k) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(s, 16, 12), new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(k) }));
      m.position.copy(pos);
      envScene.add(m);
    };
    blob(WARM, new THREE.Vector3(-60, 14, -22), 16, 22);
    blob(COOL, new THREE.Vector3(60, 16, -22), 16, 16);
    blob(new THREE.Color(0.7, 0.8, 1.0), new THREE.Vector3(-10, 70, 30), 22, 2.2);
    const pm = new THREE.PMREMGenerator(renderer.gl);
    this.envMap = pm.fromScene(envScene, 0.035, 0.5, 500).texture;
    pm.dispose();
    scene.environment = this.envMap;
    scene.environmentIntensity = 0.55;
    scene.fog = new THREE.FogExp2(0x070b14, 0.0105);

    // --- lights --------------------------------------------------------------------------------
    const key = (this.key = new THREE.DirectionalLight(new THREE.Color(0.84, 0.88, 1.0), 2.0));
    key.position.set(-9, 30, 16);
    key.castShadow = true;
    key.shadow.mapSize.set(renderer.q.shadow, renderer.q.shadow);
    const sc = key.shadow.camera;
    sc.left = -23; sc.right = 23; sc.top = 23; sc.bottom = -23; sc.near = 4; sc.far = 80;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.035;
    key.shadow.radius = 2.5;
    scene.add(key, key.target);
    const warmRim = new THREE.DirectionalLight(WARM, 3.0);
    warmRim.position.copy(SUN_DIR).multiplyScalar(40).setY(9);
    const coolRim = new THREE.DirectionalLight(COOL, 2.3);
    coolRim.position.set(40, 12, -17);
    scene.add(warmRim, coolRim);
    this.practicals = [];
    this.dyn = [];
    for (let i = 0; i < lightsPool; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 30, 2);
      l.userData.life = 0;
      scene.add(l);
      this.dyn.push(l);
    }

    // --- materials -------------------------------------------------------------------------------
    const stoneTex = (this.stoneTex = stoneTextures());
    const stone = (rep, col = 0x23252b, rough = 0.86) => {
      const t = stoneTex.clone();
      t.repeat.set(rep[0], rep[1]);
      t.needsUpdate = true;
      return new THREE.MeshStandardMaterial({ color: col, roughness: rough, metalness: 0.0, bumpMap: t, bumpScale: 0.9, roughnessMap: t });
    };
    const emis = (col, k) => new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(k), toneMapped: false, fog: true });
    const metal = new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.38, metalness: 0.9 });

    // --- floor ---------------------------------------------------------------------------------
    const FR = ARENA_R + 1.4;
    const floor = (this.floor = new THREE.Mesh(new THREE.CircleGeometry(FR, 128), makeFloorMaterial(renderer.reflUniforms, this.shared)));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.group.add(floor);
    renderer.reflHide.push(floor);

    const below = new THREE.Group();
    this.group.add(below);
    renderer.reflHide.push(below);
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(FR, FR - 0.5, 2.2, 96, 1, true), stone([28, 1], 0x1c1e23));
    drum.position.y = -1.1;
    below.add(drum);
    // hanging rock mass under the platform
    const rockG = new THREE.CylinderGeometry(FR - 0.6, 3.0, 26, 64, 14, false);
    {
      const p = rockG.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const t = 1 - (y + 13) / 26;
        const a = Math.atan2(z, x);
        const k = 1 + (Math.sin(a * 5 + y * 0.6) * 0.07 + Math.sin(a * 13 - y * 1.3) * 0.045 + Math.sin(a * 29 + y * 2.1) * 0.02) * (0.3 + t * 2.2);
        p.setXYZ(i, x * k, y + Math.sin(a * 7 + x) * t * 1.2, z * k);
      }
      rockG.computeVertexNormals();
    }
    const rock = new THREE.Mesh(rockG, stone([14, 6], 0x15161a, 0.95));
    rock.position.y = -15.2;
    below.add(rock);

    // rim: a low bevelled curb with inset studs
    const rim = new THREE.Mesh(new THREE.TorusGeometry(FR - 0.25, 0.3, 10, 128), stone([60, 1], 0x1a1c21, 0.6));
    rim.rotation.x = Math.PI / 2;
    rim.scale.z = 0.75;
    rim.position.y = 0.02;
    rim.castShadow = rim.receiveShadow = true;
    this.group.add(rim);

    // --- corner pylons: braziers on the warm side, coils on the cool side -------------------------
    this.braziers = [];
    this.coils = [];
    const pylonAt = (x, z, warm) => {
      const g = new THREE.Group();
      g.position.set(x, 0, z);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 1.0, 0.5, 8), stone([3, 1], 0x1d1f24, 0.7));
      base.position.y = 0.25;
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.6, 2.6, 8), stone([2, 2], 0x202228, 0.8));
      col.position.y = 1.8;
      g.add(base, col);
      if (warm) {
        const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.5, 0.55, 20, 1, false), metal);
        bowl.position.y = 3.35;
        const coals = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.82, 0.08, 20), emis(new THREE.Color(1.0, 0.22, 0.03), 5));
        coals.position.y = 3.62;
        g.add(bowl, coals);
        this.braziers.push(new THREE.Vector3(x, 3.75, z));
      } else {
        for (let i = 0; i < 4; i++) {
          const t = new THREE.Mesh(new THREE.TorusGeometry(0.62 - i * 0.1, 0.085, 8, 24), metal);
          t.rotation.x = Math.PI / 2;
          t.position.y = 3.2 + i * 0.24;
          g.add(t);
        }
        const orb = new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 14), emis(new THREE.Color(0.35, 0.7, 1.0), 9));
        orb.position.y = 4.35;
        g.add(orb);
        this.coils.push(new THREE.Vector3(x, 4.35, z));
      }
      g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.group.add(g);
      const l = new THREE.PointLight(warm ? WARM : COOL, warm ? 55 : 42, 34, 2);
      l.position.set(x * 0.96, warm ? 4.6 : 4.4, z * 0.96);
      l.userData.base = l.intensity;
      scene.add(l);
      this.practicals.push(l);
    };
    const pr = FR - 0.9, pa = 0.62;
    pylonAt(-Math.cos(pa) * pr, -Math.sin(pa) * pr, true);
    pylonAt(-Math.cos(pa) * pr, Math.sin(pa) * pr, true);
    pylonAt(Math.cos(pa) * pr, -Math.sin(pa) * pr, false);
    pylonAt(Math.cos(pa) * pr, Math.sin(pa) * pr, false);

    // --- monoliths ringing the arena, rising out of the cloud sea ---------------------------------
    const monoMat = stone([3, 12], 0x34363d, 0.92);
    const N = 11;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU + 0.21 + rng.range(-0.08, 0.08);
      const rad = rng.range(33, 46);
      const H = rng.range(46, 78), W = rng.range(5, 9), D = rng.range(3.2, 5.5);
      const geo = new RoundedBoxGeometry(W, H, D, 3, 0.35);
      // taper + chipped silhouette
      const p = geo.attributes.position;
      for (let v = 0; v < p.count; v++) {
        const y = p.getY(v) / H + 0.5;
        const k = 1 - y * 0.22 + Math.sin(y * 9 + i * 3.3) * 0.025;
        p.setX(v, p.getX(v) * k + Math.sin(y * 5 + i) * 0.25);
        p.setZ(v, p.getZ(v) * k);
      }
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, monoMat);
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      m.position.set(x, H / 2 - 30 + rng.range(-3, 5), z);
      m.rotation.y = -a + Math.PI / 2 + rng.range(-0.25, 0.25);
      m.rotation.z = rng.range(-0.06, 0.06);
      m.rotation.x = rng.range(-0.05, 0.05);
      m.castShadow = false;
      this.group.add(m);
      // a glowing seam down the inner face
      const warm = x < 0;
      const seam = new THREE.Mesh(new THREE.BoxGeometry(0.16, H * 0.55, 0.12), emis(warm ? WARM : COOL, warm ? 4.5 : 5));
      seam.position.set(rng.range(-W * 0.2, W * 0.2), rng.range(-2, 6), -D / 2 - 0.02);
      m.add(seam);
      const seam2 = new THREE.Mesh(new THREE.BoxGeometry(W * 0.35, 0.14, 0.12), seam.material);
      seam2.position.set(seam.position.x + W * 0.175, seam.position.y - H * 0.275, -D / 2 - 0.02);
      m.add(seam2);
    }
    // a few drifting rock shards for parallax
    const shardMat = stone([2, 2], 0x16181c, 0.9);
    this.shards = [];
    for (let i = 0; i < 16; i++) {
      const g = new THREE.SphereGeometry(rng.range(0.5, 2.2), 14, 10);
      const p = g.attributes.position;
      for (let v = 0; v < p.count; v++) {
        const k = 1 + (Math.sin(p.getX(v) * 3.1 + i) + Math.sin(p.getY(v) * 4.3) + Math.sin(p.getZ(v) * 2.7)) * 0.13;
        p.setXYZ(v, p.getX(v) * k, p.getY(v) * k * 1.5, p.getZ(v) * k);
      }
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, shardMat);
      const a = rng.range(0, TAU), rad = rng.range(23, 31);
      m.position.set(Math.cos(a) * rad, rng.range(-5, 13), Math.sin(a) * rad);
      m.rotation.set(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3));
      m.userData = { y: m.position.y, ph: rng.range(0, TAU), sp: rng.range(0.15, 0.4) };
      this.shards.push(m);
      this.group.add(m);
    }

    // --- cloud sea -------------------------------------------------------------------------------
    this.seaUniforms = { uNoise: fxGlobals.uNoise, uTime: fxGlobals.uTime, uSun: { value: SUN_DIR }, uCam: { value: new THREE.Vector3() } };
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(1400, 1400),
      new THREE.ShaderMaterial({
        vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
        fragmentShader: CLOUDSEA_FRAG, uniforms: this.seaUniforms, fog: false,
      })
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = -26;
    below.add(sea);

    // --- energy barrier (only visible where something slams into it) ------------------------------
    this.barrierUniforms = {
      ...fxGlobals,
      uHits: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, 0, -1)) },
      uHitCol: { value: [0, 1, 2, 3].map(() => new THREE.Vector3(1, 1, 1)) },
    };
    const barrier = new THREE.Mesh(
      new THREE.CylinderGeometry(ARENA_R + 0.75, ARENA_R + 0.75, 9, 96, 1, true),
      new THREE.ShaderMaterial({
        vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
        fragmentShader: BARRIER_FRAG, uniforms: this.barrierUniforms, transparent: true, depthTest: false, depthWrite: false,
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, side: THREE.DoubleSide,
      })
    );
    barrier.position.y = 4.5;
    barrier.layers.set(LAYER.FX);
    barrier.frustumCulled = false;
    this.group.add(barrier);
    this.barrierNext = 0;
    this.flash = 0;
    this.flashT = 3;
    this.rng = new RNG(99);
    this.t = 0;
  }

  barrierHit(pos, color) {
    const i = this.barrierNext++ % 4;
    const ang = Math.atan2(pos.z, pos.x);
    this.barrierUniforms.uHits.value[i].set(Math.cos(ang) * (ARENA_R + 0.75), Math.max(0.6, pos.y), Math.sin(ang) * (ARENA_R + 0.75), 0);
    this.barrierUniforms.uHitCol.value[i].set(color.r, color.g, color.b);
  }

  // Borrow a pooled point light for an effect. Intensity decays exponentially.
  light(pos, color, intensity, life = 0.4, dist = 30) {
    let best = this.dyn[0];
    for (const l of this.dyn) if (l.intensity < best.intensity) best = l;
    best.position.set(pos.x, Math.max(0.6, pos.y), pos.z);
    best.color.copy(color);
    best.intensity = intensity * 0.45;
    best.distance = dist;
    best.userData.life = life;
    return best;
  }

  skyFlash(strength = 1) {
    const a = this.rng.range(0, TAU);
    this.skyUniforms.uFlash.value.set(Math.cos(a), this.rng.range(0.15, 0.5), Math.sin(a), 0);
    this.flash = strength;
  }

  update(dt, camera) {
    this.t += dt;
    this.seaUniforms.uCam.value.copy(camera.position);
    for (const l of this.dyn) {
      if (l.intensity > 0.01) l.intensity *= Math.exp(-dt / Math.max(0.02, l.userData.life * 0.35));
      else l.intensity = 0;
    }
    const hits = this.barrierUniforms.uHits.value;
    for (const h of hits) if (h.w >= 0) { h.w += dt; if (h.w > 2.5) h.w = -1; }
    // practical flicker
    this.practicals.forEach((l, i) => {
      const f = i < 2
        ? 0.82 + 0.18 * Math.sin(this.t * 11 + i * 2) * Math.sin(this.t * 7.3 + i) + 0.08 * Math.sin(this.t * 31 + i * 5)
        : 0.9 + 0.1 * Math.sin(this.t * 23 + i) + (Math.sin(this.t * 61 + i * 3) > 0.93 ? 0.5 : 0);
      l.intensity = l.userData.base * f;
    });
    for (const s of this.shards) {
      s.position.y = s.userData.y + Math.sin(this.t * s.userData.sp + s.userData.ph) * 0.8;
      s.rotation.y += dt * 0.04;
    }
    // distant sheet lightning on a seeded schedule
    this.flashT -= dt;
    if (this.flashT <= 0) { this.skyFlash(this.rng.range(0.5, 1)); this.flashT = this.rng.range(2.2, 6.5); }
    this.flash *= Math.exp(-dt * 7);
    const flick = this.flash * (0.6 + 0.4 * Math.sin(this.t * 90));
    this.skyUniforms.uFlash.value.w = flick;
    this.shared.uPulse.value *= Math.exp(-dt * 3.5);
  }
}
