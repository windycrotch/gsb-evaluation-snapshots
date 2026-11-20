import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateMelody } from '../../src/core/generator/melody.generator'
import { createRng } from '../../src/core/generator/rng'
import type { AppNote } from '../../src/core/schemas/note.schema'
import type { TrainedMarkovArtifact } from '../../src/core/schemas/trained-markov.schema'
import * as modelService from '../../src/services/trained-model-service'
import { useHarmonyStore } from '../../src/stores/harmony.store'
import { useMelodyStore } from '../../src/stores/melody.store'
import { useProjectStore } from '../../src/stores/project.store'
import { useTakesStore } from '../../src/stores/takes.store'

const SEED = 777

function sampleNote(id: string, step: number, midi = 60, durationSteps = 4): AppNote {
  return { id, pitch: 'C4', midi, step, durationSteps, velocity: 100, isMuted: false }
}

function musical(notes: AppNote[]) {
  return notes.map(({ id: _id, ...note }) => note)
}

/**
 * End-to-end invariants for "current effective model + generation range is the
 * sole basis of a generation": determinism, model switching, local replacement,
 * hard failure handling and in-flight switch races.
 */
describe('melody model + range generation invariants', () => {
  let melodyModel: TrainedMarkovArtifact
  let bassModel: TrainedMarkovArtifact

  beforeEach(async () => {
    setActivePinia(createPinia())
    const project = useProjectStore()
    project.setBars(4)
    project.setKey('C')
    project.setScale('minor')
    project.setWorkRange({ startStep: 0, endStep: 64 })
    useHarmonyStore().useChords = false
    const takes = useTakesStore()
    takes.currentSeed = SEED
    takes.setSeedLocked(true)
    const store = useMelodyStore()
    store.setGeneratorParams({
      rhythmMode: 'euclidean',
      motif: 'FREE',
      callAndResponse: false,
      restProbability: 0,
      velocityVariation: 0,
      minOctave: 3,
      maxOctave: 4
    })
    const melody = await modelService.loadTrainedModel('melody')
    const bass = await modelService.loadTrainedModel('bass')
    if (!melody || !bass) throw new Error('shipped models must load')
    melodyModel = melody
    bassModel = bass
  })

  afterEach(() => vi.restoreAllMocks())

  it('reproduces identical notes for the same model, range and seed twice in a row', async () => {
    vi.spyOn(modelService, 'loadTrainedModelForRole').mockResolvedValue(melodyModel)
    const store = useMelodyStore()
    store.setMelodyModel('melody')

    await store.generate()
    const first = musical(store.notes)
    await store.generate()
    const second = musical(store.notes)

    expect(second).toEqual(first)
  })

  it('uses only the newly selected model after a switch, matching a first-time generation with that model', async () => {
    vi.spyOn(modelService, 'loadTrainedModelForRole').mockImplementation(async (role) =>
      role === 'bass' ? bassModel : melodyModel
    )
    const store = useMelodyStore()

    store.setMelodyModel('bass')
    await store.generate()
    const bassFirst = musical(store.notes)

    store.setMelodyModel('melody')
    await store.generate()
    const switched = musical(store.notes)

    const project = useProjectStore()
    const melodyFromScratch = musical(
      generateMelody({
        project: project.toConfig(),
        generator: store.generatorParams,
        rangeStartStep: 0,
        rangeEndStep: 64,
        trainedModel: melodyModel,
        rng: createRng(SEED)
      })
    )
    const bassFromScratch = musical(
      generateMelody({
        project: project.toConfig(),
        generator: store.generatorParams,
        rangeStartStep: 0,
        rangeEndStep: 64,
        trainedModel: bassModel,
        rng: createRng(SEED)
      })
    )

    expect(bassFirst).toEqual(bassFromScratch)
    expect(switched).toEqual(melodyFromScratch)
    expect(switched).not.toEqual(bassFirst)
  })

  it('local regeneration only replaces notes inside the range and keeps outside note ids, pitches, steps and order', async () => {
    vi.spyOn(modelService, 'loadTrainedModelForRole').mockResolvedValue(melodyModel)
    const store = useMelodyStore()
    store.setMelodyModel('melody')
    const project = useProjectStore()
    project.setWorkRange({ startStep: 16, endStep: 32 })

    const outsideLeft = sampleNote('keep-left', 0, 60, 4)
    const crossing = sampleNote('keep-crossing', 12, 62, 8) // spans into the range
    const insideOld = sampleNote('drop-me', 20, 64, 4)
    const outsideRight = sampleNote('keep-right', 40, 71, 4)
    store.setNotes([outsideLeft, crossing, insideOld, outsideRight], false)
    const before = store.notes.map((note) => ({ ...note }))

    await store.generate()

    const after = store.notes
    // Outside notes survive with identity, pitch, step and ordering intact.
    expect(after.find((note) => note.id === 'keep-left')).toEqual(outsideLeft)
    expect(after.find((note) => note.id === 'keep-right')).toEqual(outsideRight)
    const crossingAfter = after.find((note) => note.id === 'keep-crossing')
    expect(crossingAfter).toMatchObject({ pitch: 'C4', midi: 62, step: 12, durationSteps: 4 })
    expect(after.some((note) => note.id === 'drop-me')).toBe(false)
    // Every generated onset is strictly inside the work range.
    const generated = after.filter((note) => !['keep-left', 'keep-crossing', 'keep-right'].includes(note.id))
    expect(generated.length).toBeGreaterThan(0)
    generated.forEach((note) => {
      expect(note.step).toBeGreaterThanOrEqual(16)
      expect(note.step).toBeLessThan(32)
    })
    // Chronological order is preserved and no outside musical data changed.
    expect(after.map((note) => note.step)).toEqual([...after.map((note) => note.step)].sort((a, b) => a - b))
    expect(before.filter((note) => note.step < 16 || note.step >= 32).map((note) => note.id)).toEqual(
      after
        .filter((note) => note.step < 16 || note.step >= 32)
        .filter((note) => ['keep-left', 'keep-crossing', 'keep-right'].includes(note.id))
        .map((note) => note.id)
    )
  })

  it('writes nothing, keeps every existing note and shows a visible error when the model load fails', async () => {
    vi.spyOn(modelService, 'loadTrainedModelForRole').mockRejectedValue(new Error('network down'))
    vi.spyOn(modelService, 'loadTrainedModelIndex').mockResolvedValue(null)
    const store = useMelodyStore()
    store.setMelodyModel('melody')
    const existing = [sampleNote('a', 0), sampleNote('b', 16), sampleNote('c', 48)]
    store.setNotes(existing, false)

    await store.generate()

    expect(store.notes).toEqual(existing)
    expect(store.hasMelodyModelError).toBe(true)
    expect(store.melodyModelStatus).toBe('error')
    expect(store.melodyModelStatusMessage.length).toBeGreaterThan(0)
    expect(useTakesStore().takes).toEqual([])
    expect(useTakesStore().currentSeed).toBe(SEED)
  })

  it('preserves the diagnostic message when a load throws inside the composable', async () => {
    const rejected = vi.spyOn(modelService, 'loadTrainedModelForRole').mockRejectedValue(new Error('network down'))
    vi.spyOn(modelService, 'loadTrainedModelIndex').mockResolvedValue(null)
    const { useMelodyModel } = await import('../../src/composables/useMelodyModel')
    const { ref } = await import('vue')
    const modelState = useMelodyModel(ref<'melody'>('melody'))

    const result = await modelState.loadModel('melody', undefined)

    expect(result.artifact).toBeNull()
    expect(modelState.modelStatus.value).toBe('error')
    expect(modelState.modelStatusMessage.value).toContain('network down')
    rejected.mockRestore()
  })

  it('treats an empty/null model table as a failure without touching existing notes', async () => {
    vi.spyOn(modelService, 'loadTrainedModelForRole').mockResolvedValue(null)
    vi.spyOn(modelService, 'loadTrainedModelIndex').mockResolvedValue(null)
    const store = useMelodyStore()
    store.setMelodyModel('bass')
    const existing = [sampleNote('survive', 8)]
    store.setNotes(existing, false)

    await store.generate()

    expect(store.notes).toEqual(existing)
    expect(store.hasMelodyModelError).toBe(true)
    expect(useTakesStore().takes).toEqual([])
  })

  it('recovers on retry and uses the freshly loaded model instead of any cached failure', async () => {
    const roleLoader = vi
      .spyOn(modelService, 'loadTrainedModelForRole')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(melodyModel)
    vi.spyOn(modelService, 'loadTrainedModelIndex').mockResolvedValue(null)
    const store = useMelodyStore()
    store.setMelodyModel('melody')

    await store.generate()
    expect(store.hasMelodyModelError).toBe(true)
    expect(store.notes).toEqual([])

    await store.generate()
    expect(store.hasMelodyModelError).toBe(false)
    expect(store.melodyModelStatus).toBe('ready')
    expect(store.notes.length).toBeGreaterThan(0)
    expect(roleLoader).toHaveBeenCalledTimes(2)

    const expected = musical(
      generateMelody({
        project: useProjectStore().toConfig(),
        generator: store.generatorParams,
        rangeStartStep: 0,
        rangeEndStep: 64,
        trainedModel: melodyModel,
        rng: createRng(SEED)
      })
    )
    expect(musical(store.notes)).toEqual(expected)
  })

  it('attributes an in-flight model switch plus retrigger to one model with no mixed output', async () => {
    let resolveBass!: (model: TrainedMarkovArtifact) => void
    const bassPromise = new Promise<TrainedMarkovArtifact>((resolve) => {
      resolveBass = resolve
    })
    const roleLoader = vi
      .spyOn(modelService, 'loadTrainedModelForRole')
      .mockImplementation((role) => (role === 'bass' ? bassPromise : Promise.resolve(melodyModel)))
    vi.spyOn(modelService, 'loadTrainedModelIndex').mockResolvedValue(null)
    const store = useMelodyStore()
    store.setMelodyModel('bass')

    const first = store.generate()
    // Switch while the bass load is pending and trigger again immediately.
    store.setMelodyModel('melody')
    const second = store.generate()
    expect(store.isGenerating).toBe(true)

    resolveBass(bassModel)
    await Promise.all([first, second])

    expect(store.isGenerating).toBe(false)
    expect(roleLoader).toHaveBeenCalledTimes(2)
    // The committed result must be the pure melody-model output.
    const expected = musical(
      generateMelody({
        project: useProjectStore().toConfig(),
        generator: store.generatorParams,
        rangeStartStep: 0,
        rangeEndStep: 64,
        trainedModel: melodyModel,
        rng: createRng(SEED)
      })
    )
    expect(musical(store.notes)).toEqual(expected)
    // No intermediate bass-model take is retained for the locked seed.
    expect(useTakesStore().takes.at(-1)?.context.modelId).toBe(melodyModel.id)
  })

  it('a stale in-flight load cannot repaint the panel after a switch without a new generation', async () => {
    const { nextTick, ref } = await import('vue')
    const { useMelodyModel } = await import('../../src/composables/useMelodyModel')
    const choice = ref<'bass' | 'melody'>('bass')
    const modelState = useMelodyModel(choice)
    let resolveBass!: (model: TrainedMarkovArtifact) => void
    vi.spyOn(modelService, 'loadTrainedModelForRole').mockImplementation(
      (role) =>
        new Promise((resolve) => {
          if (role === 'bass') resolveBass = resolve
          else resolve(melodyModel)
        })
    )
    vi.spyOn(modelService, 'loadTrainedModelIndex').mockResolvedValue(null)

    const pending = modelState.loadModel('bass', undefined)
    // The selection moves on while the bass load is still pending.
    choice.value = 'melody'
    await nextTick()
    expect(modelState.modelStatus.value).toBe('idle')

    resolveBass(bassModel)
    const result = await pending

    // The stale bass result is returned to its own caller but never repaints
    // the panel, which must remain on the idle state of the new selection.
    expect(result.artifact?.id).toBe(bassModel.id)
    expect(modelState.modelStatus.value).toBe('idle')
    expect(modelState.activeModelId.value).toBeNull()
  })

  it('still allows synthetic generation after a trained-model failure', async () => {
    vi.spyOn(modelService, 'loadTrainedModelForRole').mockRejectedValue(new Error('down'))
    vi.spyOn(modelService, 'loadTrainedModelIndex').mockResolvedValue(null)
    const store = useMelodyStore()
    store.setMelodyModel('melody')
    await store.generate()
    expect(store.hasMelodyModelError).toBe(true)

    store.setMelodyModel('synthetic')
    await store.generate()

    expect(store.hasMelodyModelError).toBe(false)
    expect(store.melodyModelStatus).toBe('ready')
    expect(store.notes.length).toBeGreaterThan(0)
  })
})
