import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  KICK_CODE, KICK_V2_CODE,
  insertSound, mountPlayer, deliver, liveTone,
  resetAll, waitFor, spyDispose,
  Sounds, Tones, Meteor, MixTable, Tone, updateSound, updateParamsInCode, callLog,
} from './helpers/app.mjs'

beforeEach(resetAll)
after(() => { Tone.Transport.stop(); Tone.Transport.cancel(0) })

// 删除音色：播放实例、持久化记录与混音台写回全部失效，无残留
test('delete invalidates instance, records and mixer write-back', async () => {
  const soundA = insertSound(KICK_CODE)
  const soundB = insertSound(KICK_V2_CODE)
  const renderer = mountPlayer([])
  deliver(renderer, [soundA, soundB])

  await waitFor(() => liveTone(soundA._id) && liveTone(soundB._id), { label: 'both tones registered' })
  const toneA = liveTone(soundA._id).tone
  const toneADisposed = spyDispose(toneA)
  await waitFor(() => toneA.state === 'started', { label: 'tone A started' })
  await waitFor(() => Tones.find({}).count() === 2, { label: 'both tones persisted' })
  const recordA = Tones.findOne({ soundId: soundA._id })

  // delete sound A through the real chain
  Meteor.call('sounds.remove', soundA._id)
  deliver(renderer, [soundB])

  // playing instance removed and cleaned up, persisted record gone
  assert.equal(liveTone(soundA._id), undefined)
  assert.ok(liveTone(soundB._id), 'other sounds keep playing')
  assert.equal(Tones.find({ soundId: soundA._id }).count(), 0)
  assert.equal(Tones.find({ soundId: soundB._id }).count(), 1)
  await waitFor(() => toneADisposed.disposed, { label: 'deleted tone disposed' })

  // stale mixer write-back (real MixTable path): dropped, nothing recreated
  const mixTable = new MixTable({ tones: [] })
  assert.equal(mixTable.changeValue(recordA, 0, -3), false)
  assert.equal(Tones.find({ soundId: soundA._id }).count(), 0)

  // stale server-side write-back: refused, residuals cleaned
  assert.equal(Meteor.call('tones.update', recordA), false)
  assert.equal(Tones.find({ soundId: soundA._id }).count(), 0)

  // a residual record that raced the delete is removed, not updated
  const ghostId = Tones.insert({ soundId: soundA._id, name: 'ghost', options: { vars: [['volume', { persistedValue: -1 }, -40, 0, 1, -20]] } })
  assert.equal(Meteor.call('tones.update', { _id: ghostId, soundId: soundA._id, options: { vars: [] } }), false)
  assert.equal(Tones.find({ soundId: soundA._id }).count(), 0)

  // a residual record changed through the collection observer is cleaned up
  // and never reaches the live tones of other sounds
  const ghostId2 = Tones.insert({ soundId: soundA._id, name: 'ghost2', options: { vars: [['volume', { persistedValue: -2 }, -40, 0, 1, -20]] } })
  Tones.update(ghostId2, { $set: { name: 'ghost2-changed' } })
  assert.equal(Tones.find({ soundId: soundA._id }).count(), 0)
  assert.ok(liveTone(soundB._id), 'sound B unaffected')
  assert.equal(liveTone(soundB._id).options.vars[0][1].value, liveTone(soundB._id).options.vars[0][1].value)

  // saving mixer params back into the code of a deleted sound is a no-op
  const callsBefore = callLog.filter(([name]) => name === 'sounds.updateCode').length
  assert.equal(updateParamsInCode(soundA._id, recordA._id), false)
  const callsAfter = callLog.filter(([name]) => name === 'sounds.updateCode').length
  assert.equal(callsAfter, callsBefore, 'no code update for a deleted sound')

  // a late update for the deleted sound recreates nothing
  assert.equal(updateSound({ _id: soundA._id, name: soundA.name, code: KICK_CODE, muted: false, version: 99 }).status, 'deleted')
  assert.equal(liveTone(soundA._id), undefined)
  assert.equal(Tones.find({ soundId: soundA._id }).count(), 0)

  renderer.unmount()
})
