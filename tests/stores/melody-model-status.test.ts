import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { generateMelody } from '../../src/core/generator/melody.generator'
import { createRng } from '../../src/core/generator/rng'
import { getRhythmPresetById } from '../../src/core/rhythm/presets'
import type { AppNote } from '../../src/core/schemas/note.schema'
import {
  getTrainedModelStatus,
  loadTrainedModel,
  resetTrainedModelCache,
  setTrainedModelLoadersForTesting
} from '../../src/services/trained-model-service'
import { useHarmonyStore } from '../../src/stores/harmony.store'
import { useMelodyStore } from '../../src/stores/melody.store'
import { useProjectStore } from '../../src/stores/project.store'
import { useTakesStore } from '../../src/stores/takes.store'

const SEED = 4242
const HASH16 = '0123456789abcdef'

const ARTIFACT = {
  artifactVersion: 1,
  kind: 'melodymate-markov',
  id: 'melody:default',
  role: 'melody',
  style: 'default',
  representation: { type: 'tonic-relative-chroma', symbolCount: 12 },
  maxOrder: 4,
  backoffStrength: 4,
  configHash: HASH16,
  manifestHash: HASH16,
  stats: { files: 1, tracks: 1, sequences: 1, notes: 4, contexts: 2, transitions: 3 },
  counts: { '': { '0': 2, '2': 1, '4': 1 }, '0': { '2': 1 } }
}

const BASS_ARTIFACT = { ...ARTIFACT, id: 'bass:default', role: 'bass' as const }

function makeIndex() {
  return {
    artifactVersion: 1,
    kind: 'melodymate-markov-index',
    models: [
      {
        file: 'melodymate-markov-melody-default.json',
        id: ARTIFACT.id,
        role: ARTIFACT.role,
        style: ARTIFACT.style,
        sha256: '0'.repeat(64),
        maxOrder: ARTIFACT.maxOrder,
        stats: ARTIFACT.stats
      }
    ]
  }
}

function musicalNotes(notes: AppNote[]) {
  return notes.map(({ id: _id, ...note }) => note)
}

/** Reference output of the pure generator when no trained model is supplied (synthetic scale table path). */
function syntheticReference() {
  const project = useProjectStore()
  const melody = useMelodyStore()
  return musicalNotes(
    generateMelody({
      project: project.toConfig(),
      generator: { ...melody.generatorParams },
      rhythmPreset: getRhythmPresetById(melody.generatorParams.rhythmPresetId),
      trainedModel: null,
      rangeStartStep: project.workRange.startStep,
      rangeEndStep: project.workRange.endStep,
      rng: createRng(SEED)
    })
  )
}

