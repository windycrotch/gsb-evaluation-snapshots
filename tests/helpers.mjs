// Shared fakes for the offline tests. No audio device, no Meteor, no npm deps.

// A fake "Tone.js"-like library injected into the evaluated sound code.
// Every created object is pushed into `registry` so tests can inspect what
// the sound code instantiated. start/stop/dispose calls are counted.
export const makeFakeToneLib = (registry) => {
  class Loop {
    constructor(callback, interval) {
      this.callback = callback
      this.interval = interval
      this.calls = { start: 0, stop: 0, dispose: 0 }
      registry.push(this)
    }
    start() { this.calls.start += 1; return this }
    stop() { this.calls.stop += 1; return this }
    dispose() { this.calls.dispose += 1; return this }
  }

  class MembraneSynth {
    constructor() {
      this.calls = { dispose: 0 }
      registry.push(this)
    }
    triggerAttackRelease() {}
    dispose() { this.calls.dispose += 1 }
  }

  return { Loop, MembraneSynth }
}

// Sound code samples -------------------------------------------------------

export const VALID_CODE = `
let synth = new Tone.MembraneSynth()
let c = new Tone.Loop((time) => { synth.triggerAttackRelease('C2', '8n', time) }, '4n')
let o = { vars: [ ['pitchDecay', synth, 0, 0.5, 0.1, 0] ] }
`

export const VALID_CODE_NO_OPTIONS = `
let c = new Tone.Loop(() => {}, '2n')
`

export const SYNTAX_ERROR_CODE = `
let c = new Tone.Loop(
`

export const STRUCTURE_ERROR_NO_C_CODE = `
let x = 1
`

export const STRUCTURE_ERROR_BAD_VARS_CODE = `
let c = new Tone.Loop(() => {}, '4n')
let o = { vars: [ 'pitchDecay' ] }
`

// Sound documents ----------------------------------------------------------

export const makeSound = (overrides = {}) => Object.assign({
  _id: 'sound-1',
  name: 'sound-one',
  code: VALID_CODE,
  muted: false
}, overrides)

// Engine deps recording every side effect ----------------------------------

export const makeFakeDeps = (evalCodeImpl) => {
  const calls = {
    started: [],
    stopped: [],
    disposed: [],
    persisted: [],
    removedPersistence: [],
    changes: []
  }

  const deps = {
    evalCode: evalCodeImpl,
    startTone: (tone) => calls.started.push(tone),
    stopTone: (tone) => calls.stopped.push(tone),
    disposeElements: (elements) => calls.disposed.push(elements),
    persistTone: (tone) => calls.persisted.push(tone),
    initTonesModifiers: () => {},
    removeTonePersistence: (soundId) => calls.removedPersistence.push(soundId),
    onChange: (state) => calls.changes.push(state)
  }

  return { deps, calls }
}
