/** Finding the timelines of an animation: every list of keys (objects with a numeric `time`) inside a value. The one place that knows what a key list looks like. */
import type { Animation } from './model';

export type KeyList = { time: number }[];

/** The parts of an animation that hold keys. Its name, length, play settings and markers do not. */
const KEYED_PARTS = [
  'bones',
  'slots',
  'deform',
  'sequence',
  'ik',
  'transform',
  'slider',
  'path',
  'physics',
  'drawOrder',
  'drawOrderFolder',
  'events',
] as const;

/** Every key list inside `value` (records and arrays are walked; the list of keys itself is not). */
export function keyListsIn(value: unknown, out: KeyList[] = []): KeyList[] {
  if (Array.isArray(value)) {
    const first = value[0] as { time?: unknown } | undefined;
    if (first && typeof first === 'object' && typeof first.time === 'number') out.push(value as KeyList);
    else for (const v of value) keyListsIn(v, out);
  } else if (value && typeof value === 'object') for (const v of Object.values(value)) keyListsIn(v, out);
  return out;
}

/** Every timeline of the animation. */
export function keyLists(anim: Animation): KeyList[] {
  return keyListsIn(KEYED_PARTS.map((part) => anim[part]));
}
