// Procedural sample models for the demo, so the repository ships no binary assets.
// Each is a dense parametric surface (about 260k triangles) with UVs, normals and a generated
// base-colour texture, written as a .glb.   node examples/make-sample.mjs <kind> <out.glb>
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// ---- value noise
const hash = (x, y, z) => { let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const fade = (t) => t * t * (3 - 2 * t), mix = (a, b, t) => a + (b - a) * t;
function noise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
  const c = (dx, dy, dz) => hash(xi + dx, yi + dy, zi + dz);
  return mix(mix(mix(c(0, 0, 0), c(1, 0, 0), u), mix(c(0, 1, 0), c(1, 1, 0), u), v), mix(mix(c(0, 0, 1), c(1, 0, 1), u), mix(c(0, 1, 1), c(1, 1, 1), u), v), w) * 2 - 1;
}
function fbm(x, y, z, octaves, ridged = false) {
  let s = 0, a = 0.5, f = 1;
  for (let o = 0; o < octaves; o++) { const n = noise(x * f + o * 17.1, y * f - o * 9.3, z * f + o * 4.7); s += a * (ridged ? 1 - 2 * Math.abs(n) : n); a *= 0.5; f *= 2.03; }
  return s;
}

// ---- shapes: (u, v) in [0,1]^2 -> { p: [x, y, z], h: a 0..1 value used for colouring }
const TAU = Math.PI * 2;
const SHAPES = {
  // boulder: sphere pushed around by ridged noise
  rock: {
    segments: [512, 256], color: [[0.36, 0.33, 0.30], [0.62, 0.58, 0.52], [0.25, 0.27, 0.22]],
    f(u, v) {
      const th = u * TAU, ph = v * Math.PI, d = [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)];
      const big = fbm(d[0] * 1.3, d[1] * 1.3, d[2] * 1.3, 3), fine = fbm(d[0] * 5, d[1] * 5, d[2] * 5, 6, true);
      const r = 0.42 * (1 + 0.32 * big + 0.09 * fine);
      return { p: [d[0] * r * 1.15, d[1] * r * 0.85 + 0.36, d[2] * r], h: 0.5 + 0.5 * fine };
    },
  },
  // (2,3) torus knot with a rope-like bumped surface
  knot: {
    segments: [1024, 128], color: [[0.55, 0.30, 0.16], [0.85, 0.62, 0.30], [0.30, 0.16, 0.10]],
    f(u, v) {
      const curve = (t) => { const a = t * TAU * 2, b = t * TAU * 3, r = 0.3 * (2 + Math.cos(b)) * 0.5; return [r * Math.cos(a), r * Math.sin(a), 0.3 * Math.sin(b) * 0.5]; };
      const P1 = curve(u), P2 = curve(u + 0.0005);
      const T = [P2[0] - P1[0], P2[1] - P1[1], P2[2] - P1[2]], N0 = [P2[0] + P1[0], P2[1] + P1[1], P2[2] + P1[2]];
      const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
      const B = norm(cross(T, N0)), N = norm(cross(B, T));
      const a = v * TAU, strands = 0.5 + 0.5 * Math.cos(a * 6 + u * TAU * 40);
      const q = [P1[0] * 9, P1[1] * 9, P1[2] * 9], fine = fbm(q[0] + Math.cos(a), q[1] + Math.sin(a), q[2], 4);
      const r = 0.085 * (1 + 0.16 * strands + 0.1 * fine), cx = -r * Math.cos(a), cy = r * Math.sin(a);
      // lay the knot flat (xz) and lift it off the ground
      return { p: [P1[0] + cx * N[0] + cy * B[0], P1[2] + cx * N[2] + cy * B[2] + 0.27, P1[1] + cx * N[1] + cy * B[1]], h: strands * 0.7 + 0.3 * (0.5 + 0.5 * fine) };
    },
  },
  // fluted, twisted column with a weathered surface
  column: {
    segments: [512, 256], color: [[0.70, 0.68, 0.62], [0.88, 0.86, 0.80], [0.45, 0.46, 0.42]],
    f(u, v) {
      const y = v, a = u * TAU + y * 1.2;
      const profile = 0.16 + 0.05 * Math.pow(Math.abs(Math.cos(y * Math.PI)), 6) + 0.012 * Math.sin(y * 40) * (y > 0.08 && y < 0.92 ? 1 : 0);
      const flutes = 0.5 + 0.5 * Math.cos(u * TAU * 16), fine = fbm(Math.cos(a) * 3, y * 9, Math.sin(a) * 3, 5, true);
      // closed ends: radius goes to zero in the first and last rows
      const cap = Math.min(1, Math.min(v, 1 - v) * 256);
      const r = (profile - 0.014 * flutes + 0.012 * fine) * cap;
      return { p: [Math.cos(a) * r, y * 1.0, Math.sin(a) * r], h: 0.6 * flutes + 0.4 * (0.5 + 0.5 * fine) };
    },
  },
};
export const SAMPLE_KINDS = Object.keys(SHAPES);

