/**
 * A turn around a point that is not the bone's own origin (a temporary pivot: a forearm turning about the wrist of a hand that is a child,
 * a head nodding about the neck). Turning a bone about such a point moves its origin as well, so a pose of this kind needs the rotate AND the
 * translate keys; this works out both from the mouse angle.
 */

/** The world matrix of a parent bone: world = [a b; c d] * local + [x y]. */
export interface ParentFrame {
  a: number;
  b: number;
  c: number;
  d: number;
  x: number;
  y: number;
}

/** A bone as the turn found it: its local pose and the matrix of its parent (none for a root). */
export interface TurnFrame {
  x: number;
  y: number;
  rotation: number;
  /** -1 when the parent mirrors (its matrix flips), else 1: the local angle then runs the other way round. */
  sign: number;
  parent: ParentFrame | null;
}

const IDENTITY: ParentFrame = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };

/** Where the bone's origin is in the world. */
export function originOf(f: TurnFrame): [number, number] {
  const p = f.parent ?? IDENTITY;
  return [p.a * f.x + p.b * f.y + p.x, p.c * f.x + p.d * f.y + p.y];
}

/** The sign of the local angle for a parent matrix: -1 when it mirrors. */
export const turnSign = (p: ParentFrame | null): number => (p && p.a * p.d - p.b * p.c < 0 ? -1 : 1);

/**
 * The local pose of the bone after it is turned `degrees` (counterclockwise in the world) about the world point (`px`, `py`): its origin
 * goes round the point and the bone turns by the same angle.
 */
export function turnAbout(f: TurnFrame, px: number, py: number, degrees: number): { x: number; y: number; rotation: number } {
  const p = f.parent ?? IDENTITY;
  const [wx, wy] = originOf(f);
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = wx - px;
  const dy = wy - py;
  const ex = px + dx * cos - dy * sin - p.x;
  const ey = py + dx * sin + dy * cos - p.y;
  const det = p.a * p.d - p.b * p.c || 1e-9;
  return { x: (p.d * ex - p.b * ey) / det, y: (-p.c * ex + p.a * ey) / det, rotation: f.rotation + f.sign * degrees };
}
