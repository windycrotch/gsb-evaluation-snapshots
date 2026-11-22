import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  KICK_CODE, KICK_V2_CODE, KICK_V3_CODE,
  insertSound, mountPlayer, deliver, liveTone, toneInterval,
  resetAll, waitFor,
  Sounds, Tones, Meteor, Tone, updateSound,
} from './helpers/app.mjs'

beforeEach(resetAll)
after(() => { Tone.Transport.stop(); Tone.Transport.cancel(0) })

// 连续保存：最终结果生效
test('rapid successive saves converge to the last save', async () => {
  const sound = insertSound(KICK_CODE)
  const renderer = mountPlayer([])
  deliver(renderer, [sound])
  await waitFor(() => liveTone(sound._id), { label: 'tone registered' })

  Meteor.call('sounds.updateCode', sound._id, KICK_V2_CODE)
  const docV1 = Sounds.findOne(sound._id)
  Meteor.call('sounds.updateCode', sound._id, KICK_V3_CODE)
  const docV2 = Sounds.findOne(sound._id)
  assert.ok(docV2.version > docV1.version)

  deliver(renderer, [docV1])
  assert.equal(toneInterval(liveTone(sound._id)), '8n')
  deliver(renderer, [docV2])
  assert.equal(toneInterval(liveTone(sound._id)), '2n')

  renderer.unmount()
})

// 跨窗口并发：后到的旧快照不得覆盖新结果
test('cross-window saves: a stale snapshot arriving late is ignored', async () => {
  const sound = insertSound(KICK_CODE)
  const renderer = mountPlayer([])
  deliver(renderer, [sound])
  await waitFor(() => liveTone(sound._id), { label: 'tone registered' })

  // two windows save; v2 is the newer result
  Meteor.call('sounds.updateCode', sound._id, KICK_V2_CODE)
  const docV1 = Sounds.findOne(sound._id)
  Meteor.call('sounds.updateCode', sound._id, KICK_V3_CODE)
  const docV2 = Sounds.findOne(sound._id)

  // the newer snapshot arrives first, the stale one afterwards
  deliver(renderer, [docV2])
  assert.equal(toneInterval(liveTone(sound._id)), '2n')
  deliver(renderer, [docV1])
  assert.equal(toneInterval(liveTone(sound._id)), '2n', 'stale save must not overwrite the newer result')

  // a direct stale update is refused as well
  const result = updateSound(docV1)
  assert.equal(result.status, 'stale')
  assert.equal(toneInterval(liveTone(sound._id)), '2n')

  renderer.unmount()
})

// 静音/取消静音按最后一次操作为准
test('mute/unmute: the last operation wins, even delivered out of order', async () => {
  const sound = insertSound(KICK_CODE)
  const renderer = mountPlayer([])
  deliver(renderer, [sound])
  await waitFor(() => liveTone(sound._id), { label: 'tone registered' })

  // in-order: mute removes the tone, unmute brings it back
  Meteor.call('sounds.toggleMute', sound._id)
  const docMuted = Sounds.findOne(sound._id)
  assert.equal(docMuted.muted, true)
  deliver(renderer, [docMuted])
  assert.equal(liveTone(sound._id), undefined)

  Meteor.call('sounds.toggleMute', sound._id)
  const docUnmuted = Sounds.findOne(sound._id)
  assert.equal(docUnmuted.muted, false)
  deliver(renderer, [docUnmuted])
  await waitFor(() => liveTone(sound._id), { label: 'tone back after unmute' })

  // out-of-order: the final state (unmuted) arrives first, the stale mute later
  Meteor.call('sounds.toggleMute', sound._id)
  const staleMuted = Sounds.findOne(sound._id)
  Meteor.call('sounds.toggleMute', sound._id)
  const finalUnmuted = Sounds.findOne(sound._id)

  deliver(renderer, [finalUnmuted])
  await waitFor(() => liveTone(sound._id), { label: 'tone present after final state' })
  deliver(renderer, [staleMuted])
  assert.ok(liveTone(sound._id), 'stale mute must not silence the final unmuted state')

  renderer.unmount()
})
