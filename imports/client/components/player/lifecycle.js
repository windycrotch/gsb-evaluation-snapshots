import { each, isNumber } from 'lodash';

// Shared lifecycle state for the player.
//
// One sound goes through: edit/save -> evaluate -> replace playing tone,
// mute/unmute, delete -> stop + cleanup. This module holds the bookkeeping
// that keeps those transitions consistent:
//
// - appliedVersions: last-write-wins guard. Every save/mute bumps a version
//   on the sound document (server side); a snapshot arriving with an older
//   version than the one already applied must be ignored, whether it comes
//   from rapid successive saves or from another window.
// - deletedSounds: tombstones. Once a sound is deleted, no late update,
//   persistence call or mixer write-back may recreate anything for it.
// - playerGeneration: bumped when the player unmounts. Any transport task
//   (start / stop / dispose) scheduled before the unmount becomes a no-op.

let appliedVersions = {};
let deletedSounds = {};
let playerGeneration = 0;

export let getPlayerGeneration = () => playerGeneration;

export let isCurrentGeneration = gen => gen === playerGeneration;

// invalidate every task scheduled so far (called when the player unmounts)
export let killPlayerTasks = () => { playerGeneration++ };

export let isSoundDeleted = soundId => !!deletedSounds[soundId];

export let markSoundDeleted = soundId => { deletedSounds[soundId] = true };

// a sound snapshot is stale when a newer version was already applied
export let isStaleSound = sound => {
  if (!sound || !sound._id || !isNumber(sound.version)) return false
  let last = appliedVersions[sound._id]
  return isNumber(last) && sound.version <= last
};

// record the newest snapshot version seen for this sound (monotonic):
// called when a snapshot is applied, and also when one arrives that only
// bumped the version without audible changes — a later stale snapshot must
// still be recognized as such
export let markSoundApplied = sound => {
  if (!sound || !sound._id || !isNumber(sound.version)) return
  let last = appliedVersions[sound._id]
  if (!isNumber(last) || sound.version > last) appliedVersions[sound._id] = sound.version
};

// fresh player mount: forget versions/tombstones of the previous session
export let resetSoundLifecycle = () => {
  each(Object.keys(appliedVersions), k => delete appliedVersions[k])
  each(Object.keys(deletedSounds), k => delete deletedSounds[k])
};
