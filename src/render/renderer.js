import * as THREE from 'three';

// Render layers. SCENE is lit, opaque-ish geometry; FX is unlit transparent effects rendered to
// their own HDR target (manual soft depth test); DISTORT writes screen-space refraction offsets.
export const LAYER = { SCENE: 0, FX: 1, DISTORT: 2 };

export const QUALITY = {
  low: { scale: 0.66, msaa: 0, refl: 0, reflFx: false, fxScale: 0.5, shadow: 1024, bloom: 5 },
  medium: { scale: 0.8, msaa: 2, refl: 0.4, reflFx: true, fxScale: 0.5, shadow: 2048, bloom: 6 },
  high: { scale: 1, msaa: 4, refl: 0.5, reflFx: true, fxScale: 0.75, shadow: 2048, bloom: 7 },
  film: { scale: 1, msaa: 4, refl: 0.75, reflFx: true, fxScale: 1, shadow: 4096, bloom: 7 },
};

// Uniforms shared (by reference) with every FX material.
export const fxGlobals = {
  uDepthTex: { value: null },
  uInvRes: { value: new THREE.Vector2(1, 1) },
  uNear: { value: 0.1 },
  uFar: { value: 600 },
  uTime: { value: 0 },
  uNoise: { value: null },
};

// GLSL shared by FX fragment shaders: soft depth test against the opaque scene.
export const FX_DEPTH_GLSL = /* glsl */ `
uniform sampler2D uDepthTex;
uniform vec2 uInvRes;
uniform float uNear;
uniform float uFar;
float linDepth(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}
// 0 when behind opaque geometry, ramps to 1 over 'soft' world units in front of it.
float depthFade(float soft) {
  float sd = linDepth(texture2D(uDepthTex, gl_FragCoord.xy * uInvRes).r);
  float fd = linDepth(gl_FragCoord.z);
  return clamp((sd - fd) / soft, 0.0, 1.0);
}
`;

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

function fsMaterial(fragmentShader, uniforms, extra = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    ...extra,
  });
}

class FSQuad {
  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.mesh = new THREE.Mesh(g, null);
    this.mesh.frustumCulled = false;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  render(renderer, material, target) {
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.mesh, this.cam);
  }
}

const NOISE_FRAG = /* glsl */ `
varying vec2 vUv;
float hash(vec2 p, float per) {
  p = mod(p, per);
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
vec2 hash2(vec2 p, float per) {
  p = mod(p, per);
  return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}
float vnoise(vec2 p, float per) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(hash(i, per), hash(i + vec2(1, 0), per), u.x),
             mix(hash(i + vec2(0, 1), per), hash(i + vec2(1, 1), per), u.x), u.y);
}
float fbm(vec2 uv, float per, float seed) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 6; i++) {
    s += a * vnoise(uv * per + seed * 17.0, per);
    n += a; a *= 0.5; per *= 2.0;
  }
  return s / n;
}
float worley(vec2 uv, float per) {
  vec2 p = uv * per;
  vec2 i = floor(p), f = fract(p);
  float d = 1.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = hash2(i + g, per);
    d = min(d, length(g + o - f));
  }
  return d;
}
void main() {
  float r = fbm(vUv, 4.0, 1.0);
  float w = 1.0 - worley(vUv, 6.0);
  float w2 = 1.0 - worley(vUv, 14.0);
  float g = clamp(w * 0.7 + w2 * 0.3 + (fbm(vUv, 8.0, 3.0) - 0.5) * 0.5, 0.0, 1.0);
  float b = fbm(vUv, 16.0, 5.0);
  float a = fbm(vUv + 0.37, 3.0, 9.0);
  gl_FragColor = vec4(r, g, b, a);
}
`;

