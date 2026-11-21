/**
 * Path attachments: creating them and editing their nodes in the setup pose. In Animate mode the points are deformed and keyed
 * instead (`setDeformKey` in meshActions works for paths too). Moving points reuses `movePolygonVertices`.
 *
 * A path has three points per node — in-handle, anchor, out-handle (see `PathAttachment`) — so the point index `p` belongs to
 * node `p / 3 | 0`; `p % 3 === 1` is the anchor.
 */
import { dropDeformTimeline, freshName } from '@/core/edit';
import { matApply, matInvert } from '@/core/math';
import { defaultPathVertices } from '@/core/path';
import type { Mat } from '@/core/math';
import { autoWeights, normalizeInfluences, vertexWorldPositions } from '@/core/mesh';
import { DEFAULT_PATH_COLOR, newSlot, pathNodeCount, polygonVertexCount } from '@/core/model';
import type { Id, Influence, PathAttachment } from '@/core/model';
import { getSetupSkeleton } from '@/store/scene';
import { setSelection } from './actions';
import { docStore } from './doc';
import { boneSegments, setupMats } from './meshActions';
import { toast, uiStore } from './ui';

/** A node being drawn: the anchor and both handles, in world coordinates. */
export interface PathNodeDraft {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

export function getPath(slotId: Id, name: string): PathAttachment | undefined {
  const a = docStore.get().skeleton.skins[0]?.attachments[slotId]?.[name];
  return a && a.type === 'path' ? a : undefined;
}

/** The bone a new path is placed on: the selected bone (or the bone of the selected slot), else the root. */
function targetBone(): Id {
  const doc = docStore.get().skeleton;
  const id = uiStore.get().selection.bones[0];
  return id && doc.bones.some((b) => b.id === id) ? id : doc.bones[0].id;
}

/** Creates a slot (after the selected slot, else on top) holding a path made of `nodes`, in one undo step. */
export function createPath(nodes: PathNodeDraft[], closed: boolean): { slotId: Id; name: string } | null {
  if (nodes.length < 2) return null;
  const boneId = targetBone();
  const bone = getSetupSkeleton().boneById(boneId);
  if (!bone) return null;
  const vertices: number[] = [];
  const push = (x: number, y: number) => {
    const [lx, ly] = bone.worldToLocal(x, y);
    vertices.push(lx, ly);
  };
  for (const n of nodes) {
    push(n.inX, n.inY);
    push(n.x, n.y);
    push(n.outX, n.outY);
  }
  const doc = docStore.get().skeleton;
  const name = freshName('path', doc.slots);
  const att: PathAttachment = { type: 'path', name, color: [...DEFAULT_PATH_COLOR], closed, constantSpeed: true, vertices, weights: null };
  const slot = newSlot({ name, bone: boneId, attachment: name });
  docStore.update('Create path', (d) => {
    const sel = uiStore.get().selection.slot;
    const idx = sel ? d.skeleton.slots.findIndex((s) => s.id === sel) : -1;
    if (idx >= 0) d.skeleton.slots.splice(idx + 1, 0, slot);
    else d.skeleton.slots.push(slot);
    d.skeleton.skins[0].attachments[slot.id] = { [name]: att };
  });
  setSelection({ slot: slot.id, attachment: name, bones: [boneId] });
  return { slotId: slot.id, name };
}

/** Deform keys have one value per point, so they cannot survive a change of the number of points. */
function dropDeformKeys(d: { skeleton: { animations: Parameters<typeof dropDeformTimeline>[0][] } }, slotId: Id, name: string) {
  for (const a of d.skeleton.animations) for (const skinId of Object.keys(a.deform)) dropDeformTimeline(a, skinId, slotId, name);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Inserts a node on the curve nearest to a world position (the curve shape does not change: the curve is split with de Casteljau).
 * Returns the index of the new node.
 */
export function insertPathNode(slotId: Id, name: string, wx: number, wy: number): number | null {
  const att = getPath(slotId, name);
  if (!att) return null;
  if (att.weights) {
    toast('Nodes cannot be added to a path that is bound to bones', 'error');
    return null;
  }
  const { slotMat } = setupMats();
  const inv = matInvert(slotMat(slotId));
  const lx = inv.a * wx + inv.b * wy + inv.x;
  const ly = inv.c * wx + inv.d * wy + inv.y;
  const v = att.vertices;
  const n = pathNodeCount(att);
  const curves = att.closed ? n : n - 1;
  const point = (i: number, t: number): [number, number] => {
    const j = (i + 1) % n;
    const [x0, y0, x1, y1, x2, y2, x3, y3] = [
      v[(3 * i + 1) * 2],
      v[(3 * i + 1) * 2 + 1],
      v[(3 * i + 2) * 2],
      v[(3 * i + 2) * 2 + 1],
      v[3 * j * 2],
      v[3 * j * 2 + 1],
      v[(3 * j + 1) * 2],
      v[(3 * j + 1) * 2 + 1],
    ];
    const u = 1 - t;
    return [
      u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
      u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
    ];
  };
  const dist = (i: number, t: number) => {
    const [x, y] = point(i, t);
    return (x - lx) ** 2 + (y - ly) ** 2;
  };
  let bestI = -1;
  let bestT = 0;
  let bestD = Infinity;
  const STEPS = 32;
  for (let i = 0; i < curves; i++) {
    for (let s = 0; s <= STEPS; s++) {
      const d = dist(i, s / STEPS);
      if (d < bestD) {
        bestD = d;
        bestI = i;
        bestT = s / STEPS;
      }
    }
  }
  if (bestI < 0) return null;
  // refine around the best sample
  let lo = Math.max(0, bestT - 1 / STEPS);
  let hi = Math.min(1, bestT + 1 / STEPS);
  for (let k = 0; k < 24; k++) {
    const a = lo + (hi - lo) / 3;
    const b = hi - (hi - lo) / 3;
    if (dist(bestI, a) < dist(bestI, b)) hi = b;
    else lo = a;
  }
  const t = Math.min(0.98, Math.max(0.02, (lo + hi) / 2));
  const i = bestI;
  const j = (i + 1) % n;
  docStore.update('Add node', (d) => {
    const p = d.skeleton.skins[0].attachments[slotId]?.[name];
    if (!p || p.type !== 'path' || p.weights) return;
    const vv = p.vertices;
    const g = (k: number) => vv[k];
    const x0 = g((3 * i + 1) * 2),
      y0 = g((3 * i + 1) * 2 + 1),
      x1 = g((3 * i + 2) * 2),
      y1 = g((3 * i + 2) * 2 + 1);
    const x2 = g(3 * j * 2),
      y2 = g(3 * j * 2 + 1),
      x3 = g((3 * j + 1) * 2),
      y3 = g((3 * j + 1) * 2 + 1);
    const ax = lerp(x0, x1, t),
      ay = lerp(y0, y1, t),
      bx = lerp(x1, x2, t),
      by = lerp(y1, y2, t),
      cx = lerp(x2, x3, t),
      cy = lerp(y2, y3, t);
    const dx = lerp(ax, bx, t),
      dy = lerp(ay, by, t),
      ex = lerp(bx, cx, t),
      ey = lerp(by, cy, t);
    const fx = lerp(dx, ex, t),
      fy = lerp(dy, ey, t);
    vv[(3 * i + 2) * 2] = ax;
    vv[(3 * i + 2) * 2 + 1] = ay;
    vv[3 * j * 2] = cx;
    vv[3 * j * 2 + 1] = cy;
    vv.splice(3 * (i + 1) * 2, 0, dx, dy, fx, fy, ex, ey);
    dropDeformKeys(d, slotId, name);
  });
  setSelection({ ...uiStore.get().selection, vertices: [(i + 1) * 3 + 1] });
  return i + 1;
}

/** Removes nodes, keeping at least two. Returns false when nothing was removed. */
export function deletePathNodes(slotId: Id, name: string, nodes: number[]): boolean {
  const att = getPath(slotId, name);
  if (!att) return false;
  const n = pathNodeCount(att);
  const drop = new Set(nodes.filter((i) => i >= 0 && i < n));
  if (!drop.size) return false;
  if (n - drop.size < 2) {
    toast('A path needs at least 2 nodes', 'error');
    return false;
  }
  docStore.update('Delete nodes', (d) => {
    const p = d.skeleton.skins[0].attachments[slotId]?.[name];
    if (!p || p.type !== 'path') return;
    if (p.weights) p.weights = p.weights.filter((_, k) => !drop.has((k / 3) | 0));
    else p.vertices = p.vertices.filter((_, k) => !drop.has(((k >> 1) / 3) | 0));
    dropDeformKeys(d, slotId, name);
  });
  setSelection({ ...uiStore.get().selection, vertices: [] });
  return true;
}

/**
 * Reset (Spine's button on a path): the path goes back to a plain open path of two nodes around the origin of its bone, without
 * weights; the deform keys made for the old points go. One undo step.
 */
export function resetPathShape(slotId: Id, name: string) {
  if (!getPath(slotId, name)) return;
  docStore.update('Reset path', (d) => {
    const p = d.skeleton.skins[0].attachments[slotId]?.[name];
    if (!p || p.type !== 'path') return;
    p.vertices = defaultPathVertices();
    p.weights = null;
    p.closed = false;
    dropDeformKeys(d, slotId, name);
  });
  uiStore.patch({ selection: { ...uiStore.get().selection, vertices: [] } });
}

/** Closes or opens a path. Closing needs real outer handles, so the placeholder ones mirror their neighbours. */
export function setPathClosed(slotId: Id, name: string, closed: boolean) {
  docStore.update(closed ? 'Close path' : 'Open path', (d) => {
    const p = d.skeleton.skins[0].attachments[slotId]?.[name];
    if (!p || p.type !== 'path' || p.closed === closed) return;
    p.closed = closed;
    if (closed && !p.weights) {
      const v = p.vertices;
      const n = pathNodeCount(p);
      v[0] = 2 * v[2] - v[4];
      v[1] = 2 * v[3] - v[5];
      const l = (n - 1) * 6;
      v[l + 4] = 2 * v[l + 2] - v[l];
      v[l + 5] = 2 * v[l + 3] - v[l + 1];
    }
  });
}

/**
 * Binds a path to bones with automatic distance weights, so moving the bones moves the path. The three points of a node share
 * the weights of their anchor, which keeps the curve smooth. Binding again re-weights using the current positions.
 */
export function bindPathToBones(slotId: Id, name: string, boneIds: Id[]) {
  const att = getPath(slotId, name);
  if (!att) return;
  const { mats, slotMat } = setupMats();
  const doc = docStore.get().skeleton;
  const slot = doc.slots.find((s) => s.id === slotId);
  const ids = [...new Set([...(att.weights ? att.weights.flat().map((i) => i[0]) : []), ...boneIds])];
  if (!ids.length && slot) ids.push(slot.bone);
  if (!ids.length) {
    toast('Select the bones to bind to first', 'error');
    return;
  }
  const n = polygonVertexCount(att);
  const world = vertexWorldPositions(att, n, slotMat(slotId), mats);
  const auto = autoWeights(world, boneSegments(ids));
  const inv = new Map<Id, Mat>();
  for (const [id, m] of mats) inv.set(id, matInvert(m));
  const weights: Influence[][] = [];
  for (let i = 0; i < n; i++) {
    const list: Influence[] = [];
    for (const e of auto[Math.min(n - 1, ((i / 3) | 0) * 3 + 1)] ?? []) {
      const im = inv.get(e.bone);
      if (!im) continue;
      const p = matApply(im, world[i * 2], world[i * 2 + 1]);
      list.push([e.bone, p[0], p[1], e.w]);
    }
    weights.push(normalizeInfluences(list));
  }
  docStore.update('Bind path', (d) => {
    const p = d.skeleton.skins[0].attachments[slotId]?.[name];
    if (!p || p.type !== 'path') return;
    p.weights = weights;
    p.vertices = [];
    dropDeformKeys(d, slotId, name);
  });
  toast(`Bound to ${ids.length} bone${ids.length === 1 ? '' : 's'}`, 'ok');
}

/** Back to a plain path in the slot bone's space (the points keep their places). */
export function unbindPath(slotId: Id, name: string) {
  const att = getPath(slotId, name);
  if (!att || !att.weights) return;
  const { mats, slotMat } = setupMats();
  const world = vertexWorldPositions(att, polygonVertexCount(att), slotMat(slotId), mats);
  const inv = matInvert(slotMat(slotId));
  const vertices: number[] = [];
  for (let i = 0; i < world.length / 2; i++) {
    const p = matApply(inv, world[i * 2], world[i * 2 + 1]);
    vertices.push(p[0], p[1]);
  }
  docStore.update('Unbind path', (d) => {
    const p = d.skeleton.skins[0].attachments[slotId]?.[name];
    if (!p || p.type !== 'path') return;
    p.weights = null;
    p.vertices = vertices;
    dropDeformKeys(d, slotId, name);
  });
}
