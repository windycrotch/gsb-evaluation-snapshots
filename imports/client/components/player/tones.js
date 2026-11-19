import Tone from 'tone';
import { Meteor } from 'meteor/meteor'

import { Tones } from '/imports/api/tones';
import { each, find, get, isNumber } from 'lodash';

Meteor.subscribe('tones');

export let getToneType = tone => {
  if (typeof tone === 'number') return 'transport-event'
  else if (typeof tone === 'object') return 'loop'

  return false
}

// Persist the live window.tones entry into the Meteor tones collection.
// An upsert keyed on soundId keeps one record per track: re-saving code must
// not stack duplicate persisted sources.
export let persistTone = entry => {
  if (!get(entry, 'options.vars')) return false
  each(entry.options.vars, (v, i) => {
    if (!v[1]) {
      console.warn(`the options ${v[0]} is not interpreted as its value is null`)
      entry.options.vars.splice(i, 1)
      return false
    }
    if (v[1].value) v[1].persistedValue = v[1].value
  })
  Meteor.call('tones.upsert', entry)
}

export let removePersistedTone = soundId => {
  Meteor.call('tones.removeFromSoundId', soundId)
}

// If some vars inside the options changed in the collection, spread the change
// onto the live window.tones entry to modify the running sound.
export let observeTones = () => {
  Tones.find().observeChanges({
    changed: function(id, field) {
      let soundId = Tones.findOne(id).soundId
      let tone = find(window.tones, {soundId: soundId})
      if (!tone || !tone.options) return
      let vars = field['options'] && field['options']['vars']
      if (!vars) return

      each(vars, (v, i) => {
        // if the options.vars.variable is a Tone.Param (obj), update its .value
        // prop; else if a number, update the number directly
        let nameProp = tone['options']['vars'][i][0]
        isNumber(v[1].persistedValue)
          ? tone['options']['vars'][i][1].value = v[1].persistedValue
          : tone['options']['vars'][i][1][nameProp] = v[1][nameProp]
      })
    }
  })
}
