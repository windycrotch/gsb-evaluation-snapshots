/**
 * Sequences: a region or mesh whose picture changes frame by frame (flames, smoke, a blinking eye drawn as pictures).
 * The frame names, the frame a key shows at a time, and the pictures an attachment needs. Same rules as Spine's runtime
 * (Sequence.getPath, SequenceTimeline.applyToSlot) so what the editor plays is what an engine plays.
 */
import type { Attachment, SequenceDef, SequenceKey, SequenceMode } from './model';
import { SEQUENCE_MODES } from './model';

/** The name of the picture of frame `index`: the path with the number (start + index) added, zero padded to `digits`. */
export function sequenceFramePath(path: string, seq: SequenceDef, index: number): string {
  const frame = String(seq.start + index);
  return path + '0'.repeat(Math.max(0, seq.digits - frame.length)) + frame;
}

/** Every picture name of a sequence, frame 0 first. */
export function sequenceFrameNames(path: string, seq: SequenceDef): string[] {
  return Array.from({ length: seq.count }, (_, i) => sequenceFramePath(path, seq, i));
}

/** The frame to show for a slot's sequence index: -1 (no key active) is the setup frame, and a frame past the end is the last one. */
export function resolveSequenceIndex(seq: SequenceDef, index: number): number {
  let i = index === -1 ? seq.setupIndex : index;
  if (i >= seq.count) i = seq.count - 1;
  return Math.max(0, i);
}

/**
 * The sequence index at `time` for the keys of a timeline (the official SequenceTimeline): -1 before the first key, else the key's
 * index moved on by the time since the key (one step per `delay` seconds) in the key's mode.
 */
export function sequenceIndexAt(keys: readonly SequenceKey[], time: number, count: number): number {
  if (!keys.length || time < keys[0].time) return -1;
  let at = 0;
  for (let i = 0; i < keys.length; i++) if (keys[i].time <= time) at = i;
  const key = keys[at];
  let index = key.index;
  if (key.mode === 'hold') return index;
  // the official loader truncates with `| 0`: a delay of 0 gives infinity or NaN there, which is 0
  index += ((time - key.time) / key.delay + 0.00001) | 0;
  switch (key.mode) {
    case 'once':
      return Math.min(count - 1, index);
    case 'loop':
      return index % count;
    case 'pingpong': {
      const n = (count << 1) - 2;
      index = n === 0 ? 0 : index % n;
      return index >= count ? n - index : index;
    }
    case 'onceReverse':
      return Math.max(count - 1 - index, 0);
    case 'loopReverse':
      return count - 1 - (index % count);
    case 'pingpongReverse': {
      const n = (count << 1) - 2;
      index = n === 0 ? 0 : (index + count - 1) % n;
      return index >= count ? n - index : index;
    }
  }
}

/** A stretch of time in which a sequence shows one frame. */
export interface SequenceSpan {
  start: number;
  end: number;
  /** The frame (0 is the first), already inside the sequence. */
  index: number;
}

/**
 * Where each frame of a sequence shows between `from` and `to` seconds, from the keys of its timeline: a span per frame, with the time
 * before the first key left out (the setup frame shows there). It follows `sequenceIndexAt`, so the thumbnails on the timeline show what
 * plays. A span past the last key runs to `end` (the animation's duration). At most `limit` spans are made, so a very small delay stays cheap.
 */
export function sequenceSpans(keys: readonly SequenceKey[], count: number, end: number, from = 0, to = end, limit = 2000): SequenceSpan[] {
  const out: SequenceSpan[] = [];
  const push = (start: number, stop: number) => {
    const a = Math.max(start, from);
    const b = Math.min(stop, to, end);
    if (b <= a) return;
    const index = Math.min(count - 1, Math.max(0, sequenceIndexAt(keys, (a + b) / 2, count)));
    const last = out[out.length - 1];
    if (last && last.index === index && Math.abs(last.end - a) < 1e-9) last.end = b;
    else out.push({ start: a, end: b, index });
  };
  for (let i = 0; i < keys.length && out.length < limit; i++) {
    const key = keys[i];
    const stop = i + 1 < keys.length ? keys[i + 1].time : end;
    if (stop <= from || key.time >= to) continue;
    if (key.mode === 'hold' || !(key.delay > 0)) {
      push(key.time, stop);
      continue;
    }
    // the frame number moves on every `delay` seconds (the official loader adds a little to the quotient before it truncates)
    const startOf = (n: number) => (n <= 0 ? key.time : key.time + (n - 0.00001) * key.delay);
    const n0 = Math.max(0, Math.floor((Math.max(from, key.time) - key.time) / key.delay) - 1);
    for (let n = n0; out.length < limit; n++) {
      const a = startOf(n);
      if (a >= stop || a >= to) break;
      push(a, Math.min(startOf(n + 1), stop));
    }
  }
  return out;
}

