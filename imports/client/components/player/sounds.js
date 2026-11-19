import { evalCode } from '../code/evalCode';
import { persistTone, removePersistedTone } from './tones';
import { createToneScheduler } from './toneScheduler';
import { createGenerationRegistry, createSoundController } from './soundController';

// In-memory registry of the live tracks. Kept on window for the mixer /
// observeTones consumers, exactly as before.
const tones = []
window.tones = tones

// One generation registry shared by the scheduler (it needs the predicate to
// guard scheduled callbacks) and the controller (it claims the generations).
const registry = createGenerationRegistry()
const scheduler = createToneScheduler(registry.isCurrent)

const controller = createSoundController({
  evaluate: evalCode,
  scheduler,
  store: window.tones,
  persist: persistTone,
  removePersisted: removePersistedTone,
  registry
})

// Sound created or updated (code edited / mute toggled).
// Validate-first: on failure the previous source keeps playing, the store and
// the persisted record are untouched, and a readable error is returned.
export let updateSound = sound => controller.updateSound(sound)

// Sound deleted: clears the in-memory entry, every pending Tone transport
// event for that sound and the persisted tones collection record.
export let removeSound = sound => controller.removeSound(sound)