const COMBINE_REFL_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tFx;
void main() {
  vec3 s = texture2D(tScene, vUv).rgb;
  vec4 f = texture2D(tFx, vUv);
  gl_FragColor = vec4(min(s * (1.0 - clamp(f.a, 0.0, 1.0)) + f.rgb, vec3(60.0)), 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tFx;
uniform sampler2D tDistort;
uniform sampler2D tDepth;
uniform vec2 uPx;
uniform float uNear;
uniform float uFar;
uniform float uDof;      // max blur radius in pixels (0 = off)
uniform float uFocus;    // focus distance (world units)
uniform float uFocusRange;
float lin(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}
float cocAt(vec2 uv) {
  float d = lin(texture2D(tDepth, uv).r);
  return clamp(abs(d - uFocus) / uFocusRange - 0.12, 0.0, 1.0) * uDof;
}
vec3 sceneAt(vec2 uv) {
  if (uDof < 0.01) return texture2D(tScene, uv).rgb;
  float coc = cocAt(uv);
  if (coc < 0.6) return texture2D(tScene, uv).rgb;
  vec3 acc = texture2D(tScene, uv).rgb;
  float wsum = 1.0;
  // Golden-angle disk gather; a tap only contributes if its own blur reaches this pixel.
  for (int i = 1; i < 30; i++) {
    float fi = float(i);
    float r = sqrt(fi / 30.0) * coc;
    float a = fi * 2.39996323;
    vec2 o = vec2(cos(a), sin(a)) * r * uPx;
    float sc = cocAt(uv + o);
    float w = clamp(sc - r + 1.0, 0.0, 1.0);
    vec3 c = texture2D(tScene, uv + o).rgb;
    w *= 1.0 + dot(c, vec3(0.3)) * 0.6; // bias toward highlights for bokeh-ish pop
    acc += c * w; wsum += w;
  }
  return acc / wsum;
}
void main() {
  vec2 d = texture2D(tDistort, vUv).rg;
  vec2 uv = vUv + d;
  vec3 scene = sceneAt(uv);
  float dl = dot(d, d);
  if (dl > 0.0000004) {
    scene.r = texture2D(tScene, vUv + d * 1.35).r;
    scene.b = texture2D(tScene, vUv + d * 0.65).b;
  }
  vec4 fx = texture2D(tFx, uv);
  vec3 col = scene * (1.0 - clamp(fx.a, 0.0, 1.0)) + fx.rgb;
  gl_FragColor = vec4(min(col, vec3(400.0)), 1.0);
}
`;

const COPY_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform float uWeight;
void main() { gl_FragColor = vec4(texture2D(tSrc, vUv).rgb * uWeight, 1.0); }
`;

const BLOOM_PRE_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uPx;
uniform float uThr;
uniform float uKnee;
vec3 thr(vec3 c) {
  c = min(c, vec3(250.0));
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThr + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  return c * max(soft, br - uThr) / max(br, 1e-4);
}
float karis(vec3 c) { return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))); }
void main() {
  // 4-tap box with Karis weighting kills single-pixel fireflies before they flicker in bloom.
  vec3 a = thr(texture2D(tSrc, vUv + uPx * vec2(-1.0, -1.0)).rgb);
  vec3 b = thr(texture2D(tSrc, vUv + uPx * vec2(1.0, -1.0)).rgb);
  vec3 c = thr(texture2D(tSrc, vUv + uPx * vec2(-1.0, 1.0)).rgb);
  vec3 d = thr(texture2D(tSrc, vUv + uPx * vec2(1.0, 1.0)).rgb);
  float wa = karis(a), wb = karis(b), wc = karis(c), wd = karis(d);
  gl_FragColor = vec4((a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd), 1.0);
}
`;

const BLOOM_DOWN_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uPx;
void main() {
  vec3 a = texture2D(tSrc, vUv + uPx * vec2(-2.0, 2.0)).rgb;
  vec3 b = texture2D(tSrc, vUv + uPx * vec2(0.0, 2.0)).rgb;
  vec3 c = texture2D(tSrc, vUv + uPx * vec2(2.0, 2.0)).rgb;
  vec3 d = texture2D(tSrc, vUv + uPx * vec2(-2.0, 0.0)).rgb;
  vec3 e = texture2D(tSrc, vUv).rgb;
  vec3 f = texture2D(tSrc, vUv + uPx * vec2(2.0, 0.0)).rgb;
  vec3 g = texture2D(tSrc, vUv + uPx * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture2D(tSrc, vUv + uPx * vec2(0.0, -2.0)).rgb;
  vec3 i = texture2D(tSrc, vUv + uPx * vec2(2.0, -2.0)).rgb;
  vec3 j = texture2D(tSrc, vUv + uPx * vec2(-1.0, 1.0)).rgb;
  vec3 k = texture2D(tSrc, vUv + uPx * vec2(1.0, 1.0)).rgb;
  vec3 l = texture2D(tSrc, vUv + uPx * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture2D(tSrc, vUv + uPx * vec2(1.0, -1.0)).rgb;
  gl_FragColor = vec4(e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125, 1.0);
}
`;

