/**
 * The outline map (a small overview of the whole skeleton with the part the viewport shows): where the scene lands on the map, the
 * rectangle of the viewport, and the camera for a click on the map. Pure functions; the panel draws.
 */
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** How scene units become pixels of the map (y points up in the scene, down on the map). */
export interface MapView {
  scale: number;
  /** The scene point that is at the middle of the map. */
  cx: number;
  cy: number;
  width: number;
  height: number;
}

/** The box that holds all the points, or null for none. */
export function boxOf(points: readonly (readonly [number, number])[]): Box | null {
  if (!points.length) return null;
  const b: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    b.minX = Math.min(b.minX, x);
    b.minY = Math.min(b.minY, y);
    b.maxX = Math.max(b.maxX, x);
    b.maxY = Math.max(b.maxY, y);
  }
  return Number.isFinite(b.minX) ? b : null;
}

export function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

/** The scene rectangle the viewport shows (camera x, y at its middle, zoom in pixels per unit). */
export function viewBox(cam: { x: number; y: number; zoom: number }, w: number, h: number): Box {
  const hw = w / 2 / Math.max(cam.zoom, 1e-6);
  const hh = h / 2 / Math.max(cam.zoom, 1e-6);
  return { minX: cam.x - hw, minY: cam.y - hh, maxX: cam.x + hw, maxY: cam.y + hh };
}

/**
 * A map of `width` × `height` pixels that shows `content` and the viewport's own rectangle `view` (so that it can be seen when it is off to
 * the side), with a margin of `pad` pixels. A content with no size still gets a sensible scale.
 */
export function fitMap(content: Box | null, view: Box, width: number, height: number, pad = 8): MapView {
  const all = unionBox(content, view)!;
  const w = Math.max(all.maxX - all.minX, 1);
  const h = Math.max(all.maxY - all.minY, 1);
  const scale = Math.min((width - pad * 2) / w, (height - pad * 2) / h);
  return { scale, cx: (all.minX + all.maxX) / 2, cy: (all.minY + all.maxY) / 2, width, height };
}

/** Scene point to the pixel of the map. */
export function toMap(m: MapView, x: number, y: number): [number, number] {
  return [m.width / 2 + (x - m.cx) * m.scale, m.height / 2 - (y - m.cy) * m.scale];
}

/** Pixel of the map to the scene point. */
export function fromMap(m: MapView, px: number, py: number): [number, number] {
  return [m.cx + (px - m.width / 2) / m.scale, m.cy - (py - m.height / 2) / m.scale];
}
