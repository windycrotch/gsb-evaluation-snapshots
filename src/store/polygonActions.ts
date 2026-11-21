/** Clipping / bounding box / point attachments: creation and vertex editing (always in the setup pose). */
import { dropDeformTimeline, freshName } from '@/core/edit';
import { matInvert } from '@/core/math';
import { vertexWorldPositions } from '@/core/mesh';
import { DEFAULT_BOUNDING_BOX_COLOR, DEFAULT_CLIPPING_COLOR, DEFAULT_POINT_COLOR, newSlot, polygonVertexCount } from '@/core/model';
import type { Id, Influence, PointAttachment, PolygonAttachment } from '@/core/model';
import { getSetupSkeleton } from '@/store/scene';
import { setSelection } from './actions';
import { docStore } from './doc';
import { setupMats } from './meshActions';
import { toast, uiStore } from './ui';

export type PolygonKind = 'clipping' | 'boundingbox';

const LABEL: Record<PolygonKind | 'point', string> = { clipping: 'clipping', boundingbox: 'bounding box', point: 'point' };

export function getPolygon(slotId: Id, name: string): PolygonAttachment | undefined {
  const a = docStore.get().skeleton.skins[0]?.attachments[slotId]?.[name];
  return a && (a.type === 'clipping' || a.type === 'boundingbox') ? a : undefined;
}

/** The bone a new attachment is placed on: the selected bone (or the bone of the selected slot), else the root. */
function targetBone(): Id {
  const doc = docStore.get().skeleton;
  const sel = uiStore.get().selection;
  const id = sel.bones[0];
  return id && doc.bones.some((b) => b.id === id) ? id : doc.bones[0].id;
}

/** Creates a slot (after the selected slot, else on top) holding the attachment, in one undo step. */
function addSlotWith(
  kind: PolygonKind | 'point',
  attachment: (name: string) => PolygonAttachment | PointAttachment,
  boneId: Id,
): { slotId: Id; name: string } {
  const doc = docStore.get().skeleton;
  const name = freshName(LABEL[kind], doc.slots);
  const att = attachment(name);
  const slot = newSlot({ name, bone: boneId, attachment: name });
  docStore.update(`Create ${LABEL[kind]}`, (d) => {
    const sel = uiStore.get().selection.slot;
    const idx = sel ? d.skeleton.slots.findIndex((s) => s.id === sel) : -1;
    if (idx >= 0) d.skeleton.slots.splice(idx + 1, 0, slot);
    else d.skeleton.slots.push(slot);
    d.skeleton.skins[0].attachments[slot.id] = { [name]: att };
  });
  setSelection({ slot: slot.id, attachment: name, bones: [boneId] });
  return { slotId: slot.id, name };
}

/** Creates a clipping polygon or bounding box from world positions (setup pose), on the selected bone. */
export function createPolygon(kind: PolygonKind, world: [number, number][]): { slotId: Id; name: string } | null {
  if (world.length < 3) return null;
  const boneId = targetBone();
  const bone = getSetupSkeleton().boneById(boneId);
  if (!bone) return null;
  const vertices: number[] = [];
  for (const [x, y] of world) {
    const [lx, ly] = bone.worldToLocal(x, y);
    vertices.push(lx, ly);
  }
  return addSlotWith(
    kind,
    (name) =>
      kind === 'clipping'
        ? { type: 'clipping', name, color: [...DEFAULT_CLIPPING_COLOR], vertices, weights: null, end: null, convex: false, inverse: false }
        : { type: 'boundingbox', name, color: [...DEFAULT_BOUNDING_BOX_COLOR], vertices, weights: null },
    boneId,
  );
}

/** Creates a point attachment at a world position (setup pose), on the selected bone. */
export function createPoint(wx: number, wy: number): { slotId: Id; name: string } | null {
  const boneId = targetBone();
  const bone = getSetupSkeleton().boneById(boneId);
  if (!bone) return null;
  const [x, y] = bone.worldToLocal(wx, wy);
  return addSlotWith('point', (name) => ({ type: 'point', name, x, y, rotation: 0, color: [...DEFAULT_POINT_COLOR] }), boneId);
}

/** The side of the square a polygon is reset to, in the units of the bone it sits on. */
const DEFAULT_POLYGON_SIZE = 100;

/**
 * Reset (Spine's button on clipping and bounding box attachments): the polygon goes back to a square around the origin of its bone, without
 * weights, and the deform keys made for the old shape go. One undo step.
 */
