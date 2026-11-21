/**
 * Viewport behaviour for path attachments: drawing a path with the Path tool (click = node, drag = handles) and editing nodes and
 * handles with the mesh tool. In Animate mode dragging deforms (keys) the path instead of changing the setup pose.
 */
import { distToSegmentSq } from '@/core/math';
import type { Id } from '@/core/model';
import { samplePath } from '@/core/path';
import { meshWorldVertices } from '@/core/skeleton';
import type { PathAttachmentData } from '@/core/skeleton';
import { setSelection } from '@/store/actions';
import { docStore } from '@/store/doc';
import { currentDeform, setDeformKey } from '@/store/meshActions';
import { createPath, deletePathNodes, getPath, insertPathNode } from '@/store/pathActions';
import type { PathNodeDraft } from '@/store/pathActions';
import { movePolygonVertices } from '@/store/polygonActions';
import { toast, uiStore } from '@/store/ui';
import { getScene, worldToScreen } from '@/store/scene';
import type { Scene } from '@/store/scene';
import { dragMarquee, drawMarquee, startMarquee } from './marquee';
import type { Marquee } from './marquee';
import { COLORS } from './overlay';
import type { OverlayInput } from './overlay';
import { alpha, token } from '../ui/tokens';

interface ActivePath {
  slotId: Id;
  name: string;
}

/** The selected attachment when it is a path. */
function activePath(): ActivePath | null {
  const sel = uiStore.get().selection;
  if (!sel.slot || !sel.attachment) return null;
  return getPath(sel.slot, sel.attachment) ? { slotId: sel.slot, name: sel.attachment } : null;
}

interface Draft {
  nodes: PathNodeDraft[];
  cursor: [number, number];
}

type Drag =
  | { kind: 'draftHandle' }
  | { kind: 'points'; moves: Map<number, { x: number; y: number; s: number }>; p0: [number, number]; base: number[] | null }
  | Marquee;

const rgba = (c: ArrayLike<number>, a: number) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

/** World positions of every point of the path that `slotId` shows now (deformation and bones included). */
function worldPoints(scene: Scene, slotId: Id): { pts: number[]; att: PathAttachmentData } | null {
  const skel = scene.skeleton;
  const slot = skel.slotById(slotId);
  if (!slot) return null;
  const att = skel.slotAttachment(slot);
  if (!att || att.kind !== 'path') return null;
  const pts: number[] = [];
  meshWorldVertices(skel, slot, att, slot.deform.length ? slot.deform : null, pts);
  return { pts, att };
}

/** Point indices a user can grab: every anchor and handle, except the two placeholder handles at the ends of an open path. */
function grabbable(att: PathAttachmentData): number[] {
  const n = Math.floor(att.vertexCount / 3);
  const out: number[] = [];
  for (let p = 0; p < n * 3; p++) {
    if (!att.closed && (p === 0 || p === n * 3 - 1)) continue;
    out.push(p);
  }
  return out;
}

export class PathTool {
  /** The path being drawn with the Path tool (nothing is in the document until it is committed). */
  draft: Draft | null = null;
  hoverPoint = -1;
  private drag: Drag | null = null;

  constructor(private invalidate: () => void) {}

  get dragging() {
    return this.drag !== null;
  }

  /** Is this tool in charge of pointer events right now? */
  handles(): boolean {
    const ui = uiStore.get();
    if (ui.tool !== 'path') this.draft = null; // an unfinished path is dropped when another tool is picked
    return ui.tool === 'path' || (ui.tool === 'mesh' && activePath() !== null);
  }

  private draftDown(e: PointerEvent, wx: number, wy: number): boolean {
    const ui = uiStore.get();
    if (ui.mode !== 'setup') {
      toast('Paths are created in Setup mode');
      return true;
    }
    const d = (this.draft ??= { nodes: [], cursor: [wx, wy] });
    const first = d.nodes[0];
    if (d.nodes.length >= 3 && first && Math.hypot(first.x - wx, first.y - wy) * ui.camera.zoom < 10) {
      this.commit(true);
      return true;
    }
    if (e.detail >= 2 && d.nodes.length >= 2) {
      this.commit(false);
      return true;
    }
    d.nodes.push({ x: wx, y: wy, inX: wx, inY: wy, outX: wx, outY: wy });
    d.cursor = [wx, wy];
    this.drag = { kind: 'draftHandle' };
    this.invalidate();
    return true;
  }

