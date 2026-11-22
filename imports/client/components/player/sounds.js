import { Meteor } from 'meteor/meteor'
import Tone from 'tone';

import { evalCode } from '../code/evalCode';
import { stopTone, startTone, persistTone, initTonesModifiers } from './tones';
import {
  getPlayerGeneration, isCurrentGeneration,
  isSoundDeleted, markSoundDeleted, isStaleSound, markSoundApplied
} from './lifecycle';

import {filter, isFunction, reduce, intersection, indexOf, find, isEqual, each, get} from 'lodash';

window.tones = window.tones || []

// when sound is created or updated, call that function to generate its tone
export let updateSound = (sound, props) => {

  if (!sound || !sound._id) return {status: 'err', body: 'updateSound called without a sound'}

  // the sound was deleted: a late update must not recreate anything
  if (isSoundDeleted(sound._id)) return {status: 'deleted'}

  // last write wins: an older save/mute arriving after a newer one
  // (rapid saves or two windows editing the same sound) is dropped
  if (isStaleSound(sound)) return {status: 'stale'}
  markSoundApplied(sound)

  // 1. evaluate and validate the new code BEFORE touching the playing tone,
  //    so a failing save keeps the current sound alive
  let evaluated = null
  if (!sound.muted) {
    evaluated = evalCode(sound.code)
    if (evaluated.status === 'err') return evaluated
  }

  // 2. evaluation succeeded (or the sound is muted): swap the playing tone
  removeSound(sound, true)

  if (sound.muted) return {status:'ok'}

  let result = evaluated.body
  result = {soundId: sound._id, name: sound.name, tone: result.c, elementsToDispose: result.e, options: result.o}

  startTone(result.tone)

  window.tones.push(result)

  if (get(result, 'options.vars')) initTonesModifiers(result.options.vars)

  persistTone(result)

  return {status:'ok'}
}

// when tone get removed
// swap=true: internal replacement during an update (not a deletion)
export let removeSound = (sound, swap) => {
  let old = find(window.tones, {'soundId': sound._id})

  old && stopTone(old.tone)

  if (get(old, 'elementsToDispose')) {
    let gen = getPlayerGeneration()
    Tone.Transport.scheduleOnce(t => {
      // the player was unmounted since this cleanup was scheduled: drop it
      if (!isCurrentGeneration(gen)) return false
      each(old.elementsToDispose, e => {
        // if we have elementsToDispose, try to dispose them (tonejs)
        if (isFunction(e.dispose)) try { e.dispose() } catch (e) { console.log('error when dispose() :'+ e.message) }

        // then put them all equal to null to force the garbage collection process
        e = null
      })
    }, 1)
  }

  window.tones = filter(window.tones, t => t.soundId !== sound._id)
  Meteor.call('tones.removeFromSoundId', sound._id)

  // a real deletion (not a swap) tombstones the sound: no late update,
  // persistence or mixer write-back may recreate it afterwards
  if (!swap) markSoundDeleted(sound._id)
}
