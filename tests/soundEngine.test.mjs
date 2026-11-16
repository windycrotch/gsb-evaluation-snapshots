import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createSoundEngine } from '../imports/client/components/player/soundEngine.js'
import { evalCode } from '../imports/client/components/code/evalCode.js'
import {
  makeFakeToneLib,
  makeFakeDeps,
  makeSound,
  VALID_CODE,
  SYNTAX_ERROR_CODE,
  STRUCTURE_ERROR_NO_C_CODE
} from './helpers.mjs'

// an engine wired to the real evalCode, with the fake Tone lib injected
const makeEngine = () => {
  const registry = []
  const Tone = makeFakeToneLib(registry)
  const { deps, calls } = makeFakeDeps((code) => evalCode(code, { Tone }))
  const engine = createSoundEngine(deps)
  return { engine, calls, registry }
}

test('normal generation: valid code produces one started tone and no error', () => {
  const { engine, calls } = makeEngine()

  const result = engine.updateSound(makeSound())

  assert.equal(result.status, 'ok')
  assert.equal(engine.getTones().length, 1)
  assert.equal(calls.started.length, 1)
  assert.equal(calls.persisted.length, 1)
  assert.deepEqual(engine.getErrors(), {})
  assert.ok(calls.changes.length > 0, 'onChange must fire so the UI can sync')
})

test('syntax error: previous tone is kept alive and the error is exposed', () => {
  const { engine, calls } = makeEngine()
  engine.updateSound(makeSound())
  const liveTone = engine.getTones()[0]

  const result = engine.updateSound(makeSound({ code: SYNTAX_ERROR_CODE }))

  assert.equal(result.status, 'err')
  assert.equal(result.errorType, 'syntax')
  // the old tone object must NOT be destroyed
  assert.equal(engine.getTones().length, 1)
  assert.equal(engine.getTones()[0], liveTone)
  assert.equal(calls.stopped.length, 0, 'the previous tone must not be stopped')
  assert.equal(calls.disposed.length, 0, 'the previous elements must not be disposed')
  // the error is exposed for the player result area and the list error state
  const errors = engine.getErrors()
  assert.ok(errors['sound-1'])
  assert.equal(errors['sound-1'].errorType, 'syntax')
  assert.match(errors['sound-1'].message, /^EDITOR SYNTAX ERROR =>/)
})

test('structure error: previous tone is kept and the error is typed structure', () => {
  const { engine } = makeEngine()
  engine.updateSound(makeSound())

  const result = engine.updateSound(makeSound({ code: STRUCTURE_ERROR_NO_C_CODE }))

  assert.equal(result.status, 'err')
  assert.equal(result.errorType, 'structure')
  assert.equal(engine.getTones().length, 1)
  assert.match(engine.getErrors()['sound-1'].message, /^EDITOR RESULT ERROR =>/)
})

test('recovery: fixing the code clears the error and replaces the tone', () => {
  const { engine, calls } = makeEngine()
  engine.updateSound(makeSound())
  engine.updateSound(makeSound({ code: SYNTAX_ERROR_CODE }))
  assert.ok(engine.getErrors()['sound-1'])

  const result = engine.updateSound(makeSound({ code: VALID_CODE }))

  assert.equal(result.status, 'ok')
  assert.deepEqual(engine.getErrors(), {}, 'error state must be cleared')
  assert.equal(engine.getTones().length, 1, 'exactly one new tone')
  assert.equal(calls.stopped.length, 1, 'the old tone is stopped once replaced')
  assert.equal(calls.disposed.length, 1, 'the old elements are disposed once replaced')
  assert.equal(calls.started.length, 2, 'a new tone was started')
})

test('muted sound produces no tone object', () => {
  const { engine, calls } = makeEngine()

  const result = engine.updateSound(makeSound({ muted: true }))

  assert.equal(result.status, 'ok')
  assert.equal(engine.getTones().length, 0)
  assert.equal(calls.started.length, 0)
})

test('muting a playing sound stops and removes its tone', () => {
  const { engine, calls } = makeEngine()
  engine.updateSound(makeSound())
  assert.equal(engine.getTones().length, 1)

  const result = engine.updateSound(makeSound({ muted: true }))

  assert.equal(result.status, 'ok')
  assert.equal(engine.getTones().length, 0)
  assert.equal(calls.stopped.length, 1)
  assert.equal(calls.disposed.length, 1)
})

test('unmuting regenerates the tone from the current code', () => {
  const { engine, calls } = makeEngine()
  engine.updateSound(makeSound({ muted: true }))
  assert.equal(engine.getTones().length, 0)

  const result = engine.updateSound(makeSound({ muted: false }))

  assert.equal(result.status, 'ok')
  assert.equal(engine.getTones().length, 1)
  assert.equal(calls.started.length, 1)
})

test('mute toggle with broken code shows the error and leaves no tone behind', () => {
  const { engine, calls } = makeEngine()
  engine.updateSound(makeSound())
  assert.equal(engine.getTones().length, 1)

  // muting while the code is broken: error is shown, old tone must not remain
  const muteResult = engine.updateSound(makeSound({ muted: true, code: SYNTAX_ERROR_CODE }))
  assert.equal(muteResult.status, 'err')
  assert.equal(engine.getTones().length, 0, 'no tone object may remain for a muted sound')
  assert.ok(engine.getErrors()['sound-1'])

  // unmuting with the code still broken: error stays, still no tone
  const unmuteResult = engine.updateSound(makeSound({ muted: false, code: SYNTAX_ERROR_CODE }))
  assert.equal(unmuteResult.status, 'err')
  assert.equal(engine.getTones().length, 0)
  assert.ok(engine.getErrors()['sound-1'])

  // fixing the code while unmuted: error cleared, tone regenerated
  const fixed = engine.updateSound(makeSound({ muted: false, code: VALID_CODE }))
  assert.equal(fixed.status, 'ok')
  assert.deepEqual(engine.getErrors(), {})
  assert.equal(engine.getTones().length, 1)
})

test('removing a sound clears both its tone and its error state', () => {
  const { engine, calls } = makeEngine()
  const sound = makeSound()
  engine.updateSound(sound)
  engine.updateSound(makeSound({ code: SYNTAX_ERROR_CODE }))
  assert.ok(engine.getErrors()['sound-1'])

  engine.removeSound(sound)

  assert.equal(engine.getTones().length, 0)
  assert.deepEqual(engine.getErrors(), {})
  assert.ok(calls.removedPersistence.includes('sound-1'))
})