export function resetPolygonShape(slotId: Id, name: string, size = DEFAULT_POLYGON_SIZE) {
  if (!getPolygon(slotId, name)) return;
  const h = size / 2;
  docStore.update('Reset shape', (d) => {
    const p = d.skeleton.skins[0].attachments[slotId]?.[name];
    if (!p || (p.type !== 'clipping' && p.type !== 'boundingbox')) return;
    p.vertices = [-h, -h, h, -h, h, h, -h, h];
    p.weights = null;
    for (const a of d.skeleton.animations) for (const skinId of Object.keys(a.deform)) dropDeformTimeline(a, skinId, slotId, name);
  });
  uiStore.patch({ selection: { ...uiStore.get().selection, vertices: [] } });
}

/** Moves polygon vertices to world positions (setup pose). Weighted vertices move every influence along. */
export function movePolygonVertices(slotId: Id, name: string, moves: { index: number; x: number; y: number }[]) {
  const { mats, slotMat } = setupMats();
  const inv = matInvert(slotMat(slotId));
  docStore.update('Move vertices', (d) => {
    const p = d.skeleton.skins[0].attachments[slotId]?.[name];
    if (!p || (p.type !== 'clipping' && p.type !== 'boundingbox' && p.type !== 'path')) return; // path points move the same way
    for (const mv of moves) {
      if (p.weights) {
        const list = p.weights[mv.index];
        if (!list) continue;
        p.weights[mv.index] = list.map(([bone, , , w]) => {
          const bm = mats.get(bone);
          if (!bm) return [bone, 0, 0, w] as Influence;
          const im = matInvert(bm);
          return [bone, im.a * mv.x + im.b * mv.y + im.x, im.c * mv.x + im.d * mv.y + im.y, w] as Influence;
        });
      } else if (mv.index * 2 + 1 < p.vertices.length) {
        p.vertices[mv.index * 2] = inv.a * mv.x + inv.b * mv.y + inv.x;
        p.vertices[mv.index * 2 + 1] = inv.c * mv.x + inv.d * mv.y + inv.y;
      }
    }
  });
}

/** Adds a vertex on the polygon edge nearest to a world position. Returns the new vertex index. */
export function addPolygonVertex(slotId: Id, name: string, wx: number, wy: number): number | null {
  const att = getPolygon(slotId, name);
  if (!att) return null;
  const { mats, slotMat } = setupMats();
  const n = polygonVertexCount(att);
  const world = vertexWorldPositions(att, n, slotMat(slotId), mats);
  let edge = -1;
  let bestD = Infinity;
  let bestT = 0;
  let px = wx;
  let py = wy;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = world[i * 2];
    const ay = world[i * 2 + 1];
    const dx = world[j * 2] - ax;
    const dy = world[j * 2 + 1] - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((wx - ax) * dx + (wy - ay) * dy) / len2)) : 0;
    const qx = ax + dx * t;
    const qy = ay + dy * t;
    const dist = (wx - qx) ** 2 + (wy - qy) ** 2;
    if (dist < bestD) {
      bestD = dist;
      edge = i;
      bestT = t;
      px = qx;
      py = qy;
    }
  }
  if (edge < 0) return null;
  const inv = matInvert(slotMat(slotId));
  const at = edge + 1;
  docStore.update('Add vertex', (d) => {
    const p = d.skeleton.skins[0].attachments[slotId]?.[name];
    if (!p || (p.type !== 'clipping' && p.type !== 'boundingbox')) return;
    if (p.weights) {
      // the new vertex follows the bones of the nearer end of its edge
      const from = p.weights[bestT < 0.5 ? edge : (edge + 1) % n];
      p.weights.splice(
        at,
        0,
        from.map(([bone, , , w]) => {
          const bm = mats.get(bone);
          if (!bm) return [bone, 0, 0, w] as Influence;
          const im = matInvert(bm);
          return [bone, im.a * px + im.b * py + im.x, im.c * px + im.d * py + im.y, w] as Influence;
        }),
      );
    } else {
      p.vertices.splice(at * 2, 0, inv.a * px + inv.b * py + inv.x, inv.c * px + inv.d * py + inv.y);
    }
  });
  return at;
}

/** Removes vertices, keeping at least three. Returns false when nothing was removed. */
export function deletePolygonVertices(slotId: Id, name: string, indices: number[]): boolean {
  const att = getPolygon(slotId, name);
  if (!att) return false;
  const drop = new Set(indices.filter((i) => i >= 0 && i < polygonVertexCount(att)));
  if (!drop.size) return false;
  if (polygonVertexCount(att) - drop.size < 3) {
    toast('A polygon needs at least 3 vertices', 'error');
    return false;
  }
  docStore.update('Delete vertices', (d) => {
    const p = d.skeleton.skins[0].attachments[slotId]?.[name];
    if (!p || (p.type !== 'clipping' && p.type !== 'boundingbox')) return;
    if (p.weights) p.weights = p.weights.filter((_, i) => !drop.has(i));
    else p.vertices = p.vertices.filter((_, k) => !drop.has(k >> 1));
  });
  setSelection({ ...uiStore.get().selection, vertices: [] });
  return true;
}
