import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { glowTexture, mulberry32 } from './utils.js';

function buildStars() {
  const rng = mulberry32(20261018);
  const count = 2800;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);
  const tint = new Float32Array(count * 3);
  const c = new THREE.Color();
  const axis = new THREE.Vector3(0.35, 0.8, 0.2).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);

  for (let i = 0; i < count; i++) {
    // 40% 的星星聚集在"银河带"上，其余均匀分布
    let dir;
    if (i % 5 < 2) {
      const phi = rng() * Math.PI * 2;
      const spread = (rng() - 0.5) * 0.28;
      dir = new THREE.Vector3(Math.cos(phi), spread, Math.sin(phi)).normalize().applyQuaternion(q);
    } else {
      const u = rng() * 2 - 1;
      const theta = rng() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - u * u));
      dir = new THREE.Vector3(r * Math.cos(theta), u, r * Math.sin(theta));
    }
    const dist = 150 + Math.pow(rng(), 0.6) * 620;
    positions[i * 3] = dir.x * dist;
    positions[i * 3 + 1] = dir.y * dist;
    positions[i * 3 + 2] = dir.z * dist;

    const warm = rng();
    c.setHSL(warm < 0.25 ? 0.09 : warm < 0.7 ? 0.58 : 0.72, 0.35 + rng() * 0.4, 0.72 + rng() * 0.25);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
    tint[i * 3] = tint[i * 3 + 1] = tint[i * 3 + 2] = i % 3 === 0 ? 1 : 0;

    sizes[i] = (0.7 + Math.pow(rng(), 2.2) * 3.4) * 1.5;
    phases[i] = rng() * Math.PI * 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1200);

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uDpr: { value: 1 },
      uAccent: { value: new THREE.Color(0x66e0ff) },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute vec3 aTint;
      attribute float aSize;
      attribute float aPhase;
      uniform float uTime;
      uniform float uDpr;
      uniform vec3 uAccent;
      varying vec3 vColor;
      varying float vTwinkle;
      void main() {
        float tw = 0.55 + 0.45 * sin(uTime * 1.3 + aPhase);
        vTwinkle = 0.35 + 0.9 * tw;
        vColor = mix(aColor, uAccent, aTint.x * 0.55);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uDpr * (260.0 / max(1.0, -mv.z)) * (0.75 + 0.5 * tw);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vTwinkle;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        float a = smoothstep(0.5, 0.02, d);
        a = pow(a, 1.9);
        gl_FragColor = vec4(vColor * vTwinkle, a * 0.95);
      }
    `,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = -2;
  return { points, mat };
}

export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    stencil: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x04060d, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(56, window.innerWidth / window.innerHeight, 0.1, 2200);
  camera.position.set(0, 14, 26);
  camera.lookAt(0, 0, 0);

  // 深空底色
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x070b1c) },
      uBottom: { value: new THREE.Color(0x02030a) },
      uAccent: { value: new THREE.Color(0x1a2b55) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform vec3 uTop;
      uniform vec3 uBottom;
      uniform vec3 uAccent;
      void main() {
        float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 col = mix(uBottom, uTop, pow(h, 1.35));
        float glow = pow(max(0.0, 1.0 - abs(vDir.y + 0.15)), 6.0);
        col += uAccent * glow * 0.55;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 24), skyMat);
  sky.renderOrder = -3;
  scene.add(sky);

  const stars = buildStars();
  scene.add(stars.points);

  // 星云
  const nebTex = glowTexture(256);
  const nebula = new THREE.Group();
  const nebulaSprites = [];
  const nebRng = mulberry32(7788);
  for (let i = 0; i < 9; i++) {
    const mat = new THREE.SpriteMaterial({
      map: nebTex,
      color: 0x3050ff,
      transparent: true,
      opacity: 0.1 + nebRng() * 0.12,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    const s = new THREE.Sprite(mat);
    const dir = new THREE.Vector3(nebRng() * 2 - 1, nebRng() * 1.4 - 0.55, nebRng() * 2 - 1).normalize();
    s.position.copy(dir.multiplyScalar(330 + nebRng() * 220));
    const sc = 180 + nebRng() * 320;
    s.scale.set(sc, sc * (0.7 + nebRng() * 0.7), 1);
    s.renderOrder = -2;
    nebula.add(s);
    nebulaSprites.push(s);
  }
  scene.add(nebula);

  // 远处的巨行星剪影，增强纵深
  const distant = new THREE.Group();
  const planetRimMat = () =>
    new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uColor: { value: new THREE.Color(0x3a5cff) }, uStr: { value: 0.85 } },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV;
        void main() {
          vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV;
        uniform vec3 uColor; uniform float uStr;
        void main() {
          float f = pow(1.0 - abs(dot(vN, vV)), 3.0);
          gl_FragColor = vec4(uColor, f * uStr);
        }
      `,
    });
  const rimMats = [];
  [
    { r: 46, d: 430, dir: new THREE.Vector3(-0.75, 0.42, -0.5), col: 0x2b4fa8 },
    { r: 26, d: 360, dir: new THREE.Vector3(0.82, -0.25, -0.35), col: 0x7a3f9c },
  ].forEach((cfg) => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(cfg.r, 32, 24),
      new THREE.MeshBasicMaterial({ color: 0x05070f })
    );
    const rim = new THREE.Mesh(new THREE.SphereGeometry(cfg.r * 1.06, 32, 24), planetRimMat());
    rim.material.uniforms.uColor.value = new THREE.Color(cfg.col);
    rimMats.push(rim.material);
    g.add(body, rim);
    g.position.copy(cfg.dir.clone().normalize().multiplyScalar(cfg.d));
    distant.add(g);
  });
  scene.add(distant);

  // 灯光
  const hemi = new THREE.HemisphereLight(0x9db8ff, 0x0a0e18, 1.05);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xbcd4ff, 1.35);
  key.position.set(6, 10, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x6f5bff, 0.65);
  rim.position.set(-8, -4, -7);
  scene.add(rim);

  // 后期处理
  const size = new THREE.Vector2();
  renderer.getSize(size);
  let dpr = Math.min(window.devicePixelRatio || 1, 1.9);
  renderer.setPixelRatio(dpr);

  let composer;
  function makeComposer() {
    renderer.getSize(size);
    let rt;
    try {
      rt = new THREE.WebGLRenderTarget(size.x * dpr, size.y * dpr, {
        type: THREE.HalfFloatType,
        samples: 4,
      });
    } catch (e) {
      rt = new THREE.WebGLRenderTarget(size.x * dpr, size.y * dpr, { type: THREE.HalfFloatType });
    }
    const c = new EffectComposer(renderer, rt);
    c.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.85, 0.72, 0.52);
    c.addPass(bloom);
    c.addPass(new OutputPass());
    return { composer: c, bloom };
  }
  const made = makeComposer();
  composer = made.composer;
  const bloomPass = made.bloom;

  let lastW = -1;
  let lastH = -1;
  let lastDpr = -1;

  function resize(force = false) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // 尺寸与像素比都没变时跳过，避免无谓的渲染目标重建
    if (!force && w === lastW && h === lastH && dpr === lastDpr) return;
    lastW = w;
    lastH = h;
    lastDpr = dpr;
    (window.__resizes = window.__resizes || []).push({ w, h, dpr, t: performance.now() / 1000 });
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    if (composer) {
      composer.setPixelRatio(dpr);
      composer.setSize(w, h);
    }
    stars.mat.uniforms.uDpr.value = dpr;
  }

  window.addEventListener('resize', () => resize(false));
  resize(true);

  const accentTarget = new THREE.Color(0x66e0ff);
  const accent2Target = new THREE.Color(0x8a6bff);
  const rimTarget = new THREE.Color(0x2b4fa8);

  return {
    renderer,
    scene,
    camera,
    composer,
    bloomPass,
    stars: stars.points,
    starMat: stars.mat,
    nebula,
    nebulaSprites,
    skyMat,
    distant,
    rimMats,
    hemi,
    key,
    rim,
    get dpr() {
      return dpr;
    },
    update(t) {
      stars.mat.uniforms.uTime.value = t;
      nebula.rotation.y = t * 0.008;
      nebula.rotation.x = Math.sin(t * 0.05) * 0.03;
      distant.rotation.y = t * 0.006;
    },
    setAccent(hex, hex2) {
      accentTarget.set(hex);
      accent2Target.set(hex2 ?? hex);
      stars.mat.uniforms.uAccent.value.copy(accentTarget).lerp(new THREE.Color(0xffffff), 0.25);
      nebulaSprites.forEach((s, i) => {
        s.material.color.copy(i % 2 === 0 ? accentTarget : accent2Target).multiplyScalar(0.55);
      });
      skyMat.uniforms.uAccent.value.copy(accentTarget).multiplyScalar(0.16);
      skyMat.uniforms.uTop.value.copy(new THREE.Color(0x070b1c)).lerp(accentTarget, 0.06);
      rimMats.forEach((m, i) => m.uniforms.uColor.value.copy(i === 0 ? accentTarget : accent2Target).multiplyScalar(0.8));
      hemi.color.copy(accentTarget).lerp(new THREE.Color(0xbcd4ff), 0.7);
      rim.color.copy(accent2Target);
    },
    setQuality(level) {
      // 0 = 低, 1 = 中, 2 = 高
      if (level === 0) {
        dpr = 1;
        bloomPass.strength = 0.7;
        resize();
      } else if (level === 1) {
        dpr = Math.min(window.devicePixelRatio || 1, 1.4);
        bloomPass.strength = 0.8;
        resize();
      } else {
        dpr = Math.min(window.devicePixelRatio || 1, 1.9);
        bloomPass.strength = 0.9;
        resize();
      }
    },
    setBloomEnabled(on) {
      bloomPass.enabled = on;
    },
  };
}
