import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createFakeToneScheduler } from './fakeToneScheduler.js'
import { createHarness, createFakeLoop, createVarEntry, defaultBuild, deferEvaluations } from './helpers.js'
import {
  validateEvalResult,
  createGenerationRegistry,
  createSoundController
} from '../imports/client/components/player/soundController.js'
// ---------------------------------------------------------------------------
// 1. Successful update: evaluation -> stop/release old -> start new -> persist,
//    exactly one live source, no duplicate entries.
// ---------------------------------------------------------------------------
test('successful update stops and releases the old source before starting the new one, then persists', async () => {
  const h = createHarness()

  const first = await h.controller.updateSound(h.sound({ code: 'code-A' }))
  assert.equal(first.status, 'ok')
  assert.equal(h.store.length, 1)
  assert.equal(h.persisted.length, 1)
  const firstTone = h.store[0].tone

  const second = await h.controller.updateSound(h.sound({ code: 'code-B' }))
  assert.equal(second.status, 'ok')

  // One and only one live entry for the sound.
  assert.equal(h.store.length, 1)
  assert.notEqual(h.store[0].tone, firstTone)
  assert.equal(h.store[0].code, 'code-B')

  // Call ordering around the switch: old source stopped before the NEW source
  // starts (the first update's start happened before any stop).
  const ordered = h.scheduler.calls
  const stopIndex = ordered.findIndex(c => c.type === 'stopSound' && c.tone === firstTone)
  const newStartIndex = ordered.findIndex(
    c => c.type === 'startSound' && c.tone === h.store[0].tone
  )
  assert.ok(stopIndex > -1, 'old source must be stopped')
  assert.ok(newStartIndex > stopIndex, 'new source must start after the old one is stopped')

  // A disposal of the old elements was scheduled before the new start too.
  const disposeIndex = ordered.findIndex(c => c.type === 'schedule' && c.kind === 'dispose')
  assert.ok(disposeIndex > -1 && disposeIndex < newStartIndex)

  // Persistence written once per successful update, newest last.
  assert.equal(h.persisted.length, 2)
  assert.equal(h.persisted[1].code, 'code-B')
})

test('flushing the scheduler disposes old elements exactly once', async () => {
  const h = createHarness()
  await h.controller.updateSound(h.sound({ code: 'code-A' }))
  const oldElement = h.store[0].elementsToDispose[0]
  await h.controller.updateSound(h.sound({ code: 'code-B' }))

  h.flush()
  assert.deepEqual(oldElement.events.filter(e => e[0] === 'dispose').length, 1)
})

// ---------------------------------------------------------------------------
// 2. Evaluation / validation failure: old source keeps playing, store and
//    persistence stay untouched, a readable error is returned.
// ---------------------------------------------------------------------------
test('evaluation failure keeps the old source playing and does not persist', async () => {
  const h = createHarness({ failOn: code => code === 'broken' })

  await h.controller.updateSound(h.sound({ code: 'code-A' }))
  const oldTone = h.store[0].tone
  const snapshotCalls = h.scheduler.calls.length
  const snapshotPersisted = h.persisted.length

  const result = await h.controller.updateSound(h.sound({ code: 'broken' }))
  assert.equal(result.status, 'err')
  assert.match(result.body, /forced failure/)

  // Nothing was stopped, nothing was started.
  assert.equal(h.scheduler.calls.length, snapshotCalls)
  // Same source still live, still one entry.
  assert.equal(h.store.length, 1)
  assert.equal(h.store[0].tone, oldTone)
  // No extra persistence write.
  assert.equal(h.persisted.length, snapshotPersisted)
})

test('result missing c or e is treated as failure and leaves the old source intact', async () => {
  // Only the second evaluation returns a malformed body.
  const h = createHarness({
    build: code => (code === 'code-no-c'
      ? { e: [createFakeLoop('e')] }
      : defaultBuild(code))
  })
  await h.controller.updateSound(h.sound({ code: 'code-A' }))
  const oldTone = h.store[0].tone

  const result = await h.controller.updateSound(h.sound({ code: 'code-no-c' }))
  assert.equal(result.status, 'err')
  assert.match(result.body, /c \(code\) var/)
  assert.equal(h.store[0].tone, oldTone)
  assert.equal(h.persisted.length, 1)
})

