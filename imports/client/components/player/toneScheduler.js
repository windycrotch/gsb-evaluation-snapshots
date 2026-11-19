// Real Tone.Transport adapter implementing the same scheduler interface as the
// fake used in tests. Every scheduled callback is registered per sound and
// guarded by the controller's generation predicate, so:
//   * stop/release/start events are always ordered through the transport the
//     same way the fake records them;
//   * a release scheduled by an old, superseded update becomes a no-op once a
//     newer generation exists, and therefore cannot free the new source;
//   * mute/delete can cancel every pending event of one sound in one call.
import Tone from 'tone';
import { getToneType } from './tones';

export const createToneScheduler = (isCurrent) => {
  // soundId -> array of transport event ids
  const scheduled = {}

  const remember = (soundId, eventId) => {
    if (!scheduled[soundId]) scheduled[soundId] = []
    scheduled[soundId].push(eventId)
  }

  const scheduler = {
    schedule(soundId, generation, kind, callback) {
      const eventId = Tone.Transport.scheduleOnce(() => {
        if (!isCurrent(soundId, generation)) return
        callback()
      }, 1)
      remember(soundId, eventId)
      return eventId
    },

    clear(soundId, generation, event) {
      Tone.Transport.clear(event)
    },

    cancelSound(soundId, generation) {
      const events = scheduled[soundId] || []
      events.forEach(eventId => Tone.Transport.clear(eventId))
      delete scheduled[soundId]
    },

    stopSound(soundId, tone, generation) {
      const type = getToneType(tone)
      if (type === 'loop') {
        scheduler.schedule(soundId, generation, 'stop-loop', () => {
          tone.stop().dispose()
        })
      } else if (type === 'transport-event') {
        scheduler.clear(soundId, generation, tone)
      }
    },

    startSound(soundId, tone, generation) {
      const type = getToneType(tone)
      if (type === 'loop') {
        scheduler.schedule(soundId, generation, 'start-loop', () => tone.start(0))
      }
    },

    scheduleDispose(soundId, generation, callback) {
      return scheduler.schedule(soundId, generation, 'dispose', callback)
    }
  }

  return scheduler
}
