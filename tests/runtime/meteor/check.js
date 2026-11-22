// Minimal check shim (meteor/check) for the harness.

export const check = (value, pattern) => {
  if (pattern === String && typeof value !== 'string') throw new Error('Match error: expected string')
  if (pattern === Number && typeof value !== 'number') throw new Error('Match error: expected number')
  if (pattern === Boolean && typeof value !== 'boolean') throw new Error('Match error: expected boolean')
}

export const Match = { Optional: pattern => pattern }