test('illegal options.vars structure is rejected as failure', () => {
  const goodLoop = createFakeLoop('x')
  assert.equal(validateEvalResult({ c: goodLoop, e: [] }).valid, true)

  const missingC = validateEvalResult({ e: [] })
  assert.equal(missingC.valid, false)

  const missingE = validateEvalResult({ c: goodLoop })
  assert.equal(missingE.valid, false)

  const varsNotArray = validateEvalResult({ c: goodLoop, e: [], o: { vars: {} } })
  assert.equal(varsNotArray.valid, false)

  const entryNotArray = validateEvalResult({ c: goodLoop, e: [], o: { vars: ['nope'] } })
  assert.equal(entryNotArray.valid, false)

  const nullTarget = validateEvalResult({
    c: goodLoop, e: [], o: { vars: [['volume', null, 0, 1]] }
  })
  assert.equal(nullTarget.valid, false)
})

test('failed first evaluation leaves no store entry and no persisted record', async () => {
  const h = createHarness({ failOn: () => true })
  const result = await h.controller.updateSound(h.sound())
  assert.equal(result.status, 'err')
  assert.equal(h.store.length, 0)
  assert.equal(h.persisted.length, 0)
})

// ---------------------------------------------------------------------------
// 3. Mute stops playback but retains the code; unmute regenerates the source
//    from the original code.
// ---------------------------------------------------------------------------
test('mute stops the source and keeps the code without a new evaluation', async () => {
  const h = createHarness()
  await h.controller.updateSound(h.sound({ code: 'code-A' }))
  const oldTone = h.store[0].tone

  const muted = await h.controller.updateSound(h.sound({ code: 'code-A', muted: true }))
  assert.equal(muted.status, 'ok')

  // The running source was stopped and its disposal scheduled.
  assert.ok(h.scheduler.calls.some(c => c.type === 'stopSound' && c.tone === oldTone))

  // Entry remains, marked muted, code retained, no tone source attached.
  assert.equal(h.store.length, 1)
  assert.equal(h.store[0].muted, true)
  assert.equal(h.store[0].code, 'code-A')
  assert.equal(h.store[0].tone, undefined)

  // Re-muting without a code change must not re-evaluate.
  const evalCalls = h.evaluator.calls.length
  await h.controller.updateSound(h.sound({ code: 'code-A', muted: true }))
  assert.equal(h.evaluator.calls.length, evalCalls)
})

test('unmute regenerates the source from the retained code and restarts it', async () => {
  const h = createHarness()
  await h.controller.updateSound(h.sound({ code: 'code-A' }))
  await h.controller.updateSound(h.sound({ code: 'code-A', muted: true }))

  const result = await h.controller.updateSound(h.sound({ code: 'code-A', muted: false }))
  assert.equal(result.status, 'ok')

  assert.equal(h.store.length, 1)
  assert.equal(h.store[0].muted, false)
  assert.equal(h.store[0].code, 'code-A')
  assert.ok(h.store[0].tone, 'a new source must have been generated')
  assert.ok(h.scheduler.calls.some(c => c.type === 'startSound'))
})

test('editing code while muted validates the new code but stays muted', async () => {
  // A failing evaluation while muted keeps the previous retained code and the
  // muted placeholder; no audible source is created.
  const h = createHarness({ failOn: c => c === 'broken' })
  await h.controller.updateSound(h.sound({ code: 'code-A' }))
  await h.controller.updateSound(h.sound({ code: 'code-A', muted: true }))

  const fail = await h.controller.updateSound(h.sound({ code: 'broken', muted: true }))
  assert.equal(fail.status, 'err')
  assert.equal(h.store[0].code, 'code-A')
  assert.equal(h.store[0].muted, true)
  assert.equal(h.store[0].tone, undefined)

  // A valid code while muted swaps the retained code but stays silent.
  const startCountAfterMute = h.scheduler.calls.filter(c => c.type === 'startSound').length
  const ok = await h.controller.updateSound(h.sound({ code: 'code-B', muted: true }))
  assert.equal(ok.status, 'ok')
  assert.equal(h.store[0].code, 'code-B')
  assert.equal(h.store[0].muted, true)
  assert.equal(h.store[0].tone, undefined)
  assert.ok(h.store[0].options, 'muted entries keep the options shape for the mixer')
  assert.equal(
    h.scheduler.calls.filter(c => c.type === 'startSound').length,
    startCountAfterMute,
    'muted updates must never start a source'
  )
})

