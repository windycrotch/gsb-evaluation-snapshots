/** Events: the definitions and their keys. */
import { freshName } from '@/core/edit';
import { newAnimation } from '@/core/model';
import type { Id } from '@/core/model';
import { docStore } from './doc';
import { toast, uiStore } from './ui';
import { setMode } from './sessionActions';
import { currentAnimation, skeletonDoc } from './accessors';
import { extendDuration } from './boneActions';

export function createEvent(name?: string): Id {
  const doc = skeletonDoc();
  const id = newAnimation('x').id;
  docStore.update('New event', (d) => {
    d.skeleton.events.push({ id, name: freshName(name?.trim() || 'event', doc.events), int: 0, float: 0, string: '' });
  });
  return id;
}

export function updateEvent(
  id: Id,
  patch: Partial<{ name: string; int: number; float: number; string: string; audio: string; volume: number; balance: number }>,
) {
  const doc = skeletonDoc();
  docStore.update('Edit event', (d) => {
    const e = d.skeleton.events.find((x) => x.id === id);
    if (!e) return;
    if (patch.name !== undefined)
      e.name = freshName(
        patch.name.trim() || e.name,
        doc.events.filter((x) => x.id !== id),
      );
    if (patch.int !== undefined) e.int = Math.round(patch.int);
    if (patch.float !== undefined) e.float = patch.float;
    if (patch.string !== undefined) e.string = patch.string;
    if (patch.audio !== undefined) {
      const path = patch.audio.trim();
      if (path) e.audio = path;
      else {
        delete e.audio;
        delete e.volume;
        delete e.balance;
      }
    }
    if (e.audio) {
      if (patch.volume !== undefined) e.volume = Math.min(1, Math.max(0, patch.volume));
      if (patch.balance !== undefined) e.balance = Math.min(1, Math.max(-1, patch.balance));
    }
  });
}

export function deleteEvent(id: Id) {
  docStore.update('Delete event', (d) => {
    d.skeleton.events = d.skeleton.events.filter((e) => e.id !== id);
    for (const a of d.skeleton.animations) a.events = a.events.filter((k) => k.event !== id);
  });
}

/** Fires the event at the playhead of the current animation. */
export function keyEvent(eventId: Id) {
  const ui = uiStore.get();
  const anim = currentAnimation();
  if (!anim) {
    toast('Create an animation first');
    return;
  }
  if (ui.mode !== 'animate') setMode('animate');
  docStore.update('Key event', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    a.events.push({ time: uiStore.get().time, event: eventId });
    a.events.sort((x, y) => x.time - y.time);
    extendDuration(a, uiStore.get().time);
  });
}