// ---- PNG (RGB, 8 bit) without dependencies
function png(w, h, rgb) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => { const o = Buffer.alloc(12 + data.length); o.writeUInt32BE(data.length, 0); o.write(type, 4, 'ascii'); data.copy(o, 8); o.writeUInt32BE(crc(o.subarray(4, 8 + data.length)), 8 + data.length); return o; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** @returns {Buffer} a binary glTF file */
export function makeSample(kind, { texture = 1024 } = {}) {
  const shape = SHAPES[kind]; if (!shape) throw new Error(`unknown sample "${kind}" (have: ${SAMPLE_KINDS.join(', ')})`);
  const [SU, SV] = shape.segments, W = SU + 1, V = W * (SV + 1);
  const pos = new Float32Array(V * 3), uv = new Float32Array(V * 2), nrm = new Float32Array(V * 3);
  for (let j = 0; j <= SV; j++) for (let i = 0; i <= SU; i++) {
    const k = j * W + i, { p } = shape.f(i === SU ? 0 : i / SU, j / SV); // i === SU repeats column 0 exactly: a UV seam, not a gap
    pos.set(p, k * 3); uv[k * 2] = i / SU; uv[k * 2 + 1] = j / SV;
  }
  const idx = new Uint32Array(SU * SV * 6); let n = 0;
  for (let j = 0; j < SV; j++) for (let i = 0; i < SU; i++) { const a = j * W + i, b = a + 1, c = a + W, d = c + 1; idx[n++] = a; idx[n++] = b; idx[n++] = c; idx[n++] = b; idx[n++] = d; idx[n++] = c; }
  // normals: face normals accumulated per position, so the seam column and collapsed rows shade smoothly
  const key = new Map(), rep = new Uint32Array(V);
  for (let k = 0; k < V; k++) { const s = `${Math.round(pos[k * 3] * 1e5)},${Math.round(pos[k * 3 + 1] * 1e5)},${Math.round(pos[k * 3 + 2] * 1e5)}`; let r = key.get(s); if (r === undefined) { r = k; key.set(s, k); } rep[k] = r; }
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    for (const q of [idx[t], idx[t + 1], idx[t + 2]]) { const r = rep[q] * 3; nrm[r] += x; nrm[r + 1] += y; nrm[r + 2] += z; }
  }
  // make sure the surface faces outwards: flip everything if the signed volume is negative
  let vol = 0;
  for (let t = 0; t < idx.length; t += 3) { const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3; vol += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]); }
  const sign = vol < 0 ? -1 : 1;
  if (sign < 0) for (let t = 0; t < idx.length; t += 3) { const x = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = x; }
  for (let k = 0; k < V; k++) { const r = rep[k] * 3, l = (Math.hypot(nrm[r], nrm[r + 1], nrm[r + 2]) || 1) * sign; if (rep[k] === k) { nrm[r] /= l; nrm[r + 1] /= l; nrm[r + 2] /= l; } }
  for (let k = 0; k < V; k++) if (rep[k] !== k) nrm.set(nrm.subarray(rep[k] * 3, rep[k] * 3 + 3), k * 3);

  // base colour texture from the shape's own height value plus a little grain
  const TW = texture, TH = texture, rgb = Buffer.alloc(TW * TH * 3), [c0, c1, c2] = shape.color;
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
    const { p, h } = shape.f(x / TW, y / TH), g = 0.5 + 0.5 * fbm(p[0] * 40, p[1] * 40, p[2] * 40, 3), d = 0.5 + 0.5 * fbm(p[0] * 3, p[1] * 3, p[2] * 3, 2), o = (y * TW + x) * 3;
    for (let ch = 0; ch < 3; ch++) { let c = mix(c0[ch], c1[ch], Math.min(1, Math.max(0, h))); c = mix(c, c2[ch], d * 0.45); rgb[o + ch] = Math.round(255 * Math.min(1, Math.max(0, c * (0.85 + 0.3 * g)))); }
  }
  const image = png(TW, TH, rgb);

  // ---- GLB
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < V; k++) for (let a = 0; a < 3; a++) { const x = pos[k * 3 + a]; if (x < min[a]) min[a] = x; if (x > max[a]) max[a] = x; }
  const parts = [pos, nrm, uv, idx, image].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)), views = []; let off = 0; const chunks = [];
  for (const b of parts) { views.push({ buffer: 0, byteOffset: off, byteLength: b.length }); chunks.push(b); off += b.length; const pad = (4 - (off % 4)) % 4; if (pad) { chunks.push(Buffer.alloc(pad)); off += pad; } }
  const gltf = {
    asset: { version: '2.0', generator: 'three-nanite examples/make-sample.mjs' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: kind }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ name: kind, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.75 } }],
    textures: [{ source: 0 }], images: [{ bufferView: 4, mimeType: 'image/png' }],
    accessors: [{ bufferView: 0, componentType: 5126, count: V, type: 'VEC3', min, max }, { bufferView: 1, componentType: 5126, count: V, type: 'VEC3' }, { bufferView: 2, componentType: 5126, count: V, type: 'VEC2' }, { bufferView: 3, componentType: 5125, count: idx.length, type: 'SCALAR' }],
    bufferViews: views, buffers: [{ byteLength: off }],
  };
  let json = Buffer.from(JSON.stringify(gltf)); json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + json.length + 8 + off, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(json.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(off, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jh, json, bh, ...chunks]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [kind, out] = process.argv.slice(2);
  if (!kind || !out) { console.error(`usage: node examples/make-sample.mjs <${SAMPLE_KINDS.join('|')}> <out.glb>`); process.exit(2); }
  fs.writeFileSync(out, makeSample(kind)); console.log(`wrote ${out}`);
}