/** The sequence of an attachment, if it has one (only a region or a mesh can). */
export const sequenceOf = (a: Attachment | undefined | null): SequenceDef | undefined =>
  a && (a.type === 'region' || a.type === 'mesh') ? a.sequence : undefined;

/** The pictures an attachment is drawn with: every frame of its sequence, or its one picture, or none. */
export function attachmentPictures(a: Attachment): string[] {
  if (a.type !== 'region' && a.type !== 'mesh') return [];
  return a.sequence ? sequenceFrameNames(a.path, a.sequence) : [a.path];
}

/** The picture shown in the setup pose (the setup frame of a sequence), or null for an attachment without one. */
export function setupPicture(a: Attachment): string | null {
  if (a.type !== 'region' && a.type !== 'mesh') return null;
  return a.sequence ? sequenceFramePath(a.path, a.sequence, resolveSequenceIndex(a.sequence, -1)) : a.path;
}

const isSequenceMode = (v: unknown): v is SequenceMode => (SEQUENCE_MODES as readonly unknown[]).includes(v);

/** A sequence key from anything: a mode that is not known is hold, a negative or fractional index is made whole, a delay is never negative. */
export function cleanSequenceKey(k: Partial<SequenceKey>): SequenceKey {
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    time: Math.max(0, num(k.time, 0)),
    mode: isSequenceMode(k.mode) ? k.mode : 'hold',
    index: Math.max(0, Math.trunc(num(k.index, 0))),
    delay: Math.max(0, num(k.delay, 0)),
  };
}

/** A whole, in-range sequence from anything (a count of at least 1, a setup frame inside it). */
export function cleanSequence(s: Partial<SequenceDef> | undefined): SequenceDef {
  const int = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : fallback;
  const count = int(s?.count, 1, 1, 10000);
  return { count, start: int(s?.start, 1, 0, 1000000), digits: int(s?.digits, 0, 0, 9), setupIndex: int(s?.setupIndex, 0, 0, count - 1) };
}

/**
 * Finds a numbered series of pictures ("flame01", "flame02", …) that an attachment's picture belongs to. `path` is the name of one picture
 * of the series (or its start, "flame"); the result has the start of the names as the new path and the sequence that covers the run of
 * consecutive numbers around it. Null when there are fewer than two pictures in the run.
 */
export function detectSequence(imageNames: readonly string[], path: string): { path: string; sequence: SequenceDef } | null {
  const m = /^(.*?)(\d+)$/.exec(path);
  const base = m ? m[1] : path;
  const own = m ? parseInt(m[2], 10) : null;
  const names = new Set(imageNames);
  const tails: { k: number; digits: number }[] = [];
  const digitOptions = new Set<number>([0]);
  for (const n of imageNames) {
    if (!n.startsWith(base)) continue;
    const rest = n.slice(base.length);
    if (/^\d+$/.test(rest)) {
      tails.push({ k: parseInt(rest, 10), digits: rest.length });
      if (rest.length > 1 && rest[0] === '0') digitOptions.add(rest.length);
    }
  }
  let best: { start: number; count: number; digits: number; has: boolean } | null = null;
  for (const digits of digitOptions) {
    const nameOf = (k: number) => base + '0'.repeat(Math.max(0, digits - String(k).length)) + k;
    const ks = [...new Set(tails.map((t) => t.k))].filter((k) => names.has(nameOf(k))).sort((a, b) => a - b);
    for (let i = 0; i < ks.length;) {
      let j = i;
      while (j + 1 < ks.length && ks[j + 1] === ks[j] + 1) j++;
      const run = { start: ks[i], count: j - i + 1, digits, has: own !== null && own >= ks[i] && own <= ks[j] };
      if (!best || (run.has && !best.has) || (run.has === best.has && run.count > best.count)) best = run;
      i = j + 1;
    }
  }
  if (!best || best.count < 2) return null;
  const setupIndex = own !== null && best.has ? own - best.start : 0;
  return { path: base, sequence: { count: best.count, start: best.start, digits: best.digits, setupIndex } };
}
