/** Mute timelines: the editor plays the animation without a bone's, slot's or constraint's keys (see core/mute). Session only. */
import type { Id } from '@/core/model';
import { uiStore } from './ui';

export function toggleMute(id: Id) {
  const cur = uiStore.get().muted;
  uiStore.patch({ muted: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
}

export function clearMute() {
  if (uiStore.get().muted.length) uiStore.patch({ muted: [] });
}
