/**
 * The weight brush's fade: how much of its strength a vertex at distance `d` from the centre gets. Inside the hard core (the part of the size that
 * Feather leaves out) it is 1, then it falls to 0 at the radius along the chosen shape. Editor only.
 */
export type BrushShape = 'soft' | 'linear' | 'smooth' | 'sharp';

export const BRUSH_SHAPES: readonly BrushShape[] = ['soft', 'linear', 'smooth', 'sharp'];

/** The fade along the feather zone: `u` is 1 at the edge of the core and 0 at the radius. */
export function shapeCurve(u: number, shape: BrushShape): number {
  const v = Math.max(0, Math.min(1, u));
  if (shape === 'linear') return v;
  if (shape === 'smooth') return v * v * (3 - 2 * v);
  if (shape === 'sharp') return v * v * v;
  return Math.pow(v, 1.4); // soft: the brush as it always was
}

/**
 * How the strength slider maps to the strength the brush paints with. `linear` is the slider as it was; `fine` spends most of the slider on
 * the low end (10% paints 1%) for careful touch-ups; `bold` spends it on the high end (10% paints about 32%) for quick, strong strokes.
 */
export type StrengthCurve = 'linear' | 'fine' | 'bold';

export const STRENGTH_CURVES: readonly StrengthCurve[] = ['linear', 'fine', 'bold'];

/** The strength painted for a slider value (0 to 1; out of range is clamped). */
export function strengthAmount(strength: number, curve: StrengthCurve = 'linear'): number {
  const s = Math.max(0, Math.min(1, strength));
  if (curve === 'fine') return s * s;
  if (curve === 'bold') return Math.sqrt(s);
  return s;
}

/** `feather` is the percent of the radius that fades (100 from the centre, 0 a hard edge). Out of range, or a radius that is not positive, gives 0. */
export function brushFalloff(d: number, radius: number, feather: number, shape: BrushShape = 'soft'): number {
  if (!(radius > 0) || !(d <= radius)) return 0;
  const inner = radius * (1 - Math.max(0, Math.min(100, feather)) / 100);
  if (d <= inner) return 1;
  return shapeCurve(1 - (d - inner) / (radius - inner), shape);
}