describe('melody generation trained-model status', () => {
  let shippedMelody: NonNullable<Awaited<ReturnType<typeof loadTrainedModel>>>

  beforeEach(async () => {
    setActivePinia(createPinia())
    resetTrainedModelCache()
    setTrainedModelLoadersForTesting(null)
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
    const model = await loadTrainedModel('melody')
    if (!model) throw new Error('Shipped melody model must be available')
    shippedMelody = model
    resetTrainedModelCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setTrainedModelLoadersForTesting(null)
    resetTrainedModelCache()
  })

  it('surfaces a visible fallback and generates identical notes to the synthetic scale path when the index fails', async () => {
    setTrainedModelLoadersForTesting({
      'index.json': async () => {
        throw new Error('index corrupt')
      }
    })
    const expected = syntheticReference()

    const melody = useMelodyStore()
    await melody.generate()

    expect(melody.trainedModelStatus.status).toBe('fallback')
    expect(melody.trainedModelStatus.reason).toBe('index-load-error')
    expect(melody.trainedModelStatus.message).toMatch(/scale table/)
    expect(getTrainedModelStatus('melody').status).toBe('fallback')
    expect(musicalNotes(melody.notes)).toEqual(expected)
  })

  it('reports available and truly uses the trained model once it loads successfully', async () => {
    setTrainedModelLoadersForTesting({
      'index.json': async () => makeIndex(),
      'melodymate-markov-melody-default.json': async () => ARTIFACT
    })

    const melody = useMelodyStore()
    await melody.generate()

    expect(melody.trainedModelStatus.status).toBe('available')
    expect(melody.trainedModelStatus.model?.id).toBe(ARTIFACT.id)
    // Trained output must differ from the synthetic fallback for this setup.
    expect(musicalNotes(melody.notes)).not.toEqual(syntheticReference())
  })

  it('tracks the bass role and its independent fallback message for bass presets', async () => {
    setTrainedModelLoadersForTesting({
      'index.json': async () => ({
        ...makeIndex(),
        models: [
          {
            file: 'bass.json',
            id: BASS_ARTIFACT.id,
            role: 'bass',
            style: BASS_ARTIFACT.style,
            sha256: '0'.repeat(64),
            maxOrder: BASS_ARTIFACT.maxOrder,
            stats: BASS_ARTIFACT.stats
          }
        ]
      }),
      'bass.json': async () => {
        throw new Error('bass chunk missing')
      }
    })

    const melody = useMelodyStore()
    expect(melody.trainedRole).toBe('melody')

    melody.setRhythmPreset('ebm-machine-pulse')
    await nextTick()
    expect(melody.trainedRole).toBe('bass')
    await melody.generate()

    expect(melody.trainedModelStatus.status).toBe('fallback')
    expect(melody.trainedModelStatus.reason).toBe('model-load-error')
    expect(melody.trainedModelStatus.message).toMatch(/bass/i)
    expect(musicalNotes(melody.notes)).toEqual(syntheticReference())
  })

  it('retries the load on the next generation after a failure and recovers without a page refresh', async () => {
    let indexAttempts = 0
    setTrainedModelLoadersForTesting({
      'index.json': async () => {
        indexAttempts += 1
        if (indexAttempts === 1) throw new Error('first read fails')
        return makeIndex()
      },
      'melodymate-markov-melody-default.json': async () => ARTIFACT
    })

    const melody = useMelodyStore()
    await melody.generate()
    expect(melody.trainedModelStatus.status).toBe('fallback')
    const fallbackNotes = musicalNotes(melody.notes)
    expect(fallbackNotes).toEqual(syntheticReference())

    await melody.generate()
    expect(indexAttempts).toBe(2)
    expect(melody.trainedModelStatus.status).toBe('available')
    expect(melody.trainedModelStatus.model?.id).toBe(ARTIFACT.id)
    expect(musicalNotes(melody.notes)).not.toEqual(fallbackNotes)
  })

  it('exposes a retry action that recovers the status even without regenerating', async () => {
    let indexAttempts = 0
    setTrainedModelLoadersForTesting({
      'index.json': async () => {
        indexAttempts += 1
        if (indexAttempts === 1) return { kind: 'invalid-schema' }
        return makeIndex()
      },
      'melodymate-markov-melody-default.json': async () => ARTIFACT
    })

    const melody = useMelodyStore()
    await melody.generate()
    expect(melody.trainedModelStatus.status).toBe('fallback')
    expect(melody.trainedModelStatus.reason).toBe('index-invalid')

    const recovered = await melody.retryTrainedModel()
    expect(recovered?.id).toBe(ARTIFACT.id)
    expect(melody.trainedModelStatus.status).toBe('available')
  })

  it('does not rely on stale success: a recovered melody model is the artifact actually passed to the generator', async () => {
    setTrainedModelLoadersForTesting({
      'index.json': async () => makeIndex(),
      'melodymate-markov-melody-default.json': async () => shippedMelody
    })
    const melody = useMelodyStore()
    await melody.generate()
    expect(melody.trainedModelStatus.status).toBe('available')
    expect(melody.trainedModelStatus.model?.id).toBe(shippedMelody.id)
    expect(melody.trainedModelStatus.model?.role).toBe(shippedMelody.role)
  })
})