// ---------------------------------------------------------------------------
// 4. Delete clears store, pending Tone events and the persisted record.
// ---------------------------------------------------------------------------
test('delete removes the store entry, all pending transport events and the persisted record', async () => {
  const h = createHarness()
  await h.controller.updateSound(h.sound({ _id: 's1', code: 'code-A' }))
  assert.ok(h.scheduler.pendingCount('s1') > 0, 'start events should be pending')

  h.controller.removeSound({ _id: 's1' })

  assert.equal(h.store.length, 0)
  assert.equal(h.scheduler.pendingCount('s1'), 0)
  assert.deepEqual(h.removedIds, ['s1'])
  assert.ok(h.scheduler.calls.some(c => c.type === 'cancelSound' && c.soundId === 's1'))
})

test('delete on an unknown sound still asks to remove the persisted record', () => {
  const h = createHarness()
  h.controller.removeSound({ _id: 'ghost' })
  assert.deepEqual(h.removedIds, ['ghost'])
  assert.equal(h.store.length, 0)
})

test('deleting while an evaluation is in flight prevents the late result from resurrecting the track', async () => {
  const h = createHarness()
  const slots = deferEvaluations(h, 1)

  const p1 = h.controller.updateSound(h.sound({ code: 'code-A' }))
  h.controller.removeSound({ _id: 'sound-1' })
  assert.equal(h.registry.isCurrent('sound-1', 1), false, 'deleted generations are retired')

  slots[0].resolve({ status: 'ok', body: defaultBuild('code-A') })
  const result = await p1
  assert.equal(result.status, 'stale')

  assert.equal(h.store.length, 0)
  assert.equal(h.scheduler.calls.filter(c => c.type === 'startSound').length, 0)
  assert.deepEqual(h.removedIds, ['sound-1'])
})

test('a sound re-added after deletion starts a fresh lifecycle', async () => {
  const h = createHarness()
  await h.controller.updateSound(h.sound({ code: 'code-A' }))
  h.controller.removeSound({ _id: 'sound-1' })

  const reAdded = await h.controller.updateSound(h.sound({ code: 'code-A' }))
  assert.equal(reAdded.status, 'ok')
  assert.equal(h.store.length, 1)
  assert.equal(h.registry.isCurrent('sound-1', h.registry.current('sound-1')), true)
})

// ---------------------------------------------------------------------------
// 5. Rapid consecutive updates: only the last successful evaluation wins;
//    stale asynchronous starts/releases never touch the newer source.
// ---------------------------------------------------------------------------
test('consecutive updates: the last successful evaluation is the only live source', async () => {
  const h = createHarness()
  const slots = deferEvaluations(h, 3)

  const p1 = h.controller.updateSound(h.sound({ code: 'code-A' }))
  const p2 = h.controller.updateSound(h.sound({ code: 'code-B' }))
  const p3 = h.controller.updateSound(h.sound({ code: 'code-C' }))

  // Generations were claimed synchronously in call order.
  assert.equal(h.registry.current('sound-1'), 3)

  // Resolve out of order: oldest last.
  slots[2].resolve({ status: 'ok', body: defaultBuild('code-C') })
  slots[1].resolve({ status: 'ok', body: defaultBuild('code-B') })
  slots[0].resolve({ status: 'ok', body: defaultBuild('code-A') })

  const results = await Promise.all([p1, p2, p3])
  assert.deepEqual(results.map(r => r.status), ['stale', 'stale', 'ok'])

  assert.equal(h.store.length, 1)
  assert.equal(h.store[0].code, 'code-C')
  // Only the last update produced start/persist side effects.
  const starts = h.scheduler.calls.filter(c => c.type === 'startSound')
  assert.equal(starts.length, 1)
  assert.equal(starts[0].generation, 3)
  assert.equal(h.persisted.length, 1)
  assert.equal(h.persisted[0].code, 'code-C')
})

test('a failed middle update does not roll back a newer successful update', async () => {
  const h = createHarness()
  const slots = deferEvaluations(h, 2)

  const p1 = h.controller.updateSound(h.sound({ code: 'code-A' }))
  const p2 = h.controller.updateSound(h.sound({ code: 'code-B' }))

  slots[1].resolve({ status: 'err', body: 'boom' })
  slots[0].resolve({ status: 'ok', body: defaultBuild('code-A') })

  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1.status, 'stale')
  assert.equal(r2.status, 'err')

  // No source was ever committed: update 2 failed and update 1 was stale.
  assert.equal(h.store.length, 0)
  assert.equal(h.persisted.length, 0)

  // A subsequent successful update establishes the source normally.
  const r3 = await h.controller.updateSound(h.sound({ code: 'code-C' }))
  assert.equal(r3.status, 'ok')
  assert.equal(h.store[0].code, 'code-C')
})

