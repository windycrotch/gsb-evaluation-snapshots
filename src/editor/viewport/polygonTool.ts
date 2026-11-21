/** Viewport behaviour for clipping polygons, bounding boxes and point attachments: creating them and editing polygon vertices. */
import { softMoves, softWeights } from '@/core/soft';
import { meshWorldVertices, pointWorld } from '@/core/skeleton';
import type { Id, PolygonAttachment } from '@/core/model';
import { setSelection } from '@/store/actions';
import { docStore } from '@/store/doc';
import {
  addPolygonVertex,
  createPoint,
  createPolygon,
  deletePolygonVertices,
  getPolygon,
  movePolygonVertices,
} from '@/store/polygonActions';
import type { PolygonKind } from '@/store/polygonActions';
import { POLYGON_TOOLS, toast, uiStore } from '@/store/ui';
import { worldToScreen } from '@/store/scene';
import type { Scene } from '@/store/scene';
import { slotWorldVertices } from './hit';
import { dragMarquee, drawMarquee, hitVertex, startMarquee } from './marquee';
import type { Marquee } from './marquee';
import { COLORS } from './overlay';
import type { OverlayInput } from './overlay';
import { alpha, token } from '../ui/tokens';

interface ActivePolygon {
  slotId: Id;
  name: string;
  att: PolygonAttachment;
}

/** The selected attachment when it is a clipping polygon or a bounding box. */
function activePolygon(): ActivePolygon | null {
  const sel = uiStore.get().selection;
  if (!sel.slot || !sel.attachment) return null;
  const att = getPolygon(sel.slot, sel.attachment);
  return att ? { slotId: sel.slot, name: sel.attachment, att } : null;
}

interface Draft {
  kind: PolygonKind;
  points: [number, number][];
  cursor: [number, number];
}

type Drag = { kind: 'vertices'; start: Float32Array; weights: Map<number, number>; p0: [number, number] } | Marquee;

const rgba = (c: ArrayLike<number>, a: number) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

export class PolygonTool {
  /** The polygon being drawn with a creation tool (nothing is in the document until it is committed). */
  draft: Draft | null = null;
  hoverVertex = -1;
  private drag: Drag | null = null;

  constructor(private invalidate: () => void) {}

  get dragging() {
    return this.drag !== null;
  }

  /** Is this tool in charge of pointer events right now? */
  handles(): boolean {
    const ui = uiStore.get();
    if (!POLYGON_TOOLS.includes(ui.tool)) this.draft = null; // an unfinished polygon is dropped when another tool is picked
    return POLYGON_TOOLS.includes(ui.tool) || (ui.tool === 'mesh' && activePolygon() !== null);
  }

  private draftClick(e: PointerEvent, wx: number, wy: number, kind: PolygonKind): boolean {
    const ui = uiStore.get();
    if (ui.mode !== 'setup') {
      toast('Attachments are created in Setup mode');
      return true;
    }
    const d = (this.draft ??= { kind, points: [], cursor: [wx, wy] });
    d.kind = kind;
    const first = d.points[0];
    const closing = d.points.length >= 3 && !!first && Math.hypot(first[0] - wx, first[1] - wy) * ui.camera.zoom < 10;
    if (closing || (e.detail >= 2 && d.points.length >= 3)) {
      this.commit();
      return true;
    }
    d.points.push([wx, wy]);
    d.cursor = [wx, wy];
    this.invalidate();
    return true;
  }

  /** Turns the draft into an attachment (Enter / double click / click on the first point). */
  commit(): boolean {
    const d = this.draft;
    if (!d) return false;
    if (d.points.length < 3) {
      toast('A polygon needs at least 3 points');
      return true;
    }
    this.draft = null;
    if (createPolygon(d.kind, d.points)) uiStore.patch({ tool: 'mesh' }); // fine-tune the vertices right away
    this.invalidate();
    return true;
  }

  cancel(): boolean {
    if (!this.draft) return false;
    this.draft = null;
    this.invalidate();
    return true;
  }

