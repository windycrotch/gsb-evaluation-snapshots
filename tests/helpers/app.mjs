// Boots the REAL app modules (collections, methods, player, watcher,
// mixer write-back) inside the harness and exposes test utilities.
// Nothing in this file re-implements app logic.

import '../runtime/env.mjs'

import { Meteor, callLog } from 'meteor/meteor'

// real collection definitions + real Meteor methods (imports/api/*)
import { Sounds } from '/imports/api/sounds'
import { Tones } from '/imports/api/tones'
import { Songs } from '/imports/api/songs'

// real player chain
import { updateSound, removeSound } from '/imports/client/components/player/sounds'
import { soundsWatcher } from '/imports/client/components/player/soundsWatcher'
import { observeTones } from '/imports/client/components/player/tones'
import Player from '/imports/client/components/player/Player.jsx'

// the lifecycle module only exists in the fixed tree, not in the pre-change
// baseline the flow is also run against
let lifecycle = null
try { lifecycle = await import('/imports/client/components/player/lifecycle') } catch (e) { /* baseline tree */ }

// real mixer write-back chain
import MixTable from '/imports/client/components/mixer/MixTable'
import { updateParamsInCode } from '/imports/client/components/code/updateParamsInCode'
import { evalCode } from '/imports/client/components/code/evalCode'

import Tone from 'tone'
import React from 'react'
import TestRenderer from 'react-test-renderer'

export {
  Meteor, callLog,
  Sounds, Tones, Songs,
  updateSound, removeSound, soundsWatcher, observeTones, lifecycle,
  Player, MixTable, updateParamsInCode, evalCode,
  Tone, React, TestRenderer,
}

//
// sample sound codes (evaluated by the real evalCode against real Tone.js)
//

export const KICK_CODE = `
var synth = new Tone.MembraneSynth().toMaster()
var c = new Tone.Loop(function(time){ synth.triggerAttackRelease('C2', '8n', time) }, '4n')
var o = { vars: [ ['volume', synth.volume, -40, 0, 1, -20] ] }
`

export const KICK_V2_CODE = `
var synth = new Tone.MembraneSynth().toMaster()
var c = new Tone.Loop(function(time){ synth.triggerAttackRelease('D2', '8n', time) }, '8n')
var o = { vars: [ ['volume', synth.volume, -40, 0, 1, -7] ] }
`

export const KICK_V3_CODE = `
var synth = new Tone.MembraneSynth().toMaster()
var c = new Tone.Loop(function(time){ synth.triggerAttackRelease('E2', '8n', time) }, '2n')
var o = { vars: [ ['volume', synth.volume, -40, 0, 1, -3] ] }
`

export const SYNTAX_ERROR_CODE = `var synth = new Tone.MembraneSynth(`

export const RUNTIME_ERROR_CODE = `var c = thisFunctionDoesNotExist()`

export const NO_TONE_CODE = `var x = 1`

//
// utilities
//

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export const waitFor = async (cond, { timeout = 5000, interval = 50, label = 'condition' } = {}) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    let ok = false
    try { ok = await cond() } catch (e) { ok = false }
    if (ok) return true
    await sleep(interval)
  }
  throw new Error(`waitFor timed out after ${timeout}ms: ${label}`)
}

// the transport loop ('2m') must stay longer than the 1s scheduling horizon
// used by the player, so scheduled start/stop/cleanup tasks keep firing —
// like a user turning the BPM knob up
export const FAST_BPM = 300

export const resetAll = () => {
  Tone.Transport.stop()
  Tone.Transport.cancel(0)
  window.tones = []
  Tones.remove({})
  Sounds.remove({})
  Songs.remove({})
  lifecycle && lifecycle.resetSoundLifecycle()
  callLog.length = 0
}

export const insertSound = (code, extra = {}) => {
  const before = new Set(Sounds.find({}).fetch().map(s => s._id))
  Meteor.call('sounds.insert', code)
  const sound = Sounds.find({}).fetch().find(s => !before.has(s._id))
  if (Object.keys(extra).length) Sounds.update(sound._id, { $set: extra })
  return Sounds.findOne(sound._id)
}

// mount the real Player component through the real React lifecycle
export const mountPlayer = (sounds = []) => {
  const renderer = TestRenderer.create(React.createElement(Player, { sounds }))
  // shorten the transport loop so scheduled tasks fire quickly (user-level control)
  Tone.Transport.bpm.value = FAST_BPM
  return renderer
}

// deliver a new sounds snapshot to the player, like withTracker would
export const deliver = (renderer, sounds) => {
  renderer.update(React.createElement(Player, { sounds }))
}

export const fetchSounds = () => Sounds.find({}, { sort: { createdAt: -1 } }).fetch()

export const liveTone = soundId => window.tones.find(t => t.soundId === soundId)

export const toneInterval = toneRecord => String(toneRecord.tone.interval)

// Tone r11 has no `disposed` flag: observe dispose() calls on a live object
export const spyDispose = obj => {
  const state = { disposed: false }
  const original = obj.dispose.bind(obj)
  obj.dispose = () => { state.disposed = true; return original() }
  return state
}
