import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  KICK_CODE, KICK_V2_CODE, SYNTAX_ERROR_CODE, RUNTIME_ERROR_CODE, NO_TONE_CODE,
  insertSound, mountPlayer, deliver, liveTone,
  resetAll, waitFor, spyDispose,
  Sounds, Tones, Meteor, Tone,
} from './helpers/app.mjs'

beforeEach(resetAll)
after(() => { Tone.Transport.stop(); Tone.Transport.cancel(0) })

// 求值失败保留原声并显示错误，改回合法代码后重新生效
test('eval failure keeps the playing sound, fixing the code recovers', async () => {
  const sound = insertSound(KICK_CODE)
  const renderer = mountPlayer([])
  deliver(renderer, [sound])

  await waitFor(() => liveTone(sound._id), { label: 'tone registered' })
  const playingTone = liveTone(sound._id).tone
  const playingDisposed = spyDispose(playingTone)
  await waitFor(() => playingTone.state === 'started', { label: 'tone started' })
  await waitFor(() => Tones.find({ soundId: sound._id }).count() === 1, { label: 'tone persisted' })

  // save broken code: evaluation fails BEFORE the playing tone is touched
  Meteor.call('sounds.updateCode', sound._id, SYNTAX_ERROR_CODE)
  deliver(renderer, [Sounds.findOne(sound._id)])

  const errors = renderer.getInstance().state.codeErrors
  assert.ok(errors, 'an error is displayed')
  assert.match(String(errors), /ERROR/)

  // the old sound is still there, still playing, not disposed, still persisted
  assert.equal(liveTone(sound._id).tone, playingTone)
  assert.equal(playingTone.state, 'started')
  assert.equal(playingDisposed.disposed, false)
  assert.equal(Tones.find({ soundId: sound._id }).count(), 1)

  // runtime errors and missing-tone results are also kept away from the player
  Meteor.call('sounds.updateCode', sound._id, RUNTIME_ERROR_CODE)
  deliver(renderer, [Sounds.findOne(sound._id)])
  assert.ok(renderer.getInstance().state.codeErrors)
  assert.equal(liveTone(sound._id).tone, playingTone)

  Meteor.call('sounds.updateCode', sound._id, NO_TONE_CODE)
  deliver(renderer, [Sounds.findOne(sound._id)])
  assert.ok(renderer.getInstance().state.codeErrors)
  assert.equal(liveTone(sound._id).tone, playingTone)

  // fix the code: the new tone replaces the old one and the error clears
  Meteor.call('sounds.updateCode', sound._id, KICK_V2_CODE)
  deliver(renderer, [Sounds.findOne(sound._id)])

  assert.equal(renderer.getInstance().state.codeErrors, false)
  await waitFor(() => liveTone(sound._id) && liveTone(sound._id).tone !== playingTone, { label: 'tone replaced after fix' })
  await waitFor(() => liveTone(sound._id).tone.state === 'started', { label: 'fixed tone started' })
  await waitFor(() => playingDisposed.disposed, { label: 'old tone disposed after fix' })

  renderer.unmount()
})
