/**
 * Markers on the timeline of an animation (a name, a colour and a note at a time), and what they make possible: cutting one long
 * animation into several clips at the markers. Pure functions over the document.
 */
import { SAME_EPS } from './math';
import { sampleKeys } from './curve';
import { uid } from './ids';
import { MARKER_COLORS, newAnimation } from './model';
import type { Animation, Id, Marker } from './model';

/** The markers of an animation, in time order. */
export const markersOf = (anim: Pick<Animation, 'markers'> | null | undefined): Marker[] =>
  [...(anim?.markers ?? [])].sort((a, b) => a.time - b.time);

/** Markers from anything: only well-formed ones, times inside the animation, a palette colour, text where text belongs. */
export function cleanMarkers(raw: unknown, duration: number): Marker[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Marker[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Partial<Marker>;
    if (!Number.isFinite(r.time)) continue;
    let id = typeof r.id === 'string' && r.id ? r.id : uid();
    if (seen.has(id)) id = uid();
    seen.add(id);
    const color = Number.isInteger(r.color) ? Math.min(Math.max(0, r.color as number), MARKER_COLORS - 1) : 0;
    const marker: Marker = {
      id,
      time: Math.min(Math.max(0, r.time as number), Math.max(0, duration)),
      name: typeof r.name === 'string' ? r.name : '',
      color,
      text: typeof r.text === 'string' ? r.text : '',
    };
    if (r.review === true) {
      marker.review = true;
      if (typeof r.author === 'string') marker.author = r.author;
      if (typeof r.bone === 'string') marker.bone = r.bone;
      marker.resolved = r.resolved === true;
    }
    out.push(marker);
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Adds a marker (at the time of one that is there already: replaces its text). Returns the marker. */
export function addMarker(anim: Animation, time: number, name = '', color = 0, text = ''): Marker {
  const list = (anim.markers ??= []);
  const t = Math.max(0, time);
  const here = list.find((m) => Math.abs(m.time - t) < SAME_EPS);
  if (here) return here;
  const m: Marker = { id: uid(), time: t, name, color, text };
  list.push(m);
  list.sort((a, b) => a.time - b.time);
  return m;
}

export function removeMarker(anim: Animation, id: Id): boolean {
  const i = anim.markers?.findIndex((m) => m.id === id) ?? -1;
  if (i < 0) return false;
  anim.markers!.splice(i, 1);
  if (!anim.markers!.length) delete anim.markers;
  return true;
}

/** The marker within `tolerance` seconds of a time (the closest one), or undefined. */
export function markerNear(anim: Pick<Animation, 'markers'> | null | undefined, time: number, tolerance: number): Marker | undefined {
  let best: Marker | undefined;
  for (const m of anim?.markers ?? [])
    if (Math.abs(m.time - time) <= tolerance && (!best || Math.abs(m.time - time) < Math.abs(best.time - time))) best = m;
  return best;
}

/** The nearest marker before (`dir` -1) or after (+1) a time, or null. */
export function neighbourMarker(anim: Animation | null | undefined, time: number, dir: 1 | -1): Marker | null {
  const list = markersOf(anim);
  return (dir > 0 ? list.find((m) => m.time > time + SAME_EPS) : [...list].reverse().find((m) => m.time < time - SAME_EPS)) ?? null;
}

type AnyKey = { time: number; value?: number[]; curve?: unknown };

/**
 * The keys of one timeline that fall in [t0, t1], moved so t0 is time 0. A number timeline gets keys exactly at the cut edges (sampled where
 * the original passes through them), so the piece moves like the original did. A timeline of states (attachment, draw order, sequence) starts with
 * the state in force at t0. `events` are only the ones inside: [t0, t1) (the end belongs to the next piece unless it is the last one).
 */
function cutKeys<T extends AnyKey>(
  keys: T[],
  t0: number,
  t1: number,
  kind: 'number' | 'colour' | 'state' | 'event',
  lastPiece: boolean,
): T[] {
  const inside = keys.filter(
    (k) => k.time >= t0 - SAME_EPS && (kind === 'event' && !lastPiece ? k.time < t1 - SAME_EPS : k.time <= t1 + SAME_EPS),
  );
  const shifted = inside.map((k) => ({ ...structuredClone(k), time: Math.max(0, k.time - t0) }));
  if (kind === 'event' || !keys.length) return shifted;
  const active = [...keys].reverse().find((k) => k.time <= t0 + SAME_EPS);
  if (kind === 'state') {
    if (active && !inside.some((k) => Math.abs(k.time - t0) < SAME_EPS)) shifted.unshift({ ...structuredClone(active), time: 0 });
    return shifted;
  }
  // numbers: sampled keys at both edges
  const sample = (t: number): number[] | null => {
    const out: number[] = [];
    if (!sampleKeys(keys as never, t, out)) return null;
    const v = out.slice(0, (keys[0].value ?? []).length);
    // a colour never shows outside 0..1 (and the export cannot write it), so an overshooting curve is cut where the piece starts
    return kind === 'colour' ? v.map((x) => Math.min(1, Math.max(0, x))) : v;
  };
  if (!inside.some((k) => Math.abs(k.time - t0) < SAME_EPS)) {
    const v = sample(t0);
    if (v && active) {
      const copy = structuredClone(active) as AnyKey;
      copy.value = v;
      copy.time = 0;
      // a bezier of the original does not fit the shorter piece; a stepped one still does
      if (copy.curve !== 'stepped') delete copy.curve;
      shifted.unshift(copy as T);
    }
  }
  if (!inside.some((k) => Math.abs(k.time - t1) < SAME_EPS) && keys.some((k) => k.time > t1 + SAME_EPS)) {
    const v = sample(t1);
    if (v && active !== undefined) {
      const end = structuredClone(keys[keys.length - 1]) as AnyKey;
      end.value = v;
      end.time = t1 - t0;
      delete end.curve;
      shifted.push(end as T);
    }
  }
  return shifted;
}

/** A copy of the part [t0, t1] of an animation as an animation of its own (editor data other than the keys, like the play settings, is not carried). */
export function cutAnimation(anim: Animation, t0: number, t1: number, name: string, lastPiece = false): Animation {
  const out = newAnimation(name, Math.max(0, t1 - t0));
  const nums = (k: AnyKey[] | undefined) => (k?.length ? cutKeys(k, t0, t1, 'number', lastPiece) : []);
  const states = (k: AnyKey[] | undefined) => (k?.length ? cutKeys(k, t0, t1, 'state', lastPiece) : []);
  const keep = <T>(v: T[]): T[] | undefined => (v.length ? v : undefined);

  for (const [id, tl] of Object.entries(anim.bones)) {
    const piece: Record<string, AnyKey[]> = {};
    for (const [prop, keys] of Object.entries(tl as Record<string, AnyKey[] | undefined>)) {
      const cut = nums(keys);
      if (cut.length) piece[prop] = cut;
    }
    if (Object.keys(piece).length) out.bones[id] = piece;
  }
  for (const [id, tl] of Object.entries(anim.slots)) {
    const piece: Record<string, AnyKey[]> = {};
    if (tl.attachment) piece.attachment = states(tl.attachment);
    const colours = (k: AnyKey[] | undefined) => (k?.length ? cutKeys(k, t0, t1, 'colour', lastPiece) : []);
    if (tl.rgba) piece.rgba = colours(tl.rgba);
    if (tl.rgba2) piece.rgba2 = colours(tl.rgba2);
    for (const p of Object.keys(piece)) if (!piece[p].length) delete piece[p];
    if (Object.keys(piece).length) out.slots[id] = piece;
  }
  for (const [id, keys] of Object.entries(anim.ik)) {
    const cut = nums(keys);
    if (cut.length) out.ik[id] = cut as never;
  }
  for (const [id, keys] of Object.entries(anim.transform ?? {})) {
    const cut = nums(keys);
    if (cut.length) out.transform[id] = cut as never;
  }
  const groups: ('slider' | 'path' | 'physics')[] = ['slider', 'path', 'physics'];
  for (const g of groups) {
    for (const [id, tl] of Object.entries(anim[g] ?? {})) {
      const piece: Record<string, AnyKey[]> = {};
      for (const [prop, keys] of Object.entries(tl as Record<string, AnyKey[] | undefined>)) {
        const cut = prop === 'reset' ? (keys ? cutKeys(keys, t0, t1, 'event', lastPiece) : []) : nums(keys);
        if (cut.length) piece[prop] = cut;
      }
      if (Object.keys(piece).length) (out[g] as Record<Id, unknown>)[id] = piece;
    }
  }
  for (const [skin, perSlot] of Object.entries(anim.deform ?? {})) {
    for (const [slot, perAtt] of Object.entries(perSlot)) {
      for (const [att, keys] of Object.entries(perAtt)) {
        const cut = nums(keys);
        if (cut.length) ((out.deform[skin] ??= {})[slot] ??= {})[att] = cut as never;
      }
    }
  }
  for (const [skin, perSlot] of Object.entries(anim.sequence ?? {})) {
    for (const [slot, perAtt] of Object.entries(perSlot)) {
      for (const [att, keys] of Object.entries(perAtt)) {
        const cut = states(keys);
        if (cut.length) (((out.sequence ??= {})[skin] ??= {})[slot] ??= {})[att] = cut as never;
      }
    }
  }
  out.drawOrder = (keep(states(anim.drawOrder as unknown as AnyKey[])) ?? []) as never;
  for (const [id, keys] of Object.entries(anim.drawOrderFolder ?? {})) {
    const cut = states(keys);
    if (cut.length) (out.drawOrderFolder ??= {})[id] = cut as never;
  }
  out.events = cutKeys(anim.events as unknown as AnyKey[], t0, t1, 'event', lastPiece) as never;
  return out;
}

export interface SplitPiece {
  from: number;
  to: number;
  name: string;
}

/**
 * The pieces the markers cut an animation into: from the start to the first marker, between markers, and from the last marker to the end;
 * a piece is named after the marker it starts at (the first one keeps the animation's own name). Pieces shorter than `minLength` are left out.
 */
export function splitPieces(anim: Animation, minLength = 1e-3): SplitPiece[] {
  const marks = markersOf(anim).filter((m) => m.time > SAME_EPS && m.time < anim.duration - SAME_EPS);
  const edges = [
    { time: 0, name: anim.name },
    ...marks.map((m, i) => ({ time: m.time, name: m.name.trim() || `${anim.name} ${i + 2}` })),
    { time: anim.duration, name: '' },
  ];
  const pieces: SplitPiece[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    if (edges[i + 1].time - edges[i].time >= minLength) pieces.push({ from: edges[i].time, to: edges[i + 1].time, name: edges[i].name });
  }
  return pieces;
}

/** The animations the markers cut `anim` into (new ids, unique names among `taken`). The first piece is named `<name> 1` when the markers split it. */
export function splitAtMarkers(anim: Animation, taken: Iterable<string>): Animation[] {
  const pieces = splitPieces(anim);
  if (pieces.length < 2) return [];
  const used = new Set(taken);
  const unique = (base: string) => {
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base} ${i}`;
    used.add(n);
    return n;
  };
  return pieces.map((p, i) => {
    const piece = cutAnimation(anim, p.from, p.to, unique(i === 0 ? `${anim.name} 1` : p.name), i === pieces.length - 1);
    const marks = markersOf(anim).filter((m) => m.time >= p.from - SAME_EPS && m.time <= p.to + SAME_EPS && m.time > p.from + SAME_EPS);
    if (marks.length) piece.markers = marks.map((m) => ({ ...m, id: uid(), time: m.time - p.from }));
    return piece;
  });
}