  /** Turns the draft into a path (Enter / double click / click on the first node). */
  commit(closed = false): boolean {
    const d = this.draft;
    if (!d) return false;
    if (d.nodes.length < 2) {
      toast('A path needs at least 2 nodes');
      return true;
    }
    this.draft = null;
    if (createPath(d.nodes, closed)) uiStore.patch({ tool: 'mesh' }); // fine-tune the nodes right away
    this.invalidate();
    return true;
  }

  cancel(): boolean {
    if (!this.draft) return false;
    this.draft = null;
    this.invalidate();
    return true;
  }

  private hitPoint(pts: number[], att: PathAttachmentData, wx: number, wy: number, zoom: number): number {
    const tolAnchor = (9 / zoom) ** 2;
    const tolHandle = (8 / zoom) ** 2;
    let best = -1;
    let bd = Infinity;
    for (const p of grabbable(att)) {
      const d = (pts[p * 2] - wx) ** 2 + (pts[p * 2 + 1] - wy) ** 2;
      const lim = p % 3 === 1 ? tolAnchor : tolHandle;
      // anchors win ties against handles that sit on top of them
      const score = p % 3 === 1 ? d - lim * 0.5 : d;
      if (d <= lim && score < bd) {
        bd = score;
        best = p;
      }
    }
    return best;
  }

  private nearCurve(pts: number[], att: PathAttachmentData, wx: number, wy: number, zoom: number): boolean {
    const poly = samplePath(pts, Math.floor(att.vertexCount / 3), att.closed, 24);
    const tol = (9 / zoom) ** 2;
    for (let i = 0; i + 3 < poly.length; i += 2)
      if (distToSegmentSq(wx, wy, poly[i], poly[i + 1], poly[i + 2], poly[i + 3]) <= tol) return true;
    return false;
  }

  pointerDown(e: PointerEvent, wx: number, wy: number, scene: Scene): boolean {
    const ui = uiStore.get();
    if (ui.tool === 'path') return this.draftDown(e, wx, wy);
    const ap = activePath();
    if (!ap) return false;
    const geo = worldPoints(scene, ap.slotId);
    if (!geo) return false;
    const hit = this.hitPoint(geo.pts, geo.att, wx, wy, ui.camera.zoom);
    if (hit >= 0) {
      const cur = ui.selection.vertices;
      let vertices: number[];
      if (e.shiftKey) vertices = cur.includes(hit) ? cur.filter((v) => v !== hit) : [...cur, hit];
      else vertices = cur.includes(hit) ? cur : [hit];
      setSelection({ ...ui.selection, vertices });
      if (!vertices.includes(hit)) return true;
      if (ui.mode === 'animate' && !scene.animation) {
        toast('Create an animation first');
        return true;
      }
      // moving an anchor takes its handles along; Alt on a handle mirrors the opposite one
      const moves = new Map<number, { x: number; y: number; s: number }>();
      const add = (p: number, s: number) => {
        if (!moves.has(p) && p >= 0 && p < geo.att.vertexCount) moves.set(p, { x: geo.pts[p * 2], y: geo.pts[p * 2 + 1], s });
      };
      for (const p of vertices) {
        add(p, 1);
        if (p % 3 === 1) {
          add(p - 1, 1);
          add(p + 1, 1);
        } else if (e.altKey) add(p % 3 === 0 ? p + 2 : p - 2, -1);
      }
      docStore.beginGesture(ui.mode === 'animate' ? 'Deform path' : 'Move nodes');
      this.drag = { kind: 'points', moves, p0: [wx, wy], base: ui.mode === 'animate' ? currentDeform(ap.slotId) : null };
      return true;
    }
    if ((e.ctrlKey || e.metaKey || e.detail >= 2) && this.nearCurve(geo.pts, geo.att, wx, wy, ui.camera.zoom)) {
      if (ui.mode !== 'setup') toast('Nodes are added in Setup mode');
      else insertPathNode(ap.slotId, ap.name, wx, wy);
      return true;
    }
    if (!e.shiftKey) setSelection({ ...ui.selection, vertices: [] });
    this.drag = startMarquee(wx, wy, e.shiftKey ? ui.selection.vertices : []);
    return true;
  }

