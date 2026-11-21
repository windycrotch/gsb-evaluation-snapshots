/**
 * The view of the player page: where the skeleton is on the canvas, and which bone a click points at. The player draws with these numbers
 * and the click uses the same ones, so what is hit is what is seen.
 */

/** The box every frame of the animation fits in. */
export interface Fit {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlayerView {
  /** How far the picture is panned from the centre of the box (world units). */
  x: number;
  y: number;
  zoom: number;
}

/** Device pixels per world unit: the box fits the canvas with a margin, times the zoom. */
export function viewScale(width: number, height: number, fit: Fit, zoom: number): number {
  return Math.min(width / (fit.w * 1.16), height / (fit.h * 1.16)) * zoom;
}

/** A point of the canvas (device pixels from its top left corner) in world coordinates. */
export function canvasToWorld(px: number, py: number, width: number, height: number, fit: Fit, view: PlayerView): [number, number] {
  const scale = viewScale(width, height, fit, view.zoom);
  return [fit.x + view.x + (px - width / 2) / scale, fit.y + view.y - (py - height / 2) / scale];
}

/** A world point on the canvas (device pixels): the other way round. */
export function worldToCanvas(wx: number, wy: number, width: number, height: number, fit: Fit, view: PlayerView): [number, number] {
  const scale = viewScale(width, height, fit, view.zoom);
  return [(wx - fit.x - view.x) * scale + width / 2, height / 2 - (wy - fit.y - view.y) * scale];
}

export interface BoneSegment {
  name: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Distance from a point to a segment (a bone with no length is a point). */
export function distanceToSegment(s: BoneSegment, x: number, y: number): number {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((x - s.x1) * dx + (y - s.y1) * dy) / l2)) : 0;
  return Math.hypot(s.x1 + dx * t - x, s.y1 + dy * t - y);
}

/** The bone nearest to a world point, when it is within `tolerance` world units; null when none is. */
export function nearestBone(segments: readonly BoneSegment[], x: number, y: number, tolerance: number): string | null {
  let best: string | null = null;
  let bestDistance = tolerance;
  for (const s of segments) {
    if (![s.x1, s.y1, s.x2, s.y2].every(Number.isFinite)) continue;
    const d = distanceToSegment(s, x, y);
    if (d <= bestDistance) {
      bestDistance = d;
      best = s.name;
    }
  }
  return best;
}
