// Dependency-free core of the player: turns sound documents
// ({_id, name, code, muted}) into live tone objects and tracks per-sound
// evaluation errors. It guarantees that:
//  - a sound whose code fails to evaluate KEEPS its previous live tone
//    (unless the sound is muted),
//  - a muted sound never produces nor keeps a tone object,
//  - unmuting regenerates the tone from the current code,
//  - an error state is cleared as soon as the code evaluates fine again.
//
// Every side effect (Tone.js transport, Meteor persistence, window globals)
// is injected through `deps`, so this module can be tested offline with fakes.
//
// deps: {
//   evalCode(code)            -> {status: 'ok', body} | {status: 'err', errorType, body}
//   startTone(tone)           -> starts a live tone object
//   stopTone(tone)            -> stops a live tone object
//   disposeElements(elements) -> disposes the elementsToDispose of a tone
//   persistTone(tone)         -> persists a tone (mixer params replication)
//   initTonesModifiers(vars)  -> applies the init values of the options vars
//   removeTonePersistence(id) -> removes the persisted tone of a sound (optional)
//   onChange({tones, errors}) -> called after every state change (optional)
// }

export const createSoundEngine = (deps) => {
  let tones = []
  let errors = {}

  const notify = () => {
    if (deps.onChange) deps.onChange({ tones: tones.slice(), errors: Object.assign({}, errors) })
  }

  const setError = (sound, result) => {
    errors = Object.assign({}, errors, {
      [sound._id]: {
        name: sound.name,
        message: result.body,
        errorType: result.errorType || 'structure'
      }
    })
    notify()
  }

  const clearError = (soundId) => {
    if (!errors[soundId]) return
    errors = Object.assign({}, errors)
    delete errors[soundId]
  }

  const removeSound = (sound) => {
    const old = tones.find(t => t.soundId === sound._id)

    if (old) {
      deps.stopTone(old.tone)
      if (old.elementsToDispose) deps.disposeElements(old.elementsToDispose)
    }

    tones = tones.filter(t => t.soundId !== sound._id)
    clearError(sound._id)
    if (deps.removeTonePersistence) deps.removeTonePersistence(sound._id)
    notify()
  }

  const updateSound = (sound) => {
    const result = deps.evalCode(sound.code)

    if (result.status === 'err') {
      // a muted sound must not produce nor keep any tone object
      if (sound.muted) removeSound(sound)
      // an unmuted sound keeps its previous (still valid) tone playing
      setError(sound, result)
      return result
    }

    // the code evaluates fine again: drop the previous tone and any previous error
    removeSound(sound)

    // a muted sound produces no tone object
    if (sound.muted) {
      notify()
      return { status: 'ok' }
    }

    const body = result.body
    const tone = {
      soundId: sound._id,
      name: sound.name,
      tone: body.c,
      elementsToDispose: body.e,
      options: body.o
    }

    deps.startTone(tone.tone)
    tones = tones.concat(tone)
    if (tone.options && tone.options.vars) deps.initTonesModifiers(tone.options.vars)
    deps.persistTone(tone)
    notify()

    return { status: 'ok' }
  }

  return {
    updateSound,
    removeSound,
    getTones: () => tones.slice(),
    getErrors: () => Object.assign({}, errors)
  }
}
