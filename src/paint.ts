// Dab painting, after https://patch.gg/blendi/oil-paint. The whole world is made of brush dabs pinned to points in 3D.
//
//   under ── coarse geometry in flat colours: the underpainting, so nothing shows between the dabs
//   dabs ─── instanced cards, each one mark of the brush sheet (brush.ts) in one mixed colour, run along a
//            direction of the world. `face` dabs turn to the eye (leaves, bark, cloud). `lie` dabs lie on their
//            surface (ground, walls, rock) and are stood up when seen edge on.
//
// Colours are mixed once, when the world is built: a tone from a ramp, picked by light and chance. The shader only
// breaks each colour a little, streaks a lighter one into it, and lets a light rake across the thick paint.
// Because every dab is pinned to the world, the paint stays on things as the eye moves. Far away only a share of
// the dabs is drawn, each grown to stand for its neighbours; which ones stay never changes.
import * as THREE from 'three'
import { BRUSH_COLUMNS, BRUSH_ROWS, createBrushSheet } from './brush.ts'

// ---------- math and noise ----------

export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export function smooth(a: number, b: number, x: number) {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hash2(x: number, y: number) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

export function noise(x: number, y: number) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  let fx = x - ix
  let fy = y - iy
  fx = fx * fx * (3 - 2 * fx)
  fy = fy * fy * (3 - 2 * fy)
  return lerp(lerp(hash2(ix, iy), hash2(ix + 1, iy), fx), lerp(hash2(ix, iy + 1), hash2(ix + 1, iy + 1), fx), fy)
}

export function fbm(x: number, y: number, octaves = 4) {
  let amp = 0.5
  let sum = 0
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x, y)
    x = x * 2.03 + 17.1
    y = y * 2.03 + 9.7
    amp *= 0.5
  }
  return sum
}

/** sharp ridges: mountains */
export function ridged(x: number, y: number) {
  let amp = 0.5
  let sum = 0
  for (let i = 0; i < 4; i++) {
    sum += amp * (1 - Math.abs(noise(x, y) * 2 - 1))
    x = x * 2.1 + 5.3
    y = y * 2.1 + 3.1
    amp *= 0.5
  }
  return sum
}

/** rounded lumps with creases between them: cumulus */
export function billow(x: number, y: number) {
  let amp = 0.5
  let sum = 0
  for (let i = 0; i < 4; i++) {
    sum += amp * Math.abs(noise(x, y) * 2 - 1)
    x = x * 2.07 + 11.3
    y = y * 2.07 + 11.3
    amp *= 0.5
  }
  return sum
}

// ---------- palette ----------

export const TONES = 6

export type Vec3 = [number, number, number]
export type RGB = Vec3

