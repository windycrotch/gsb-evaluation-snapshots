import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  KICK_CODE, KICK_V2_CODE,
  insertSound, mountPlayer, deliver, liveTone, toneInterval,
  resetAll, waitFor, sleep, spyDispose,
  Sounds, Tones, Meteor, MixTable, Tone,
} from './helpers/app.mjs'

beforeEach(resetAll)
after(() => { Tone.Transport.stop(); Tone.Transport.cancel(0) })

// 正常编辑生效：求值成功才替换音色，参数持久化，混音台写回到达播放实例
test('normal edit: add, valid edit, mute/unmute, mixer write-back', async () => {
  const sound = insertSound(KICK_CODE)
  const renderer = mountPlayer([])
  deliver(renderer, [sound])

  // added sound starts playing and is persisted
  await waitFor(() => liveTone(sound._id), { label: 'tone registered' })
  const firstTone = liveTone(sound._id).tone
  const firstDisposed = spyDispose(firstTone)
  assert.equal(toneInterval(liveTone(sound._id)), '4n')
  await waitFor(() => firstTone.state === 'started', { label: 'first tone started' })

  await waitFor(() => Tones.find({ soundId: sound._id }).count() === 1, { label: 'tone persisted' })
  const persisted = Tones.findOne({ soundId: sound._id })
  assert.equal(typeof persisted.options.vars[0][1].persistedValue, 'number')

  // valid edit replaces the playing tone
  Meteor.call('sounds.updateCode', sound._id, KICK_V2_CODE)
  deliver(renderer, [Sounds.findOne(sound._id)])
  assert.equal(renderer.getInstance().state.codeErrors, false)
  await waitFor(() => liveTone(sound._id) && toneInterval(liveTone(sound._id)) === '8n', { label: 'tone replaced' })
  const secondTone = liveTone(sound._id).tone
  assert.notEqual(secondTone, firstTone)
  await waitFor(() => secondTone.state === 'started', { label: 'second tone started' })
  await waitFor(() => firstDisposed.disposed, { label: 'old tone disposed' })

  // mute stops and removes the tone, unmute brings it back
  Meteor.call('sounds.toggleMute', sound._id)
  deliver(renderer, [Sounds.findOne(sound._id)])
  assert.equal(liveTone(sound._id), undefined)

  Meteor.call('sounds.toggleMute', sound._id)
  deliver(renderer, [Sounds.findOne(sound._id)])
  await waitFor(() => liveTone(sound._id), { label: 'tone back after unmute' })
  const thirdTone = liveTone(sound._id).tone
  await waitFor(() => thirdTone.state === 'started', { label: 'unmuted tone started' })

  // mixer write-back reaches the live tone through the tones collection
  const record = Tones.findOne({ soundId: sound._id })
  const mixTable = new MixTable({ tones: [] })
  mixTable.changeValue(record, 0, -5)
  const updated = Tones.findOne({ soundId: sound._id })
  assert.equal(updated.options.vars[0][1].persistedValue, -5)
  await waitFor(() => Math.abs(liveTone(sound._id).options.vars[0][1].value - -5) < 0.2, { label: 'param applied to live tone' })

  renderer.unmount()
})
