import { computed, type Ref } from 'vue'
import { generateMelody } from '../core/generator/melody.generator'
import { createRng } from '../core/generator/rng'
import { getRhythmPresetById, pickRandomRhythmPresetId } from '../core/rhythm/presets'
import type { GeneratorParams } from '../core/schemas/generator.schema'
import type { AppNote } from '../core/schemas/note.schema'
import type { TrainedRole } from '../core/schemas/trained-markov.schema'
import type { TakeScope } from '../core/takes/scope'
import { loadTrainedModel } from '../services/trained-model-service'
import { useTrainedModelStatus } from './useTrainedModelStatus'
import { useHarmonyStore } from '../stores/harmony.store'
import { useProjectStore } from '../stores/project.store'
import { useRhythmStore } from '../stores/rhythm.store'
import { useTakesStore } from '../stores/takes.store'

export function useMelodyGeneration(
  generatorParams: Ref<GeneratorParams>,
  isGenerating: Ref<boolean>,
  setRhythmPreset: (id: string) => void,
  replaceNotesInScope: (notes: AppNote[], scope: TakeScope) => void
) {
  // The role is resolved again inside generate() after a possible random-preset
  // roll; this mirrors the same rule so the status badge tracks the role the
  // next generation will actually request.
  const trainedRole = computed<TrainedRole>(() => {
    const preset = getRhythmPresetById(generatorParams.value.rhythmPresetId)
    return preset?.category === 'bass' ? 'bass' : 'melody'
  })

  const melodyStatusApi = useTrainedModelStatus('melody')
  const bassStatusApi = useTrainedModelStatus('bass')

  const trainedModelStatus = computed(() =>
    trainedRole.value === 'bass' ? bassStatusApi.status.value : melodyStatusApi.status.value
  )

  async function retryTrainedModel() {
    return trainedRole.value === 'bass' ? bassStatusApi.retry() : melodyStatusApi.retry()
  }

  async function generate(): Promise<void> {
    if (isGenerating.value) return
    const rhythmStore = useRhythmStore()
    if (generatorParams.value.rhythmMode === 'custom' && !rhythmStore.canGenerate) return
    isGenerating.value = true
    try {
      const projectStore = useProjectStore()
      const harmonyStore = useHarmonyStore()
      const takesStore = useTakesStore()
      const { startStep: rangeStartStep, endStep: rangeEndStep } = { ...projectStore.workRange }
      const seed = takesStore.resolveGenerationSeed()
      const rng = createRng(seed)

      const activeChords = harmonyStore.useChords && harmonyStore.chords.length > 0 ? harmonyStore.chords : undefined
      if (generatorParams.value.rhythmMode === 'preset' && generatorParams.value.randomRhythmPreset) {
        const randomId = pickRandomRhythmPresetId(undefined, rng)
        if (randomId) {
          setRhythmPreset(randomId)
        }
      }

      // Model loading can yield to UI edits, so the selected role and generation
      // inputs must describe the same request, including a randomized preset.
      const generator = { ...generatorParams.value }
      const project = projectStore.toConfig()
      const rhythmPreset = generator.rhythmMode === 'preset' ? getRhythmPresetById(generator.rhythmPresetId) : undefined
      const customPattern = generator.rhythmMode === 'custom' ? rhythmStore.pattern : undefined
      const role: TrainedRole = rhythmPreset?.category === 'bass' ? 'bass' : 'melody'
      // Failures are not cached, so every (re)generation retries a failed load;
      // a healthy model resolves immediately from the service cache.
      const trainedModel = await loadTrainedModel(role)

      const generated = generateMelody({
        project,
        generator,
        chords: activeChords,
        chordAdherence: generator.chordAdherence ?? harmonyStore.adherence,
        rhythmPreset,
        customPattern,
        startWithRoot: generator.startWithRoot,
        endWithRoot: generator.endWithRoot,
        minOctave: generator.minOctave,
        maxOctave: generator.maxOctave,
        rangeStartStep,
        rangeEndStep,
        trainedModel,
        rng
      })

      replaceNotesInScope(generated, { startStep: rangeStartStep, endStep: rangeEndStep })
      takesStore.captureTake(
        generated,
        generator,
        {
          key: project.key,
          scale: project.scale,
          bpm: project.bpm,
          bars: project.bars,
          rangeStartStep,
          rangeEndStep
        },
        seed
      )
      takesStore.markSeedUsed(seed)
    } finally {
      isGenerating.value = false
    }
  }

  return { generate, trainedRole, trainedModelStatus, retryTrainedModel }
}