  pointerDown(e: PointerEvent, wx: number, wy: number, scene: Scene): boolean {
    const ui = uiStore.get();
    if (ui.tool === 'point') {
      if (ui.mode !== 'setup') {
        toast('Attachments are created in Setup mode');
        return true;
      }
      if (createPoint(wx, wy)) uiStore.patch({ tool: 'select' });
      return true;
    }
    if (ui.tool === 'clipping' || ui.tool === 'boundingbox') return this.draftClick(e, wx, wy, ui.tool);

    const ap = activePolygon();
    if (!ap) return false;
    if (ui.mode !== 'setup') {
      toast('Polygons are edited in Setup mode');
      return true;
    }
    const geo = slotWorldVertices(scene.skeleton, ap.slotId);
    if (!geo) return false;
    const hit = hitVertex(geo.vertices, geo.count, wx, wy, ui.camera.zoom);
    if (hit >= 0) {
      const cur = ui.selection.vertices;
      let vertices: number[];
      if (e.shiftKey) vertices = cur.includes(hit) ? cur.filter((v) => v !== hit) : [...cur, hit];
      else vertices = cur.includes(hit) ? cur : [hit];
      setSelection({ ...ui.selection, vertices });
      if (!vertices.includes(hit)) return true;
      const start = geo.vertices.slice(0, geo.count * 2);
      const weights = softWeights(start, vertices, ui.meshView.soft ? ui.meshView.softRadius : 0, ui.meshView.softShape);
      docStore.beginGesture('Move vertices');
      this.drag = { kind: 'vertices', start, weights, p0: [wx, wy] };
      return true;
    }
    if (e.ctrlKey || e.metaKey || e.detail >= 2) {
      const at = addPolygonVertex(ap.slotId, ap.name, wx, wy);
      if (at !== null) setSelection({ ...uiStore.get().selection, vertices: [at] });
      return true;
    }
    if (!e.shiftKey) setSelection({ ...ui.selection, vertices: [] });
    this.drag = startMarquee(wx, wy, e.shiftKey ? ui.selection.vertices : []);
    return true;
  }

