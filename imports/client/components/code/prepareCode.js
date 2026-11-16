import esprima from 'esprima'

// Parse the sound code, then append the return statement that builds the
// {c, o, e} object the player expects. Parse errors are thrown so the caller
// (evalCode) can report them as syntax errors.
export let prepareCode = (code) => {
  let result = esprima.parseModule(code)

  // get all the vars declarations
  let variables = result.body.filter(e => e.type === "VariableDeclaration")

  // build the object returned according to what is given
  let toneVar = variables.filter(v => ['t', 'tone', 'c'].includes(v.declarations[0].id.name))[0] || false
  if (toneVar) toneVar = toneVar.declarations[0].id.name

  let optionsVar = variables.filter(v => ['o', 'options'].includes(v.declarations[0].id.name))[0] || false
  if (optionsVar) optionsVar = optionsVar.declarations[0].id.name

  let allElements = variables.map(v => v.declarations[0].id.name)

  let returnStatement = `return {c: ${toneVar}, o: ${optionsVar}, e: [${allElements}]}`

  return code + '\n\r' + returnStatement
}
