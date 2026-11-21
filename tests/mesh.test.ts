import { describe, expect, it } from 'vitest';
import {
  adjacency,
  autoWeights,
  bindMesh,
  generateMeshFromImage,
  meshFromRegion,
  meshWorldPositions,
  polygonArea,
  removeMeshVertices,
  setBoneWeight,
  smoothWeights,
  traceOutline,
  unbindMesh,
} from '../src/core/mesh';
import type { BoneMats } from '../src/core/mesh';
import type { RegionAttachment } from '../src/core/model';
import type { Mat } from '../src/core/math';

function circleImage(w: number, h: number, r: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const inside = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) <= r;
      d[(y * w + x) * 4 + 3] = inside ? 255 : 0;
    }
  return d;
}

function lImage(w: number, h: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[(y * w + x) * 4 + 3] = x < w * 0.35 || y > h * 0.65 ? 255 : 0;
  return d;
}

const region = (w: number, h: number): RegionAttachment => ({
  type: 'region',
  name: 'img',
  path: 'img',
  x: 10,
  y: -5,
  rotation: 30,
  scaleX: 1,
  scaleY: 1,
  width: w,
  height: h,
  color: [1, 1, 1, 1],
});

function triAreaSum(pos: ArrayLike<number>, tris: number[]): number {
  let s = 0;
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i] * 2,
      b = tris[i + 1] * 2,
      c = tris[i + 2] * 2;
    s += Math.abs((pos[b] - pos[a]) * (pos[c + 1] - pos[a + 1]) - (pos[c] - pos[a]) * (pos[b + 1] - pos[a + 1])) / 2;
  }
  return s;
}

describe('mesh tracing and generation', () => {
  it('traces a circle close to its true area', () => {
    const r = 48;
    const poly = traceOutline(circleImage(128, 128, r), 128, 128, { padding: 0, maxHullVertices: 60 });
    expect(poly.length).toBeGreaterThan(8);
    const a = Math.abs(polygonArea(poly));
    expect(a / (Math.PI * r * r)).toBeGreaterThan(0.85);
    expect(a / (Math.PI * r * r)).toBeLessThan(1.15);
  });

  it('generates a valid mesh for a circle', () => {
    const m = generateMeshFromImage(region(128, 128), circleImage(128, 128, 48), 128, 128, { spacing: 24 });
    const n = m.uvs.length / 2;
    expect(m.hull).toBeGreaterThanOrEqual(6);
    expect(n).toBeGreaterThan(m.hull);
    expect(m.vertices.length).toBe(n * 2);
    expect(m.triangles.length % 3).toBe(0);
    expect(m.triangles.length).toBeGreaterThan(9);
    for (const i of m.triangles) expect(i).toBeLessThan(n);
    for (const uv of m.uvs) {
      expect(uv).toBeGreaterThanOrEqual(0);
      expect(uv).toBeLessThanOrEqual(1);
    }
    // triangles tile (roughly) the traced polygon
    const hullPoly = Array.from({ length: m.hull }, (_, i) => [m.vertices[i * 2], m.vertices[i * 2 + 1]] as [number, number]);
    expect(triAreaSum(m.vertices, m.triangles) / Math.abs(polygonArea(hullPoly))).toBeGreaterThan(0.9);
  });

  it('handles a concave (L) shape without covering the notch', () => {
    const m = generateMeshFromImage(region(100, 100), lImage(100, 100), 100, 100, { spacing: 16, padding: 0 });
    // no triangle centroid may fall inside the empty notch (x > 35%, y < 65% in image space)
    for (let t = 0; t < m.triangles.length; t += 3) {
      let u = 0,
        v = 0;
      for (let k = 0; k < 3; k++) {
        u += m.uvs[m.triangles[t + k] * 2] / 3;
        v += m.uvs[m.triangles[t + k] * 2 + 1] / 3;
      }
      expect(u > 0.5 && v < 0.5).toBe(false);
    }
  });

  it('quad from region matches the region corners', () => {
    const m = meshFromRegion(region(40, 20));
    expect(m.vertices.length).toBe(8);
    expect(m.triangles).toEqual([0, 1, 2, 2, 3, 0]);
  });
});

