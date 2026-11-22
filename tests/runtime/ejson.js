// EJSON-like wire semantics for the test runtime.
//
// Real Meteor clones every argument of Meteor.call through EJSON and every
// document stored in / fetched from minimongo: class instances become plain
// objects, functions are dropped, Dates survive. This reproduces that
// behavior so the app code under test observes the same data shapes it
// would in the real client-server loop.
//
// Note: Tone.js objects are serializable in the browser (setTimeout returns
// a number there). Under Node they hold circular Timeout handles, so cycles
// are tolerated here and replaced with null — the browser equivalent of
// those branches contains no object at all.

export const wireClone = (value, seen = new Map()) => {
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t === 'function') return undefined
  if (t === 'number' || t === 'string' || t === 'boolean') return value
  if (value instanceof Date) return new Date(value.getTime())
  if (t !== 'object') return undefined

  if (seen.has(value)) return null
  seen.set(value, true)

  if (Array.isArray(value)) {
    const out = value.map(v => {
      const c = wireClone(v, seen)
      return c === undefined ? null : c
    })
    seen.delete(value)
    return out
  }

  const out = {}
  for (const key of Object.keys(value)) {
    const c = wireClone(value[key], seen)
    if (c !== undefined) out[key] = c
  }
  seen.delete(value)
  return out
}
