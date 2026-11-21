/**
 * Colours of the bones a mesh is bound to (Spine's weights view: Pies and Overlay). Every bound bone gets its own hue by its place in the
 * skeleton's bone order, spread by the golden angle so neighbours differ, and the colour of a bone does not change while the weights do.
 */
import type { Id, Influence } from '@/core/model';

/** The bones a weighted mesh follows, in the order of the skeleton's bones. */
export function boundBones(weights: readonly (readonly Influence[])[], order: readonly Id[]): Id[] {
  const used = new Set<Id>();
  for (const list of weights) for (const e of list) used.add(e[0]);
  return order.filter((b) => used.has(b));
}

/** r, g, b in 0..1 for the bone at `index` of the bound bones. */
export function boneRgb(index: number): [number, number, number] {
  const h = ((index * 137.508 + 20) % 360) / 360;
  const s = 0.72;
  const l = 0.55;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

export function boneCss(index: number, alpha = 1): string {
  const [r, g, b] = boneRgb(index);
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${alpha})`;
}

/**
 * Per-vertex colour for Overlay: the colours of the bones weighted by their weights. With `only` (Selected) the bones outside it are black.
 * Returns r, g, b, a per vertex.
 */
export function overlayColors(
  weights: readonly (readonly Influence[])[],
  bound: readonly Id[],
  only: ReadonlySet<Id> | null,
  alpha = 0.62,
): number[] {
  const index = new Map(bound.map((b, i) => [b, i] as const));
  const out = new Array<number>(weights.length * 4);
  for (let v = 0; v < weights.length; v++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const e of weights[v]) {
      if (only && !only.has(e[0])) continue;
      const c = boneRgb(index.get(e[0]) ?? 0);
      r += c[0] * e[3];
      g += c[1] * e[3];
      b += c[2] * e[3];
    }
    out[v * 4] = r;
    out[v * 4 + 1] = g;
    out[v * 4 + 2] = b;
    out[v * 4 + 3] = alpha;
  }
  return out;
}

/** Which vertices a pie is drawn for: all of them, or with Selected only the picked vertices and those weighted to a picked bone. */
export function pieVertices(
  weights: readonly (readonly Influence[])[],
  pickedVertices: ReadonlySet<number>,
  pickedBones: ReadonlySet<Id>,
  selectedOnly: boolean,
): number[] {
  const out: number[] = [];
  for (let v = 0; v < weights.length; v++) {
    if (!selectedOnly || pickedVertices.has(v) || weights[v].some((e) => e[3] > 0 && pickedBones.has(e[0]))) out.push(v);
  }
  return out;
}
