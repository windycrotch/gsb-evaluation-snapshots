/** Pointer / wheel interaction for the viewport: camera, selection, and the bone/attachment tools. */
import { clamp, distToSegmentSq, wrapAngle } from '@/core/math';
import { turnAbout, turnSign } from '@/core/pivot';
import type { TurnFrame } from '@/core/pivot';
import type { Id } from '@/core/model';
import {
  clearSelection,
  createBoneWorld,
  currentPose,
  deleteBones,
  selectBone,
  selectSlot,
  setAttachmentProps,
  setBonePose,
  setSelection,
} from '@/store/actions';
import { guideAt, snapPoint } from '@/core/snap';
import { docStore } from '@/store/doc';
import { addGuide, moveGuide, removeGuide } from '@/store/guideActions';
import { settingsStore } from '@/store/settings';
import { createIkFromDrag } from '@/store/ikActions';
import { applyParent, cancelSetParent } from '@/store/parentActions';
import { POLYGON_TOOLS, toast, uiStore } from '@/store/ui';
import { flipSign, getScene, getSetupSkeleton, screenToWorld } from '@/store/scene';
import { RULER } from './overlay';
import type { Interaction } from './overlay';
import { hitAttachment, hitBone } from './hit';
import { MeshTool, activeMesh } from './meshTool';
import { PathTool } from './pathTool';
import { PolygonTool } from './polygonTool';

type Mat4 = [number, number, number, number];

type Drag =
  | { kind: 'ik'; bone: Id }
  | { kind: 'mesh' }
  | { kind: 'polygon' }
  | { kind: 'path' }
  | { kind: 'pan'; sx: number; sy: number; camX: number; camY: number }
  | { kind: 'create'; parent: Id | null; ox: number; oy: number }
  | { kind: 'guide'; axis: 'x' | 'y'; index: number }
  | {
      kind: 'rotate';
      ids: Id[];
      cx: Record<Id, [number, number]>;
      a0: Record<Id, number>;
      r0: Record<Id, number>;
      sign: Record<Id, number>;
      pivot?: { x: number; y: number; frames: Record<Id, TurnFrame> };
    }
  | {
      kind: 'translate';
      ids: Id[];
      p0: [number, number];
      w0: [number, number];
      start: Record<Id, { x: number; y: number }>;
      inv: Record<Id, Mat4>;
      axis: 'x' | 'y' | null;
    }
  | {
      kind: 'shear';
      ids: Id[];
      o: Record<Id, [number, number]>;
      ang: Record<Id, number>;
      p0: [number, number];
      start: Record<Id, { shx: number; shy: number }>;
      mode: 'xy' | 'x' | 'y';
    }
  | {
      kind: 'scale';
      ids: Id[];
      o: Record<Id, [number, number]>;
      d0: Record<Id, number>;
      start: Record<Id, { sx: number; sy: number }>;
      mode: 'xy' | 'x' | 'y';
    }
  | { kind: 'attachment'; slotId: Id; name: string; label: string; p0: [number, number]; start: { x: number; y: number }; inv: Mat4 };

const GIZMO_LEN = 54;

export class ViewportController {
  hoverBone: Id | null = null;
  interaction: Interaction | null = null;
  spaceDown = false;
  readonly meshTool: MeshTool;
  readonly polygonTool: PolygonTool;
  readonly pathTool: PathTool;
  private drag: Drag | null = null;
  private pointerId = -1;

  constructor(
    private el: HTMLElement,
    private invalidate: () => void,
  ) {
    this.meshTool = new MeshTool(invalidate);
    this.polygonTool = new PolygonTool(invalidate);
    this.pathTool = new PathTool(invalidate);
  }

  private size(): [number, number] {
    return [this.el.clientWidth, this.el.clientHeight];
  }