/** Raw sRGB values in 0..1. Not THREE.Color: that converts to linear and shifts the palette. */
export function hex(color: string): RGB {
  const n = parseInt(color.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

// Colours measured from the reference video, dark to light, then made more saturated: the video's colours are
// washed out. The grade in main.ts pulls them together again.
const RAMPS = {
  grass: ['#144613', '#24541d', '#395e1f', '#4d6c18', '#647310', '#797900'].map(hex),
  forestFloor: ['#000905', '#06110d', '#0d1a18', '#102c19', '#1f3a14', '#295112'].map(hex),
  path: ['#7d6e38', '#97783e', '#ad9255', '#bca464', '#d1b873', '#e8d59f'].map(hex),
  bark: ['#000100', '#030806', '#08100b', '#0f1712', '#18221b', '#222f27'].map(hex),
  canopy: ['#000101', '#010906', '#06110c', '#0d1a17', '#102c1c', '#1f4329'].map(hex),
  conifer: ['#08110e', '#0e1e17', '#152d25', '#1a3a2d', '#224742', '#2d5845'].map(hex),
  bushy: ['#121f1c', '#1b301f', '#2b4024', '#3c5327', '#49692a', '#5a7e3b'].map(hex),
  roof: ['#2b161a', '#431c1a', '#582a1f', '#773529', '#993e1a', '#b24300'].map(hex),
  wall: ['#323d45', '#5d5b47', '#8a7053', '#a5895b', '#b39765', '#ccb37e'].map(hex),
  castle: ['#0b0a1e', '#0f0e27', '#13122e', '#181736', '#1e1d41', '#27264d'].map(hex),
  crag: ['#0c0b20', '#11102a', '#161533', '#1d1c3f', '#272654', '#363768'].map(hex),
  cragTree: ['#070711', '#090a1a', '#0c0e22', '#101329', '#131930', '#182137'].map(hex),
  mountain: ['#1b193c', '#25234f', '#2f2d5b', '#3b3964', '#4a456a', '#605573'].map(hex),
  // Not in the video. Goblin skin is a yellower, lighter green than any leaf, so it reads against the shrubs.
  goblin: ['#18280f', '#2d4215', '#4a641b', '#6c8726', '#93aa3a', '#b9c95b'].map(hex),
  // troll skin has the slate blue of the far crag in it
  troll: ['#12162a', '#212843', '#343e5d', '#4c597a', '#6b7a97', '#909eb4'].map(hex),
  hide: ['#120a0c', '#24100f', '#3b1a14', '#59261a', '#7a3319', '#9c4416'].map(hex),
  bone: ['#3c3524', '#5f553a', '#877a55', '#a99b71', '#c9bc90', '#e8dfb8'].map(hex),
}

export type RampName = keyof typeof RAMPS

export function mixColor(a: RGB, b: RGB, t: number): RGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
}

/**
 * The colour of a ramp for t in 0..1, dark to light. A dab is one mix or the next, seldom between: the edge
 * between two mixes is narrow, so with a little chance in t one zone breaks into the next dab by dab.
 */
export function tone(name: RampName, t: number): RGB {
  const ramp = RAMPS[name]
  const f = clamp(t * TONES - 0.5, 0, TONES - 1)
  const i = Math.min(TONES - 2, Math.floor(f))
  return mixColor(ramp[i], ramp[i + 1], smooth(0.3, 0.7, f - i))
}

export const LIGHT_DIR = new THREE.Vector3(-0.55, 0.75, 0.35).normalize()

/** how lit a surface with this normal is, 0..1 */
export const lightOn = (nx: number, ny: number, nz: number) => (nx * LIGHT_DIR.x + ny * LIGHT_DIR.y + nz * LIGHT_DIR.z) * 0.5 + 0.5

const tShade: { value: THREE.Texture | null } = { value: null }

/** Uniforms shared by every painted material. uPixel and uRef are set on resize, the shade by bakeShade. */
export const shared = {
  uTime: { value: 0 },
  // world size of one screen pixel at distance 1
  uPixel: { value: 0.001 },
  // screen pixels in one pixel of the reference frame: dab sizes on screen are given in reference pixels
  uRef: { value: 4 },
  // how strongly the light rakes across the thick paint
  uImpasto: { value: 1 },
  // the way the wind blows over the ground (x, z): from the left of the first view, and a little toward it
  uWind: { value: new THREE.Vector2(0.94, 0.34).normalize() },
  tBrush: { value: createBrushSheet() },
  // a stroke narrower than x reference pixels on the canvas is plain, one wider than y has all its detail;
  // z: how much of the broken colour a plain stroke keeps
  uFine: { value: new THREE.Vector3(1.2, 3.2, 0.6) },
  // the most depth a lying stroke is stepped toward the eye, in clip space: see the dab shader
  uDepthStep: { value: 5e-6 },
  // where the sun reaches: a picture of the still world's depth as the sun sees it
  tShade,
  uShadeMatrix: { value: new THREE.Matrix4() },
  uSunDir: { value: LIGHT_DIR },
  // paint in the shade is the paint times uShadeMul plus uShadeAdd: darker and toward plum. In the sun it is warmer
  uShadeMul: { value: new THREE.Vector3(0.6, 0.62, 0.8) },
  uShadeAdd: { value: new THREE.Vector3(0.012, 0.008, 0.03) },
  uSunMul: { value: new THREE.Vector3(1.08, 1.03, 0.9) },
  // mist between the eye and a thing: its colour, how fast it thickens with distance, and the most of it
  uHaze: { value: new THREE.Vector3(...hex('#1a2946')) },
  uHazeDensity: { value: 0.0018 },
  uHazeMost: { value: 0.75 },
}

// Sun, shade and mist, for dabs and underpainting alike.
const AIR = /* glsl */ `
uniform sampler2D tShade;
uniform mat4 uShadeMatrix;
uniform vec3 uSunDir;
uniform vec3 uShadeMul;
uniform vec3 uShadeAdd;
uniform vec3 uSunMul;
uniform vec3 uHaze;
uniform float uHazeDensity;
uniform float uHazeMost;
uniform float uTakeShade;
uniform float uMist;
uniform vec4 uFlash;

// 1 in the sun, 0 in the shade of the still world. That shade never moves, so a dab can take it whole.
float sunAt(vec3 world) {
  // asked a little toward the sun, so a thing is not in its own shade
  vec4 t = uShadeMatrix * vec4(world + uSunDir * 0.6, 1.0);
  if (t.x <= 0.0 || t.x >= 1.0 || t.y <= 0.0 || t.y >= 1.0 || t.z >= 1.0) return 1.0;
  return step(t.z - 0.0003, texture2D(tShade, t.xy).r);
}
vec3 lit(vec3 c, vec3 world) {
  float sun = mix(1.0 - uTakeShade, 1.0, sunAt(world));
  // what takes no shade is painted in its own colours and is left as it is
  return mix(c * uShadeMul + uShadeAdd, c * mix(vec3(1.0), uSunMul, uTakeShade), sun);
}
// A thing that was just struck flares toward one light colour (a: how much).
vec3 flared(vec3 c) { return mix(c, uFlash.rgb, uFlash.a); }
// Mist puts distance between one row of things and the next. By true distance: turning the head changes nothing.
vec3 hazed(vec3 c, vec3 world) {
  return mix(c, uHaze, uMist * min(uHazeMost, 1.0 - exp(-distance(world, cameraPosition) * uHazeDensity)));
}
`

/** How a group of things takes the sun's shade and the mist. */
export interface Air {
  /** how much of the shade it takes, 0..1. Leaves take half: light comes down through the leaves above */
  shade?: number
  /** false for far things painted in their own airy colours, and for the sky */
  mist?: boolean
}

const airUniforms = ({ shade = 1, mist = true }: Air) => ({
  uTakeShade: { value: shade },
  uMist: { value: mist ? 1 : 0 },
  uFlash: { value: new THREE.Vector4(0, 0, 0, 0) },
})

const SHADE_SIZE = 4096
export const CASTER_LAYER = 1
// turns clip space, -1..1, into the 0..1 of a texture and its depth
const TO_TEXTURE = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)

