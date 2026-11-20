import type { Ref } from 'vue'
import { generateMelody } from '../core/generator/melody.generator'
import { createRng } from '../core/generator/rng'
import { getRhythmPresetById, pickRandomRhythmPresetId, type RhythmPreset } from '../core/rhythm/presets'
import type { GeneratorParams } from '../core/schemas/generator.schema'
import type { AppNote } from '../core/schemas/note.schema'
import type { TrainedMarkovArtifact } from '../core/schemas/trained-markov.schema'
import type { TakeScope } from '../core/takes/scope'
import { isUsableTrainedArtifact, resolveMelodyModelRole, SYNTHETIC_MODEL_ID } from '../core/generator/melody-model'
import { useHarmonyStore } from '../stores/harmony.store'
import { useProjectStore } from '../stores/project.store'
import { useRhythmStore } from '../stores/rhythm.store'
import { useTakesStore } from '../stores/takes.store'
import type { MelodyModelStatus } from './useMelodyModel'

export interface MelodyGenerationModelState {
  modelStatus: Ref<MelodyModelStatus>
  modelStatusMessage: Ref<string>
  loadModel: (
    choice: GeneratorParams['melodyModel'],
    rhythmPreset: RhythmPreset | undefined
  ) => Promise<{ artifact: TrainedMarkovArtifact | null }>
}

/**
 * One generation request is fully described by its snapshots. Nothing read
 * after an await may influence pitch selection, which is what makes the
 * "current model + range" pair the sole basis of the produced notes.
 */
interface GenerationSnapshot {
  revision: number
  generator: GeneratorParams
  project: ReturnType<ReturnType<typeof useProjectStore>['toConfig']>
  scope: TakeScope
  chords: ReturnType<typeof useHarmonyStore>['chords'] | undefined
  rhythmPreset: RhythmPreset | undefined
  customPattern: ReturnType<typeof useRhythmStore>['pattern'] | undefined
  seed: number
  rng: () => number
  modelChoice: GeneratorParams['melodyModel']
  modelRole: ReturnType<typeof resolveMelodyModelRole>
}

export function useMelodyGeneration(
  generatorParams: Ref<GeneratorParams>,
  isGenerating: Ref<boolean>,
  setRhythmPreset: (id: string) => void,
  replaceNotesInScope: (notes: AppNote[], scope: TakeScope) => void,
  modelState: MelodyGenerationModelState
) {
  // Monotonic per composable; a generation whose revision is no longer current
  // when it finishes must not commit, so a quick switch-and-retrigger can never
  // leave half-new/half-old notes behind.
  let generationRevision = 0
  let queuedRerun = false

  function buildSnapshot(revision: number): GenerationSnapshot {
    const projectStore = useProjectStore()
    const harmonyStore = useHarmonyStore()
    const takesStore = useTakesStore()
    const rhythmStore = useRhythmStore()

    const generator = { ...generatorParams.value }
    const project = projectStore.toConfig()
    const scope: TakeScope = { ...projectStore.workRange }
    const chords = harmonyStore.useChords && harmonyStore.chords.length > 0 ? harmonyStore.chords : undefined
    const rhythmPreset = generator.rhythmMode === 'preset' ? getRhythmPresetById(generator.rhythmPresetId) : undefined
    const customPattern = generator.rhythmMode === 'custom' ? rhythmStore.pattern : undefined
    const seed = takesStore.resolveGenerationSeed()
    const rng = createRng(seed)
    const modelRole = resolveMelodyModelRole(generator.melodyModel, rhythmPreset)

    return {
      revision,
      generator,
      project,
      scope,
      chords,
      rhythmPreset,
      customPattern,
      seed,
      rng,
      modelChoice: generator.melodyModel,
      modelRole
    }
  }

  async function runGeneration(snapshot: GenerationSnapshot): Promise<boolean> {
    const takesStore = useTakesStore()
    const harmonyStore = useHarmonyStore()

    // The only await: resolve the artifact for the snapshotted choice. Every
    // other input above is immutable local state for this run.
    const { artifact } = await modelState.loadModel(snapshot.modelChoice, snapshot.rhythmPreset)

    if (snapshot.revision !== generationRevision) {
      // Superseded by a newer request; never commit its notes.
      return false
    }

    if (snapshot.modelRole !== 'synthetic' && !isUsableTrainedArtifact(artifact)) {
      // Hard failure: no synthetic substitution, no note writes, no take,
      // no seed consumption. Existing notes stay byte-identical. The model
      // composable owns the visible error state and its diagnostic message;
      // only guarantee an error is displayed if it left the panel clean.
      if (modelState.modelStatus.value !== 'error') {
        modelState.modelStatus.value = 'error'
        modelState.modelStatusMessage.value = `Trained ${snapshot.modelRole} model is unavailable`
      }
      return false
    }

    const trainedModel = snapshot.modelRole === 'synthetic' ? null : artifact

    const generated = generateMelody({
      project: snapshot.project,
      generator: snapshot.generator,
      chords: snapshot.chords,
      chordAdherence: snapshot.generator.chordAdherence ?? harmonyStore.adherence,
      rhythmPreset: snapshot.rhythmPreset,
      customPattern: snapshot.customPattern,
      startWithRoot: snapshot.generator.startWithRoot,
      endWithRoot: snapshot.generator.endWithRoot,
      minOctave: snapshot.generator.minOctave,
      maxOctave: snapshot.generator.maxOctave,
      rangeStartStep: snapshot.scope.startStep,
      rangeEndStep: snapshot.scope.endStep,
      trainedModel,
      rng: snapshot.rng
    })

    if (snapshot.revision !== generationRevision) {
      return false
    }

    replaceNotesInScope(generated, snapshot.scope)
    takesStore.captureTake(
      generated,
      snapshot.generator,
      {
        key: snapshot.project.key,
        scale: snapshot.project.scale,
        bpm: snapshot.project.bpm,
        bars: snapshot.project.bars,
        rangeStartStep: snapshot.scope.startStep,
        rangeEndStep: snapshot.scope.endStep,
        modelId: trainedModel ? trainedModel.id : SYNTHETIC_MODEL_ID
      },
      snapshot.seed
    )
    takesStore.markSeedUsed(snapshot.seed)
    return true
  }

  async function generate(): Promise<void> {
    if (isGenerating.value) {
      // A second trigger while a run is in flight (e.g. model switched during
      // loading) invalidates the in-flight snapshot immediately, so its notes
      // can never commit, and schedules one rerun against the latest selection.
      generationRevision++
      queuedRerun = true
      return
    }
    const rhythmStore = useRhythmStore()
    if (generatorParams.value.rhythmMode === 'custom' && !rhythmStore.canGenerate) return

    isGenerating.value = true
    try {
      do {
        queuedRerun = false
        // Random preset selection precedes the snapshot and shares the request's
        // seed, so preset, model role and pitch output stay reproducible.
        const takesStore = useTakesStore()
        const presetRng = createRng(takesStore.currentSeed)
        if (generatorParams.value.rhythmMode === 'preset' && generatorParams.value.randomRhythmPreset) {
          const randomId = pickRandomRhythmPresetId(undefined, presetRng)
          if (randomId) {
            setRhythmPreset(randomId)
          }
        }
        const snapshot = buildSnapshot(++generationRevision)
        await runGeneration(snapshot)
      } while (queuedRerun)
    } finally {
      isGenerating.value = false
    }
  }

  return { generate }
}
