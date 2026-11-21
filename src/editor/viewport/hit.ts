import { distToSegmentSq, pointInTriangle } from '@/core/math';
import type { Id } from '@/core/model';
import { samplePath } from '@/core/path';
import { REGION_TRIANGLES, meshWorldVertices, pointWorld, regionWorldVertices } from '@/core/skeleton';
import type { Skeleton } from '@/core/skeleton';
import type { Scene } from '@/store/scene';

export interface BoneHit {
  id: Id;
  /** Distance in screen pixels. */
  dist: number;
}

/** Nearest bone within `tolPx` screen pixels. Later (child) bones win ties. */
export function hitBone(scene: Scene, hiddenOrLocked: Set<Id>, wx: number, wy: number, zoom: number, tolPx = 8): BoneHit | null {
  let best: BoneHit | null = null;
  const tol = tolPx / zoom;
  const tolSq = tol * tol;
  for (const bone of scene.skeleton.bones) {
    if (hiddenOrLocked.has(bone.data.id)) continue;
    const len = bone.data.length * Math.max(1e-6, bone.worldScaleX);
    const tx = bone.worldX + bone.a * bone.data.length;
    const ty = bone.worldY + bone.c * bone.data.length;
    let d2: number;
    if (len < 1e-3) d2 = (wx - bone.worldX) ** 2 + (wy - bone.worldY) ** 2;
    else d2 = distToSegmentSq(wx, wy, bone.worldX, bone.worldY, tx, ty);
    if (d2 <= tolSq) {
      const d = Math.sqrt(d2) * zoom;
      if (!best || d <= best.dist + 0.5) best = { id: bone.data.id, dist: d };
    }
  }
  return best;
}

export interface AttachmentHit {
  slotId: Id;
  name: string;
}

/** Topmost slot attachment containing the point. */
export function hitAttachment(
  scene: Scene,
  hiddenSlots: Set<Id>,
  wx: number,
  wy: number,
  zoom = 1,
  what: { images: boolean; outlines: boolean } = { images: true, outlines: true },
): AttachmentHit | null {
  const skel = scene.skeleton;
  const order = skel.drawOrder;
  for (let i = order.length - 1; i >= 0; i--) {
    const slot = order[i];
    if (hiddenSlots.has(slot.data.id)) continue;
    const att = skel.slotAttachment(slot);
    if (!att) continue;
    const isImage = att.kind === 'region' || att.kind === 'mesh';
    if (isImage ? !what.images : !what.outlines) continue;
    if (att.kind === 'point') {
      // a point has no area: grab it within a few pixels
      const p = pointWorld(att, slot.bone);
      if ((p.x - wx) ** 2 + (p.y - wy) ** 2 <= (10 / zoom) ** 2) return { slotId: slot.data.id, name: att.name };
    } else if (att.kind === 'path') {
      // a path is a curve: it can only be grabbed on the line
      const v: number[] = [];
      meshWorldVertices(skel, slot, att, slot.deform.length ? slot.deform : null, v);
      const poly = samplePath(v, Math.floor(att.vertexCount / 3), att.closed, 16);
      const tol2 = (8 / zoom) ** 2;
      for (let k = 0; k + 3 < poly.length; k += 2)
        if (distToSegmentSq(wx, wy, poly[k], poly[k + 1], poly[k + 2], poly[k + 3]) <= tol2)
          return { slotId: slot.data.id, name: att.name };
    } else if (att.kind === 'boundingbox' || att.kind === 'clipping') {
      // only the outline is grabbable: the inside of a clipping polygon or box usually covers the images that should be picked
      const v = new Float32Array(att.vertexCount * 2);
      meshWorldVertices(skel, slot, att, null, v);
      const tol2 = (8 / zoom) ** 2;
      for (let i = 0, n = att.vertexCount; i < n; i++) {
        const j = (i + 1) % n;
        if (distToSegmentSq(wx, wy, v[i * 2], v[i * 2 + 1], v[j * 2], v[j * 2 + 1]) <= tol2)
          return { slotId: slot.data.id, name: att.name };
      }
    } else if (att.kind === 'region') {
      const v = new Float32Array(8);
      regionWorldVertices(att, slot.bone, v);
      for (let t = 0; t < 6; t += 3) {
        const a = REGION_TRIANGLES[t] * 2;
        const b = REGION_TRIANGLES[t + 1] * 2;
        const c = REGION_TRIANGLES[t + 2] * 2;
        if (pointInTriangle(wx, wy, v[a], v[a + 1], v[b], v[b + 1], v[c], v[c + 1])) return { slotId: slot.data.id, name: att.name };
      }
    } else {
      const v = new Float32Array(att.vertexCount * 2);
      meshWorldVertices(skel, slot, att, slot.deform.length ? slot.deform : null, v);
      const tri = att.triangles;
      for (let t = 0; t < tri.length; t += 3) {
        const a = tri[t] * 2;
        const b = tri[t + 1] * 2;
        const c = tri[t + 2] * 2;
        if (pointInTriangle(wx, wy, v[a], v[a + 1], v[b], v[b + 1], v[c], v[c + 1])) return { slotId: slot.data.id, name: att.name };
      }
    }
  }
  return null;
}

/** World vertices of the currently shown attachment of a slot (for overlays). */
export function slotWorldVertices(
  skel: Skeleton,
  slotId: Id,
): { vertices: Float32Array; count: number; kind: 'region' | 'mesh' | 'polygon' } | null {
  const slot = skel.slotById(slotId);
  if (!slot) return null;
  const att = skel.slotAttachment(slot);
  if (!att || att.kind === 'point') return null;
  if (att.kind === 'region') {
    const v = new Float32Array(8);
    regionWorldVertices(att, slot.bone, v);
    return { vertices: v, count: 4, kind: 'region' };
  }
  const v = new Float32Array(att.vertexCount * 2);
  meshWorldVertices(skel, slot, att, (att.kind === 'mesh' || att.kind === 'path') && slot.deform.length ? slot.deform : null, v);
  return { vertices: v, count: att.vertexCount, kind: att.kind === 'mesh' ? 'mesh' : 'polygon' };
}
