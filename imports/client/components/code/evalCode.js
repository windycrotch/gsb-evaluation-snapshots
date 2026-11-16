import { prepareCode } from './prepareCode'

// The two kinds of failure a sound code evaluation can produce:
//  - syntax:    the code cannot be parsed / executed
//  - structure: the code runs but its result does not follow the convention
//               (result must be an object with c and e, and o.vars entries must be arrays)
export const ERROR_TYPES = {
  SYNTAX: 'syntax',
  STRUCTURE: 'structure'
}

const syntaxError = (message) => ({ status: 'err', errorType: ERROR_TYPES.SYNTAX, body: `EDITOR SYNTAX ERROR => ${message}` })
const structureError = (message) => ({ status: 'err', errorType: ERROR_TYPES.STRUCTURE, body: `EDITOR RESULT ERROR => ${message}` })

// The evaluated code may reference Tone, teoria, each and filter as free variables.
// Resolve them from the injected scope first, then from the browser globals,
// so this module stays usable without importing Tone.js (e.g. in offline tests).
const resolveScope = (scope) => {
  const g = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {})
  return {
    Tone: scope.Tone || g.Tone,
    teoria: scope.teoria || g.teoria,
    each: scope.each || (g._ && g._.each),
    filter: scope.filter || (g._ && g._.filter)
  }
}

export let evalCode = (code, scope = {}) => {

  let prepared
  try {
    prepared = prepareCode(code)
  } catch (e) {
    return syntaxError(e.message)
  }
  if (typeof prepared !== 'string') return syntaxError('the code could not be parsed')

  // these consts are intentionally "unused": the evaluated code closes over them
  const { Tone, teoria, each, filter } = resolveScope(scope)

  let result
  try {
    result = eval(`(function self(){${prepared}}())`);
  } catch (e) {
    return syntaxError(e.message)
  }

  if (!result || typeof result !== 'object') return structureError('the code should return an object containing one c(code) var')
  if (!result.c) return structureError('the code should contain one c(code) var')
  if (!result.e) return structureError('the code should contain one e(elements) var')
  if (result.o && result.o.vars) {
    let vars = result.o.vars
    if (!Array.isArray(vars) || vars.some(v => !Array.isArray(v))) {
      return structureError('each result.o.vars structure should be [NAMEVAR, VAR, MINVAL, MAXVAL]')
    }
  }

  return { status: 'ok', body: result }
}
