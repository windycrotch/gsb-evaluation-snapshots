// Minimal but real Meteor client/server runtime for the harness.
// Methods registered by the app's imports/api/* files run here for real;
// Meteor.call dispatches synchronously (like a server-side call) and clones
// arguments/return values with EJSON-like semantics, as DDP would.

import { wireClone } from '../ejson.js'

const methods = {}
export const callLog = []

export const Meteor = {
  isServer: true,
  isClient: true,
  isProduction: false,

  methods: definitions => Object.assign(methods, definitions),

  call: (name, ...args) => {
    let callback = null
    if (args.length && typeof args[args.length - 1] === 'function') callback = args.pop()
    callLog.push([name, ...args])
    if (!methods[name]) throw new Error(`Method not found [${name}]`)
    const wireArgs = args.map(a => wireClone(a))
    const result = methods[name].apply({}, wireArgs)
    const wireResult = wireClone(result)
    if (callback) callback(null, wireResult)
    return wireResult
  },

  publish: (name, fn) => { /* publications are a no-op in the harness */ },
  subscribe: () => ({ stop: () => {}, ready: () => true }),
  startup: fn => fn(),

  _methods: methods,
}

// several app modules use the Meteor global without importing it
if (!globalThis.Meteor) globalThis.Meteor = Meteor

export default Meteor
