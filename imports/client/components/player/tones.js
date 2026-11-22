import Tone from 'tone';
import { Meteor } from 'meteor/meteor'

import { Tones } from '/imports/api/tones';
import { getPlayerGeneration, isCurrentGeneration, isSoundDeleted } from './lifecycle';
import { each, find, get, set, isNumber, round } from 'lodash';

Meteor.subscribe('tones');

export let getToneType = tone => {
  if (typeof tone === 'number') return 'transport-event'
  else if (typeof tone === 'object') return 'loop'

  return false
}

export let stopTone = tone => {
  let gen = getPlayerGeneration()
  let type = getToneType(tone)
  type === 'loop' && Tone.Transport.scheduleOnce(t => {
    // the player was unmounted since this stop was scheduled: drop it
    if (!isCurrentGeneration(gen)) return false
    tone.stop().dispose()
  }, 1)
  type === 'transport-event' && Tone.Transport.clear(tone)
}

export let startTone = tone => {
  let gen = getPlayerGeneration()
  let type = getToneType(tone)
  type === 'loop' && Tone.Transport.scheduleOnce(t => {
    // the player was unmounted since this start was scheduled: drop it
    if (!isCurrentGeneration(gen)) return false
    tone.start(0)
  }, 1)
}

// for each option var defined in the o array, apply the init value
export let initTonesModifiers = (vars) => {
  each(vars, v => {
    // ['pitchDecay',     synth, 0,     0.5,     0.001 ,->0] which is init value of param
    if (isNumber(v[5])) {
      isNumber(v[1][v[0]]) ? v[1][v[0]] = round(v[5],5) : v[1].value = v[5]
    }
  })
}


// persist the window.tones object to a meteor collection
export let persistTone = tone => {
  if (!get(tone, 'options.vars')) return false
  // the sound was deleted before this persistence ran: do not recreate a record
  if (isSoundDeleted(tone.soundId)) return false
  each(tone.options.vars, (v,i) => {
    if (!v[1]) {
      console.warn(`the options ${v[0]} is not interpreted as its value is null`)
      tone.options.vars.splice(i, 1)
      return false
    }
    if (v[1].value) v[1].persistedValue = v[1].value
  })
  Meteor.call('tones.insert', tone)
}

// if we have some vars inside the options that changed
// spread the change to value inside  window.tones to modify sound
// returns the observe handle so the player can stop it on unmount
export let observeTones = () => {
  var handle = Tones.find().observeChanges({
    changed: function(id, field) {
      // the record may already be gone (sound deleted): nothing to write back
      let doc = Tones.findOne(id)
      if (!doc) return false

      let soundId = doc.soundId
      let tone = find(window.tones, {soundId: soundId})

      // no live tone for this record (deleted sound or leftover record):
      // drop the residual record instead of writing parameters to a ghost
      if (!tone || isSoundDeleted(soundId)) {
        Meteor.call('tones.removeFromSoundId', soundId)
        return false
      }

      let vars = get(field, 'options.vars')
      if (!vars || !get(tone, 'options.vars')) return false

      each(vars, (v,i) => {
        // if the options.vars.variable is a Tone.Param (obj), update its .value prop
        // else if a number, update the number directly
        let nameProp = tone['options']['vars'][i][0]
        isNumber(v[1].persistedValue) ? tone['options']['vars'][i][1].value = v[1].persistedValue : tone['options']['vars'][i][1][nameProp] = v[1][nameProp]
      })
    }
  })
  return handle
}
