import Tone from 'tone';
import teoria from 'teoria';
import { Meteor } from 'meteor/meteor'
import { each, filter, isFunction } from 'lodash';

import { evalCode } from '../code/evalCode';
import { stopTone, startTone, persistTone, initTonesModifiers } from './tones';
import { createSoundEngine } from './soundEngine';

// dispose the tonejs elements of a removed tone
const disposeElements = (elementsToDispose) => {
  Tone.Transport.scheduleOnce(t => {
    each(elementsToDispose, e => {
      // if we have elementsToDispose, try to dispose them (tonejs)
      if (isFunction(e.dispose)) try { e.dispose() } catch (err) { console.log('error when dispose() :' + err.message) }

      // then put them all equal to null to force the garbage collection process
      e = null
    })
  }, 1)
}

// UI components subscribe here to reflect per-sound error states
const errorListeners = new Set()

const engine = createSoundEngine({
  evalCode: (code) => evalCode(code, { Tone, teoria, each, filter }),
  startTone,
  stopTone,
  disposeElements,
  persistTone,
  initTonesModifiers,
  removeTonePersistence: (soundId) => Meteor.call('tones.removeFromSoundId', soundId),
  onChange: ({ tones, errors }) => {
    window.tones = tones
    window.soundErrors = errors
    errorListeners.forEach(cb => { try { cb(errors) } catch (e) { console.log(e) } })
  }
})

window.tones = []
window.soundErrors = {}

// when a sound is created or updated, call that function to generate its tone
export const updateSound = (sound) => engine.updateSound(sound)

// when a tone gets removed
export const removeSound = (sound) => engine.removeSound(sound)

// per-sound evaluation errors, keyed by sound id: {name, message, errorType}
export const getSoundErrors = () => engine.getErrors()
export const getSoundError = (soundId) => engine.getErrors()[soundId]
export const subscribeSoundErrors = (cb) => {
  errorListeners.add(cb)
  return () => errorListeners.delete(cb)
}
