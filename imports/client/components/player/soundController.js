// Framework-agnostic sound-track update controller.
//
// This module deliberately has NO import of Meteor, Tone, lodash or any other
// runtime that requires a browser/audio device. Every side effect goes through
// the injected dependencies, which makes the whole update lifecycle testable
// under plain Node with a fake scheduler (see ../../../../../tests/).
//
// Lifecycle guarantees implemented here:
//   * a track update is an atomic validate -> switch transaction: the new code
//     is evaluated and validated first, and only on success is the old source
//     stopped/released, the new one started and the persistence record written;
//   * on evaluation/validation failure the old source keeps playing, the
//     persisted record is untouched and a readable error is returned;
//   * mute only stops playback and keeps the code, unmute regenerates the
//     source from the original code;
//   * every sound carries a monotonically increasing generation token, so a
//     late asynchronous start/release from an older evaluation can never touch
//     a newer source;
//   * re-evaluated sources are initialised with their persisted parameter
//     values instead of the defaults baked in the code.

// Monotonic per-sound generation registry. A generation is claimed
// synchronously when an update/delete starts, which invalidates every
// asynchronous callback (eval resolution, scheduled release) born earlier.
export const createGenerationRegistry = () => {
  const generations = Object.create(null)
  // Sound ids removed through removeSound. A generation claimed before the
  // deletion can never become "current" again, so an in-flight evaluation that
  // resolves afterwards cannot resurrect the deleted track.
  const retired = Object.create(null)

  return {
    claim(soundId) {
      // A new lifecycle for this id (re-add after deletion): clear the
      // tombstone so the freshly claimed generation is current again.
      delete retired[soundId]
      const next = (generations[soundId] || 0) + 1
      generations[soundId] = next
      return next
    },

    current(soundId) {
      return generations[soundId] || 0
    },

    isCurrent(soundId, generation) {
      return !retired[soundId] && generation === generations[soundId]
    },

    forget(soundId) {
      retired[soundId] = true
      delete generations[soundId]
    }
  }
}

const VARS_MIN_LENGTH = 2
const VARS_NAME_INDEX = 0
const VARS_TARGET_INDEX = 1
const VARS_INITIAL_VALUE_INDEX = 5
const ROUND_DECIMALS = 5

// Shared validation of the object produced by evaluating track code.
// Missing `c`/`e`, or an illegal `options.vars` structure, are failures and
// must never reach persistence as a half-built record.
export const validateEvalResult = (result) => {
  const missingResultError =
    'EDITOR RESULT ERROR => the code should return an object containing a c (code) var and an e (elements to dispose) var'

  if (!result || typeof result !== 'object') {
    return { valid: false, error: missingResultError }
  }
  if (!result.c) {
    return { valid: false, error: missingResultError }
  }
  if (!result.e) {
    return { valid: false, error: missingResultError }
  }

  if (result.o && result.o.vars !== undefined && result.o.vars !== null) {
    const varsError =
      'EDITOR RESULT ERROR => each result.o.vars entry must be an array shaped [NAMEVAR, VAR, MINVAL, MAXVAL, STEP?, INITIAL?]'
    const vars = result.o.vars

    if (!Array.isArray(vars)) return { valid: false, error: varsError }

    const malformed = vars.some(
      entry => !Array.isArray(entry)
        || entry.length < VARS_MIN_LENGTH
        || typeof entry[VARS_NAME_INDEX] !== 'string'
        || entry[VARS_TARGET_INDEX] === null
        || typeof entry[VARS_TARGET_INDEX] !== 'object'
    )
    if (malformed) return { valid: false, error: varsError }
  }

  return { valid: true }
}

const round5 = value => Math.round(value * 10 ** ROUND_DECIMALS) / 10 ** ROUND_DECIMALS

