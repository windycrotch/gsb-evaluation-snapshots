import { dropSequenceTimeline, upsertKey } from '@/core/edit';
import type { Id, SequenceDef, SequenceKey } from '@/core/model';
import { cleanSequence, cleanSequenceKey, detectSequence, sequenceFrameNames, setupPicture } from '@/core/sequence';
import { addImageToScene, currentAnimation, extendDuration } from './actions';
import { docStore } from './doc';
import { toast, uiStore } from './ui';

/** Gives the region or mesh of the default skin a sequence, changes it, or (null) takes it away together with its keys. */
export function setSequence(slotId: Id, name: string, def: SequenceDef | null): boolean {
  let done = false;
  docStore.update(def ? 'Edit sequence' : 'Remove sequence', (d) => {
    const att = d.skeleton.skins[0]?.attachments[slotId]?.[name];
    if (!att || (att.type !== 'region' && att.type !== 'mesh')) return;
    if (def) att.sequence = cleanSequence(def);
    else {
      att.path = setupPicture(att) ?? att.path; // it keeps showing the picture of its setup frame
      delete att.sequence;
      for (const a of d.skeleton.animations) dropSequenceTimeline(a, slotId, name);
    }
    done = true;
  });
  return done;
}

/**
 * Makes a sequence out of a numbered series of pictures ("flame01" … "flame08"): the picture of the attachment gives the series, its
 * number the setup frame. Without such a series nothing changes. Returns the frame count (0 when there is none).
 */
export function makeSequence(slotId: Id, name: string): number {
  const project = docStore.get();
  const att = project.skeleton.skins[0]?.attachments[slotId]?.[name];
  if (!att || (att.type !== 'region' && att.type !== 'mesh')) return 0;
  const found = detectSequence(
    project.images.map((i) => i.name),
    att.path,
  );
  if (!found) {
    toast('No numbered pictures were found: import pictures named like flame01, flame02… and try again', 'info');
    return 0;
  }
  docStore.update('Make a sequence', (d) => {
    const a = d.skeleton.skins[0].attachments[slotId][name];
    if (a.type !== 'region' && a.type !== 'mesh') return;
    a.path = found.path;
    a.sequence = found.sequence;
  });
  toast(`Sequence of ${found.sequence.count} pictures`, 'ok');
  return found.sequence.count;
}

/** Finds the series again for an attachment that already has a sequence (after pictures were added). Returns the frame count, or 0 when there is none. */
export function findFrames(slotId: Id, name: string): number {
  const project = docStore.get();
  const att = project.skeleton.skins[0]?.attachments[slotId]?.[name];
  if (!att || (att.type !== 'region' && att.type !== 'mesh') || !att.sequence) return 0;
  const found = detectSequence(
    project.images.map((i) => i.name),
    att.path,
  );
  if (!found) {
    toast('No numbered pictures were found', 'info');
    return 0;
  }
  docStore.update('Find frames', (d) => {
    const a = d.skeleton.skins[0].attachments[slotId][name];
    if (a.type !== 'region' && a.type !== 'mesh') return;
    a.path = found.path;
    a.sequence = found.sequence;
  });
  return found.sequence.count;
}

/** The sequence key that is in force at the playhead (the one on it, or the last one before it). */
export function sequenceKeyAt(slotId: Id, name: string, time: number): SequenceKey | undefined {
  const anim = currentAnimation();
  const skin = docStore.get().skeleton.skins[0];
  const keys = anim?.sequence?.[skin?.id ?? '']?.[slotId]?.[name];
  if (!keys) return undefined;
  let at: SequenceKey | undefined;
  for (const k of keys) if (k.time <= time + 1e-4) at = k;
  return at;
}

/** Keys the sequence of an attachment at the playhead of the current animation (Animate mode). What `patch` leaves out comes from the key in force, else a one picture a frame hold. */
export function keySequence(slotId: Id, name: string, patch: Partial<Omit<SequenceKey, 'time'>> = {}) {
  const anim = currentAnimation();
  const ui = uiStore.get();
  if (!anim || ui.mode !== 'animate') return;
  const fps = docStore.get().skeleton.fps;
  const before = sequenceKeyAt(slotId, name, ui.time);
  docStore.update('Key sequence', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    const skin = d.skeleton.skins[0];
    const att = skin?.attachments[slotId]?.[name];
    if (!a || !skin || !att || (att.type !== 'region' && att.type !== 'mesh') || !att.sequence) return;
    const key = cleanSequenceKey({
      time: ui.time,
      mode: before?.mode ?? 'hold',
      index: before?.index ?? 0,
      delay: before?.delay ?? 1 / fps,
      ...patch,
    });
    const keys = ((((a.sequence ??= {})[skin.id] ??= {})[slotId] ??= {})[name] ??= []);
    upsertKey(keys, key);
    extendDuration(a, ui.time);
  });
}

/**
 * Pictures of a dropped folder that make numbered series (frame01 … frame24) are put on the scene as a slot with a sequence each, instead of a
 * slot per frame. One history step (unless `ownStep` is off: the caller has a step open). Returns how many series were placed (0: nothing in the folder is a series, nothing was changed).
 */
export function placeSequences(names: readonly string[], worldX: number, worldY: number, ownStep = true): number {
  const consumed = new Set<string>();
  const series: { setup: string }[] = [];
  for (const first of names) {
    if (consumed.has(first)) continue;
    const found = detectSequence(names, first);
    if (!found) continue;
    const frames = sequenceFrameNames(found.path, found.sequence);
    if (!frames.every((f) => names.includes(f))) continue;
    for (const f of frames) consumed.add(f);
    series.push({ setup: frames[found.sequence.setupIndex] ?? frames[0] });
  }
  if (!series.length) return 0;
  if (ownStep) docStore.beginGesture('Add sequences');
  let off = 0;
  let made = 0;
  try {
    for (const s of series) {
      const placed = addImageToScene(s.setup, worldX + off, worldY - off);
      if (placed && makeSequence(placed.slotId, s.setup) > 0) made++;
      off += 24;
    }
  } finally {
    if (ownStep) docStore.endGesture();
  }
  return made;
}
