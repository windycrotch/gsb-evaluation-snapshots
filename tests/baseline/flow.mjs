// Baseline comparison flow: exercises ONLY the normal playback behavior
// (add -> edit -> mute/unmute -> mixer write-back) against whichever app
// source tree REPO_ROOT points at, and writes a JSON summary.
// Run once against the pre-change baseline and once against the fixed tree;
// compare.mjs then diffs the two summaries.

import '../runtime/env.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  KICK_CODE, KICK_V2_CODE,
  insertSound, mountPlayer, deliver, liveTone, toneInterval,
  resetAll, waitFor, spyDispose,
  Sounds, Tones, Meteor, MixTable, Tone,
} from '../helpers/app.mjs'

const summary = {}
const record = (key, value) => { summary[key] = value; console.log(`  ${key}: ${JSON.stringify(value)}`) }

resetAll()

const sound = insertSound(KICK_CODE)
const renderer = mountPlayer([])
deliver(renderer, [sound])

// add: tone registered, started, persisted
await waitFor(() => liveTone(sound._id), { label: 'tone registered' })
const firstTone = liveTone(sound._id).tone
const firstDisposed = spyDispose(firstTone)
record('add.interval', toneInterval(liveTone(sound._id)))
await waitFor(() => firstTone.state === 'started', { label: 'first tone started' })
record('add.started', firstTone.state === 'started')
await waitFor(() => Tones.find({ soundId: sound._id }).count() === 1, { label: 'tone persisted' })
record('add.persistedRecords', Tones.find({ soundId: sound._id }).count())
record('add.persistedValueIsNumber', typeof Tones.findOne({ soundId: sound._id }).options.vars[0][1].persistedValue === 'number')

// valid edit: tone replaced, old one cleaned up
Meteor.call('sounds.updateCode', sound._id, KICK_V2_CODE)
deliver(renderer, [Sounds.findOne(sound._id)])
await waitFor(() => liveTone(sound._id) && toneInterval(liveTone(sound._id)) === '8n', { label: 'tone replaced' })
const secondTone = liveTone(sound._id).tone
record('edit.replaced', secondTone !== firstTone)
record('edit.interval', toneInterval(liveTone(sound._id)))
await waitFor(() => secondTone.state === 'started', { label: 'second tone started' })
record('edit.secondStarted', secondTone.state === 'started')
await waitFor(() => firstDisposed.disposed, { label: 'old tone disposed' })
record('edit.oldDisposed', firstDisposed.disposed)
record('edit.toneCount', window.tones.length)

// mute / unmute
Meteor.call('sounds.toggleMute', sound._id)
deliver(renderer, [Sounds.findOne(sound._id)])
record('mute.toneGone', liveTone(sound._id) === undefined)

Meteor.call('sounds.toggleMute', sound._id)
deliver(renderer, [Sounds.findOne(sound._id)])
await waitFor(() => liveTone(sound._id), { label: 'tone back after unmute' })
record('unmute.toneBack', !!liveTone(sound._id))
const thirdTone = liveTone(sound._id).tone
await waitFor(() => thirdTone.state === 'started', { label: 'unmuted tone started' })
record('unmute.started', thirdTone.state === 'started')

// mixer write-back reaches the live tone
const mixTable = new MixTable({ tones: [] })
mixTable.changeValue(Tones.findOne({ soundId: sound._id }), 0, -5)
record('mixer.persistedValue', Tones.findOne({ soundId: sound._id }).options.vars[0][1].persistedValue)
await waitFor(() => Math.abs(liveTone(sound._id).options.vars[0][1].value - -5) < 0.2, { label: 'param applied to live tone' })
record('mixer.liveValueApprox', Math.round(liveTone(sound._id).options.vars[0][1].value * 10) / 10)

renderer.unmount()
Tone.Transport.stop()

const out = process.env.BASELINE_OUT
if (out) {
  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(summary, null, 2))
  console.log(`summary written to ${out}`)
}
process.exit(0)