// Apply the initial value (index 5) of each option var, the same way the
// original initTonesModifiers did. Pure: it only mutates the var targets
// embedded in the freshly evaluated source.
export const applyInitialVarValues = (vars) => {
  if (!Array.isArray(vars)) return

  vars.forEach((entry) => {
    const initial = entry[VARS_INITIAL_VALUE_INDEX]
    if (typeof initial !== 'number') return

    const target = entry[VARS_TARGET_INDEX]
    const name = entry[VARS_NAME_INDEX]
    // A Tone.Param exposes the controllable number through .value; a plain
    // synth property is a number directly under its name.
    if (typeof target.value === 'number') {
      target.value = round5(initial)
    } else if (typeof target[name] === 'number') {
      target[name] = round5(initial)
    }
  })
}

// After a re-evaluation every Tone object is brand new, so the values adjusted
// through the mixer would be lost without restoring the persisted values of
// the previous source for the same sound.
const applyPersistedVars = (vars, previousEntry) => {
  if (!Array.isArray(vars) || !previousEntry || !Array.isArray(previousEntry.vars)) return

  const previousByName = {}
  previousEntry.vars.forEach((entry) => {
    previousByName[entry[VARS_NAME_INDEX]] = entry
  })

  vars.forEach((entry) => {
    const previous = previousByName[entry[VARS_NAME_INDEX]]
    if (!previous) return

    const previousTarget = previous[VARS_TARGET_INDEX]
    if (!previousTarget) return

    const target = entry[VARS_TARGET_INDEX]
    const name = entry[VARS_NAME_INDEX]

    if (typeof previousTarget.persistedValue === 'number') {
      target.value = previousTarget.persistedValue
    } else if (typeof previousTarget.value === 'number') {
      target.value = previousTarget.value
    } else if (previousTarget[name] !== undefined) {
      target[name] = previousTarget[name]
    }
  })
}

