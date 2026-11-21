/**
 * The mix table (crossfade times between animations) as a small JSON file for the game: Spine keeps mixes in the runtime's AnimationStateData
 * (`defaultMix`, `setMix(from, to, duration)`), not in the skeleton file, so without this file the numbers set in the editor are retyped by hand.
 */
import type { Animation, Id } from '../model';

export interface MixTable {
  default: number;
  pairs: { from: Id; to: Id; time: number }[];
}

/** The text of the file, or null when the table says nothing (default 0, no pairs among the exported animations). */
export function mixesToText(animations: readonly Pick<Animation, 'id' | 'name'>[], mixes: MixTable | undefined | null): string | null {
  if (!mixes) return null;
  const name = new Map(animations.map((a) => [a.id, a.name] as const));
  const list = mixes.pairs
    .filter((p) => name.has(p.from) && name.has(p.to) && Number.isFinite(p.time))
    .map((p) => ({ from: name.get(p.from)!, to: name.get(p.to)!, duration: Math.round(p.time * 1e5) / 1e5 }));
  const defaultMix = Number.isFinite(mixes.default) ? Math.round(mixes.default * 1e5) / 1e5 : 0;
  if (!list.length && defaultMix === 0) return null;
  return (
    JSON.stringify(
      {
        kind: 'bone2d-mixes',
        note: 'For the runtime: AnimationStateData.defaultMix and setMix(from, to, duration).',
        defaultMix,
        mixes: list,
      },
      null,
      2,
    ) + '\n'
  );
}
