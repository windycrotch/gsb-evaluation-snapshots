import type { RhythmPreset } from '../rhythm/presets'
import type { MelodyModelChoice } from '../schemas/generator.schema'
import type { TrainedMarkovArtifact, TrainedRole } from '../schemas/trained-markov.schema'
import { getTrainedMarkovTable } from './trained-markov'
import type { MarkovTable } from './markov.engine'

/**
 * Deterministic mapping from the explicit model choice to the offline table
 * role that must be loaded. 'auto' preserves the historical pairing: bass
 * rhythm presets drive the bass table, every other rhythm drives the melody
 * table; 'synthetic' never touches an offline artifact.
 */
export function resolveMelodyModelRole(
  choice: MelodyModelChoice,
  rhythmPreset: Pick<RhythmPreset, 'category'> | undefined
): TrainedRole | 'synthetic' {
  switch (choice) {
    case 'melody':
      return 'melody'
    case 'bass':
      return 'bass'
    case 'synthetic':
      return 'synthetic'
    case 'auto':
    default:
      return rhythmPreset?.category === 'bass' ? 'bass' : 'melody'
  }
}

/**
 * A loaded table is only usable when it has at least one context and a
 * non-empty order-0 unigram bucket. Schema validation rejects such artifacts
 * at parse time; this guard additionally covers hand-built artifacts passed
 * straight to the generator (tests, future in-memory loaders).
 */
export function isUsableTrainedArtifact(artifact: TrainedMarkovArtifact | null): artifact is TrainedMarkovArtifact {
  if (!artifact) return false
  const contexts = Object.keys(artifact.counts)
  if (contexts.length === 0) return false
  const unigrams = artifact.counts['']
  return Boolean(unigrams && Object.keys(unigrams).length > 0)
}

/**
 * Converts a validated artifact into the runtime Markov table and verifies
 * the conversion produced usable data. Returns null instead of an empty table
 * so callers can surface a failure rather than silently mixing priors.
 */
export function resolveTrainedTable(artifact: TrainedMarkovArtifact | null): MarkovTable | null {
  if (!isUsableTrainedArtifact(artifact)) return null
  const table = getTrainedMarkovTable(artifact)
  if (table.size === 0) return null
  const unigrams = table.get('')
  if (!unigrams || unigrams.size === 0) return null
  return table
}

/** Identity of the model that actually backs a generation request. */
export interface ResolvedMelodyModel {
  /** 'synthetic' for the built-in scale model, otherwise the artifact id. */
  modelId: string
  role: TrainedRole | 'synthetic'
  artifact: TrainedMarkovArtifact | null
  table: MarkovTable | null
  encoderRoot: string | null
}

export const SYNTHETIC_MODEL_ID = 'synthetic:scale'
