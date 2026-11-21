/**
 * Snapping and guides: the grid step the viewport draws at a zoom, where a point lands when it snaps to the grid or to a guide,
 * and the repair of a list of guides. Pure functions; the viewport and the store call them.
 */

/** Vertical lines (their x) and horizontal lines (their y) the person laid over the scene. Saved with the project. */
export interface Guides {
  x: number[];
  y: number[];
}

/** The nicest step of 1, 2, 5 × 10ⁿ that is at least `minWorld`. */
export function niceStep(minWorld: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(minWorld)));
  const n = minWorld / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** The distance between two grid lines at a zoom: about 28 pixels on the screen. */
export const gridStep = (zoom: number): number => niceStep(28 / Math.max(zoom, 1e-6));

/** How close, in pixels, a point has to be to a guide to stick to it. */
export const GUIDE_PULL = 8;

export interface SnapOptions {
  zoom: number;
  /** Snap to the grid (a point near a guide still sticks to the guide first). */
  grid: boolean;
  guides?: Guides;
  /** Without a guide or the grid, land on a whole unit (a pixel of the picture at 100%). */
  pixel?: boolean;
}

function snapAxis(v: number, lines: readonly number[], pull: number, step: number | null): { value: number; guide: boolean } {
  let best: number | null = null;
  for (const g of lines) if (Math.abs(g - v) <= pull && (best === null || Math.abs(g - v) < Math.abs(best - v))) best = g;
  if (best !== null) return { value: best, guide: true };
  return { value: step ? Math.round(v / step) * step : v, guide: false };
}

/** Where a point lands: on the nearest guide within reach, else on the grid (when it is on), else where it is. */
export function snapPoint(x: number, y: number, o: SnapOptions): { x: number; y: number; guideX: boolean; guideY: boolean } {
  const pull = GUIDE_PULL / Math.max(o.zoom, 1e-6);
  const step = o.grid ? gridStep(o.zoom) : o.pixel ? 1 : null;
  const sx = snapAxis(x, o.guides?.x ?? [], pull, step);
  const sy = snapAxis(y, o.guides?.y ?? [], pull, step);
  return { x: sx.value, y: sy.value, guideX: sx.guide, guideY: sy.guide };
}

/** A list of guides from anything: only finite numbers, no two the same, in order, and not more than the viewport could show. */
export function cleanGuides(raw: unknown): Guides {
  const list = (v: unknown): number[] => {
    if (!Array.isArray(v)) return [];
    const nums = v
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e7)
      .map((n) => Math.round(n * 1000) / 1000);
    return [...new Set(nums)].sort((a, b) => a - b).slice(0, 100);
  };
  const o = raw && typeof raw === 'object' ? (raw as Partial<Guides>) : {};
  return { x: list(o.x), y: list(o.y) };
}

/** The index of the guide of a list that is within reach of a coordinate, or -1. */
export function guideAt(lines: readonly number[], v: number, zoom: number): number {
  let best = -1;
  const reach = 4 / Math.max(zoom, 1e-6);
  lines.forEach((g, i) => {
    if (Math.abs(g - v) <= reach && (best < 0 || Math.abs(g - v) < Math.abs(lines[best] - v))) best = i;
  });
  return best;
}
