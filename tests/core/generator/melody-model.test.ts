import { describe, expect, it } from 'vitest'
import { generateMelody } from '../../../src/core/generator/melody.generator'
import { createRng } from '../../../src/core/generator/rng'
import { GeneratorParamsSchema } from '../../../src/core/schemas/generator.schema'
import { ProjectSchema, PROJECT_SCHEMA_VERSION } from '../../../src/core/schemas/project.schema'
import {
  isUsableTrainedArtifact,
  resolveMelodyModelRole,
  resolveTrainedTable,
  SYNTHETIC_MODEL_ID
} from '../../../src/core/generator/melody-model'
import {
  clearTrainedTableCache,
  getTrainedMarkovTable,
  trainedArtifactCacheKey
} from '../../../src/core/generator/trained-markov'
import type { RhythmPreset } from '../../../src/core/rhythm/presets'
import {
  TrainedMarkovArtifactSchema,
  type TrainedMarkovArtifact
} from '../../../src/core/schemas/trained-markov.schema'

const HASH16 = '0123456789abcdef'

function artifact(overrides: Record<string, unknown> = {}): TrainedMarkovArtifact {
  const parsed = TrainedMarkovArtifactSchema.safeParse({
    artifactVersion: 1,
    kind: 'melodymate-markov',
    id: 'melody:default',
    role: 'melody',
    style: 'default',
    representation: { type: 'tonic-relative-chroma', symbolCount: 12 },
    maxOrder: 2,
    backoffStrength: 4,
    configHash: HASH16,
    manifestHash: HASH16,
    stats: { files: 1, tracks: 1, sequences: 1, notes: 4, contexts: 2, transitions: 3 },
    counts: { '': { '0': 2, '2': 2 }, '0': { '2': 2 } },
    ...overrides
  })
  if (!parsed.success) throw new Error('fixture must parse')
  return parsed.data
}

const bassPreset = { category: 'bass' } as Pick<RhythmPreset, 'category'>
const melodyPreset = { category: 'melody' } as Pick<RhythmPreset, 'category'>

describe('resolveMelodyModelRole', () => {
  it('maps explicit choices to their roles and synthetic to no artifact', () => {
    expect(resolveMelodyModelRole('melody', bassPreset)).toBe('melody')
    expect(resolveMelodyModelRole('bass', melodyPreset)).toBe('bass')
    expect(resolveMelodyModelRole('synthetic', bassPreset)).toBe('synthetic')
  })

  it('auto follows the preset category and defaults to melody', () => {
    expect(resolveMelodyModelRole('auto', bassPreset)).toBe('bass')
    expect(resolveMelodyModelRole('auto', melodyPreset)).toBe('melody')
    expect(resolveMelodyModelRole('auto', undefined)).toBe('melody')
  })
})

describe('isUsableTrainedArtifact', () => {
  it('accepts an artifact with contexts and unigrams', () => {
    expect(isUsableTrainedArtifact(artifact())).toBe(true)
  })

  it('rejects null and empty tables', () => {
    expect(isUsableTrainedArtifact(null)).toBe(false)
    // Hand-built objects bypass schema validation, so the runtime guard must
    // still catch an empty counts object or missing unigrams.
    const empty = { ...artifact(), counts: {} } as unknown as TrainedMarkovArtifact
    const noUnigrams = { ...artifact(), counts: { '0': { '2': 1 } } } as unknown as TrainedMarkovArtifact
    const emptyUnigrams = { ...artifact(), counts: { '': {} } } as unknown as TrainedMarkovArtifact
    expect(isUsableTrainedArtifact(empty)).toBe(false)
    expect(isUsableTrainedArtifact(noUnigrams)).toBe(false)
    expect(isUsableTrainedArtifact(emptyUnigrams)).toBe(false)
  })
})

describe('resolveTrainedTable', () => {
  it('returns a populated table for a valid artifact', () => {
    const table = resolveTrainedTable(artifact())
    expect(table).not.toBeNull()
    expect(table?.get('')?.get('0')).toBe(2)
  })

  it('returns null instead of an empty table for unusable input', () => {
    expect(resolveTrainedTable(null)).toBeNull()
    const empty = { ...artifact(), counts: {} } as unknown as TrainedMarkovArtifact
    expect(resolveTrainedTable(empty)).toBeNull()
  })

  it('exposes the synthetic model identity constant', () => {
    expect(SYNTHETIC_MODEL_ID).toBe('synthetic:scale')
  })
})

describe('trained table cache identity', () => {
  it('produces different cache keys when successor counts differ even with identical id/hash/context count', () => {
    clearTrainedTableCache()
    const first = artifact({ counts: { '': { '0': 5, '7': 5 }, '0': { '7': 5 } } })
    const second = artifact({
      id: first.id,
      configHash: first.configHash,
      stats: { ...first.stats, contexts: 2 },
      counts: { '': { '0': 5, '7': 5 }, '0': { '0': 5 } }
    })
    expect(Object.keys(first.counts).length).toBe(Object.keys(second.counts).length)
    expect(trainedArtifactCacheKey(first)).not.toBe(trainedArtifactCacheKey(second))
  })

  it('does not cross-contaminate converted tables between distinct artifacts', () => {
    clearTrainedTableCache()
    const first = artifact({ id: 'melody:a', counts: { '': { '0': 10 }, '0': { '0': 10 } } })
    const second = artifact({
      id: 'melody:b',
      configHash: first.configHash,
      counts: { '': { '9': 10 }, '9': { '9': 10 } }
    })
    const tableA = getTrainedMarkovTable(first)
    const tableB = getTrainedMarkovTable(second)
    expect(tableA).not.toBe(tableB)
    expect(tableA.get('')?.has('9')).toBe(false)
    expect(tableB.get('')?.has('0')).toBe(false)
    // Same artifact reuses its cached table.
    expect(getTrainedMarkovTable(first)).toBe(tableA)
  })
})

describe('melody generator hard model failure', () => {
  const project = ProjectSchema.parse({ version: PROJECT_SCHEMA_VERSION, key: 'C', scale: 'major', bars: 2 })
  const generator = GeneratorParamsSchema.parse({
    rhythmMode: 'euclidean',
    motif: 'FREE',
    callAndResponse: false,
    restProbability: 0
  })

  it('throws instead of silently swapping to the synthetic model for an empty table', () => {
    const broken = { ...artifact(), counts: {} } as unknown as TrainedMarkovArtifact
    expect(() =>
      generateMelody({
        project,
        generator,
        trainedModel: broken,
        rng: createRng(1)
      })
    ).toThrow(/no usable transition table/)
  })

  it('keeps trained runs deterministic for the same seed and inputs', () => {
    const trained = artifact()
    const options = { project, generator, rangeStartStep: 0, rangeEndStep: 32 }
    const runA = generateMelody({ ...options, trainedModel: trained, rng: createRng(99) }).map(({ id: _id, ...n }) => n)
    const runB = generateMelody({ ...options, trainedModel: trained, rng: createRng(99) }).map(({ id: _id, ...n }) => n)
    expect(runA).toEqual(runB)
  })
})