/**
 * Draws the still world's shade once, from the sun: the depth of every mesh on CASTER_LAYER, in a square of
 * `half` metres each way round `center`. Every dab then asks it whether its spot is in the sun.
 */
export function bakeShade({ renderer, scene, center, half }: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; center: THREE.Vector3; half: number }) {
  const target = new THREE.WebGLRenderTarget(SHADE_SIZE, SHADE_SIZE, { depthBuffer: true, generateMipmaps: false })
  target.depthTexture = new THREE.DepthTexture(SHADE_SIZE, SHADE_SIZE, THREE.UnsignedIntType)
  const back = half * 2
  const sun = new THREE.OrthographicCamera(-half, half, half, -half, 1, back * 2)
  sun.position.copy(center).addScaledVector(LIGHT_DIR, back)
  sun.lookAt(center)
  sun.updateMatrixWorld(true)
  sun.layers.set(CASTER_LAYER)
  scene.overrideMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  renderer.setRenderTarget(target)
  renderer.clear()
  renderer.render(scene, sun)
  renderer.setRenderTarget(null)
  scene.overrideMaterial = null
  shared.tShade.value = target.depthTexture
  shared.uShadeMatrix.value.copy(TO_TEXTURE).multiply(sun.projectionMatrix).multiply(sun.matrixWorldInverse)
}

// The wind: gusts cross the valley in bands that travel downwind, with finer squalls inside. 0 calm .. 1 full gust.
// Needs uTime declared before it.
const WIND = /* glsl */ `
uniform vec2 uWind;
float gustAt(vec2 xz) {
  float along = dot(xz, uWind);
  float across = dot(xz, vec2(-uWind.y, uWind.x));
  float band = sin(along * 0.07 - uTime * 1.5 + 2.0 * sin(across * 0.04));
  float squall = sin(along * 0.29 - uTime * 3.3 + across * 0.13);
  return clamp(0.55 + 0.4 * band + 0.2 * squall, 0.0, 1.0);
}
`

/** The gusts of gustAt in the WIND chunk, for what is heard and not seen. Keep the two in step. */
export function gustAt({ x, z, time }: { x: number; z: number; time: number }) {
  const wind = shared.uWind.value
  const along = x * wind.x + z * wind.y
  const across = z * wind.x - x * wind.y
  const band = Math.sin(along * 0.07 - time * 1.5 + 2 * Math.sin(across * 0.04))
  const squall = Math.sin(along * 0.29 - time * 3.3 + across * 0.13)
  return clamp(0.55 + 0.4 * band + 0.2 * squall, 0, 1)
}

// ---------- dabs ----------

