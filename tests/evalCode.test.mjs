import { test } from 'node:test'
import assert from 'node:assert/strict'

import { evalCode, ERROR_TYPES } from '../imports/client/components/code/evalCode.js'
import {
  makeFakeToneLib,
  VALID_CODE,
  VALID_CODE_NO_OPTIONS,
  SYNTAX_ERROR_CODE,
  STRUCTURE_ERROR_NO_C_CODE,
  STRUCTURE_ERROR_BAD_VARS_CODE
} from './helpers.mjs'

const evalWithFakeTone = (code) => {
  const registry = []
  const result = evalCode(code, { Tone: makeFakeToneLib(registry) })
  return { result, registry }
}

test('valid code evaluates to an ok result with c, e and o', () => {
  const { result, registry } = evalWithFakeTone(VALID_CODE)

  assert.equal(result.status, 'ok')
  assert.ok(result.body.c, 'result must contain c')
  assert.ok(Array.isArray(result.body.e), 'result must contain e')
  assert.ok(result.body.o, 'result must contain o')
  // the sound code instantiated its objects through the injected Tone lib
  assert.equal(registry.length, 2)
})

test('valid code without options var is ok', () => {
  const { result } = evalWithFakeTone(VALID_CODE_NO_OPTIONS)
  assert.equal(result.status, 'ok')
  assert.ok(result.body.c)
})

test('syntax error is reported with errorType syntax', () => {
  const { result } = evalWithFakeTone(SYNTAX_ERROR_CODE)

  assert.equal(result.status, 'err')
  assert.equal(result.errorType, ERROR_TYPES.SYNTAX)
  assert.match(result.body, /^EDITOR SYNTAX ERROR =>/)
})

test('missing c var is a structure error, not a syntax error', () => {
  const { result } = evalWithFakeTone(STRUCTURE_ERROR_NO_C_CODE)

  assert.equal(result.status, 'err')
  assert.equal(result.errorType, ERROR_TYPES.STRUCTURE)
  assert.match(result.body, /^EDITOR RESULT ERROR =>/)
  assert.match(result.body, /c\(code\)/)
})

test('o.vars entries that are not arrays are a structure error', () => {
  const { result } = evalWithFakeTone(STRUCTURE_ERROR_BAD_VARS_CODE)

  assert.equal(result.status, 'err')
  assert.equal(result.errorType, ERROR_TYPES.STRUCTURE)
  assert.match(result.body, /result\.o\.vars/)
})

test('result that is not an object is a structure error', () => {
  const { result } = evalWithFakeTone(`let c = new Tone.Loop(() => {}, '4n')\nreturn 42`)

  assert.equal(result.status, 'err')
  assert.equal(result.errorType, ERROR_TYPES.STRUCTURE)
})

test('runtime exception inside the code is a syntax error', () => {
  const { result } = evalWithFakeTone(`let c = doesNotExist.atAll()`)

  assert.equal(result.status, 'err')
  assert.equal(result.errorType, ERROR_TYPES.SYNTAX)
})
