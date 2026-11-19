import { prepareCode } from './prepareCode'
import { validateEvalResult } from '../player/soundController'

import Tone from 'tone';
import teoria from 'teoria'

export let evalCode = (code) => {

  let prepared = prepareCode(code)
  if (prepared === undefined) {
    return {
      status: 'err',
      body: 'EDITOR SYNTAX ERROR => the code could not be parsed (prepareCode failed)'
    }
  }

  try {
    let result = eval(`(function self(){${prepared}}())`);

    // Structural validation lives in the controller so the same rules apply to
    // the production evaluator and to injected test evaluators.
    let validation = validateEvalResult(result)
    if (!validation.valid) return {status: 'err', body: validation.error}

    return {status: 'ok', body: result}

  } catch (e) {
    let error = `EDITOR SYNTAX ERROR => ${e.message}`
    return {status: 'err', body: error}
  }
}
