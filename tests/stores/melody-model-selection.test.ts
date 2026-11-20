import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateMelody } from '../../src/core/generator/melody.generator'
import { createRng } from '../../src/core/generator/rng'
import * as rhythmPresets from '../../src/core/rhythm/presets'
import type { GeneratorParams } from '../../src/core/schemas/generator.schema'
import type { AppNote } from '../../src/core/schemas/note.schema'
import type { TrainedMarkovArtifact } from '../../src/core/schemas/trained-markov.schema'
import * as modelService from '../../src/services/trained-model-service'
import { useHarmonyStore } from '../../src/stores/harmony.store'
import { useMelodyStore } from '../../src/stores/melody.store'
import { useProjectStore } from '../../src/stores/project.store'
import { useRhythmStore } from '../../src/stores/rhythm.store'
import { useTakesStore } from '../../src/stores/takes.store'

const SEED = 4242
let bassModel: TrainedMarkovArtifact
let melodyModel: TrainedMarkovArtifact

function musicalNotes(notes: AppNote[]) {
  return notes.map(({ id: _id, ...note }) => note)
}

function expectedNotes(
  model: TrainedMarkovArtifact | null,
  generator: GeneratorParams = useMelodyStore().generatorParams
) {
  const project = useProjectStore()
  return musicalNotes(
    generateMelody({
      project: project.toConfig(),
      generator,
      rhythmPreset:
        generator.rhythmMode === 'preset' ? rhythmPresets.getRhythmPresetById(generator.rhythmPresetId) : undefined,
      customPattern: generator.rhythmMode === 'custom' ? useRhythmStore().pattern : undefined,
      trainedModel: model,
      rangeStartStep: project.workRange.startStep,
      rangeEndStep: project.workRange.endStep,
      rng: createRng(SEED)
    })
  )
}

describe('melody generation model selection', () => {
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
    useMelodyStore().setGeneratorParams({
      rhythmMode: 'preset',
      randomRhythmPreset: false,
      motif: 'FREE',
      callAndResponse: false,
      restProbability: 0,
      velocityVariation: 0,
      minOctave: 2,
      maxOctave: 3,
      startWithRoot: true,
      endWithRoot: false
    })
    const bass = await modelService.loadTrainedModel('bass')
    const melody = await modelService.loadTrainedModel('melody')
    if (!bass || !melody) throw new Error('Shipped bass and melody models must be available')
    bassModel = bass
    melodyModel = melody
    vi.spyOn(modelService, 'loadTrainedModelForRole').mockImplementation(async (role) =>
      role === 'bass' ? bassModel : melodyModel
    )
  })

  afterEach(() => vi.restoreAllMocks())

  it('auto mode pairs bass presets with the bass table and other presets with the melody table', async () => {
    const store = useMelodyStore()
    expect(store.generatorParams.melodyModel).toBe('auto')

    store.setRhythmPreset('ebm-machine-pulse')
    const expectedBass = expectedNotes(bassModel)
    expect(expectedBass).not.toEqual(expectedNotes(melodyModel))

    await store.generate()
    expect(musicalNotes(store.notes)).toEqual(expectedBass)
    expect(useTakesStore().takes.at(-1)?.context.modelId).toBe(bassModel.id)

    store.setRhythmPreset('arpeggio-flow')
    await store.generate()
    expect(musicalNotes(store.notes)).toEqual(expectedNotes(melodyModel))
    // The locked seed dedupes takes, so the latest take remains the bass one;
    // the committed notes themselves are the melody-model output.
    expect(useTakesStore().takes).toHaveLength(1)
  })

  it('a pinned melody model overrides a bass preset entirely', async () => {
    const store = useMelodyStore()
    store.setRhythmPreset('ebm-machine-pulse')
    store.setMelodyModel('melody')
    const expected = expectedNotes(melodyModel)

    await store.generate()

    expect(musicalNotes(store.notes)).toEqual(expected)
    expect(modelService.loadTrainedModelForRole).toHaveBeenCalledWith('melody')
  })

  it('a pinned bass model overrides a melody preset entirely', async () => {
    const store = useMelodyStore()
    store.setRhythmPreset('arpeggio-flow')
    store.setMelodyModel('bass')
    const expected = expectedNotes(bassModel)

    await store.generate()

    expect(musicalNotes(store.notes)).toEqual(expected)
    expect(modelService.loadTrainedModelForRole).toHaveBeenCalledWith('bass')
  })

  it('synthetic mode reproduces the built-in scale model without loading an artifact', async () => {
    const store = useMelodyStore()
    store.setRhythmPreset('arpeggio-flow')
    store.setMelodyModel('synthetic')
    const expected = expectedNotes(null)

    await store.generate()

    expect(musicalNotes(store.notes)).toEqual(expected)
    expect(modelService.loadTrainedModelForRole).not.toHaveBeenCalled()
    expect(useTakesStore().takes[0].context.modelId).toBe('synthetic:scale')
  })

  it('uses the model for the randomized preset rather than the previously selected preset', async () => {
    const store = useMelodyStore()
    store.setRhythmPreset('arpeggio-flow')
    store.setGeneratorParams({ randomRhythmPreset: true })
    vi.spyOn(rhythmPresets, 'pickRandomRhythmPresetId').mockReturnValue('ebm-machine-pulse')
    const expected = expectedNotes(bassModel, { ...store.generatorParams, rhythmPresetId: 'ebm-machine-pulse' })

    await store.generate()

    expect(store.generatorParams.rhythmPresetId).toBe('ebm-machine-pulse')
    expect(musicalNotes(store.notes)).toEqual(expected)
  })

  it.each(['custom', 'euclidean'] as const)('ignores a saved bass preset in %s mode under auto', async (mode) => {
    const store = useMelodyStore()
    store.setRhythmPreset('ebm-machine-pulse')
    useRhythmStore().insert(0, 4, 92)
    useRhythmStore().insert(8, 4, 92)
    store.setRhythmMode(mode)
    const expected = expectedNotes(melodyModel)
    expect(expected).not.toEqual(expectedNotes(bassModel))

    await store.generate()

    expect(musicalNotes(store.notes)).toEqual(expected)
  })

  it('keeps a pending request and its Take consistent when settings change during loading', async () => {
    vi.restoreAllMocks()
    const store = useMelodyStore()
    const project = useProjectStore()
    store.setRhythmPreset('ebm-machine-pulse')
    const generator = { ...store.generatorParams }
    const expected = expectedNotes(bassModel)
    let resolveModel!: (model: TrainedMarkovArtifact) => void
    const realIndex = await modelService.loadTrainedModelIndex()
    vi.spyOn(modelService, 'loadTrainedModelIndex').mockResolvedValue(realIndex)
    vi.spyOn(modelService, 'loadTrainedModelForRole').mockReturnValue(
      new Promise((resolve) => {
        resolveModel = resolve
      })
    )

    const pending = store.generate()
    store.setRhythmPreset('arpeggio-flow')
    store.setRhythmMode('euclidean')
    project.setKey('D')
    resolveModel(bassModel)
    await pending

    expect(musicalNotes(store.notes)).toEqual(expected)
    expect(useTakesStore().takes[0].params).toEqual(generator)
    expect(useTakesStore().takes[0].context.key).toBe('C')
    expect(store.generatorParams.rhythmMode).toBe('euclidean')
  })
})
