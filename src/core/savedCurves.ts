/**
 * Saved easing curves: a bezier a person liked on a key can be kept under a name and put on other keys later (Rive's users ask for
 * exactly this: "save easing curves", it would speed the work up a lot). A curve is the four numbers of one channel: the two handles
 * (x1, y1, x2, y2) of the segment, the way a key stores them.
 */

export type CurveNumbers = [number, number, number, number];

export interface SavedCurve {
  name: string;
  curve: CurveNumbers;
}

/** The most curves kept: the oldest one goes when a new one comes. */
export const MAX_SAVED_CURVES = 12;
const MAX_CURVE_NAME = 24;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A handle's x lies between the keys (0 to 1), its y may leave the range a little (overshoot, anticipation) but not run away. */
export function validCurve(c: unknown): c is CurveNumbers {
  return (
    Array.isArray(c) &&
    c.length === 4 &&
    c.every(finite) &&
    c[0] >= 0 &&
    c[0] <= 1 &&
    c[2] >= 0 &&
    c[2] <= 1 &&
    Math.abs(c[1]) <= 5 &&
    Math.abs(c[3]) <= 5
  );
}

/** The curve of the first channel of a key's `curve` field, when it is a bezier; null for linear (no curve), stepped or a malformed value. */
export function curveOfKey(curve: unknown): CurveNumbers | null {
  if (!Array.isArray(curve) || curve.length < 4 || curve.length % 4 !== 0) return null;
  const first = curve.slice(0, 4);
  return validCurve(first) ? first : null;
}

const same = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 1e-4);

/** The saved curves from anything (a settings file): only well formed entries, names trimmed and made unique, at most the limit. */
export function cleanSavedCurves(raw: unknown): SavedCurve[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedCurve[] = [];
  const names = new Set<string>();
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const { name, curve } = e as { name?: unknown; curve?: unknown };
    if (typeof name !== 'string' || !validCurve(curve)) continue;
    if (out.some((o) => same(o.curve, curve))) continue;
    let n = name.trim().slice(0, MAX_CURVE_NAME) || 'Curve';
    for (let i = 2; names.has(n); i++) n = `${n.slice(0, MAX_CURVE_NAME - 3)} ${i}`;
    names.add(n);
    out.push({ name: n, curve: [curve[0], curve[1], curve[2], curve[3]] });
  }
  return out.slice(-MAX_SAVED_CURVES);
}

/** The list with `curve` added under `name` (or "Curve N"); a curve that is already in the list is not added twice. */
export function withSavedCurve(list: readonly SavedCurve[], curve: CurveNumbers, name?: string): SavedCurve[] {
  if (!validCurve(curve) || list.some((c) => same(c.curve, curve))) return [...list];
  let n = 1;
  while (list.some((c) => c.name === `Curve ${n}`)) n++;
  return cleanSavedCurves([...list, { name: name?.trim() || `Curve ${n}`, curve }]);
}
