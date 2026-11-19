// Injectable fake of the Tone.Transport scheduling surface.
//
// It never touches an audio device. Every call is recorded in order so tests
// can assert the exact stop -> dispose -> start sequence of an update, and
// pending per-sound events are kept in `pending` so tests can prove that mute
// and delete cancel everything a track had scheduled.
//
// A scheduled callback is only allowed to run while its generation is still
// current: the controller passes its `isCurrent` predicate when building the
// scheduler, which mirrors the guard the real Tone adapter applies before
// touching any source.
export const createFakeToneScheduler = (isCurrent = () => true) => {
  // soundId -> array of {id, generation, kind, run}
  const pending = Object.create(null)
  const calls = []
  let eventId = 0

  const eventsFor = soundId => {
    if (!pending[soundId]) pending[soundId] = []
    return pending[soundId]
  }

  const scheduler = {
    pending,
    calls,

    // Transport.scheduleOnce(time => callback(), 1) for starts / disposals.
    schedule(soundId, generation, kind, callback) {
      const id = ++eventId
      eventsFor(soundId).push({ id, generation, kind, run: callback })
      calls.push({ type: 'schedule', soundId, generation, kind, id })
      return id
    },

    // Tone.Transport.clear(eventId) for transport-event (numeric) tones.
    clear(soundId, generation, event) {
      calls.push({ type: 'clear', soundId, generation, event })
    },

    // Cancel every pending event of a sound and drop it from the registry.
    cancelSound(soundId, generation) {
      const events = pending[soundId] || []
      events.forEach(event => calls.push({
        type: 'cancel',
        soundId,
        generation,
        id: event.id,
        kind: event.kind
      }))
      delete pending[soundId]
      calls.push({ type: 'cancelSound', soundId, generation })
    },

    // stopTone: loops are stopped+disposed on the transport, numeric transport
    // events are cleared directly.
    stopSound(soundId, tone, generation) {
      calls.push({ type: 'stopSound', soundId, generation, tone })
      if (typeof tone === 'number') {
        scheduler.clear(soundId, generation, tone)
      } else {
        scheduler.schedule(soundId, generation, 'stop-loop', () => {
          tone.stop()
          tone.dispose()
        })
      }
    },

    startSound(soundId, tone, generation) {
      calls.push({ type: 'startSound', soundId, generation, tone })
      if (typeof tone === 'object' && tone !== null) {
        scheduler.schedule(soundId, generation, 'start-loop', () => tone.start(0))
      }
    },

    scheduleDispose(soundId, generation, callback) {
      return scheduler.schedule(soundId, generation, 'dispose', callback)
    },

    // Test helper: emulate the transport firing. Current-generation callbacks
    // run; stale callbacks are skipped exactly as the real Tone adapter's
    // isCurrent guard skips them, and every event is afterwards drained.
    flush(soundId) {
      const ids = soundId ? [soundId] : Object.keys(pending)
      const ran = []
      ids.forEach((id) => {
        const events = pending[id]
        if (!events) return
        // Snapshot first: callbacks must not change which remaining events the
        // guard is evaluated for.
        events.slice().forEach((event) => {
          if (isCurrent(id, event.generation)) {
            event.run()
            ran.push(event)
          }
        })
        pending[id] = []
      })
      return ran
    },

    pendingCount(soundId) {
      return (pending[soundId] || []).length
    }
  }

  return scheduler
}
