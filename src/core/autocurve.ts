/**
 * Automatic curves (the "Automatic" bezier of Spine's graph): the handles of the chosen keys are set so the curve runs smoothly through
 * them, with the slope at a key taken from its two neighbours. The slope is kept monotone: at a peak or a valley the handle is flat and a
 * curve never swings past the value of a key (no overshoot between keys), which is what a hand-pulled smooth curve usually wants.
 */

export interface AutoKey {
  time: number;
  value?: number[];
  curve?: unknown;
}

/** The slope of a channel at key `i`: from both neighbours, zero at a peak, never steeper than 3x either side. */
export function autoSlope(times: readonly number[], values: readonly number[], i: number): number {
  const last = values.length - 1;
  const seg = (a: number, b: number) => (values[b] - values[a]) / (times[b] - times[a] || 1);
  if (last < 1) return 0;
  if (i === 0) return seg(0, 1);
  if (i === last) return seg(last - 1, last);
  const d0 = seg(i - 1, i);
  const d1 = seg(i, i + 1);
  if (d0 * d1 <= 0) return 0;
  const s = (values[i + 1] - values[i - 1]) / (times[i + 1] - times[i - 1] || 1);
  const cap = 3 * Math.min(Math.abs(d0), Math.abs(d1));
  return Math.sign(s) * Math.min(Math.abs(s), cap);
}

/**
 * Sets the handles of the keys at `indices` (positions in `keys`, which is one timeline in time order) to the automatic ones. Each such key
 * gets its outgoing handle on its own curve and its incoming handle written onto the curve of the key before it. A segment that is stepped
 * stays stepped. Keys without values (events, pictures) are left alone. Returns how many keys were changed.
 */
export function autoCurve(keys: AutoKey[], indices: readonly number[]): number {
  const valued = keys.every((k) => Array.isArray(k.value));
  if (!valued || keys.length < 2) return 0;
  const channels = keys[0].value!.length;
  if (keys.some((k) => k.value!.length !== channels)) return 0;
  const times = keys.map((k) => k.time);
  const curveOf = (k: AutoKey): number[] | null => {
    if (k.curve === 'stepped') return null;
    if (!Array.isArray(k.curve)) {
      const fresh: number[] = [];
      for (let c = 0; c < channels; c++) fresh.push(1 / 3, 1 / 3, 2 / 3, 2 / 3);
      k.curve = fresh;
    }
    return k.curve as number[];
  };
  let changed = 0;
  for (const i of new Set(indices)) {
    if (i < 0 || i >= keys.length) continue;
    const out = i < keys.length - 1 ? curveOf(keys[i]) : null;
    const inc = i > 0 ? curveOf(keys[i - 1]) : null;
    if (!out && !inc) continue;
    for (let c = 0; c < channels; c++) {
      const values = keys.map((k) => k.value![c]);
      const s = autoSlope(times, values, i);
      if (out) {
        const dt = times[i + 1] - times[i];
        const dv = values[i + 1] - values[i];
        out[c * 4] = 1 / 3;
        out[c * 4 + 1] = dv !== 0 ? (s * dt) / 3 / dv : 0;
      }
      if (inc) {
        const dt = times[i] - times[i - 1];
        const dv = values[i] - values[i - 1];
        inc[c * 4 + 2] = 2 / 3;
        inc[c * 4 + 3] = dv !== 0 ? 1 - (s * dt) / 3 / dv : 1;
      }
    }
    changed++;
  }
  return changed;
}