const DAB_VERTEX = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aData;   // across, along (metres), rank, how much the wind carries it
attribute vec4 aDir;    // the way the stroke runs. w: how far it is pulled toward the eye, in its own sizes
attribute vec4 aNormal; // the surface it is on, or nothing. w: 1 for a lying dab
attribute vec4 aColor;  // a: which marks of the brush sheet, and whether it is pinned by its foot
uniform float uPixel;
uniform float uRef;
uniform float uTime;
uniform float uSway;
uniform float uGust;
uniform float uSalt;
uniform float uJitter;
uniform vec2 uMin;
uniform vec2 uMax;
varying vec2 vUv;
varying vec3 vC1;
varying vec3 vC2;
varying vec4 vAxis;
varying float vFine;
uniform vec3 uFine;
const float TAU = 6.28318530718;
uniform float uDepthStep;
${AIR}
${WIND}
vec4 hash4(float n) {
  vec4 q = fract(vec4(n) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  q += dot(q, q.wzxy + 33.33);
  return fract((q.xxyz + q.yzzw) * q.zywx);
}

// Broken colour: every dab is mixed a little differently on the palette (hue, strength, value).
vec3 jitter(vec3 c, vec3 r, float amount) {
  float a = (r.y - 0.5) * 0.9 * amount;
  vec3 k = vec3(0.57735);
  c = c * cos(a) + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cos(a));
  float g = dot(c, vec3(0.3, 0.59, 0.11));
  c = mix(vec3(g), c, 1.0 + (r.z - 0.5) * 0.7 * amount);
  return max(c * (1.0 + (r.x - 0.5) * 0.5 * amount), 0.0);
}

