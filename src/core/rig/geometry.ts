/** World space geometry of attachments (regions, meshes with weights and deform, points). */
import { DEG2RAD, atan2Deg } from '../math';
import type { PointData, RegionData, VertexData } from './data';
import type { Bone, Slot } from './bone';
import type { Skeleton } from './skeleton';

/** Fills `out` (8 floats) with the world positions of a region's quad: bottom-left, top-left, top-right, bottom-right. */
export function regionWorldVertices(att: RegionData, bone: Bone, out: Float32Array | number[]) {
  const w = att.width;
  const h = att.height;
  const lx = (-w / 2) * att.scaleX;
  const ly = (-h / 2) * att.scaleY;
  const lx2 = lx + w * att.scaleX;
  const ly2 = ly + h * att.scaleY;
  const r = att.rotation * DEG2RAD;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const lxCos = lx * cos + att.x;
  const lxSin = lx * sin;
  const lyCos = ly * cos + att.y;
  const lySin = ly * sin;
  const lx2Cos = lx2 * cos + att.x;
  const lx2Sin = lx2 * sin;
  const ly2Cos = ly2 * cos + att.y;
  const ly2Sin = ly2 * sin;
  const ox = [lxCos - lySin, lxCos - ly2Sin, lx2Cos - ly2Sin, lx2Cos - lySin];
  const oy = [lyCos + lxSin, ly2Cos + lxSin, ly2Cos + lx2Sin, lyCos + lx2Sin];
  for (let i = 0; i < 4; i++) {
    out[i * 2] = ox[i] * bone.a + oy[i] * bone.b + bone.worldX;
    out[i * 2 + 1] = ox[i] * bone.c + oy[i] * bone.d + bone.worldY;
  }
}

export const REGION_UVS = new Float32Array([0, 1, 0, 0, 1, 0, 1, 1]);
export const REGION_TRIANGLES = new Uint16Array([0, 1, 2, 2, 3, 0]);

/** World vertex positions of a mesh or polygon attachment. `deform` holds per vertex (or per influence) deltas. */
export function meshWorldVertices(
  skeleton: Skeleton,
  slot: Slot,
  mesh: VertexData,
  deform: ArrayLike<number> | null,
  out: Float32Array | number[],
) {
  const n = mesh.vertexCount;
  if (!mesh.weighted) {
    const bone = slot.bone;
    const v = mesh.positions;
    const dv = deform && deform.length === v.length ? deform : null;
    for (let i = 0; i < n; i++) {
      const vx = v[i * 2] + (dv ? dv[i * 2] : 0);
      const vy = v[i * 2 + 1] + (dv ? dv[i * 2 + 1] : 0);
      out[i * 2] = vx * bone.a + vy * bone.b + bone.worldX;
      out[i * 2 + 1] = vx * bone.c + vy * bone.d + bone.worldY;
    }
    return;
  }
  const bones = mesh.bones as Int32Array;
  const w = mesh.positions;
  const skelBones = skeleton.bones;
  const dv = deform && deform.length === mesh.deformLength ? deform : null;
  let v = 0;
  let b = 0;
  let f = 0;
  for (let i = 0; i < n; i++) {
    let wx = 0;
    let wy = 0;
    const count = bones[v++];
    for (let k = 0; k < count; k++, b += 3, f += 2) {
      const bone = skelBones[bones[v++]];
      let vx = w[b];
      let vy = w[b + 1];
      if (dv) {
        vx += dv[f];
        vy += dv[f + 1];
      }
      const weight = w[b + 2];
      wx += (vx * bone.a + vy * bone.b + bone.worldX) * weight;
      wy += (vx * bone.c + vy * bone.d + bone.worldY) * weight;
    }
    out[i * 2] = wx;
    out[i * 2 + 1] = wy;
  }
}

/** World position and rotation (degrees) of a point attachment — Spine's `computeWorldPosition` / `computeWorldRotation`. */
export function pointWorld(att: PointData, bone: Bone): { x: number; y: number; rotation: number } {
  const r = att.rotation * DEG2RAD;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return {
    x: att.x * bone.a + att.y * bone.b + bone.worldX,
    y: att.x * bone.c + att.y * bone.d + bone.worldY,
    rotation: atan2Deg(cos * bone.c + sin * bone.d, cos * bone.a + sin * bone.b),
  };
}