  private local(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** A point snapped to the guides and the grid when Snap is on (View menu), else as it is. */
  private snapped(wx: number, wy: number): [number, number] {
    const ui = uiStore.get();
    if (!ui.view.snap && !ui.view.pixel) return [wx, wy];
    const s = snapPoint(wx, wy, {
      zoom: ui.camera.zoom,
      grid: ui.view.snap,
      pixel: ui.view.pixel,
      guides: ui.view.snap ? docStore.get().guides : undefined,
    });
    return [s.x, s.y];
  }

  /** A guide being placed: on the grid when Snap is on. */
  private snappedLine(v: number, axis: 'x' | 'y'): number {
    const ui = uiStore.get();
    if (!ui.view.snap && !ui.view.pixel) return v;
    const s = snapPoint(axis === 'x' ? v : 0, axis === 'y' ? v : 0, { zoom: ui.camera.zoom, grid: ui.view.snap, pixel: ui.view.pixel });
    return axis === 'x' ? s.x : s.y;
  }

  private blocked(): Set<Id> {
    const s = new Set<Id>();
    for (const b of docStore.get().skeleton.bones) if (b.hidden || b.locked) s.add(b.id);
    return s;
  }

  private hiddenSlots(): Set<Id> {
    const s = new Set<Id>();
    for (const sl of docStore.get().skeleton.slots) if (sl.hidden) s.add(sl.id);
    return s;
  }

  onPointerDown = (e: PointerEvent) => {
    if (this.drag) return;
    const ui = uiStore.get();
    const [w, h] = this.size();
    const [sx, sy] = this.local(e);
    const cam = ui.camera;
    this.el.focus({ preventScroll: true });

    // camera pan
    if (e.button === 1 || e.button === 2 || (e.button === 0 && (e.altKey || this.spaceDown))) {
      this.begin(e, { kind: 'pan', sx, sy, camX: cam.x, camY: cam.y });
      this.el.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    const [wx, wy] = screenToWorld(cam, w, h, sx, sy);
    const scene = getScene();
    const blocked = this.blocked();

    // the pivot of the rotate tool is waiting for its point
    if (ui.pivotPick) {
      const [px, py] = this.snapped(wx, wy);
      uiStore.patch({ pivot: { x: px, y: py }, pivotPick: false });
      this.invalidate();
      return;
    }

    // Set Parent is waiting: the next click names the new parent (a click on nothing cancels)
    if (ui.pickParent) {
      const target = hitBone(scene, blocked, wx, wy, cam.zoom, 12);
      if (target) applyParent(target.id);
      else cancelSetParent();
      return;
    }

    // rulers: drag a guide out of the top (a horizontal line) or the left (a vertical line) ruler; drag a guide to move it, back onto a ruler to take it away
    if (ui.view.rulers) {
      const fromTop = sy < RULER && sx >= RULER;
      const fromLeft = sx < RULER && sy >= RULER;
      if (fromTop || fromLeft) {
        const axis = fromTop ? 'y' : 'x';
        this.begin(e, { kind: 'guide', axis, index: -1 });
        this.interaction = { kind: 'guide', axis, index: -1, x0: wx, y0: wy, x1: 0, y1: 0 };
        this.invalidate();
        return;
      }
      if (sx >= RULER && sy >= RULER && !hitBone(scene, blocked, wx, wy, cam.zoom, 9)) {
        const guides = docStore.get().guides;
        const gx = guideAt(guides?.x ?? [], wx, cam.zoom);
        const gy = gx >= 0 ? -1 : guideAt(guides?.y ?? [], wy, cam.zoom);
        if (gx >= 0 || gy >= 0) {
          const axis = gx >= 0 ? 'x' : 'y';
          this.begin(e, { kind: 'guide', axis, index: gx >= 0 ? gx : gy });
          this.interaction = { kind: 'guide', axis, index: gx >= 0 ? gx : gy, x0: wx, y0: wy, x1: 0, y1: 0 };
          this.invalidate();
          return;
        }
      }
    }

    if (this.pathTool.handles() && this.pathTool.pointerDown(e, wx, wy, scene)) {
      if (this.pathTool.dragging) this.begin(e, { kind: 'path' });
      this.invalidate();
      return;
    }

    if (this.polygonTool.handles() && this.polygonTool.pointerDown(e, wx, wy, scene)) {
      if (this.polygonTool.dragging) this.begin(e, { kind: 'polygon' });
      this.invalidate();
      return;
    }

    if ((ui.tool === 'mesh' || ui.tool === 'weights') && activeMesh()) {
      if (this.meshTool.pointerDown(e, wx, wy, scene)) {
        this.begin(e, { kind: 'mesh' });
        this.invalidate();
        return;
      }
    }

    if (ui.tool === 'ik') {
      if (ui.mode !== 'setup') {
        toast('IK constraints are created in Setup mode');
        return;
      }
      const hit = hitBone(scene, blocked, wx, wy, cam.zoom, 10);
      if (!hit) return;
      selectBone(hit.id);
      const b = scene.skeleton.boneById(hit.id)!;
      this.begin(e, { kind: 'ik', bone: hit.id });
      this.interaction = { kind: 'link', x0: b.tipX, y0: b.tipY, x1: wx, y1: wy };
      this.invalidate();
      return;
    }

    if (ui.tool === 'create') {
      if (ui.mode !== 'setup') return;
      const sel = ui.selection.bones[0];
      let ox = wx;
      let oy = wy;
      const parent: Id | null = sel ?? null;
      if (sel) {
        const b = scene.skeleton.boneById(sel);
        if (b) {
          const tipDist = Math.hypot(b.tipX - wx, b.tipY - wy) * cam.zoom;
          if (tipDist < 16) {
            ox = b.tipX;
            oy = b.tipY;
          }
        }
      }
      if (!(sel && parent && Math.hypot(ox - wx, oy - wy) > 1e-9)) [ox, oy] = this.snapped(ox, oy); // (a start on the tip of the parent bone stays there)
      this.begin(e, { kind: 'create', parent, ox, oy });
      const [tx, ty] = this.snapped(wx, wy);
      this.interaction = { kind: 'create', x0: ox, y0: oy, x1: tx, y1: ty };
      this.invalidate();
      return;
    }

    // gizmo axis for translate tool
    let axis: 'x' | 'y' | null = null;
    const selId = ui.selection.bones[0];
    if (ui.tool === 'translate' && selId) {
      const b = scene.skeleton.boneById(selId);
      if (b) {
        const [bx, by] = [b.worldX, b.worldY];
        const L = GIZMO_LEN / cam.zoom;
        if (distToSegmentSq(wx, wy, bx, by, bx + L, by) * cam.zoom * cam.zoom < 64) axis = 'x';
        else if (distToSegmentSq(wx, wy, bx, by, bx, by + L) * cam.zoom * cam.zoom < 64) axis = 'y';
      }
    }

    const hit = axis ? null : hitBone(scene, blocked, wx, wy, cam.zoom, 9);
    if (hit) {
      const sel = uiStore.get().selection;
      if (e.shiftKey) selectBone(hit.id, true);
      else if (!sel.bones.includes(hit.id)) selectBone(hit.id, false);
      if (!uiStore.get().selection.bones.includes(hit.id)) return;
      if (ui.tool === 'mesh' || ui.tool === 'weights') return;
      this.startBoneDrag(e, wx, wy, axis);
      return;
    }

    if (axis) {
      this.startBoneDrag(e, wx, wy, axis);
      return;
    }

    // images
    const ah = hitAttachment(scene, this.hiddenSlots(), wx, wy, cam.zoom, { images: ui.view.images, outlines: ui.view.outlines });
    if (ah) {
      selectSlot(ah.slotId, ah.name);
      if (ui.mode === 'setup' && (ui.tool === 'select' || ui.tool === 'translate')) this.startAttachmentDrag(e, ah.slotId, ah.name, wx, wy);
      return;
    }

    // empty space: tools act on the current selection from anywhere (like Spine), select tool clears it
    if (
      (ui.tool === 'translate' || ui.tool === 'rotate' || ui.tool === 'scale' || ui.tool === 'shear') &&
      uiStore.get().selection.bones.length
    ) {
      this.startBoneDrag(e, wx, wy, null);
      return;
    }
    if (!e.shiftKey) clearSelection();
  };

  private begin(e: PointerEvent, drag: Drag) {
    this.drag = drag;
    this.pointerId = e.pointerId;
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  private startBoneDrag(e: PointerEvent, wx: number, wy: number, axis: 'x' | 'y' | null) {
    const ui = uiStore.get();
    const scene = getScene();
    let ids = ui.selection.bones.filter((id) => scene.skeleton.boneById(id));
    if (!ids.length) return;
    const targets = new Set(scene.data.constraints.flatMap((c) => (c.kind === 'ik' ? [scene.data.bones[c.target].id] : [])));
    let kind: 'rotate' | 'translate' | 'scale' | 'shear' =
      ui.tool === 'rotate'
        ? 'rotate'
        : ui.tool === 'scale'
          ? 'scale'
          : ui.tool === 'shear'
            ? 'shear'
            : ui.tool === 'translate'
              ? 'translate'
              : 'rotate';
    // in the pose (select) tool, IK targets and bones without a parent are moved instead of rotated
    if (ui.tool === 'select') {
      const first = scene.skeleton.boneById(ids[0])!;
      if (targets.has(first.data.id) || !first.parent) kind = 'translate';
    }
    if (ui.mode === 'animate' && ui.autoKey === false) {
      /* overrides handled in setBonePose */
    }
    docStore.beginGesture(kind === 'rotate' ? 'Rotate' : kind === 'scale' ? 'Scale' : kind === 'shear' ? 'Shear' : 'Move');
    if (kind === 'translate') {
      // drop bones whose ancestor is also moving
      const set = new Set(ids);
      ids = ids.filter((id) => {
        let p = scene.skeleton.boneById(id)?.parent;
        while (p) {
          if (set.has(p.data.id)) return false;
          p = p.parent;
        }
        return true;
      });
      const start: Record<Id, { x: number; y: number }> = {};
      const inv: Record<Id, Mat4> = {};
      for (const id of ids) {
        const pose = currentPose(id)!;
        start[id] = { x: pose.x, y: pose.y };
        const b = scene.skeleton.boneById(id)!;
        const p = b.parent;
        if (p) {
          const det = p.a * p.d - p.b * p.c || 1e-9;
          inv[id] = [p.d / det, -p.b / det, -p.c / det, p.a / det];
        } else inv[id] = [1, 0, 0, 1];
      }
      const first = scene.skeleton.boneById(ids[0]);
      this.begin(e, { kind: 'translate', ids, p0: [wx, wy], w0: first ? [first.worldX, first.worldY] : [0, 0], start, inv, axis });
    } else if (kind === 'rotate' && ui.pivot) {
      // turning about a point: the origin of each bone goes round it, so the pose gets both its rotate and its translate. A bone below a bone that turns too goes along with it.
      const set = new Set(ids);
      ids = ids.filter((id) => {
        let p = scene.skeleton.boneById(id)?.parent;
        while (p) {
          if (set.has(p.data.id)) return false;
          p = p.parent;
        }
        return true;
      });
      const frames: Record<Id, TurnFrame> = {};
      const cx: Record<Id, [number, number]> = {};
      const a0: Record<Id, number> = {};
      const r0: Record<Id, number> = {};
      const sign: Record<Id, number> = {};
      for (const id of ids) {
        const live = scene.skeleton.boneById(id)!;
        const p = live.parent;
        const parent = p ? { a: p.a, b: p.b, c: p.c, d: p.d, x: p.worldX, y: p.worldY } : null;
        const pose = currentPose(id)!;
        frames[id] = { x: pose.x, y: pose.y, rotation: pose.rotation, sign: turnSign(parent), parent };
        cx[id] = [ui.pivot.x, ui.pivot.y];
        a0[id] = Math.atan2(wy - ui.pivot.y, wx - ui.pivot.x) * (180 / Math.PI);
        r0[id] = pose.rotation;
        sign[id] = frames[id].sign;
      }
      this.begin(e, { kind: 'rotate', ids, cx, a0, r0, sign, pivot: { x: ui.pivot.x, y: ui.pivot.y, frames } });
    } else if (kind === 'rotate') {
      const cx: Record<Id, [number, number]> = {};
      const a0: Record<Id, number> = {};
      const r0: Record<Id, number> = {};
      const sign: Record<Id, number> = {};
      for (const id of ids) {
        const b = scene.skeleton.boneById(id)!;
        cx[id] = [b.worldX, b.worldY];
        a0[id] = Math.atan2(wy - b.worldY, wx - b.worldX) * (180 / Math.PI);
        r0[id] = currentPose(id)!.rotation;
        const p = b.parent;
        sign[id] = p && p.a * p.d - p.b * p.c < 0 ? -1 : 1;
      }
      this.begin(e, { kind: 'rotate', ids, cx, a0, r0, sign });
    } else if (kind === 'shear') {
      const o: Record<Id, [number, number]> = {};
      const ang: Record<Id, number> = {};
      const start: Record<Id, { shx: number; shy: number }> = {};
      for (const id of ids) {
        const b = scene.skeleton.boneById(id)!;
        o[id] = [b.worldX, b.worldY];
        ang[id] = Math.atan2(b.c, b.a); // the world direction of the bone's x axis
        const pose = currentPose(id)!;
        start[id] = { shx: pose.shearX, shy: pose.shearY };
      }
      this.begin(e, { kind: 'shear', ids, o, ang, p0: [wx, wy], start, mode: e.shiftKey ? 'x' : e.altKey ? 'y' : 'xy' });
    } else {
      const o: Record<Id, [number, number]> = {};
      const d0: Record<Id, number> = {};
      const start: Record<Id, { sx: number; sy: number }> = {};
      for (const id of ids) {
        const b = scene.skeleton.boneById(id)!;
        o[id] = [b.worldX, b.worldY];
        d0[id] = Math.max(1e-3, Math.hypot(wx - b.worldX, wy - b.worldY));
        const pose = currentPose(id)!;
        start[id] = { sx: pose.scaleX, sy: pose.scaleY };
      }
      this.begin(e, { kind: 'scale', ids, o, d0, start, mode: e.shiftKey ? 'x' : e.altKey ? 'y' : 'xy' });
    }
  }

  private startAttachmentDrag(e: PointerEvent, slotId: Id, name: string, wx: number, wy: number) {
    const doc = docStore.get().skeleton;
    const att = doc.skins[0].attachments[slotId]?.[name];
    const slot = doc.slots.find((s) => s.id === slotId);
    if (!att || (att.type !== 'region' && att.type !== 'point') || !slot) return;
    const setup = getSetupSkeleton();
    const b = setup.boneById(slot.bone);
    if (!b) return;
    const det = b.a * b.d - b.b * b.c || 1e-9;
    const label = att.type === 'point' ? 'Move point' : 'Move image';
    docStore.beginGesture(label);
    this.begin(e, {
      kind: 'attachment',
      slotId,
      name,
      label,
      p0: [wx, wy],
      start: { x: att.x, y: att.y },
      inv: [b.d / det, -b.b / det, -b.c / det, b.a / det],
    });
  }

  onPointerMove = (e: PointerEvent) => {
    const ui = uiStore.get();
    const [w, h] = this.size();
    const [sx, sy] = this.local(e);
    const cam = ui.camera;
    const d = this.drag;
    if (!d) {
      const [wx, wy] = screenToWorld(cam, w, h, sx, sy);
      if (this.pathTool.handles() && this.pathTool.pointerMove(e, wx, wy, getScene())) {
        this.el.style.cursor = ui.tool === 'path' ? 'crosshair' : this.pathTool.hoverPoint >= 0 ? 'pointer' : 'default';
        return;
      }
      if (this.polygonTool.handles() && this.polygonTool.pointerMove(e, wx, wy, getScene())) {
        this.el.style.cursor = POLYGON_TOOLS.includes(ui.tool) ? 'crosshair' : this.polygonTool.hoverVertex >= 0 ? 'pointer' : 'default';
        return;
      }
      if ((ui.tool === 'mesh' || ui.tool === 'weights') && activeMesh()) {
        this.meshTool.pointerMove(e, wx, wy, getScene());
        this.el.style.cursor = ui.tool === 'weights' ? 'none' : this.meshTool.hoverVertex >= 0 ? 'pointer' : 'default';
        return;
      }
      const hit = hitBone(getScene(), this.blocked(), wx, wy, cam.zoom, 9);
      const id = hit?.id ?? null;
      if (id !== this.hoverBone) {
        this.hoverBone = id;
        this.invalidate();
      }
      this.el.style.cursor = this.spaceDown ? 'grab' : ui.tool === 'create' || ui.pivotPick ? 'crosshair' : id ? 'pointer' : 'default';
      return;
    }
    if (e.pointerId !== this.pointerId) return;
    const [wx, wy] = screenToWorld(cam, w, h, sx, sy);

    switch (d.kind) {
      case 'mesh':
        this.meshTool.pointerMove(e, wx, wy, getScene());
        break;
      case 'polygon':
        this.polygonTool.pointerMove(e, wx, wy, getScene());
        break;
      case 'path':
        this.pathTool.pointerMove(e, wx, wy, getScene());
        break;
      case 'ik': {
        const b = getScene().skeleton.boneById(d.bone);
        if (b) this.interaction = { kind: 'link', x0: b.tipX, y0: b.tipY, x1: wx, y1: wy };
        this.invalidate();
        break;
      }
      case 'pan':
        uiStore.patch({ camera: { ...cam, x: d.camX - (flipSign(cam) * (sx - d.sx)) / cam.zoom, y: d.camY + (sy - d.sy) / cam.zoom } });
        break;
      case 'guide': {
        const v = this.snappedLine(d.axis === 'x' ? wx : wy, d.axis);
        this.interaction = {
          kind: 'guide',
          axis: d.axis,
          index: d.index,
          x0: d.axis === 'x' ? v : 0,
          y0: d.axis === 'y' ? v : 0,
          x1: 0,
          y1: 0,
        };
        this.invalidate();
        break;
      }
      case 'create': {
        const [tx, ty] = this.snapped(wx, wy);
        this.interaction = { kind: 'create', x0: d.ox, y0: d.oy, x1: tx, y1: ty };
        this.invalidate();
        break;
      }
      case 'rotate': {
        const updates = d.ids.map((id) => {
          const [cx, cy] = d.cx[id];
          const a = Math.atan2(wy - cy, wx - cx) * (180 / Math.PI);
          if (d.pivot) return { id, props: turnAbout(d.pivot.frames[id], d.pivot.x, d.pivot.y, wrapAngle(a - d.a0[id])) };
          return { id, props: { rotation: d.r0[id] + d.sign[id] * wrapAngle(a - d.a0[id]) } };
        });
        setBonePose(updates, 'Rotate');
        break;
      }
      case 'translate': {
        let dx = wx - d.p0[0];
        let dy = wy - d.p0[1];
        if (d.axis === 'x') dy = 0;
        if (d.axis === 'y') dx = 0;
        if (uiStore.get().view.snap || uiStore.get().view.pixel) {
          // the first bone lands on the grid or a guide; the others move by the same step
          const [tx, ty] = this.snapped(d.w0[0] + dx, d.w0[1] + dy);
          if (d.axis !== 'y') dx = tx - d.w0[0];
          if (d.axis !== 'x') dy = ty - d.w0[1];
        }
        const updates = d.ids.map((id) => {
          const m = d.inv[id];
          return { id, props: { x: d.start[id].x + m[0] * dx + m[1] * dy, y: d.start[id].y + m[2] * dx + m[3] * dy } };
        });
        setBonePose(updates, 'Move');
        break;
      }
      case 'shear': {
        // the mouse moves in the bone's own frame: across the bone tilts its x axis (shear X), along it tilts the y axis (shear Y)
        const lever = 70 / uiStore.get().camera.zoom;
        const updates = d.ids.map((id) => {
          const c = Math.cos(d.ang[id]);
          const s = Math.sin(d.ang[id]);
          const dx = wx - d.p0[0];
          const dy = wy - d.p0[1];
          const along = dx * c + dy * s;
          const across = -dx * s + dy * c;
          const props: { shearX?: number; shearY?: number } = {};
          if (d.mode !== 'y') props.shearX = d.start[id].shx + Math.atan2(across, lever) * (180 / Math.PI);
          if (d.mode !== 'x') props.shearY = d.start[id].shy - Math.atan2(along, lever) * (180 / Math.PI);
          return { id, props };
        });
        setBonePose(updates, 'Shear');
        break;
      }
      case 'scale': {
        const updates = d.ids.map((id) => {
          const [cx, cy] = d.o[id];
          const f = clamp(Math.hypot(wx - cx, wy - cy) / d.d0[id], 0.02, 50);
          return {
            id,
            props: {
              scaleX: d.mode === 'y' ? d.start[id].sx : d.start[id].sx * f,
              scaleY: d.mode === 'x' ? d.start[id].sy : d.start[id].sy * f,
            },
          };
        });
        setBonePose(updates, 'Scale');
        break;
      }
      case 'attachment': {
        const dx = wx - d.p0[0];
        const dy = wy - d.p0[1];
        setAttachmentProps(
          d.slotId,
          d.name,
          { x: d.start.x + d.inv[0] * dx + d.inv[1] * dy, y: d.start.y + d.inv[2] * dx + d.inv[3] * dy },
          d.label,
        );
        break;
      }
    }
  };

  onPointerUp = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== this.pointerId) return;
    const ui = uiStore.get();
    const [w, h] = this.size();
    const [sx, sy] = this.local(e);
    if (d.kind === 'mesh') this.meshTool.pointerUp();
    if (d.kind === 'path') {
      this.pathTool.pointerUp();
      this.drag = null;
      try {
        this.el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      this.invalidate();
      return;
    }
    if (d.kind === 'polygon') {
      this.polygonTool.pointerUp();
      this.drag = null;
      try {
        this.el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      this.invalidate();
      return;
    }
    if (d.kind === 'ik') {
      const [wx, wy] = screenToWorld(ui.camera, w, h, sx, sy);
      const scene = getScene();
      const hit = hitBone(scene, this.blocked(), wx, wy, ui.camera.zoom, 12);
      const target = hit && hit.id !== d.bone ? hit.id : null;
      this.interaction = null;
      const end = scene.skeleton.boneById(d.bone);
      const moved = end ? Math.hypot(wx - end.tipX, wy - end.tipY) * ui.camera.zoom : 0;
      if (target || moved > 14) createIkFromDrag(d.bone, target, wx, wy, e.shiftKey);
    }
    if (d.kind === 'guide') {
      const [gx, gy] = screenToWorld(ui.camera, w, h, sx, sy);
      // dropped back on its ruler it goes away (a new one is never made)
      const onRuler = d.axis === 'y' ? sy < RULER : sx < RULER;
      const v = this.snappedLine(d.axis === 'x' ? gx : gy, d.axis);
      if (d.index >= 0 && onRuler) removeGuide(d.axis, d.index);
      else if (!onRuler) {
        if (d.index >= 0) moveGuide(d.axis, d.index, v);
        else addGuide(d.axis, v);
      }
      this.interaction = null;
    }
    if (d.kind === 'create') {
      const [rawX, rawY] = screenToWorld(ui.camera, w, h, sx, sy);
      const [wx, wy] = this.snapped(rawX, rawY);
      if (Math.hypot(wx - d.ox, wy - d.oy) * ui.camera.zoom >= 8) {
        const id = createBoneWorld({ parent: d.parent, x: d.ox, y: d.oy, tipX: wx, tipY: wy });
        if (id) setSelection({ bones: [id] });
      } else toast('Drag to set the bone length');
      this.interaction = null;
    }
    docStore.endGesture();
    this.drag = null;
    try {
      this.el.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.el.style.cursor = this.spaceDown ? 'grab' : 'default';
    this.invalidate();
  };

  onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const ui = uiStore.get();
    const cam = ui.camera;
    const [w, h] = this.size();
    const [sx, sy] = this.local(e);
    if (e.shiftKey && !e.ctrlKey) {
      uiStore.patch({ camera: { ...cam, x: cam.x + (flipSign(cam) * (e.deltaY + e.deltaX)) / cam.zoom } });
      return;
    }
    const [px, py] = settingsStore.get().zoomToMouse ? [sx, sy] : [w / 2, h / 2];
    const [wx, wy] = screenToWorld(cam, w, h, px, py);
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016));
    const zoom = clamp(cam.zoom * f, 0.02, 80);
    uiStore.patch({ camera: { ...cam, zoom, x: wx - (flipSign(cam) * (px - w / 2)) / zoom, y: wy - (h / 2 - py) / zoom } });
  };

  onContextMenu = (e: Event) => e.preventDefault();

  deleteSelection() {
    const sel = uiStore.get().selection;
    if (sel.bones.length) deleteBones(sel.bones);
  }

  attach() {
    const el = this.el;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', this.onContextMenu);
  }

  detach() {
    const el = this.el;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointercancel', this.onPointerUp);
    el.removeEventListener('wheel', this.onWheel);
    el.removeEventListener('contextmenu', this.onContextMenu);
  }
}
