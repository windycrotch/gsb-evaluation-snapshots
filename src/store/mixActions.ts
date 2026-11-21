/** The mix table of the Preview window: how long the crossfade between two animations lasts. */
import type { Id, Project } from '@/core/model';
import { cleanMixes, withDefaultMix, withMix } from '@/core/preview';
import { docStore } from './doc';

function commit(d: Project, next: ReturnType<typeof withMix>) {
  const clean = cleanMixes(next, new Set(d.skeleton.animations.map((a) => a.id)));
  if (clean) d.mixes = clean;
  else delete d.mixes;
}

/** The crossfade time for pairs that have no entry of their own. */
export function setDefaultMix(time: number) {
  docStore.update('Default mix', (d) => commit(d, withDefaultMix(d.mixes, time)));
}

/** The crossfade time from one animation to another (a time equal to the default removes the entry). */
export function setMixPair(from: Id, to: Id, time: number) {
  if (from === to) return;
  docStore.update('Mix time', (d) => commit(d, withMix(d.mixes, from, to, time)));
}
