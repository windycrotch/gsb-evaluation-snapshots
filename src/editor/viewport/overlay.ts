/** Canvas2D overlay drawn above the WebGL image layer: grid, bones, constraints, selection outlines, gizmos. */
import type { Id } from '@/core/model';
import type { Bone } from '@/core/skeleton';
import type { TransformConstraintRT } from '@/core/skeleton';
import { constraintLinks, focusLinks, linkLabel } from '@/core/constraintInfo';
import { gridStep } from '@/core/snap';
import { docStore } from '@/store/doc';
import { settingsStore } from '@/store/settings';
import type { Camera, UiState } from '@/store/ui';
import { worldToScreen } from '@/store/scene';
import type { MotionArrow } from '../ghosts';
import type { Scene } from '@/store/scene';
import { slotWorldVertices } from './hit';
import { fpsMeter } from './fps';
import { drawTrails } from './trails';
import { alpha, token } from '../ui/tokens';

/** The colours of the overlay: getters, because they are read from the design tokens when drawing (the stylesheet is not there yet when this module loads). */
export const COLORS = {
  get accent() {
    return token('--accent');
  },
  get accentSoft() {
    return alpha('--accent', 0.18);
  },
  get animate() {
    return token('--animate');
  },
  get hover() {
    return token('--hover-accent');
  },
  get text() {
    return token('--text');
  },
  get muted() {
    return token('--muted');
  },
  get axisX() {
    return alpha('--axis-x', 0.45);
  },
  get axisY() {
    return alpha('--axis-y', 0.45);
  },
  get ik() {
    return token('--kind-ik');
  },
};

export interface Interaction {
  kind: 'create' | 'marquee' | 'link' | 'guide' | 'none';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** A guide being dragged: which kind of line, which one of its list (-1 for a new one), and where it is now (x0 for a vertical line, y0 for a horizontal one). */
  axis?: 'x' | 'y';
  index?: number;
}

/** The width of the rulers, in pixels. */
export const RULER = 18;

export interface OverlayInput {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  cam: Camera;
  scene: Scene;
  ui: UiState;
  hoverBone: Id | null;
  hiddenBones: Set<Id>;
  hiddenSlots: Set<Id>;
  interaction: Interaction | null;
  /** Drawn right after the attachment outline, below the bones. */
  under?: (o: OverlayInput) => void;
  extra?: (o: OverlayInput) => void;
}

/** Arrows along the motion (see `motionArrows`): a line with a head at the later end, in the colour of its side. */
export function drawMotionArrows(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  cam: Camera,
  arrows: readonly MotionArrow[],
  before: readonly number[],
  after: readonly number[],
) {
  const css = (c: readonly number[]) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
  ctx.save();
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  for (const a of arrows) {
    const [x0, y0] = worldToScreen(cam, w, h, a.x0, a.y0);
    const [x1, y1] = worldToScreen(cam, w, h, a.x1, a.y1);
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 3) continue;
    const ux = (x1 - x0) / len;
    const uy = (y1 - y0) / len;
    const head = Math.min(9, len * 0.5);
    ctx.strokeStyle = ctx.fillStyle = css(a.side === 'before' ? before : after);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - ux * head - uy * head * 0.5, y1 - uy * head + ux * head * 0.5);
    ctx.lineTo(x1 - ux * head + uy * head * 0.5, y1 - uy * head - ux * head * 0.5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** The grid of single units: a line at every whole number, once a unit is wide enough on the screen (6 pixels) to tell the lines apart. */
function drawPixelGrid(o: OverlayInput) {
  const { ctx, w, h, cam } = o;
  if (cam.zoom < 6) return;
  const [wx0, wy1] = [cam.x - w / 2 / cam.zoom, cam.y + h / 2 / cam.zoom];
  const [wx1, wy0] = [cam.x + w / 2 / cam.zoom, cam.y - h / 2 / cam.zoom];
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.beginPath();
  for (let x = Math.ceil(wx0); x <= wx1; x++) {
    const sx = Math.round(worldToScreen(cam, w, h, x, 0)[0]) + 0.5;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, h);
  }
  for (let y = Math.ceil(wy0); y <= wy1; y++) {
    const sy = Math.round(worldToScreen(cam, w, h, 0, y)[1]) + 0.5;
    ctx.moveTo(0, sy);
    ctx.lineTo(w, sy);
  }
  ctx.stroke();
}