  pointerMove(_e: PointerEvent, wx: number, wy: number, scene: Scene): boolean {
    const ui = uiStore.get();
    const d = this.drag;
    if (ui.tool === 'path') {
      if (d?.kind === 'draftHandle' && this.draft) {
        const n = this.draft.nodes[this.draft.nodes.length - 1];
        if (Math.hypot(wx - n.x, wy - n.y) * ui.camera.zoom < 4) {
          n.outX = n.inX = n.x;
          n.outY = n.inY = n.y;
        } else {
          n.outX = wx;
          n.outY = wy;
          n.inX = 2 * n.x - wx;
          n.inY = 2 * n.y - wy;
        }
        this.invalidate();
        return true;
      }
      if (this.draft) {
        this.draft.cursor = [wx, wy];
        this.invalidate();
      }
      return true;
    }
    const ap = activePath();
    if (!ap) return false;
    const geo = worldPoints(scene, ap.slotId);
    if (!geo) return false;
    if (!d) {
      const h = this.hitPoint(geo.pts, geo.att, wx, wy, ui.camera.zoom);
      if (h !== this.hoverPoint) {
        this.hoverPoint = h;
        this.invalidate();
      }
      return true;
    }
    if (d.kind === 'points') {
      const dx = wx - d.p0[0];
      const dy = wy - d.p0[1];
      if (!d.base)
        movePolygonVertices(
          ap.slotId,
          ap.name,
          [...d.moves].map(([index, m]) => ({ index, x: m.x + dx * m.s, y: m.y + dy * m.s })),
        );
      else
        setDeformKey(
          ap.slotId,
          ap.name,
          d.base,
          [...d.moves].map(([index, m]) => ({ index, dx: dx * m.s, dy: dy * m.s })),
        );
    } else if (d.kind === 'marquee') {
      const [x0, y0, x1, y1] = dragMarquee(d, wx, wy);
      const picked = new Set(d.base);
      for (const p of grabbable(geo.att)) {
        const x = geo.pts[p * 2];
        const y = geo.pts[p * 2 + 1];
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) picked.add(p);
      }
      setSelection({ ...ui.selection, vertices: [...picked] });
      this.invalidate();
    }
    return true;
  }

  pointerUp(): boolean {
    if (!this.drag) return false;
    if (this.drag.kind === 'points') docStore.endGesture();
    this.drag = null;
    this.invalidate();
    return true;
  }

  /**
   * Delete key with a path selected: selected nodes are removed; a selected handle is pulled back onto its anchor.
   * Returns true when the key was handled.
   */
  deleteSelectedVertices(): boolean {
    const ap = activePath();
    const sel = uiStore.get().selection;
    if (!ap || !sel.vertices.length) return false;
    if (uiStore.get().mode !== 'setup') {
      toast('Nodes can only be removed in Setup mode');
      return true;
    }
    const anchors = sel.vertices.filter((p) => p % 3 === 1).map((p) => (p / 3) | 0);
    if (anchors.length) {
      deletePathNodes(ap.slotId, ap.name, anchors);
      return true;
    }
    const geo = worldPoints(getScene(), ap.slotId);
    if (!geo) return true;
    movePolygonVertices(
      ap.slotId,
      ap.name,
      sel.vertices.map((p) => {
        const anchor = p - (p % 3) + 1;
        return { index: p, x: geo.pts[anchor * 2], y: geo.pts[anchor * 2 + 1] };
      }),
    );
    return true;
  }

  /** Every visible path of the current pose, the handles of the selected one, and the path being drawn. Under the bones. */
  drawUnder = (o: OverlayInput) => {
    const { ctx, w, h, cam, scene, ui } = o;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (ui.view.outlines) {
      const skel = scene.skeleton;
      const editing = ui.tool === 'mesh';
      for (const slot of skel.drawOrder) {
        if (o.hiddenSlots.has(slot.data.id)) continue;
        const att = skel.slotAttachment(slot);
        if (!att || att.kind !== 'path') continue;
        const selected = ui.selection.slot === slot.data.id && ui.selection.attachment === att.name;
        const geo = worldPoints(scene, slot.data.id);
        if (!geo) continue;
        const n = Math.floor(att.vertexCount / 3);
        const poly = samplePath(geo.pts, n, att.closed, 20);
        ctx.beginPath();
        for (let i = 0; i + 1 < poly.length; i += 2) {
          const [x, y] = worldToScreen(cam, w, h, poly[i], poly[i + 1]);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        if (att.closed) ctx.closePath();
        ctx.strokeStyle = selected ? COLORS.accent : rgba(att.color, 0.95);
        ctx.lineWidth = selected ? 2.4 : 1.8;
        ctx.stroke();
        // the start of the path (where positions are counted from)
        if (geo.pts.length >= 4) {
          const [sx, sy] = worldToScreen(cam, w, h, geo.pts[2], geo.pts[3]);
          ctx.fillStyle = selected ? COLORS.accent : rgba(att.color, 0.95);
          ctx.beginPath();
          ctx.arc(sx, sy, selected ? 6 : 4.5, 0, Math.PI * 2);
          ctx.fill();
        }
        if (!(selected && editing)) continue;
        const sel = new Set(ui.selection.vertices);
        const screen = (p: number) => worldToScreen(cam, w, h, geo.pts[p * 2], geo.pts[p * 2 + 1]);
        const grab = new Set(grabbable(att));
        ctx.lineWidth = 1;
        ctx.strokeStyle = alpha('--text', 0.55);
        ctx.beginPath();
        for (let k = 0; k < n; k++) {
          for (const hp of [k * 3, k * 3 + 2]) {
            if (!grab.has(hp)) continue;
            const [ax, ay] = screen(k * 3 + 1);
            const [hx, hy] = screen(hp);
            ctx.moveTo(ax, ay);
            ctx.lineTo(hx, hy);
          }
        }
        ctx.stroke();
        for (const p of grab) {
          const [x, y] = screen(p);
          const on = sel.has(p);
          const hov = p === this.hoverPoint;
          ctx.fillStyle = on ? COLORS.accent : hov ? token('--handle-hover') : p % 3 === 1 ? token('--text') : token('--handle-tangent');
          ctx.strokeStyle = token('--handle-outline');
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          if (p % 3 === 1) {
            const r = on || hov ? 5.5 : 4.5;
            ctx.rect(x - r, y - r, r * 2, r * 2);
          } else ctx.arc(x, y, on || hov ? 4.5 : 3.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
    this.drawDraft(o);
    const d = this.drag;
    if (d?.kind === 'marquee') drawMarquee(ctx, cam, w, h, d);
    ctx.restore();
  };

  private drawDraft(o: OverlayInput) {
    const d = this.draft;
    if (!d || o.ui.tool !== 'path') return;
    const { ctx, w, h, cam } = o;
    const s = (x: number, y: number) => worldToScreen(cam, w, h, x, y);
    const color = alpha('--kind-path', 0.95);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    d.nodes.forEach((n, i) => {
      if (i === 0) {
        const [x, y] = s(n.x, n.y);
        ctx.moveTo(x, y);
        return;
      }
      const p = d.nodes[i - 1];
      const [c1x, c1y] = s(p.outX, p.outY);
      const [c2x, c2y] = s(n.inX, n.inY);
      const [x, y] = s(n.x, n.y);
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, x, y);
    });
    ctx.stroke();
    const last = d.nodes[d.nodes.length - 1];
    if (last) {
      // the segment the next click would add
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      const [lx, ly] = s(last.x, last.y);
      const [c1x, c1y] = s(last.outX, last.outY);
      const [cx, cy] = s(d.cursor[0], d.cursor[1]);
      ctx.moveTo(lx, ly);
      ctx.bezierCurveTo(c1x, c1y, cx, cy, cx, cy);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const [i, n] of d.nodes.entries()) {
      const [x, y] = s(n.x, n.y);
      const [curX, curY] = s(d.cursor[0], d.cursor[1]);
      const closable = i === 0 && d.nodes.length >= 3 && Math.hypot(curX - x, curY - y) < 10;
      for (const [hx, hy] of [s(n.inX, n.inY), s(n.outX, n.outY)]) {
        if (Math.hypot(hx - x, hy - y) < 1) continue;
        ctx.strokeStyle = alpha('--text', 0.55);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(hx, hy);
        ctx.stroke();
        ctx.fillStyle = token('--handle-tangent');
        ctx.beginPath();
        ctx.arc(hx, hy, 3.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = closable ? token('--handle-hover') : color;
      ctx.strokeStyle = token('--handle-outline');
      ctx.lineWidth = 1.2;
      const r = closable ? 6 : 4;
      ctx.beginPath();
      ctx.rect(x - r, y - r, r * 2, r * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}