void main() {
  vec4 r = hash4(float(gl_InstanceID) * 1.37 + uSalt);
  float code = floor(aColor.a * 255.0 + 0.5);
  float foot = step(128.0, code);
  code -= foot * 128.0;
  float first = floor(code / 16.0);
  float count = code - first * 16.0;

  // (the sky turns and creatures walk: their strokes turn with them)
  vec3 dir = mat3(modelMatrix) * aDir.xyz;
  vec3 normal = mat3(modelMatrix) * aNormal.xyz;
  vec3 pinned = aPos;
  if (uSway + uGust > 0.0 && aData.w > 0.0) {
    float phase = dot(aPos, vec3(1.3, 0.7, 1.1));
    float gust = gustAt(aPos.xz);
    // pushed downwind by the gust, and fluttering on its own, harder in a gust
    vec3 flutter = vec3(sin(uTime * 2.3 + phase), 0.5 * sin(uTime * 3.1 + phase * 1.3), 0.6 * sin(uTime * 1.9 + phase * 0.7));
    vec3 wind = (vec3(uWind.x, 0.0, uWind.y) * uGust * gust + flutter * uSway * (0.4 + gust)) * aData.w;
    // a blade bends from its foot, a leaf moves whole
    if (foot > 0.5) dir += wind * 3.0;
    else pinned += wind;
  }
  vec4 world = modelMatrix * vec4(pinned, 1.0);
  vec4 vc = viewMatrix * world;
  float depth = -vc.z;
  if (depth < 0.08) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // true distance, not depth: turning the head must not change any dab
  float px = length(vc.xyz) * uPixel * uRef;
  // Far away a dab would be smaller than the least size. Then only a share of the dabs stays, by rank,
  // and each one grows to stand for its neighbours. Rank is fixed, so strokes never swap.
  vec2 size = max(aData.xy, uMin * px);
  float cover = size.x * size.y / (aData.x * aData.y);
  float alive = 1.0 - smoothstep(0.8, 1.2, aData.z * cover) * smoothstep(1.0, 1.3, cover);
  if (alive <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (uMax.x > 0.0) size = min(size, uMax * px);
  vec2 half_ = size * 0.5 * alive;
  // A stroke that is small on the canvas is one plain touch of one mixed colour, in the plain mark of the brush
  // sheet: the bristles, the streak and the thickness of a stroke a few pixels wide would only be noise. Far things
  // are painted in fewer, plainer tones.
  vFine = smoothstep(uFine.x, uFine.y, size.x / px);
  float broken = uJitter * mix(uFine.z, 1.0, vFine);

  vec2 across, along;
  if (aNormal.w > 0.5) {
    // A lying dab: a real patch of its surface, run along dir.
    vec3 n = normalize(normal);
    vec3 A = dir - n * dot(dir, n);
    A = dot(A, A) > 1e-6 ? normalize(A) : normalize(cross(n, abs(n.x) > 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0)));
    vec3 a = mat3(viewMatrix) * A * half_.y;
    vec3 b = mat3(viewMatrix) * cross(n, A) * half_.x;
    // Seen nearly edge on, the stroke is stood up just enough to stay a stroke and not a hair.
    // sa and sb are the two half axes as they appear on screen, perspective included.
    vec2 sa = a.xy + vc.xy * a.z / depth;
    vec2 sb = b.xy + vc.xy * b.z / depth;
    float la = length(sa), lb = length(sb);
    float thin = abs(sa.x * sb.y - sa.y * sb.x) / max(max(la, lb), 1e-6);
    float need = uMin.x * 0.5 * px * alive;
    if (thin < need) {
      if (la > lb) {
        vec2 perp = vec2(-sa.y, sa.x) / max(la, 1e-6);
        b.xy += perp * (dot(sb, perp) < 0.0 ? -1.0 : 1.0) * (need - thin);
      } else {
        vec2 perp = vec2(-sb.y, sb.x) / max(lb, 1e-6);
        a.xy += perp * (dot(sa, perp) < 0.0 ? -1.0 : 1.0) * (need - thin);
      }
    }
    vc.xyz += a * position.y + b * position.x;
    along = normalize(sa + 1e-6);
    across = normalize(sb + 1e-6);
  } else {
    // A card that faces the eye. One with a normal is on a solid thing: it is not painted from behind.
    if (dot(normal, normal) > 0.25 && dot(normal, cameraPosition - world.xyz) < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec3 vd = mat3(viewMatrix) * normalize(dir);
    float flatness = length(vd.xy);
    along = flatness > 1e-4 ? vd.xy / flatness : vec2(0.0, 1.0);
    // a stroke that points at the eye has no direction on the canvas: give it its own
    along = normalize(mix(vec2(cos(r.x * TAU), sin(r.x * TAU)), along, smoothstep(0.08, 0.4, flatness)));
    across = vec2(along.y, -along.x);
    // pulled toward the eye, so it is never buried in the thing it is pinned to
    vc.xyz *= 1.0 - clamp(aDir.w * max(half_.x, half_.y) * (0.6 + 0.8 * r.y) / depth, -0.3, 0.3);
    vc.xy += across * position.x * half_.x + along * (position.y + foot) * half_.y;
  }
  gl_Position = projectionMatrix * vc;
  // Strokes that overlap on one surface lie millimetres apart. Far away a depth cannot tell them from each other,
  // or from the underpainting, and they would change places whenever the eye moved. Each is given its own small
  // step of depth toward the eye, for good. A step of depth is more metres the farther away it is, as the
  // coarseness of the depth is: about a millimetre at 10 m and 10 cm at 100 m.
  if (aNormal.w > 0.5) gl_Position.z -= (0.3 + r.y) * uDepthStep * gl_Position.w;

  float cell = first + floor(r.z * count * 0.999);
  // laid mirrored or with either end first, so one mark does not repeat
  float flip = r.w > 0.5 ? -1.0 : 1.0;
  float end_ = foot < 0.5 && fract(r.x * 7.13) > 0.5 ? -1.0 : 1.0;
  vec2 q = vec2(position.x * flip, position.y * end_) * 0.5 + 0.5;
  vUv = (vec2(mod(cell, ${BRUSH_COLUMNS}.0), floor(cell / ${BRUSH_COLUMNS}.0)) + q) / vec2(${BRUSH_COLUMNS}.0, ${BRUSH_ROWS}.0);
  // the dab takes sun or shade whole, so a shadow's edge is a ragged line of whole dabs
  // (asked where the dab is pinned, not where the wind has it: or it would flick between sun and shade)
  vec3 c = flared(jitter(lit(aColor.rgb, (modelMatrix * vec4(aPos, 1.0)).xyz), r.yzw, broken));
  // (a plain stroke has the mean tone of one with its lighter streak)
  c *= mix(1.06, 1.0, vFine);
  vC1 = hazed(c, world.xyz);
  vC2 = hazed(mix(c, jitter(c * 1.22 + 0.012, r.wxy, broken * 1.2), vFine), world.xyz);
  vAxis = vec4(across * flip, along * end_);
}
`

const DAB_FRAGMENT = /* glsl */ `
uniform sampler2D tBrush;
uniform float uImpasto;
varying vec2 vUv;
varying vec3 vC1;
varying vec3 vC2;
varying vec4 vAxis;
varying float vFine;
void main() {
  vec4 t = texture2D(tBrush, vUv);
  // a stroke that is small on the canvas is the plain mark: one clean shape, no bristle gaps or dry end
  float paint = mix(t.a, t.g, vFine);
  // The edge of the mark is one pixel wide on the canvas, however large the mark is drawn: the antialiasing
  // samples then cut it cleanly. An edge many pixels wide would be a band of stipple that crawls as the eye moves.
  float cover = clamp((paint - 0.46) / max(fwidth(paint), 1e-4) + 0.5, 0.0, 1.0);
  if (cover <= 0.0) discard;
  vec2 e = vec2(1.5 / 512.0, 0.0);
  float hu = texture2D(tBrush, vUv + e.xy).r - texture2D(tBrush, vUv - e.xy).r;
  float hv = texture2D(tBrush, vUv + e.yx).r - texture2D(tBrush, vUv - e.yx).r;
  // the paint stands up off the canvas and the room's light, from the upper left, rakes across it
  vec2 g = vAxis.xy * hu + vAxis.zw * hv;
  // No ridge at the very rim of the mark, where the paint ends: it would be a line one pixel wide that shimmers.
  float rake = (0.5 * g.x - 0.7 * g.y) * smoothstep(0.5, 0.9, t.g);
  vec3 col = mix(vC1, vC2, smoothstep(0.52, 0.78, t.b));
  col *= mix(1.0, mix(0.95, 1.04, t.r), vFine);
  col *= 1.0 + rake * 1.25 * uImpasto * vFine;
  col += vec3(1.0, 0.97, 0.9) * pow(max(rake, 0.0), 2.0) * 1.2 * uImpasto * vFine;
  gl_FragColor = vec4(col, cover);
}
`

/** Which marks of the brush sheet a dab may use: the first cell and how many. See KINDS in brush.ts. */
const marks = (first: number, count: number) => first * 16 + count
export const MARKS = {
  any: marks(0, 8),
  strokes: marks(0, 4),
  blades: marks(0, 3),
  frond: marks(3, 1),
  pressed: marks(4, 2),
}
const FOOT = 128

/** A card that turns to face the eye and runs along `dir` on the canvas. */
export interface FacingDab {
  at: Vec3
  dir: Vec3
  /** across and along, metres */
  size: [number, number]
  color: RGB
  marks?: number
  /** how far it is pulled toward the eye, in its own sizes, -1..1. Negative pushes it back: the dark inside of a crown */
  lift?: number
  /** the surface it is on. With one, the dab is not drawn from behind */
  normal?: Vec3
  /** pinned by its foot instead of its middle: a blade of grass */
  foot?: boolean
  /** never drops out with distance: window lights */
  pinned?: boolean
  /** how much the wind carries it. 0: it stands still (bark). 1 by default. The top of a fir has more than its foot */
  bend?: number
}

/** A stroke that lies on a surface and runs along `dir`. */
export interface LyingDab {
  at: Vec3
  normal: Vec3
  dir: Vec3
  size: [number, number]
  color: RGB
  marks?: number
}

/** How the dabs of one mesh behave. */
export interface DabKind extends Air {
  /** least size on screen, across and along, in reference pixels */
  min: [number, number]
  /** largest size on screen: for things the player can walk into */
  max?: [number, number]
  /** metres of wind movement */
  sway?: number
  /** metres a dab is pushed downwind in a full gust */
  gust?: number
  /** broken colour: how differently each dab is mixed from its neighbours */
  jitter?: number
  /**
   * For far things. Their strokes leave no depth: where two overlap, the one laid later is on top, always.
   * With a depth each they would change places whenever the eye moved, because a depth is too coarse out there.
   */
  layered?: boolean
}

const INITIAL_DABS = 1 << 14
let meshes = 0

/** Collects dabs and builds one instanced mesh from them. */
export class Dabs {
  private pos = new Float32Array(INITIAL_DABS * 3)
  private data = new Float32Array(INITIAL_DABS * 4)
  private dir = new Int8Array(INITIAL_DABS * 4)
  private normal = new Int8Array(INITIAL_DABS * 4)
  private color = new Uint8Array(INITIAL_DABS * 4)
  private seed = 1
  count = 0

  private slot() {
    if (this.count * 3 === this.pos.length) {
      const pos = new Float32Array(this.pos.length * 2)
      const data = new Float32Array(this.data.length * 2)
      const dir = new Int8Array(this.dir.length * 2)
      const normal = new Int8Array(this.normal.length * 2)
      const color = new Uint8Array(this.color.length * 2)
      pos.set(this.pos)
      data.set(this.data)
      dir.set(this.dir)
      normal.set(this.normal)
      color.set(this.color)
      this.pos = pos
      this.data = data
      this.dir = dir
      this.normal = normal
      this.color = color
    }
    return this.count++
  }

  /** rank in 0..1: which dabs stay when the picture is far away. Low ranks stay longest */
  private rank() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0
    return this.seed / 4294967296
  }

  /** what both kinds share: the place, the direction, the colour and the marks. `foot` is added by face() */
  private put(i: number, dab: FacingDab | LyingDab) {
    const length = Math.hypot(...dab.dir) || 1
    this.pos.set(dab.at, i * 3)
    this.dir.set([(dab.dir[0] / length) * 127, (dab.dir[1] / length) * 127, (dab.dir[2] / length) * 127], i * 4)
    this.color.set([clamp(dab.color[0], 0, 1) * 255, clamp(dab.color[1], 0, 1) * 255, clamp(dab.color[2], 0, 1) * 255, dab.marks ?? MARKS.any], i * 4)
  }

  face(dab: FacingDab) {
    const i = this.slot()
    this.put(i, dab)
    if (dab.foot) this.color[i * 4 + 3] += FOOT
    this.data.set([dab.size[0], dab.size[1], dab.pinned ? 0 : this.rank(), dab.bend ?? 1], i * 4)
    this.dir[i * 4 + 3] = clamp(dab.lift ?? 0.5, -1, 1) * 127
    if (dab.normal) this.normal.set([dab.normal[0] * 127, dab.normal[1] * 127, dab.normal[2] * 127], i * 4)
  }

  lie(dab: LyingDab) {
    const i = this.slot()
    this.put(i, dab)
    this.data.set([dab.size[0], dab.size[1], this.rank(), 0], i * 4)
    this.normal.set([dab.normal[0] * 127, dab.normal[1] * 127, dab.normal[2] * 127, 127], i * 4)
  }

  /** The dabs as they are now. Things that move share one geometry between many meshes. */
  geometry() {
    const geometry = new THREE.InstancedBufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3))
    geometry.setIndex([0, 1, 2, 0, 2, 3])
    const n = this.count
    geometry.setAttribute('aPos', new THREE.InstancedBufferAttribute(this.pos.subarray(0, n * 3), 3))
    geometry.setAttribute('aData', new THREE.InstancedBufferAttribute(this.data.subarray(0, n * 4), 4))
    geometry.setAttribute('aDir', new THREE.InstancedBufferAttribute(this.dir.subarray(0, n * 4), 4, true))
    geometry.setAttribute('aNormal', new THREE.InstancedBufferAttribute(this.normal.subarray(0, n * 4), 4, true))
    geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(this.color.subarray(0, n * 4), 4, true))
    geometry.instanceCount = n
    return geometry
  }

  build(kind: DabKind) {
    const mesh = new THREE.Mesh(this.geometry(), dabMaterial(kind))
    mesh.frustumCulled = false
    return mesh
  }
}

export function dabMaterial({ min, max = [0, 0], sway = 0, gust = 0, jitter = 0.5, layered = false, ...air }: DabKind) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uMin: { value: new THREE.Vector2(...min) },
      uMax: { value: new THREE.Vector2(...max) },
      uSway: { value: sway },
      uGust: { value: gust },
      uJitter: { value: jitter },
      ...airUniforms(air),
      // so two meshes do not lay the same run of marks
      uSalt: { value: 5.1 + 77.7 * meshes++ },
    },
    vertexShader: DAB_VERTEX,
    fragmentShader: DAB_FRAGMENT,
    // a lying stroke is seen from below when the eye is under its surface
    side: THREE.DoubleSide,
    // the soft edge of a mark is cut by the antialiasing samples: no sorting, no blending
    alphaToCoverage: true,
    depthWrite: !layered,
  })
}

// ---------- leaves in the air ----------

const FLYING_VERTEX = /* glsl */ `
attribute vec4 aSeed;  // its place in the box of air, 0..1 each way, and its own chance
attribute vec3 aColor;
uniform float uTime;
uniform float uPixel;
uniform float uRef;
uniform vec3 uBox;
uniform float uSpeed;
varying vec2 vUv;
varying vec3 vColor;
${AIR}
${WIND}
void main() {
  vec4 r = fract(aSeed.w * vec4(1.0, 7.13, 13.7, 31.1));
  // carried downwind, each at its own speed, sinking a little and thrown about
  vec3 p = aSeed.xyz * uBox + vec3(uWind.x, 0.0, uWind.y) * uSpeed * (0.6 + 0.8 * r.x) * uTime;
  p.y -= uTime * (0.3 + 0.6 * r.y);
  p += vec3(sin(uTime * 1.7 + r.z * 40.0), sin(uTime * 2.3 + r.w * 40.0), cos(uTime * 1.3 + r.x * 40.0)) * 0.6;
  // the box of air travels with the eye: a leaf that leaves it on one side comes in on the other
  p = mod(p - cameraPosition + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 edge = abs(p) / uBox;
  float whole = smoothstep(0.5, 0.42, max(edge.x, max(edge.y, edge.z)));
  vec3 world = p + cameraPosition;
  vec4 vc = viewMatrix * vec4(world, 1.0);
  if (-vc.z < 0.3 || whole <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // more of them fly in a gust
  whole *= step(r.w, 0.35 + 0.65 * gustAt(world.xz));
  float size = max(0.05 + 0.07 * r.y, 0.9 * uPixel * uRef * length(p)) * whole;
  // it tumbles as it flies: it spins, and shows its face and then its edge
  float spin = r.z * 6.2832 + uTime * (3.0 + 5.0 * r.w);
  float face = 0.25 + 0.75 * abs(cos(uTime * (4.0 + 4.0 * r.x) + r.y * 6.2832));
  vec2 along = vec2(cos(spin), sin(spin));
  vc.xy += vec2(along.y, -along.x) * position.x * size * face + along * position.y * size * 1.6;
  gl_Position = projectionMatrix * vc;
  float cell = 4.0 + step(0.5, r.x);
  vUv = (vec2(mod(cell, ${BRUSH_COLUMNS}.0), floor(cell / ${BRUSH_COLUMNS}.0)) + position.xy * 0.5 + 0.5) / vec2(${BRUSH_COLUMNS}.0, ${BRUSH_ROWS}.0);
  vColor = hazed(lit(aColor, world), world) * (0.75 + 0.35 * face);
}
`

const FLYING_FRAGMENT = /* glsl */ `
uniform sampler2D tBrush;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  float paint = texture2D(tBrush, vUv).g;
  float cover = clamp((paint - 0.46) / max(fwidth(paint), 1e-4) + 0.5, 0.0, 1.0);
  if (cover <= 0.0) discard;
  gl_FragColor = vec4(vColor, cover);
}
`

/**
 * Leaves torn off by the wind: pressed dabs that fly downwind through a box of air round the eye and tumble.
 * box: the size of that box, metres. speed: metres a second. They move through the world, not with the eye.
 */
export function buildFlyingLeaves({ count, colors, box, speed, rand }: { count: number; colors: RGB[]; box: Vec3; speed: number; rand: () => number }) {
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3))
  geometry.setIndex([0, 1, 2, 0, 2, 3])
  const seed = new Float32Array(count * 4)
  const color = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    seed.set([rand(), rand(), rand(), rand()], i * 4)
    color.set(colors[Math.floor(rand() * colors.length)], i * 3)
  }
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4))
  geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(color, 3))
  geometry.instanceCount = count
  const material = new THREE.ShaderMaterial({
    uniforms: { ...shared, ...airUniforms({}), uBox: { value: new THREE.Vector3(...box) }, uSpeed: { value: speed } },
    vertexShader: FLYING_VERTEX,
    fragmentShader: FLYING_FRAGMENT,
    side: THREE.DoubleSide,
    alphaToCoverage: true,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  return mesh
}

// ---------- underpainting ----------

const UNDER_VERTEX = /* glsl */ `
attribute vec3 aColor;
varying vec3 vColor;
varying vec3 vWorld;
void main() {
  vColor = aColor;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

const UNDER_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying vec3 vWorld;
${AIR}
void main() { gl_FragColor = vec4(hazed(flared(lit(vColor, vWorld)), vWorld), 1.0); }
`

export interface UnderKind extends Air {
  /** for far things: drawn a little farther than it is, so the strokes that lie on it are never behind it */
  pushBack?: boolean
}

/** flat colour per vertex, from the `aColor` attribute, in the sun's shade and the mist like the dabs over it */
export function underMaterial({ pushBack = false, ...air }: UnderKind = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, ...airUniforms(air) },
    vertexShader: UNDER_VERTEX,
    fragmentShader: UNDER_FRAGMENT,
    side: THREE.DoubleSide,
    polygonOffset: pushBack,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 8,
  })
}

/** Collects coloured triangles and builds one mesh from them. */
export class Under {
  private chunks: { position: ArrayLike<number>; color: ArrayLike<number> }[] = []
  private length = 0

  /** triangles without an index: three numbers a vertex, and a colour for each vertex */
  push(position: ArrayLike<number>, color: ArrayLike<number>) {
    this.chunks.push({ position, color })
    this.length += position.length
  }

  geometry() {
    const position = new Float32Array(this.length)
    const color = new Float32Array(this.length)
    let offset = 0
    for (const chunk of this.chunks) {
      position.set(chunk.position, offset)
      color.set(chunk.color, offset)
      offset += chunk.position.length
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
    geometry.setAttribute('aColor', new THREE.BufferAttribute(color, 3))
    return geometry
  }

  build(kind: UnderKind = {}) {
    const mesh = new THREE.Mesh(this.geometry(), underMaterial(kind))
    mesh.frustumCulled = false
    return mesh
  }
}