const BLOOM_UP_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uPx;
uniform float uWeight;
void main() {
  vec3 s = texture2D(tSrc, vUv).rgb * 4.0;
  s += (texture2D(tSrc, vUv + uPx * vec2(-1.0, 0.0)).rgb + texture2D(tSrc, vUv + uPx * vec2(1.0, 0.0)).rgb +
        texture2D(tSrc, vUv + uPx * vec2(0.0, -1.0)).rgb + texture2D(tSrc, vUv + uPx * vec2(0.0, 1.0)).rgb) * 2.0;
  s += texture2D(tSrc, vUv + uPx * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + uPx * vec2(1.0, -1.0)).rgb +
       texture2D(tSrc, vUv + uPx * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + uPx * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(s / 16.0 * uWeight, 1.0);
}
`;

const STREAK_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uPx;
uniform float uStride;
uniform float uThr;
void main() {
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = -6; i <= 6; i++) {
    float fi = float(i);
    float w = exp(-fi * fi * 0.07);
    vec3 c = texture2D(tSrc, vUv + vec2(fi * uStride * uPx.x, 0.0)).rgb;
    c = max(c - uThr, 0.0);
    acc += c * w; wsum += w;
  }
  gl_FragColor = vec4(acc / wsum, 1.0);
}
`;

const LUMA_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uCell;
void main() {
  float s = 0.0;
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
    vec2 o = (vec2(float(x), float(y)) + 0.5) / 4.0 - 0.5;
    vec3 c = min(texture2D(tSrc, vUv + o * uCell).rgb, vec3(64.0));
    s += log(dot(c, vec3(0.2126, 0.7152, 0.0722)) + 0.02);
  }
  gl_FragColor = vec4(s / 16.0, 0.0, 0.0, 1.0);
}
`;

// Eye adaptation: centre-weighted log-average luminance, fast to clamp down on a blast and slow
// to open back up. Keeps explosions and beams coloured instead of clipping the frame to white.
const ADAPT_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tLum;
uniform sampler2D tPrev;
uniform float uUp;
uniform float uDown;
void main() {
  float s = 0.0, ws = 0.0;
  for (int y = 0; y < 18; y++) for (int x = 0; x < 32; x++) {
    vec2 uv = (vec2(float(x), float(y)) + 0.5) / vec2(32.0, 18.0);
    float w = 1.0 - 0.75 * length(uv - 0.5);
    s += texture2D(tLum, uv).r * w; ws += w;
  }
  float cur = exp(s / ws);
  float prev = texture2D(tPrev, vec2(0.5)).r;
  gl_FragColor = vec4(mix(prev, cur, cur > prev ? uUp : uDown), 0.0, 0.0, 1.0);
}
`;

