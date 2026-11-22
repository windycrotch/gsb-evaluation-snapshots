import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  KICK_CODE, KICK_V2_CODE,
  insertSound, mountPlayer, deliver, liveTone,
  resetAll, waitFor, sleep, spyDispose,
  Sounds, Tones, Meteor, Tone,
} from './helpers/app.mjs'

beforeEach(resetAll)
after(() => { Tone.Transport.stop(); Tone.Transport.cancel(0) })

// 卸载：已排定的启动、停止与清理任务不得在之后继续执行
test('unmount drops every scheduled start/stop/cleanup task', async () => {
  const sound = insertSound(KICK_CODE)
  const renderer = mountPlayer([])
  deliver(renderer, [sound])

  await waitFor(() => liveTone(sound._id), { label: 'tone registered' })
  const oldTone = liveTone(sound._id).tone
  const oldDisposed = spyDispose(oldTone)
  await waitFor(() => oldTone.state === 'started', { label: 'tone started' })

  // a valid edit schedules: stop+dispose of the old tone, start of the new one
  Meteor.call('sounds.updateCode', sound._id, KICK_V2_CODE)
  deliver(renderer, [Sounds.findOne(sound._id)])
  const newTone = liveTone(sound._id).tone
  const newDisposed = spyDispose(newTone)
  assert.notEqual(newTone, oldTone)

  // unmount before the scheduled tasks fire
  renderer.unmount()
  assert.equal(Tone.Transport.state, 'stopped')

  // give any surviving scheduled task every chance to fire:
  // restart the transport and wait well beyond one loop cycle
  Tone.Transport.start('+0.1')
  await sleep(3000)

  assert.equal(oldDisposed.disposed, false, 'scheduled cleanup must not run after unmount')
  assert.equal(oldTone.state, 'started', 'scheduled stop must not run after unmount')
  assert.equal(newTone.state, 'stopped', 'scheduled start must not run after unmount')
  assert.equal(newDisposed.disposed, false)

  Tone.Transport.stop()
})

// 卸载：混音台写回观察器停止，之后的集合变化不再影响播放状态
test('unmount stops the tones observer', async () => {
  const sound = insertSound(KICK_CODE)
  const renderer = mountPlayer([])
  deliver(renderer, [sound])

  await waitFor(() => liveTone(sound._id), { label: 'tone registered' })
  await waitFor(() => Tones.find({ soundId: sound._id }).count() === 1, { label: 'tone persisted' })

  renderer.unmount()

  // any collection change after unmount must not reach the player state
  const tonesBefore = window.tones.length
  const recordId = Tones.insert({ soundId: 'late-sound', name: 'late', options: { vars: [['volume', { persistedValue: -1 }, -40, 0, 1, -20]] } })
  Tones.update(recordId, { $set: { name: 'late-changed' } })
  Meteor.call('tones.removeAll')

  assert.equal(window.tones.length, tonesBefore, 'window.tones untouched after unmount')
  assert.ok(liveTone(sound._id), 'previous tone record still in place')
})