  pointerMove(_e: PointerEvent, wx: number, wy: number, scene: Scene): boolean {
    const ui = uiStore.get();
    if (this.draft && (ui.tool === 'clipping' || ui.tool === 'boundingbox')) {
      this.draft.cursor = [wx, wy];
      this.invalidate();
      return true;
    }
    const ap = activePolygon();
    if (!ap) return false;
    const geo = slotWorldVertices(scene.skeleton, ap.slotId);
    if (!geo) return false;
    const d = this.drag;
    if (!d) {
      const h = ui.tool === 'mesh' ? hitVertex(geo.vertices, geo.count, wx, wy, ui.camera.zoom) : -1;
      if (h !== this.hoverVertex) {
        this.hoverVertex = h;
        this.invalidate();
      }
      return ui.tool === 'mesh';
    }
    if (d.kind === 'vertices') {
      const dx = wx - d.p0[0];
      const dy = wy - d.p0[1];
      movePolygonVertices(ap.slotId, ap.name, softMoves(d.start, d.weights, dx, dy));
    } else {
      const [x0, y0, x1, y1] = dragMarquee(d, wx, wy);
      const picked = new Set(d.base);
      for (let i = 0; i < geo.count; i++) {
        const x = geo.vertices[i * 2];
        const y = geo.vertices[i * 2 + 1];
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) picked.add(i);
      }
      setSelection({ ...ui.selection, vertices: [...picked] });
      this.invalidate();
    }
    return true;
  }

  pointerUp(): boolean {
    if (!this.drag) return false;
    if (this.drag.kind === 'vertices') docStore.endGesture();
    this.drag = null;
    this.invalidate();
    return true;
  }

  /** Delete key in the mesh tool with a polygon selected. Returns true when the key was handled. */
  deleteSelectedVertices(): boolean {
    const ap = activePolygon();
    const sel = uiStore.get().selection;
    if (!ap || !sel.vertices.length) return false;
    if (uiStore.get().mode !== 'setup') {
      toast('Vertices can only be removed in Setup mode');
      return true;
    }
    deletePolygonVertices(ap.slotId, ap.name, sel.vertices);
    return true;
  }

  /** Every clipping polygon, bounding box and point of the current pose, plus the polygon being drawn. Under the bones. */
  drawUnder = (o: OverlayInput) => {
    const { ctx, w, h, cam, scene, ui } = o;
    ctx.save();
    ctx.lineJoin = 'round';
    if (ui.view.outlines) {
      const skel = scene.skeleton;
      const editing = ui.tool === 'mesh';
      for (const slot of skel.drawOrder) {
        if (o.hiddenSlots.has(slot.data.id)) continue;
        const att = skel.slotAttachment(slot);
        if (!att) continue;
        const selected = ui.selection.slot === slot.data.id && ui.selection.attachment === att.name;
        if (att.kind === 'point') {
          const p = pointWorld(att, slot.bone);
          const [x, y] = worldToScreen(cam, w, h, p.x, p.y);
          const a = (p.rotation * Math.PI) / 180;
          const tx = x + Math.cos(a) * 24;
          const ty = y - Math.sin(a) * 24;
          const color = selected ? COLORS.accent : rgba(att.color, 0.95);
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.lineWidth = selected ? 2.4 : 1.6;
          ctx.beginPath();
          ctx.arc(x, y, 5.5, 0, Math.PI * 2);
          ctx.moveTo(x - 9, y);
          ctx.lineTo(x + 9, y);
          ctx.moveTo(x, y - 9);
          ctx.lineTo(x, y + 9);
          ctx.moveTo(x, y);
          ctx.lineTo(tx, ty);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(tx - Math.cos(a - 0.45) * 8, ty + Math.sin(a - 0.45) * 8);
          ctx.lineTo(tx - Math.cos(a + 0.45) * 8, ty + Math.sin(a + 0.45) * 8);
          ctx.closePath();
          ctx.fill();
          continue;
        }
        if (att.kind !== 'clipping' && att.kind !== 'boundingbox') continue;
        const n = att.vertexCount;
        const v = new Float32Array(n * 2);
        meshWorldVertices(skel, slot, att, null, v);
        const stroke = selected ? COLORS.accent : rgba(att.color, 0.95);
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const [x, y] = worldToScreen(cam, w, h, v[i * 2], v[i * 2 + 1]);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = rgba(att.color, att.kind === 'clipping' ? 0.1 : 0.14);
        ctx.fill();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = selected ? 2.2 : 1.5;
        ctx.setLineDash(att.kind === 'clipping' ? [8, 5] : []);
        ctx.stroke();
        ctx.setLineDash([]);
        if (selected && editing) {
          const sel = new Set(ui.selection.vertices);
          // soft selection: the vertices that follow the selected ones (the weights of the drag while one is going)
          const soft =
            this.drag?.kind === 'vertices'
              ? this.drag.weights
              : ui.meshView.soft && sel.size
                ? softWeights(v, ui.selection.vertices, ui.meshView.softRadius, ui.meshView.softShape)
                : null;
          for (let i = 0; i < n; i++) {
            const [x, y] = worldToScreen(cam, w, h, v[i * 2], v[i * 2 + 1]);
            const on = sel.has(i);
            const hov = i === this.hoverVertex;
            const r = on || hov ? 5 : 4;
            ctx.fillStyle = on ? COLORS.accent : hov ? token('--handle-hover') : token('--text');
            ctx.strokeStyle = token('--handle-outline');
            ctx.lineWidth = 1.3;
            ctx.beginPath();
            ctx.rect(x - r, y - r, r * 2, r * 2);
            ctx.fill();
            ctx.stroke();
            const pull = !on ? soft?.get(i) : undefined;
            if (pull) {
              ctx.fillStyle = alpha('--accent', 0.25 + 0.7 * pull);
              ctx.beginPath();
              ctx.arc(x, y, 3 + 6 * pull, 0, Math.PI * 2);
              ctx.fill();
            }
          }
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
    if (!d || !POLYGON_TOOLS.includes(o.ui.tool)) return;
    const { ctx, w, h, cam } = o;
    const pts = d.points.map(([x, y]) => worldToScreen(cam, w, h, x, y));
    const cur = worldToScreen(cam, w, h, d.cursor[0], d.cursor[1]);
    const color = d.kind === 'clipping' ? alpha('--kind-clipping', 0.95) : alpha('--kind-boundingbox', 0.95);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    const last = pts[pts.length - 1];
    if (last) {
      ctx.moveTo(last[0], last[1]);
      ctx.lineTo(cur[0], cur[1]);
      if (pts.length >= 2) ctx.lineTo(pts[0][0], pts[0][1]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    pts.forEach(([x, y], i) => {
      const closable = i === 0 && pts.length >= 3 && Math.hypot(cur[0] - x, cur[1] - y) < 10;
      ctx.fillStyle = closable ? token('--handle-hover') : color;
      ctx.strokeStyle = token('--handle-outline');
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.rect(x - (closable ? 6 : 4), y - (closable ? 6 : 4), closable ? 12 : 8, closable ? 12 : 8);
      ctx.fill();
      ctx.stroke();
    });
  }
}