describe('weights', () => {
  const mats: BoneMats = new Map<string, Mat>([
    ['a', { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 }],
    ['b', { a: 0, b: -1, c: 1, d: 0, x: 50, y: 0 }],
  ]);
  const slotMat: Mat = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };

  it('auto weights are normalized, limited and favour the nearest bone', () => {
    const w = autoWeights(
      [2, 1, 49, 2],
      [
        { id: 'a', ax: 0, ay: 0, bx: 40, by: 0 },
        { id: 'b', ax: 50, ay: 0, bx: 50, by: 40 },
      ],
    );
    for (const list of w) expect(list.reduce((s, e) => s + e.w, 0)).toBeCloseTo(1, 6);
    expect(w[0][0].bone).toBe('a');
    expect(w[1][0].bone).toBe('b');
  });

  it('bind and unbind preserve world positions', () => {
    const base = meshFromRegion(region(60, 30));
    const world0 = meshWorldPositions(base, slotMat, mats);
    const weights = autoWeights(world0, [
      { id: 'a', ax: 0, ay: 0, bx: 40, by: 0 },
      { id: 'b', ax: 50, ay: 0, bx: 50, by: 40 },
    ]);
    const bound = bindMesh(base, slotMat, mats, weights);
    expect(bound.weights).not.toBeNull();
    const world1 = meshWorldPositions(bound, slotMat, mats);
    for (let i = 0; i < world0.length; i++) expect(world1[i]).toBeCloseTo(world0[i], 4);
    const back = unbindMesh(bound, slotMat, mats);
    const world2 = meshWorldPositions(back, slotMat, mats);
    for (let i = 0; i < world0.length; i++) expect(world2[i]).toBeCloseTo(world0[i], 4);
  });

  it('setBoneWeight keeps the total at one', () => {
    const list: [string, number, number, number][] = [
      ['a', 0, 0, 0.7],
      ['b', 1, 1, 0.3],
    ];
    const out = setBoneWeight(list, 'a', 0.9, () => [0, 0]);
    expect(out.reduce((s, i) => s + i[3], 0)).toBeCloseTo(1, 6);
    expect(out.find((i) => i[0] === 'a')![3]).toBeCloseTo(0.9, 6);
    const added = setBoneWeight(list, 'c', 0.5, () => [3, 4]);
    expect(added.some((i) => i[0] === 'c')).toBe(true);
    expect(added.reduce((s, i) => s + i[3], 0)).toBeCloseTo(1, 6);
  });

  it('smoothing preserves normalization', () => {
    const m = generateMeshFromImage(region(128, 128), circleImage(128, 128, 48), 128, 128, { spacing: 24 });
    const world = meshWorldPositions(m, slotMat, mats);
    const w = autoWeights(world, [
      { id: 'a', ax: -60, ay: 0, bx: 0, by: 0 },
      { id: 'b', ax: 0, ay: 0, bx: 60, by: 0 },
    ]);
    const s = smoothWeights(w, adjacency(m.triangles, m.uvs.length / 2), 3);
    for (const list of s) expect(list.reduce((t, e) => t + e.w, 0)).toBeCloseTo(1, 6);
  });
});

describe('vertex editing', () => {
  it('removing an interior vertex keeps the mesh valid', () => {
    const m = generateMeshFromImage(region(128, 128), circleImage(128, 128, 48), 128, 128, { spacing: 24 });
    const n = m.uvs.length / 2;
    expect(n).toBeGreaterThan(m.hull);
    const out = removeMeshVertices(m, new Set([m.hull]), m.vertices);
    expect(out.uvs.length / 2).toBe(n - 1);
    expect(out.hull).toBe(m.hull);
    for (const i of out.triangles) expect(i).toBeLessThan(n - 1);
  });
});
