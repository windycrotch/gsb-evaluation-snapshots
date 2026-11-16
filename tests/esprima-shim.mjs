// Minimal esprima-compatible shim used ONLY by the offline tests.
// The real app uses the `esprima` npm package; the tests run without any
// node_modules, so this shim provides the single API prepareCode relies on:
// parseModule(code) -> { body: [ {type: 'VariableDeclaration', declarations: [{id: {name}}]} ] }
//
// It only needs to extract top-level variable declarations from well-formed
// code. Genuinely malformed code is still caught later by eval() inside
// evalCode and reported as a syntax error, exactly like in production.

const DECLARATION = /^\s*(?:let|const|var)\s+([A-Za-z_$][\w$]*)/gm

export function parseModule(code) {
  if (typeof code !== 'string') throw new Error('Invalid code')
  const body = []
  let match
  while ((match = DECLARATION.exec(code)) !== null) {
    body.push({
      type: 'VariableDeclaration',
      declarations: [{ id: { name: match[1] } }]
    })
  }
  return { body }
}

export default { parseModule }
