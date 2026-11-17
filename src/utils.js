import * as THREE from 'three';

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

/** 确定性随机数（每关可复现） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rand = (rng, a = 0, b = 1) => a + (b - a) * rng();

export function randomDirection(rng) {
  const u = rng() * 2 - 1;
  const theta = rng() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - u * u));
  return new THREE.Vector3(r * Math.cos(theta), u, r * Math.sin(theta));
}

/** 斐波那契球面均匀分布 */
export function fibonacciSphere(count, offset = 0.5) {
  const out = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - ((i + offset) / count) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    out.push(new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r));
  }
  return out;
}

export function projectOnPlane(v, n) {
  return v.clone().addScaledVector(n, -v.dot(n));
}

/** 生成柔和的径向光晕贴图 */
export function glowTexture(size = 128, stops = [0, 0.25, 1]) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(stops[1], `rgba(255,255,255,${stops[0] === 0 ? 0.45 : 0.3})`);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export const hexToCss = (hex) => '#' + new THREE.Color(hex).getHexString();

/** 递归销毁（几何体 / 材质去重） */
export function disposeObject(root) {
  const geos = new Set();
  const mats = new Set();
  const texs = new Set();
  root.traverse((obj) => {
    if (obj.geometry) geos.add(obj.geometry);
    if (obj.material) {
      const list = Array.isArray(obj.material) ? obj.material : [obj.material];
      list.forEach((m) => {
        mats.add(m);
        ['map', 'alphaMap', 'emissiveMap'].forEach((k) => {
          if (m[k]) texs.add(m[k]);
        });
      });
    }
  });
  geos.forEach((g) => g.dispose());
  mats.forEach((m) => m.dispose());
  texs.forEach((t) => t.dispose());
}
