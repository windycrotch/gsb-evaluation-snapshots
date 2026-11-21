/** What the vertex tools (mesh, polygon, path) share: the pick rectangle and the nearest-vertex hit test. */
import { worldToScreen } from '@/store/scene';
import type { Camera } from '@/store/ui';
import { COLORS } from './overlay';

/** A rectangle dragged in the viewport; `base` is the selection it adds to (Shift held). */
export interface Marquee {
  kind: 'marquee';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  base: number[];
}

export const startMarquee = (x: number, y: number, base: number[]): Marquee => ({ kind: 'marquee', x0: x, y0: y, x1: x, y1: y, base });

/** Moves the free corner to (x, y) and returns the rectangle as [left, top, right, bottom]. */
export function dragMarquee(m: Marquee, x: number, y: number): [number, number, number, number] {
  m.x1 = x;
  m.y1 = y;
  return [Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.max(m.x0, m.x1), Math.max(m.y0, m.y1)];
}

export function drawMarquee(ctx: CanvasRenderingContext2D, cam: Camera, w: number, h: number, m: Marquee) {
  const [x0, y0] = worldToScreen(cam, w, h, m.x0, m.y0);
  const [x1, y1] = worldToScreen(cam, w, h, m.x1, m.y1);
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  ctx.fillStyle = COLORS.accentSoft;
  ctx.strokeStyle = COLORS.accent;
  ctx.lineWidth = 1;
  ctx.fillRect(left, top, Math.abs(x1 - x0), Math.abs(y1 - y0));
  ctx.strokeRect(left + 0.5, top + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
}

/** The index of the vertex nearest to (wx, wy) within `tolPx` screen pixels, or -1. `v` holds x, y pairs. */
export function hitVertex(v: ArrayLike<number>, count: number, wx: number, wy: number, zoom: number, tolPx = 9): number {
  let best = -1;
  let bd = (tolPx / zoom) ** 2;
  for (let i = 0; i < count; i++) {
    const d = (v[i * 2] - wx) ** 2 + (v[i * 2 + 1] - wy) ** 2;
    if (d <= bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}