/** The frame counter, in the bottom left corner. */
function drawFps(o: OverlayInput) {
  const { ctx, h } = o;
  const { fps, ms } = fpsMeter.read(performance.now());
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillStyle = COLORS.muted;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${fps} fps · ${ms.toFixed(1)} ms`, 10, h - 10);
}

function drawGrid(o: OverlayInput) {
  const { ctx, w, h, cam } = o;
  const step = gridStep(cam.zoom);
  const [wx0, wy1] = [cam.x - w / 2 / cam.zoom, cam.y + h / 2 / cam.zoom];
  const [wx1, wy0] = [cam.x + w / 2 / cam.zoom, cam.y - h / 2 / cam.zoom];
  ctx.lineWidth = 1;
  const major = step * 5;
  const draw = (v: number, vertical: boolean, color: string) => {
    ctx.strokeStyle = color;
    ctx.beginPath();
    if (vertical) {
      const [sx] = worldToScreen(cam, w, h, v, 0);
      const x = Math.round(sx) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    } else {
      const [, sy] = worldToScreen(cam, w, h, 0, v);
      const y = Math.round(sy) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
  };
  for (let x = Math.ceil(wx0 / step) * step; x <= wx1; x += step) {
    if (Math.abs(x) < step / 2) continue;
    draw(x, true, Math.abs(x % major) < step / 2 ? 'rgba(255,255,255,0.075)' : 'rgba(255,255,255,0.035)');
  }
  for (let y = Math.ceil(wy0 / step) * step; y <= wy1; y += step) {
    if (Math.abs(y) < step / 2) continue;
    draw(y, false, Math.abs(y % major) < step / 2 ? 'rgba(255,255,255,0.075)' : 'rgba(255,255,255,0.035)');
  }
  draw(0, true, COLORS.axisY);
  draw(0, false, COLORS.axisX);
}

function boneColor(bone: Bone, o: OverlayInput, selected: boolean, hovered: boolean): { fill: string; stroke: string } {
  if (selected) return { fill: alpha('--accent', 0.55), stroke: COLORS.accent };
  if (hovered) return { fill: alpha('--hover-accent', 0.5), stroke: COLORS.hover };
  const c = bone.data.color;
  const r = Math.round(c[0] * 255);
  const g = Math.round(c[1] * 255);
  const b = Math.round(c[2] * 255);
  return {
    fill: `rgba(${r},${g},${b},0.42)`,
    stroke: `rgba(${Math.min(255, r + 70)},${Math.min(255, g + 70)},${Math.min(255, b + 70)},0.95)`,
  };
}

function drawBone(o: OverlayInput, bone: Bone, selected: boolean, hovered: boolean) {
  const { ctx, w, h, cam } = o;
  const [ox, oy] = worldToScreen(cam, w, h, bone.worldX, bone.worldY);
  const tipWX = bone.worldX + bone.a * bone.data.length;
  const tipWY = bone.worldY + bone.c * bone.data.length;
  const [tx, ty] = worldToScreen(cam, w, h, tipWX, tipWY);
  const len = Math.hypot(tx - ox, ty - oy);
  const colors = boneColor(bone, o, selected, hovered);
  const k = settingsStore.get().boneScale / 100;
  ctx.lineJoin = 'round';
  if (len < 3) {
    // a bone without length has no shape of its own: it is drawn as a small arrow along its x axis, turned by the icon rotation setting
    const angle = Math.atan2(bone.c, bone.a) + (settingsStore.get().boneIconRotation * Math.PI) / 180;
    const r = (selected ? 8 : 6.5) * k;
    const dx = Math.cos(angle);
    const dy = -Math.sin(angle);
    ctx.fillStyle = colors.fill;
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth = selected ? 2 : 1.25;
    ctx.beginPath();
    ctx.moveTo(ox + dx * r * 1.5, oy + dy * r * 1.5);
    ctx.lineTo(ox - dx * r * 0.7 - dy * r, oy - dy * r * 0.7 + dx * r);
    ctx.lineTo(ox - dx * r * 0.3, oy - dy * r * 0.3);
    ctx.lineTo(ox - dx * r * 0.7 + dy * r, oy - dy * r * 0.7 - dx * r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    const ux = (tx - ox) / len;
    const uy = (ty - oy) / len;
    const wd = Math.min(9 * k, Math.max(3.5 * k, len * 0.13 * k));
    const px = -uy * wd;
    const py = ux * wd;
    const kx = ox + ux * len * 0.2;
    const ky = oy + uy * len * 0.2;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(kx + px, ky + py);
    ctx.lineTo(tx, ty);
    ctx.lineTo(kx - px, ky - py);
    ctx.closePath();
    ctx.fillStyle = colors.fill;
    ctx.fill();
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth = selected ? 2 : 1.25;
    ctx.stroke();
  }
  // origin joint
  ctx.beginPath();
  ctx.arc(ox, oy, (selected ? 3.6 : 3) * Math.min(k, 1.6), 0, Math.PI * 2);
  ctx.fillStyle = selected ? COLORS.accent : alpha('--text', 0.95);
  ctx.fill();
  ctx.strokeStyle = token('--key-outline');
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawBones(o: OverlayInput) {
  const { scene, ui } = o;
  const sel = new Set(ui.selection.bones);
  const targets = new Set(scene.data.constraints.flatMap((c) => (c.kind === 'ik' ? [scene.data.bones[c.target].id] : [])));
  for (const bone of scene.skeleton.bones) {
    const id = bone.data.id;
    if (o.hiddenBones.has(id)) continue;
    if (targets.has(id) && bone.data.length < 1) continue; // drawn by constraint visuals
    drawBone(o, bone, sel.has(id), o.hoverBone === id);
  }
  const named = new Set(
    docStore
      .get()
      .skeleton.bones.filter((b) => b.showName)
      .map((b) => b.id),
  );
  if (ui.view.names || named.size) {
    const { ctx, w, h, cam } = o;
    ctx.font = '11px Inter Variable, Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const bone of scene.skeleton.bones) {
      if (o.hiddenBones.has(bone.data.id) || !(ui.view.names || named.has(bone.data.id))) continue;
      const mx = bone.worldX + (bone.a * bone.data.length) / 2;
      const my = bone.worldY + (bone.c * bone.data.length) / 2;
      const [sx, sy] = worldToScreen(cam, w, h, mx, my);
      const label = bone.data.name;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = alpha('--bg', 0.72);
      ctx.fillRect(sx - tw / 2 - 4, sy - 16, tw + 8, 15);
      ctx.fillStyle = sel.has(bone.data.id) ? COLORS.accent : COLORS.text;
      ctx.fillText(label, sx - tw / 2, sy - 8.5);
    }
  }
}

/** The sector of a rotation limit (a transform constraint that clamps one bone's local rotation to min..max): a pie in the frame of the bone's parent. */
function drawLimitSector(o: OverlayInput, c: TransformConstraintRT) {
  const d = c.data;
  if (!d.clamp || !d.localSource || !d.localTarget || d.additive || d.bones.length !== 1 || d.properties.length !== 1) return;
  const from = d.properties[0];
  const to = from.to[0];
  if (from.prop !== 'rotate' || from.to.length !== 1 || !to || to.prop !== 'rotate' || to.scale !== 1 || !(to.max > to.offset)) return;
  const bone = c.bones[0];
  const parent = bone.parent;
  const { ctx, w, h, cam } = o;
  const involved = o.ui.selection.bones.includes(bone.data.id) || o.ui.selection.bones.includes(c.source.data.id);
  const radius = Math.max(30, bone.data.length * 0.9);
  const rad = Math.PI / 180;
  const dir = (deg: number): [number, number] => {
    const x = Math.cos(deg * rad);
    const y = Math.sin(deg * rad);
    const wx = parent ? parent.a * x + parent.b * y : x;
    const wy = parent ? parent.c * x + parent.d * y : y;
    const len = Math.hypot(wx, wy) || 1;
    return [wx / len, wy / len];
  };
  const point = (deg: number): [number, number] => {
    const [dx, dy] = dir(deg);
    return worldToScreen(cam, w, h, bone.worldX + dx * radius, bone.worldY + dy * radius);
  };
  const [ox, oy] = worldToScreen(cam, w, h, bone.worldX, bone.worldY);
  const steps = Math.max(4, Math.ceil((to.max - to.offset) / 6));
  ctx.save();
  ctx.fillStyle = alpha('--kind-transform', involved ? 0.22 : 0.1);
  ctx.strokeStyle = token('--kind-transform');
  ctx.globalAlpha = involved ? 0.95 : 0.5;
  ctx.lineWidth = involved ? 1.6 : 1.1;
  ctx.beginPath();
  ctx.moveTo(ox, oy);
  for (let i = 0; i <= steps; i++) {
    const [px, py] = point(to.offset + ((to.max - to.offset) * i) / steps);
    ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawConstraints(o: OverlayInput) {
  const { ctx, w, h, cam, scene } = o;
  for (const c of scene.skeleton.constraints) {
    if (!c.active) continue;
    if (c.kind === 'slider') {
      // slider driven by a bone: a small diamond on the driver bone
      if (!c.bone) continue;
      const [bx, by] = worldToScreen(cam, w, h, c.bone.worldX, c.bone.worldY);
      ctx.save();
      ctx.strokeStyle = token('--kind-slider');
      ctx.fillStyle = alpha('--kind-slider', 0.2);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(bx, by - 8);
      ctx.lineTo(bx + 8, by);
      ctx.lineTo(bx, by + 8);
      ctx.lineTo(bx - 8, by);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      continue;
    }
    if (c.kind === 'transform') {
      // transform constraint: dotted link from the source bone to the constrained bones
      const s = c.source;
      const [sx, sy] = worldToScreen(cam, w, h, s.worldX, s.worldY);
      ctx.save();
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = token('--kind-transform');
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1.5;
      for (const b of c.bones) {
        const [bx, by] = worldToScreen(cam, w, h, b.worldX, b.worldY);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
      ctx.restore();
      drawLimitSector(o, c);
      continue;
    }
    if (c.kind === 'path') {
      // path constraint: a dot on every constrained bone, in the color of paths
      ctx.save();
      ctx.fillStyle = alpha('--kind-path', 0.9);
      ctx.strokeStyle = token('--handle-outline');
      ctx.lineWidth = 1.2;
      for (const b of c.bones) {
        const [bx, by] = worldToScreen(cam, w, h, b.worldX, b.worldY);
        ctx.beginPath();
        ctx.arc(bx, by, 3.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
      continue;
    }
    if (c.kind !== 'ik') continue;
    const t = c.target;
    const [tx, ty] = worldToScreen(cam, w, h, t.worldX, t.worldY);
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = COLORS.ik;
    ctx.globalAlpha = 0.55 + 0.45 * c.mix;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    // chain through constrained bones to the target
    const [fx, fy] = worldToScreen(cam, w, h, c.bones[0].worldX, c.bones[0].worldY);
    ctx.moveTo(fx, fy);
    for (const b of c.bones) {
      const [bx, by] = worldToScreen(cam, w, h, b.tipX, b.tipY);
      ctx.lineTo(bx, by);
    }
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.restore();
    // target marker
    const selected = o.ui.selection.bones.includes(t.data.id);
    ctx.strokeStyle = selected ? COLORS.accent : COLORS.ik;
    ctx.fillStyle = selected ? alpha('--accent', 0.25) : alpha('--kind-ik', 0.22);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(tx, ty, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tx - 13, ty);
    ctx.lineTo(tx + 13, ty);
    ctx.moveTo(tx, ty - 13);
    ctx.lineTo(tx, ty + 13);
    ctx.lineWidth = 1.25;
    ctx.stroke();
  }
}

function drawAttachmentOutline(o: OverlayInput) {
  const { ctx, w, h, cam, scene, ui } = o;
  const slotId = ui.selection.slot;
  if (!slotId) return;
  const geo = slotWorldVertices(scene.skeleton, slotId);
  if (!geo || geo.kind === 'polygon') return; // polygons draw their own (colored) outline
  ctx.strokeStyle = COLORS.accent;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  if (geo.kind === 'region') {
    for (let i = 0; i < 4; i++) {
      const [x, y] = worldToScreen(cam, w, h, geo.vertices[i * 2], geo.vertices[i * 2 + 1]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  } else {
    const slot = scene.skeleton.slotById(slotId);
    const att = slot ? scene.skeleton.slotAttachment(slot) : null;
    const hull = att && att.kind === 'mesh' ? att.hull : 0;
    for (let i = 0; i < hull; i++) {
      const [x, y] = worldToScreen(cam, w, h, geo.vertices[i * 2], geo.vertices[i * 2 + 1]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawOriginCross(o: OverlayInput) {
  const { ctx, w, h, cam } = o;
  const [x, y] = worldToScreen(cam, w, h, 0, 0);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.stroke();
}

/** Tool gizmo at the origin of the first selected bone. */
function drawGizmo(o: OverlayInput) {
  const { ctx, w, h, cam, scene, ui } = o;
  const id = ui.selection.bones[0];
  if (!id || ui.tool === 'select' || ui.tool === 'create') return;
  const bone = scene.skeleton.boneById(id);
  if (!bone) return;
  const [x, y] = worldToScreen(cam, w, h, bone.worldX, bone.worldY);
  ctx.lineWidth = 2;
  if (ui.tool === 'translate') {
    const L = 54;
    ctx.strokeStyle = token('--axis-x');
    ctx.fillStyle = token('--axis-x');
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + L, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + L + 9, y);
    ctx.lineTo(x + L - 1, y - 5);
    ctx.lineTo(x + L - 1, y + 5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = token('--axis-y');
    ctx.fillStyle = token('--axis-y');
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - L);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y - L - 9);
    ctx.lineTo(x - 5, y - L + 1);
    ctx.lineTo(x + 5, y - L + 1);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(x + 10, y - 22, 14, 14);
  } else if (ui.tool === 'rotate') {
    ctx.strokeStyle = alpha('--gizmo-rotate', 0.9);
    ctx.beginPath();
    ctx.arc(x, y, 46, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = alpha('--gizmo-rotate', 0.95);
    const a = -bone.worldRotationX * (Math.PI / 180);
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * 46, y + Math.sin(a) * 46, 5, 0, Math.PI * 2);
    ctx.fill();
  } else if (ui.tool === 'shear') {
    ctx.strokeStyle = alpha('--gizmo-shear', 0.95);
    ctx.fillStyle = alpha('--gizmo-shear', 0.95);
    const a = -bone.worldRotationX * (Math.PI / 180);
    const c = Math.cos(a);
    const s = Math.sin(a);
    // a parallelogram with the bone axes slanted, and an arrow along each way it can be pulled
    ctx.beginPath();
    ctx.moveTo(x - c * 22 - s * 14, y - s * 22 + c * 14);
    ctx.lineTo(x + c * 22 - s * 14 + c * 8, y + s * 22 + c * 14 + s * 8);
    ctx.lineTo(x + c * 22 + s * 14 + c * 8, y + s * 22 - c * 14 + s * 8);
    ctx.lineTo(x - c * 22 + s * 14, y - s * 22 - c * 14);
    ctx.closePath();
    ctx.stroke();
    ctx.globalAlpha = 0.18;
    ctx.fill();
    ctx.globalAlpha = 1;
  } else if (ui.tool === 'scale') {
    ctx.strokeStyle = alpha('--gizmo-scale', 0.95);
    ctx.fillStyle = alpha('--gizmo-scale', 0.95);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 40, y);
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - 40);
    ctx.stroke();
    ctx.fillRect(x + 36, y - 4, 9, 9);
    ctx.fillRect(x - 4, y - 44, 9, 9);
    ctx.strokeRect(x - 9, y - 9, 18, 18);
  }
}

/** The guide lines of the project, and the one being dragged; then the rulers over them. */
function drawGuidesAndRulers(o: OverlayInput) {
  const { ctx, w, h, cam, ui, interaction } = o;
  if (!ui.view.rulers) return;
  const guides = docStore.get().guides;
  const dragging = interaction?.kind === 'guide' ? interaction : null;
  ctx.save();
  ctx.lineWidth = 1;
  const line = (axis: 'x' | 'y', v: number, dashed: boolean) => {
    ctx.strokeStyle = alpha('--accent', dashed ? 0.9 : 0.65);
    ctx.setLineDash(dashed ? [5, 4] : []);
    ctx.beginPath();
    if (axis === 'x') {
      const x = Math.round(worldToScreen(cam, w, h, v, 0)[0]) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    } else {
      const y = Math.round(worldToScreen(cam, w, h, 0, v)[1]) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
  };
  (guides?.x ?? []).forEach((v, i) => (dragging?.axis === 'x' && dragging.index === i ? undefined : line('x', v, false)));
  (guides?.y ?? []).forEach((v, i) => (dragging?.axis === 'y' && dragging.index === i ? undefined : line('y', v, false)));
  if (dragging) line(dragging.axis!, dragging.axis === 'x' ? dragging.x0 : dragging.y0, true);
  ctx.setLineDash([]);

  // the rulers: a band along the top (x) and the left (y) with a tick at every grid line and a number at the larger ones
  const step = gridStep(cam.zoom);
  const major = step * 5;
  ctx.fillStyle = alpha('--panel', 0.94);
  ctx.fillRect(0, 0, w, RULER);
  ctx.fillRect(0, 0, RULER, h);
  ctx.strokeStyle = token('--border');
  ctx.beginPath();
  ctx.moveTo(0, RULER + 0.5);
  ctx.lineTo(w, RULER + 0.5);
  ctx.moveTo(RULER + 0.5, 0);
  ctx.lineTo(RULER + 0.5, h);
  ctx.stroke();
  ctx.fillStyle = COLORS.muted;
  ctx.strokeStyle = COLORS.muted;
  ctx.font = '9px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  const [wx0, wy1] = [cam.x - w / 2 / cam.zoom, cam.y + h / 2 / cam.zoom];
  const [wx1, wy0] = [cam.x + w / 2 / cam.zoom, cam.y - h / 2 / cam.zoom];
  const label = (v: number) => String(Math.round(v * 1000) / 1000);
  for (let v = Math.ceil(wx0 / step) * step; v <= wx1; v += step) {
    const sx = Math.round(worldToScreen(cam, w, h, v, 0)[0]) + 0.5;
    if (sx < RULER) continue;
    const isMajor = Math.abs(v % major) < step / 2;
    ctx.beginPath();
    ctx.moveTo(sx, RULER);
    ctx.lineTo(sx, RULER - (isMajor ? 9 : 4));
    ctx.stroke();
    if (isMajor) ctx.fillText(label(v), sx + 3, 2);
  }
  for (let v = Math.ceil(wy0 / step) * step; v <= wy1; v += step) {
    const sy = Math.round(worldToScreen(cam, w, h, 0, v)[1]) + 0.5;
    if (sy < RULER) continue;
    const isMajor = Math.abs(v % major) < step / 2;
    ctx.beginPath();
    ctx.moveTo(RULER, sy);
    ctx.lineTo(RULER - (isMajor ? 9 : 4), sy);
    ctx.stroke();
    if (isMajor) {
      ctx.save();
      ctx.translate(2, sy - 3);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(label(v), 0, 0);
      ctx.restore();
    }
  }
  ctx.restore();
}

function drawInteraction(o: OverlayInput) {
  const { ctx, w, h, cam, interaction } = o;
  if (!interaction || interaction.kind === 'none' || interaction.kind === 'guide') return;
  const [x0, y0] = worldToScreen(cam, w, h, interaction.x0, interaction.y0);
  const [x1, y1] = worldToScreen(cam, w, h, interaction.x1, interaction.y1);
  if (interaction.kind === 'create') {
    ctx.strokeStyle = COLORS.accent;
    ctx.fillStyle = COLORS.accentSoft;
    ctx.lineWidth = 2;
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len > 2) {
      const ux = (x1 - x0) / len;
      const uy = (y1 - y0) / len;
      const wd = Math.min(9, Math.max(3.5, len * 0.13));
      const kx = x0 + ux * len * 0.2;
      const ky = y0 + uy * len * 0.2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(kx - uy * wd, ky + ux * wd);
      ctx.lineTo(x1, y1);
      ctx.lineTo(kx + uy * wd, ky - ux * wd);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x0, y0, 4, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.accent;
    ctx.fill();
  } else if (interaction.kind === 'link') {
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = COLORS.ik;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = alpha('--kind-ik', 0.22);
    ctx.strokeStyle = COLORS.ik;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x1, y1, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (interaction.kind === 'marquee') {
    ctx.strokeStyle = COLORS.accent;
    ctx.fillStyle = COLORS.accentSoft;
    ctx.lineWidth = 1;
    ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
  }
}

/** Constraint debug: an arrow from what drives each constraint to every bone it moves, labelled with the name and strength. */
function drawConstraintInfo(o: OverlayInput) {
  const { ctx, w, h, cam, scene, ui } = o;
  const links = constraintLinks(scene.skeleton);
  const focus = focusLinks(links, ui.selection.constraint, ui.selection.bones);
  const screen = (b: Bone): [number, number] => worldToScreen(cam, w, h, b.worldX, b.worldY);
  ctx.save();
  ctx.font = '11px Inter Variable, Inter, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const l of links) {
    const on = focus.has(l.id);
    ctx.globalAlpha = on ? 1 : 0.2;
    const color = token(`--kind-${l.kind}`) || COLORS.ik;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = on ? 2 : 1.2;
    ctx.setLineDash([]);
    let lx = 0;
    let ly = 0;
    let count = 0;
    for (const b of l.driven) {
      const [bx, by] = screen(b);
      lx += bx;
      ly += by;
      count++;
      if (!l.driver) {
        ctx.beginPath();
        ctx.arc(bx, by, on ? 7 : 5, 0, Math.PI * 2);
        ctx.stroke();
        continue;
      }
      const [dx, dy] = screen(l.driver);
      const len = Math.hypot(bx - dx, by - dy);
      if (len < 4) continue;
      // the arrow runs from the driver to the bone and stops a little short of it so the head is not lost under the bone
      const ux = (bx - dx) / len;
      const uy = (by - dy) / len;
      const ex = bx - ux * 6;
      const ey = by - uy * 6;
      ctx.beginPath();
      ctx.moveTo(dx, dy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ex + ux * 6, ey + uy * 6);
      ctx.lineTo(ex - uy * 4, ey + ux * 4);
      ctx.lineTo(ex + uy * 4, ey - ux * 4);
      ctx.closePath();
      ctx.fill();
    }
    if (l.driver) {
      const [dx, dy] = screen(l.driver);
      ctx.beginPath();
      ctx.arc(dx, dy, on ? 4.5 : 3, 0, Math.PI * 2);
      ctx.fill();
      lx += dx;
      ly += dy;
      count++;
    }
    if (!on || !count) continue;
    const text = linkLabel(l);
    const tw = ctx.measureText(text).width;
    const x = lx / count;
    const y = ly / count;
    ctx.globalAlpha = 1;
    ctx.fillStyle = alpha('--bg', 0.8);
    ctx.fillRect(x - tw / 2 - 4, y - 8, tw + 8, 16);
    ctx.fillStyle = color;
    ctx.fillText(text, x - tw / 2, y);
  }
  ctx.restore();
}

/** The pivot of the rotate tool: a ring with a cross, while the rotate tool is chosen. */
function drawPivot(o: OverlayInput) {
  const { ctx, w, h, cam, ui } = o;
  if (ui.tool !== 'rotate' || !ui.pivot) return;
  const [x, y] = worldToScreen(cam, w, h, ui.pivot.x, ui.pivot.y);
  ctx.strokeStyle = token('--animate');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.moveTo(x - 11, y);
  ctx.lineTo(x + 11, y);
  ctx.moveTo(x, y - 11);
  ctx.lineTo(x, y + 11);
  ctx.stroke();
}

export function drawOverlay(o: OverlayInput) {
  const { ctx, w, h, ui } = o;
  ctx.clearRect(0, 0, w, h);
  if (ui.view.grid) drawGrid(o);
  if (settingsStore.get().pixelGrid) drawPixelGrid(o);
  drawOriginCross(o);
  drawAttachmentOutline(o);
  o.under?.(o);
  if (ui.view.bones) drawBones(o);
  if (ui.view.constraints) drawConstraints(o);
  if (ui.view.constraintInfo) drawConstraintInfo(o);
  drawTrails(o);
  o.extra?.(o);
  drawGizmo(o);
  if (settingsStore.get().showFps) drawFps(o);
  drawPivot(o);
  drawInteraction(o);
  drawGuidesAndRulers(o);
}
