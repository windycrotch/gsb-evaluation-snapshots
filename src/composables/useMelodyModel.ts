import { computed, ref, shallowRef, watch, type Ref } from 'vue'
import { resolveMelodyModelRole, isUsableTrainedArtifact } from '../core/generator/melody-model'
import type { MelodyModelChoice } from '../core/schemas/generator.schema'
import type { TrainedMarkovArtifact, TrainedModelIndexEntry, TrainedRole } from '../core/schemas/trained-markov.schema'
import type { RhythmPreset } from '../core/rhythm/presets'
import { loadTrainedModelForRole, loadTrainedModelIndex } from '../services/trained-model-service'

export type MelodyModelStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface MelodyModelLoadResult {
  artifact: TrainedMarkovArtifact | null
  role: TrainedRole | 'synthetic'
  modelId: string | null
}

export const SYNTHETIC_MODEL_ID = 'synthetic:scale'

/**
 * Owns the lifecycle of the offline-trained melody Markov model.
 *
 * Invariants enforced here:
 * - The effective model choice + rhythm role are snapshotted together with the
 *   generation inputs before any await, so a UI edit during loading cannot
 *   half-apply a different model.
 * - A failed or empty load moves the panel into a visible error state and the
 *   cached artifact is dropped; the next successful load repopulates it.
 * - A selection generation guards every artifact load: a load started under an
 *   older selection can never overwrite panel state after a newer selection,
 *   even when no replacement generation is triggered.
 */
export function useMelodyModel(melodyModel: Ref<MelodyModelChoice>) {
  const modelStatus = ref<MelodyModelStatus>('idle')
  const modelStatusMessage = ref('')
  const activeModelEntry = shallowRef<TrainedModelIndexEntry | null>(null)
  const activeArtifact = shallowRef<TrainedMarkovArtifact | null>(null)
  const activeModelId = ref<string | null>(null)
  // Bumped on every non-synthetic selection change. An artifact load captures
  // the generation at start and may only commit state while it is still
  // current; synthetic resolution is synchronous, so it can never go stale.
  let selectionGeneration = 0

  const hasModelError = computed(() => modelStatus.value === 'error')
  const isModelLoading = computed(() => modelStatus.value === 'loading')

  // Clear stale panel state on a selection change. The synthetic choice is
  // skipped because selecting it followed by a generation is one atomic
  // action whose loadModel sets 'ready' state itself, and it starts no
  // artifact load that could be made stale.
  watch(melodyModel, (next) => {
    if (next === 'synthetic') return
    selectionGeneration++
    modelStatus.value = 'idle'
    modelStatusMessage.value = ''
    activeModelEntry.value = null
    activeArtifact.value = null
    activeModelId.value = null
  })

  function setError(generation: number, message: string): void {
    if (generation !== selectionGeneration) return
    modelStatus.value = 'error'
    modelStatusMessage.value = message
    activeArtifact.value = null
    activeModelId.value = null
  }

  /**
   * Loads (or reuses) the artifact backing `choice`. Every call returns a
   * snapshot object describing what was resolved; callers must use the
   * returned artifact rather than any cached ref, which keeps concurrent
   * generations attributable to exactly one model.
   */
  async function loadModel(
    choice: MelodyModelChoice,
    rhythmPreset: RhythmPreset | undefined
  ): Promise<MelodyModelLoadResult> {
    const role = resolveMelodyModelRole(choice, rhythmPreset)
    if (role === 'synthetic') {
      // Explicit local selection: no artifact, no await, no failure path. It
      // neither consumes nor invalidates a selection generation.
      modelStatus.value = 'ready'
      modelStatusMessage.value = ''
      activeModelEntry.value = null
      activeArtifact.value = null
      activeModelId.value = SYNTHETIC_MODEL_ID
      return { artifact: null, role, modelId: SYNTHETIC_MODEL_ID }
    }

    const generation = selectionGeneration
    modelStatus.value = 'loading'
    modelStatusMessage.value = 'Loading melody model'
    try {
      // The two loads are awaited independently inside one try block so a
      // rejected artifact load is caught here rather than racing an index
      // failure through Promise.all and losing its diagnostic message.
      let index: Awaited<ReturnType<typeof loadTrainedModelIndex>> = null
      try {
        index = await loadTrainedModelIndex()
      } catch {
        index = null
      }
      const artifact = await loadTrainedModelForRole(role)
      if (generation !== selectionGeneration) {
        // A newer selection superseded this load; its resolution must not
        // touch shared state. The caller still receives the artifact so an
        // in-flight generation stays internally consistent with its snapshot.
        return {
          artifact: isUsableTrainedArtifact(artifact) ? artifact : null,
          role,
          modelId: artifact?.id ?? null
        }
      }
      const entry = index?.models.find((candidate) => candidate.role === role) ?? null
      if (!isUsableTrainedArtifact(artifact)) {
        // Drop any previously cached table: the next retry must load fresh
        // rather than read stale state from an earlier successful selection.
        setError(
          generation,
          entry ? `Trained ${role} model returned an empty transition table` : `No trained ${role} model is available`
        )
        return { artifact: null, role, modelId: null }
      }
      // The artifact is self-describing and fully validated; the index entry
      // only enriches panel metadata and may be absent when the index failed
      // but the artifact loader itself succeeded.
      activeModelEntry.value = entry
      activeArtifact.value = artifact
      activeModelId.value = artifact.id
      modelStatus.value = 'ready'
      modelStatusMessage.value = ''
      return { artifact, role, modelId: artifact.id }
    } catch (error) {
      setError(generation, error instanceof Error ? error.message : `Trained ${role} model failed to load`)
      return { artifact: null, role, modelId: null }
    }
  }

  return {
    modelStatus,
    modelStatusMessage,
    activeModelEntry,
    activeArtifact,
    activeModelId,
    hasModelError,
    isModelLoading,
    loadModel
  }
}
