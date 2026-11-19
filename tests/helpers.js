// Shared builders for the sound-controller tests. Everything here is plain
// objects/functions: no Tone, no Meteor, no audio device.
import { createGenerationRegistry, createSoundController } from
  '../imports/client/components/player/soundController.js'
import { createFakeToneScheduler } from './fakeToneScheduler.js'

// A controllable evaluator. By default it resolves with a fresh loop-like
// source per code string; tests can switch to deferred promises (queue.defer())
// to interleave asynchronous updates and resolve them out of order.
export const createFakeEvaluator = (options = {}) => {
  const calls = []
  const queue = options.deferred || { items: [] }

  const evaluator = async (code) => {
    calls.push(code)

    if (queue.items.length) {
      return queue.items.shift()
    }

    if (options.failOn && options.failOn(code)) {
      return { status: 'err', body: `forced failure for: ${code}` }
    }

    return {
      status: 'ok',
      body: options.build ? options.build(code) : defaultBuild(code)
    }
  }

  evaluator.calls = calls
  // One deferred slot per upcoming evaluation, in call order.
  evaluator.defer = () => {
    let resolve
    const promise = new Promise((res) => { resolve = res })
    queue.items.push(promise)
    return { promise, resolve }
  }
  return evaluator
}

let loopCounter = 0

// Mimics a Tone loop source (object with start/stop/dispose) plus one
// disposable element, so call ordering and disposal can be observed.
// Unique per call: every fake source gets its own distinct object identity.
export const createFakeLoop = (label) => {
  const id = ++loopCounter
  const events = []
  return {
    label: label ? `${label}-${id}` : `loop-${id}`,
    events,
    start(...args) { events.push(['start', ...args]); return this },
    stop(...args) { events.push(['stop', ...args]); return this },
    dispose(...args) { events.push(['dispose', ...args]); return this }
  }
}

export const defaultBuild = (code) => {
  const loop = createFakeLoop(code)
  const element = createFakeLoop(`${code}-element`)
  return { c: loop, e: [element], o: { vars: [] } }
}

// Build a vars structure like real track code: [name, target, min, max, step, initial]
export const createVarEntry = (name, target, initial) =>
  [name, target, 0, 1, 0.01, initial]

export const createHarness = (evaluatorOptions = {}) => {
  const store = []
  const persisted = []
  const removedIds = []
  const registry = createGenerationRegistry()
  const scheduler = createFakeToneScheduler(registry.isCurrent)
  const evaluator = createFakeEvaluator(evaluatorOptions)

  const controller = createSoundController({
    evaluate: evaluator,
    scheduler,
    store,
    persist: entry => persisted.push({ ...entry }),
    removePersisted: soundId => removedIds.push(soundId),
    registry
  })

  const sound = (overrides = {}) => ({
    _id: 'sound-1',
    name: 'sound-1',
    muted: false,
    code: 'code-A',
    ...overrides
  })

  const types = list => list.map(call => call.type)

  return {
    store,
    persisted,
    removedIds,
    registry,
    scheduler,
    evaluator,
    controller,
    sound,
    types,
    flush: () => scheduler.flush()
  }
}

// Create N deferred evaluation slots before firing the corresponding number of
// controller.updateSound calls.
export const deferEvaluations = (harness, count) => {
  const slots = []
  for (let i = 0; i < count; i += 1) slots.push(harness.evaluator.defer())
  return slots
}
