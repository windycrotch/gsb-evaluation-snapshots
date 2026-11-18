import assert from 'node:assert/strict';

// Offline behavior tests declare every message they use. This fixture clones
// payloads and checks message names only; real codec tests use loadProtocol.
export function createDeclaredProtocol(names) {
  assert(Array.isArray(names) && names.length > 0, 'Declare the fixture message names');
  assert.equal(new Set(names).size, names.length, 'Fixture message names must be unique');
  return Object.freeze(Object.fromEntries(names.map(name => {
    assert.equal(typeof name, 'string');
    return [name, Object.freeze({
      encode(value) { return { finish: () => structuredClone(value) }; },
      decode(value) { return structuredClone(value); },
    })];
  })));
}