const FINAL_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tHDR;
uniform sampler2D tBloom;
uniform sampler2D tStreak;
uniform sampler2D tAdapt;
uniform float uKey;
uniform float uMinE;
uniform vec2 uRes;
uniform float uBloom;
uniform float uStreak;
uniform float uExposure;
uniform float uCA;
uniform float uRadial;
uniform vec2 uCenter;
uniform vec4 uFlash;
uniform float uVignette;
uniform float uSat;
uniform float uContrast;
uniform float uGrain;
uniform float uFrame;
uniform float uFade;
uniform vec3 uLift;
uniform vec3 uGain;

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 color) {
  const mat3 ACESIn = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOut = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color = ACESIn * color;
  color = RRTAndODTFit(color);
  color = ACESOut * color;
  return clamp(color, 0.0, 1.0);
}
vec3 sampleHDR(vec2 uv, vec2 dir, float ca) {
  // Lateral chromatic aberration grows toward the frame edge like a real lens.
  return vec3(texture2D(tHDR, uv + dir * ca).r, texture2D(tHDR, uv).g, texture2D(tHDR, uv - dir * ca).b);
}
void main() {
  vec2 toC = vUv - uCenter;
  float r2 = dot(toC, toC);
  float ca = uCA * (0.25 + r2 * 3.0);
  vec3 col;
  if (uRadial > 0.002) {
    col = vec3(0.0);
    float jitter = hash13(vec3(gl_FragCoord.xy, uFrame)) - 0.5;
    for (int i = 0; i < 10; i++) {
      float t = (float(i) + jitter) / 10.0;
      vec2 uv = vUv - toC * t * uRadial * 0.22;
      col += sampleHDR(uv, toC, ca * (1.0 + t * 2.0));
    }
    col *= 0.1;
  } else {
    col = sampleHDR(vUv, toC, ca);
  }
  vec3 bloom = texture2D(tBloom, vUv).rgb;
  vec3 streak = texture2D(tStreak, vUv).rgb;
  col += bloom * uBloom;
  col += streak * vec3(0.45, 0.7, 1.0) * uStreak;
  float autoE = clamp(uKey / max(texture2D(tAdapt, vec2(0.5)).r, 1e-3), uMinE, 1.0);
  col *= uExposure * autoE;
  col += uFlash.rgb * uFlash.a * 2.4;
  // Vignette in scene-linear so it rolls off like lens falloff rather than a dark overlay.
  vec2 vq = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  float vig = 1.0 - uVignette * smoothstep(0.25, 1.15, length(vq));
  col *= vig * vig;
  col = aces(col / 0.6);
  // Grade (display-referred): lift/gain split-tone, contrast around mid grey, saturation.
  col = col * uGain + uLift * (1.0 - col);
  col = (col - 0.5) * uContrast + 0.5;
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat);
  col = clamp(col, 0.0, 1.0);
  // Film grain: luminance-shaped, re-seeded every output frame.
  float g = hash13(vec3(gl_FragCoord.xy, uFrame * 1.7 + 3.0)) + hash13(vec3(gl_FragCoord.yx + 17.0, uFrame * 1.3 + 9.0)) - 1.0;
  col += g * uGrain * (0.35 + 0.65 * (1.0 - abs(l * 2.0 - 1.0)));
  col *= uFade;
  // sRGB OETF + 1 LSB triangular dither against banding in the smooth sky/fog gradients.
  col = mix(col * 12.92, 1.055 * pow(max(col, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, col));
  float dth = hash13(vec3(gl_FragCoord.xy, uFrame + 77.0)) - hash13(vec3(gl_FragCoord.yx, uFrame + 177.0));
  col += dth / 255.0;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

const HALTON = [
  [0.5, 0.3333], [0.25, 0.6667], [0.75, 0.1111], [0.125, 0.4444], [0.625, 0.7778], [0.375, 0.2222], [0.875, 0.5556], [0.0625, 0.8889],
  [0.5625, 0.037], [0.3125, 0.3704], [0.8125, 0.7037], [0.1875, 0.1481], [0.6875, 0.4815], [0.4375, 0.8148], [0.9375, 0.2593], [0.0313, 0.5926],
];

export class Renderer {
  constructor(canvas, { quality = 'high', preserve = false } = {}) {
    this.canvas = canvas;
    this.q = { ...QUALITY[quality] };
    this.qualityName = quality;
    const r = (this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: preserve,
    }));
    r.setPixelRatio(1);
    r.outputColorSpace = THREE.LinearSRGBColorSpace; // we tone map + encode in the final pass
    r.toneMapping = THREE.NoToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = false;
    r.autoClear = true;
    r.info.autoReset = false;
    this.quad = new FSQuad();
    this.reflCam = new THREE.PerspectiveCamera();
    this.reflCam.matrixAutoUpdate = true;
    this.reflUniforms = {
      uReflTex: { value: null },
      uReflMatrix: { value: new THREE.Matrix4() },
      uReflOn: { value: 0 },
    };
    this.reflHide = []; // objects hidden while rendering the planar reflection (floor, underside)
    this.frame = 0;

    // Look controls driven by the camera director / gameplay events.
    this.look = {
      exposure: 1.0, bloom: 0.062, streak: 0.034, ca: 0.0016, radial: 0, center: new THREE.Vector2(0.5, 0.5),
      flash: new THREE.Vector4(1, 1, 1, 0), vignette: 0.36, sat: 1.06, contrast: 1.05, grain: 0.028, fade: 1,
      dof: 0, focus: 10, focusRange: 10, distort: 1, autoKey: 0.2, autoMin: 0.07,
      lift: new THREE.Vector3(0.0, 0.004, 0.012), gain: new THREE.Vector3(1.0, 0.99, 0.975),
    };

    this.mats = {
      combineRefl: fsMaterial(COMBINE_REFL_FRAG, { tScene: { value: null }, tFx: { value: null } }),
      composite: fsMaterial(COMPOSITE_FRAG, {
        tScene: { value: null }, tFx: { value: null }, tDistort: { value: null }, tDepth: { value: null },
        uPx: { value: new THREE.Vector2() }, uNear: fxGlobals.uNear, uFar: fxGlobals.uFar,
        uDof: { value: 0 }, uFocus: { value: 10 }, uFocusRange: { value: 10 },
      }),
      copy: fsMaterial(COPY_FRAG, { tSrc: { value: null }, uWeight: { value: 1 } }),
      accum: fsMaterial(COPY_FRAG, { tSrc: { value: null }, uWeight: { value: 1 } }, {
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
      }),
      pre: fsMaterial(BLOOM_PRE_FRAG, { tSrc: { value: null }, uPx: { value: new THREE.Vector2() }, uThr: { value: 1.0 }, uKnee: { value: 0.6 } }),
      down: fsMaterial(BLOOM_DOWN_FRAG, { tSrc: { value: null }, uPx: { value: new THREE.Vector2() } }),
      up: fsMaterial(BLOOM_UP_FRAG, { tSrc: { value: null }, uPx: { value: new THREE.Vector2() }, uWeight: { value: 1 } }, {
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
      }),
      streak: fsMaterial(STREAK_FRAG, { tSrc: { value: null }, uPx: { value: new THREE.Vector2() }, uStride: { value: 1 }, uThr: { value: 0 } }),
      luma: fsMaterial(LUMA_FRAG, { tSrc: { value: null }, uCell: { value: new THREE.Vector2(1 / 32, 1 / 18) } }),
      adapt: fsMaterial(ADAPT_FRAG, { tLum: { value: null }, tPrev: { value: null }, uUp: { value: 0.8 }, uDown: { value: 0.07 } }),
      final: fsMaterial(FINAL_FRAG, {
        tAdapt: { value: null }, uKey: { value: 0.2 }, uMinE: { value: 0.07 },
        tHDR: { value: null }, tBloom: { value: null }, tStreak: { value: null }, uRes: { value: new THREE.Vector2() },
        uBloom: { value: 0.1 }, uStreak: { value: 0.1 }, uExposure: { value: 1 }, uCA: { value: 0 }, uRadial: { value: 0 },
        uCenter: { value: this.look.center }, uFlash: { value: this.look.flash }, uVignette: { value: 0.3 }, uSat: { value: 1 },
        uContrast: { value: 1 }, uGrain: { value: 0.03 }, uFrame: { value: 0 }, uFade: { value: 1 },
        uLift: { value: this.look.lift }, uGain: { value: this.look.gain },
      }),
    };

    const tiny = (w, h) => new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.rtLum = tiny(32, 18);
    this.rtAdapt = [tiny(1, 1), tiny(1, 1)];
    this.adaptIdx = 0;
    fxGlobals.uNoise.value = this.noiseTex = this._makeNoise();
    this.w = this.h = 0;
  }

  _makeNoise() {
    const rt = new THREE.WebGLRenderTarget(512, 512, {
      type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    });
    const m = fsMaterial(NOISE_FRAG, {});
    this.quad.render(this.gl, m, rt);
    this.gl.setRenderTarget(null);
    m.dispose();
    return rt.texture;
  }

  setQuality(name) {
    if (!QUALITY[name] || name === this.qualityName) return;
    this.qualityName = name;
    this.q = { ...QUALITY[name] };
    const { cssW, cssH } = this;
    this.w = 0;
    this.setSize(cssW, cssH, this.dpr);
  }

  // cssW/cssH: canvas size in CSS pixels. Internal resolution = css * dpr * quality scale.
  setSize(cssW, cssH, dpr = 1) {
    this.cssW = cssW; this.cssH = cssH; this.dpr = dpr;
    const outW = Math.max(2, Math.round(cssW * dpr));
    const outH = Math.max(2, Math.round(cssH * dpr));
    const w = Math.max(2, Math.round((outW * this.q.scale) / 2) * 2);
    const h = Math.max(2, Math.round((outH * this.q.scale) / 2) * 2);
    this.gl.setSize(outW, outH, false);
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this._dispose();
    const HF = THREE.HalfFloatType;
    const mk = (W, H, o = {}) => new THREE.WebGLRenderTarget(Math.max(2, Math.round(W)), Math.max(2, Math.round(H)), {
      type: HF, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, ...o,
    });
    const depthTex = (W, H) => {
      const d = new THREE.DepthTexture(Math.round(W), Math.round(H));
      d.minFilter = d.magFilter = THREE.NearestFilter;
      return d;
    };
    const q = this.q;
    this.rtScene = mk(w, h, { depthBuffer: true, depthTexture: depthTex(w, h), samples: q.msaa });
    this.rtFx = mk(w * q.fxScale, h * q.fxScale);
    this.rtDistort = mk(w / 2, h / 2);
    this.rtHDR = mk(w, h);
    this.rtAccum = mk(w, h, { type: THREE.FloatType });
    if (q.refl > 0) {
      const rw = w * q.refl, rh = h * q.refl;
      this.rtReflScene = mk(rw, rh, { depthBuffer: true, depthTexture: depthTex(rw, rh) });
      this.rtReflFx = mk(rw, rh);
      this.rtRefl = mk(rw, rh, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
      this.reflUniforms.uReflTex.value = this.rtRefl.texture;
      this.reflUniforms.uReflOn.value = 1;
    } else {
      this.reflUniforms.uReflOn.value = 0;
    }
    this.bloom = [];
    let bw = w / 2, bh = h / 2;
    for (let i = 0; i < q.bloom; i++) {
      this.bloom.push(mk(bw, bh));
      bw /= 2; bh /= 2;
    }
    this.rtStreakA = mk(w / 4, h / 4);
    this.rtStreakB = mk(w / 4, h / 4);
    this.gl.shadowMap.needsUpdate = true;
  }

  _dispose() {
    for (const k of ['rtScene', 'rtFx', 'rtDistort', 'rtHDR', 'rtAccum', 'rtReflScene', 'rtReflFx', 'rtRefl', 'rtStreakA', 'rtStreakB']) {
      if (this[k]) { this[k].depthTexture?.dispose(); this[k].dispose(); this[k] = null; }
    }
    if (this.bloom) for (const b of this.bloom) b.dispose();
  }

  _setFxDepth(rt, target) {
    fxGlobals.uDepthTex.value = rt.depthTexture;
    fxGlobals.uInvRes.value.set(1 / target.width, 1 / target.height);
  }

  _renderReflection(scene, camera) {
    const gl = this.gl, vc = this.reflCam;
    const m = _m.extractRotation(camera.matrixWorld);
    camera.getWorldPosition(_a);
    _b.set(0, 0, -1).applyMatrix4(m).add(_a);
    vc.position.set(_a.x, -_a.y, _a.z);
    vc.up.set(0, 1, 0).applyMatrix4(m);
    vc.up.y *= -1;
    vc.lookAt(_b.x, -_b.y, _b.z);
    vc.near = camera.near; vc.far = camera.far;
    vc.projectionMatrix.copy(camera.projectionMatrix);
    vc.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    vc.updateMatrixWorld(true);
    this.reflUniforms.uReflMatrix.value
      .set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(vc.projectionMatrix)
      .multiply(vc.matrixWorldInverse);
    const vis = this.reflHide.map((o) => o.visible);
    for (const o of this.reflHide) o.visible = false;
    this.reflUniforms.uReflOn.value = 0;
    vc.layers.set(LAYER.SCENE);
    gl.setRenderTarget(this.rtReflScene);
    gl.setClearColor(0x000000, 1);
    gl.render(scene, vc);
    if (this.q.reflFx) {
      this._setFxDepth(this.rtReflScene, this.rtReflFx);
      vc.layers.set(LAYER.FX);
      gl.setRenderTarget(this.rtReflFx);
      gl.setClearColor(0x000000, 0);
      gl.render(scene, vc);
    } else {
      gl.setRenderTarget(this.rtReflFx);
      gl.setClearColor(0x000000, 0);
      gl.clear();
    }
    this.reflHide.forEach((o, i) => (o.visible = vis[i]));
    this.reflUniforms.uReflOn.value = 1;
    const cm = this.mats.combineRefl;
    cm.uniforms.tScene.value = this.rtReflScene.texture;
    cm.uniforms.tFx.value = this.rtReflFx.texture;
    this.quad.render(gl, cm, this.rtRefl);
  }

  // Renders the world into rtHDR (scene-linear, pre-bloom).
  drawWorld(scene, camera, jitterIndex = -1) {
    const gl = this.gl;
    const { w, h } = this;
    if (camera.aspect !== w / h) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
    if (jitterIndex >= 0) {
      const j = HALTON[jitterIndex % HALTON.length];
      camera.setViewOffset(w, h, j[0] - 0.5, j[1] - 0.5, w, h);
    } else if (camera.view) {
      camera.clearViewOffset();
    }
    camera.updateMatrixWorld(true);
    fxGlobals.uNear.value = camera.near;
    fxGlobals.uFar.value = camera.far;
    gl.shadowMap.needsUpdate = true;
    gl.info.reset();

    if (this.q.refl > 0) this._renderReflection(scene, camera);

    camera.layers.set(LAYER.SCENE);
    gl.setRenderTarget(this.rtScene);
    gl.setClearColor(0x000000, 1);
    gl.render(scene, camera);

    this._setFxDepth(this.rtScene, this.rtFx);
    camera.layers.set(LAYER.FX);
    gl.setRenderTarget(this.rtFx);
    gl.setClearColor(0x000000, 0);
    gl.render(scene, camera);

    this._setFxDepth(this.rtScene, this.rtDistort);
    camera.layers.set(LAYER.DISTORT);
    gl.setRenderTarget(this.rtDistort);
    gl.setClearColor(0x000000, 0);
    gl.render(scene, camera);
    camera.layers.set(LAYER.SCENE);

    const c = this.mats.composite, L = this.look;
    c.uniforms.tScene.value = this.rtScene.texture;
    c.uniforms.tFx.value = this.rtFx.texture;
    c.uniforms.tDistort.value = this.rtDistort.texture;
    c.uniforms.tDepth.value = this.rtScene.depthTexture;
    c.uniforms.uPx.value.set(1 / w, 1 / h);
    c.uniforms.uDof.value = L.dof * (h / 1080);
    c.uniforms.uFocus.value = L.focus;
    c.uniforms.uFocusRange.value = L.focusRange;
    this.quad.render(gl, c, this.rtHDR);
  }

  accumBegin() {
    const gl = this.gl;
    gl.setRenderTarget(this.rtAccum);
    gl.setClearColor(0x000000, 1);
    gl.clear();
  }

  accumAdd(weight) {
    const m = this.mats.accum;
    m.uniforms.tSrc.value = this.rtHDR.texture;
    m.uniforms.uWeight.value = weight;
    const gl = this.gl, ac = gl.autoClear;
    gl.autoClear = false;
    this.quad.render(gl, m, this.rtAccum);
    gl.autoClear = ac;
  }

  // Bloom + streaks + lens/grade → canvas.
  present(fromAccum = false, dt = 1 / 60) {
    const gl = this.gl, M = this.mats, L = this.look;
    const src = fromAccum ? this.rtAccum : this.rtHDR;
    // exposure adaptation from this very frame, so a blast is tamed on the frame it happens
    M.luma.uniforms.tSrc.value = src.texture;
    this.quad.render(gl, M.luma, this.rtLum);
    const prev = this.rtAdapt[this.adaptIdx], next = this.rtAdapt[1 - this.adaptIdx];
    M.adapt.uniforms.tLum.value = this.rtLum.texture;
    M.adapt.uniforms.tPrev.value = prev.texture;
    M.adapt.uniforms.uUp.value = 1 - Math.exp(-dt * 95);
    M.adapt.uniforms.uDown.value = 1 - Math.exp(-dt * 4.2);
    this.quad.render(gl, M.adapt, next);
    this.adaptIdx = 1 - this.adaptIdx;
    const B = this.bloom;
    M.pre.uniforms.tSrc.value = src.texture;
    M.pre.uniforms.uPx.value.set(0.5 / B[0].width, 0.5 / B[0].height);
    this.quad.render(gl, M.pre, B[0]);
    for (let i = 1; i < B.length; i++) {
      M.down.uniforms.tSrc.value = B[i - 1].texture;
      M.down.uniforms.uPx.value.set(1 / B[i - 1].width, 1 / B[i - 1].height);
      this.quad.render(gl, M.down, B[i]);
    }
    // Anamorphic streak from the quarter-res bright buffer (before the upsample chain mutates it).
    const S = M.streak.uniforms;
    S.uPx.value.set(1 / this.rtStreakA.width, 1 / this.rtStreakA.height);
    S.tSrc.value = B[1].texture; S.uStride.value = 1.5; S.uThr.value = 1.2;
    this.quad.render(gl, M.streak, this.rtStreakA);
    S.tSrc.value = this.rtStreakA.texture; S.uStride.value = 5.0; S.uThr.value = 0;
    this.quad.render(gl, M.streak, this.rtStreakB);
    S.tSrc.value = this.rtStreakB.texture; S.uStride.value = 14.0;
    this.quad.render(gl, M.streak, this.rtStreakA);

    const ac = gl.autoClear;
    gl.autoClear = false;
    for (let i = B.length - 1; i > 0; i--) {
      M.up.uniforms.tSrc.value = B[i].texture;
      M.up.uniforms.uPx.value.set(1 / B[i].width, 1 / B[i].height);
      M.up.uniforms.uWeight.value = 1.0;
      this.quad.render(gl, M.up, B[i - 1]);
    }
    gl.autoClear = ac;

    const F = M.final.uniforms;
    F.tHDR.value = src.texture;
    F.tBloom.value = B[0].texture;
    F.tStreak.value = this.rtStreakA.texture;
    F.tAdapt.value = next.texture;
    F.uKey.value = L.autoKey;
    F.uMinE.value = L.autoMin;
    F.uRes.value.set(this.w, this.h);
    F.uBloom.value = L.bloom;
    F.uStreak.value = L.streak;
    F.uExposure.value = L.exposure;
    F.uCA.value = L.ca;
    F.uRadial.value = L.radial;
    F.uVignette.value = L.vignette;
    F.uSat.value = L.sat;
    F.uContrast.value = L.contrast;
    F.uGrain.value = L.grain;
    F.uFade.value = L.fade;
    F.uFrame.value = this.frame % 1024;
    this.quad.render(gl, M.final, null);
    this.frame++;
  }

  // One-call real-time frame.
  render(scene, camera, dt = 1 / 60) {
    this.drawWorld(scene, camera, -1);
    this.present(false, dt);
  }
}

const _m = new THREE.Matrix4();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