// Build the framework-agnostic controller.
//
// deps:
//   evaluate(code)        -> {status:'ok', body} | {status:'err', body} (may be async)
//   scheduler             -> tone scheduler, see createFakeToneScheduler /
//                            createToneScheduler for the expected interface
//   store                 -> array holding the live track entries (window.tones)
//   persist(entry)        -> write a track record
//   removePersisted(id)   -> delete the track record
//   registry              -> generation registry (defaults to a fresh one)
export const createSoundController = (deps) => {
  const {
    evaluate,
    scheduler,
    store,
    persist,
    removePersisted,
    registry = createGenerationRegistry()
  } = deps

  const findEntry = soundId => store.find(entry => entry.soundId === soundId)

  const upsertEntry = (entry) => {
    const index = store.findIndex(item => item.soundId === entry.soundId)
    if (index === -1) {
      store.push(entry)
    } else {
      store[index] = entry
    }
  }

  const removeEntry = (soundId) => {
    const index = store.findIndex(item => item.soundId === soundId)
    if (index !== -1) store.splice(index, 1)
  }

  // Stop a source and release its disposable elements. Disposal is scheduled
  // through the (fake or real) Tone transport and guarded by the generation, so
  // a release born from an old update can never free a newer source's elements
  // when the transport eventually fires it. The elements are snapshotted into
  // the closure: nothing the callback reads can be mutated by a later update.
  const stopAndRelease = (entry, generation) => {
    scheduler.stopSound(entry.soundId, entry.tone, generation)

    const elements = Array.isArray(entry.elementsToDispose)
      ? entry.elementsToDispose.slice()
      : []

    if (elements.length) {
      scheduler.scheduleDispose(entry.soundId, generation, () => {
        elements.forEach((element) => {
          if (element && typeof element.dispose === 'function') {
            try {
              element.dispose()
            } catch (e) {
              console.log('error when dispose() :' + e.message)
            }
          }
        })
      })
    }
  }

  const commitMute = (sound, generation, previousEntry, evaluatedOptions) => {
    if (previousEntry) {
      stopAndRelease(previousEntry, generation)
      removeEntry(sound._id)
    }

    const vars = (evaluatedOptions && evaluatedOptions.vars)
      || (previousEntry && previousEntry.vars)
      || []

    const entry = {
      soundId: sound._id,
      name: sound.name,
      code: sound.code,
      muted: true,
      // Keep the same shape as an audible entry so the persisted record and
      // the mixer keep working while the track is silent.
      options: evaluatedOptions || (previousEntry && previousEntry.options),
      vars
    }
    upsertEntry(entry)

    // Keep the persisted snapshot coherent when the code changed while muted;
    // plain muting writes nothing and simply keeps the existing record.
    if (evaluatedOptions) persist(entry)
  }

  // Single entry point for "the track document changed" (add or update).
  // Returns {status:'ok'} or {status:'err', body} and may be awaited because
  // the evaluator is allowed to be asynchronous.
  const updateSound = async (sound) => {
    const soundId = sound._id
    const generation = registry.claim(soundId)
    const previousEntry = findEntry(soundId)

    // --- MUTED TRACK -----------------------------------------------------
    // Mute only stops playback; the code is retained so unmute can regenerate
    // the source from it. Nothing is evaluated when the code did not change.
    if (sound.muted) {
      if (previousEntry && previousEntry.code === sound.code) {
        commitMute(sound, generation, previousEntry, null)
        return { status: 'ok' }
      }

      const result = await evaluate(sound.code)
      if (!registry.isCurrent(soundId, generation)) {
        // A newer update/delete happened while the evaluation was in flight.
        return { status: 'stale' }
      }
      if (result.status === 'err') return result

      const validation = validateEvalResult(result.body)
      if (!validation.valid) return { status: 'err', body: validation.error }

      commitMute(sound, generation, previousEntry, result.body.o)
      return { status: 'ok' }
    }

    // --- AUDIBLE TRACK: validate first, switch only on success ------------
    const result = await evaluate(sound.code)
    if (!registry.isCurrent(soundId, generation)) {
      return { status: 'stale' }
    }

    if (result.status === 'err') return result

    const validation = validateEvalResult(result.body)
    if (!validation.valid) {
      return { status: 'err', body: validation.error }
    }

    // Validation passed: now tear down the previous source. Its vars are read
    // by applyPersistedVars before the store entry is replaced, so the new
    // source can be rebuilt with them instead of the code defaults.
    const vars = result.body.o && result.body.o.vars

    if (previousEntry) {
      stopAndRelease(previousEntry, generation)
      removeEntry(soundId)
    }

    applyInitialVarValues(vars)
    applyPersistedVars(vars, previousEntry)

    // Start the new source, then register it, then persist: no half-built
    // record can be written if an earlier step throws.
    scheduler.startSound(soundId, result.body.c, generation)

    const entry = {
      soundId,
      name: sound.name,
      code: sound.code,
      muted: false,
      tone: result.body.c,
      elementsToDispose: result.body.e,
      options: result.body.o,
      vars: vars || []
    }
    upsertEntry(entry)
    persist(entry)

    return { status: 'ok' }
  }

  // Deletion clears all three places a track can live: the controller store,
  // every pending Tone transport event scheduled for the sound, and the
  // persisted collection record.
  const removeSound = (sound) => {
    const soundId = sound._id
    const generation = registry.claim(soundId)
    const entry = findEntry(soundId)

    if (entry) {
      stopAndRelease(entry, generation)
      removeEntry(soundId)
    }

    // Belt and braces: cancel anything still queued for this sound, including
    // events whose entry was already replaced by a racing update.
    scheduler.cancelSound(soundId, generation)
    removePersisted(soundId)
    registry.forget(soundId)
  }

  return {
    updateSound,
    removeSound,
    findEntry,
    isCurrent: (soundId, generation) => registry.isCurrent(soundId, generation),
    currentGeneration: soundId => registry.current(soundId)
  }
}