test('a release scheduled by an old generation is skipped when it fires late', async () => {
  const registry = createGenerationRegistry()
  // Wrap the fake so we can observe which generations actually execute.
  const scheduler = createFakeToneScheduler(registry.isCurrent)
  const ranGenerations = []
  const originalSchedule = scheduler.schedule.bind(scheduler)
  scheduler.schedule = (soundId, generation, kind, callback) =>
    originalSchedule(soundId, generation, kind, () => {
      ranGenerations.push({ generation, kind })
      callback()
    })
  const store = []

  const controller = createSoundController({
    evaluate: async code => ({ status: 'ok', body: defaultBuild(code) }),
    scheduler,
    store,
    persist: () => {},
    removePersisted: () => {},
    registry
  })

  await controller.updateSound({ _id: 's', name: 's', muted: false, code: 'A' })
  await controller.updateSound({ _id: 's', name: 's', muted: false, code: 'B' })

  // Transport fires every queued callback, including the stale generation-1
  // start. The isCurrent guard must reject it.
  assert.equal(registry.current('s'), 2)
  scheduler.flush()

  assert.ok(ranGenerations.length > 0)
  assert.equal(
    ranGenerations.every(event => event.generation === 2),
    true,
    'no callback from the superseded generation 1 may execute'
  )
  assert.deepEqual(
    ranGenerations.map(event => event.kind).sort(),
    ['dispose', 'start-loop', 'stop-loop']
  )
  assert.equal(store[0].code, 'B')
})

test('muting while an evaluation is in flight invalidates the pending start', async () => {
  const h = createHarness()
  const slots = deferEvaluations(h, 1)

  const p1 = h.controller.updateSound(h.sound({ code: 'code-A', muted: false }))
  const p2 = h.controller.updateSound(h.sound({ code: 'code-A', muted: true }))

  slots[0].resolve({ status: 'ok', body: defaultBuild('code-A') })
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1.status, 'stale')
  assert.equal(r2.status, 'ok')

  assert.equal(h.store[0].muted, true)
  assert.equal(h.store[0].tone, undefined)
  assert.equal(h.scheduler.calls.filter(c => c.type === 'startSound').length, 0)
})

// ---------------------------------------------------------------------------
// 6. Persistence consistency: re-evaluated sources use persisted values rather
//    than the defaults in the code.
// ---------------------------------------------------------------------------
test('re-evaluation restores persisted parameter values on the new source', async () => {
  const buildWithVar = (code) => {
    const target = { value: 0, volume: 0 }
    return {
      c: createFakeLoop(code),
      e: [],
      o: { vars: [createVarEntry('volume', target, 0.25)] }
    }
  }
  const h = createHarness({ build: buildWithVar })

  await h.controller.updateSound(h.sound({ code: 'code-A' }))
  // Initial value from the code applied.
  assert.equal(h.store[0].vars[0][1].value, 0.25)

  // User moved the mixer knob; the live target records a persisted value.
  h.store[0].vars[0][1].value = 0.8
  h.store[0].vars[0][1].persistedValue = 0.8

  // Re-save code: brand new targets are created by the evaluator.
  await h.controller.updateSound(h.sound({ code: 'code-B' }))
  const newTarget = h.store[0].vars[0][1]
  assert.equal(newTarget.value, 0.8, 'persisted value must win over the code default')
  assert.equal(h.persisted.length, 2)
})

test('no persistence write happens until the whole switch succeeds', async () => {
  const h = createHarness({ failOn: c => c === 'broken' })
  await h.controller.updateSound(h.sound({ code: 'code-A' }))
  const before = h.persisted.length

  await h.controller.updateSound(h.sound({ code: 'broken' }))
  assert.equal(h.persisted.length, before)
})

// ---------------------------------------------------------------------------
// 7. Numeric transport-event tones use Transport.clear rather than scheduling.
// ---------------------------------------------------------------------------
test('numeric transport-event tones are cleared, not stop-scheduled', async () => {
  const h = createHarness({
    build: code => ({ c: 42, e: [], o: { vars: [] } })
  })
  await h.controller.updateSound(h.sound({ code: 'code-A' }))
  assert.ok(h.scheduler.calls.some(c => c.type === 'startSound' && c.tone === 42))

  await h.controller.updateSound(h.sound({ code: 'code-B' }))
  const stopCall = h.scheduler.calls.find(c => c.type === 'stopSound' && c.tone === 42)
  assert.ok(stopCall)
  assert.ok(h.scheduler.calls.some(c => c.type === 'clear' && c.event === 42))
})
