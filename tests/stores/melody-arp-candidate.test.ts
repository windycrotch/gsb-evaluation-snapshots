import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as arpeggioGenerator from '../../src/core/generator/arpeggio.generator'
import type {
  TrainedMarkovArtifact,
  TrainedModelIndex,
  TrainedModelIndexEntry
} from '../../src/core/schemas/trained-markov.schema'
import * as trainedModelService from '../../src/services/trained-model-service'
import { useAudioStore } from '../../src/stores/audio.store'
import { useHarmonyStore } from '../../src/stores/harmony.store'
import { useMelodyStore } from '../../src/stores/melody.store'
import { useProjectStore } from '../../src/stores/project.store'
import { useTakesStore } from '../../src/stores/takes.store'
import { arpTestModel } from '../helpers/arp-model'

const modelEntry = { id: arpTestModel.id, role: 'arp' } as TrainedModelIndexEntry

function useFallbackModel() {
  vi.spyOn(trainedModelService, 'loadTrainedModelIndex').mockResolvedValue(null)
  return vi.spyOn(trainedModelService, 'loadTrainedModel').mockResolvedValue(null)
}

function arpIndex(): TrainedModelIndex {
  return {
    artifactVersion: 1,
    kind: 'melodymate-markov-index',
    models: [
      {
        file: 'melodymate-markov-arp-default.json',
        id: arpTestModel.id,
        role: 'arp',
        style: arpTestModel.style,
        sha256: '0'.repeat(64),
        maxOrder: arpTestModel.maxOrder,
        stats: arpTestModel.stats
      }
    ]
  }
}

function setup() {
  const project = useProjectStore()
  project.setWorkRange({ startStep: 20, endStep: 52 })
  const melody = useMelodyStore()
  melody.setGeneratorParams({ arpPattern: 'up-down', arpRate: '1/16', arpSeed: 42, arpSeedLocked: false })
  return { project, melody, takes: useTakesStore(), audio: useAudioStore() }
}

describe('Arp Studio candidate', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('applies exactly the displayed candidate without a second generation, seed roll or model run', async () => {
    useFallbackModel()
    const nextSeed = vi.spyOn(await import('../../src/composables/arpSeed'), 'nextArpSeed').mockReturnValue(777)
    const generate = vi.spyOn(arpeggioGenerator, 'generateArpeggio')
    const { melody, takes } = setup()
    await melody.loadArpModels()

    const shown = melody.shuffleArp()!
    expect(melody.generatorParams.arpSeed).toBe(777)
    expect(generate).toHaveBeenCalledTimes(1)

    await melody.applyArp()

    expect(generate).toHaveBeenCalledTimes(1)
    expect(nextSeed).toHaveBeenCalledTimes(1)
    expect(melody.generatorParams.arpSeed).toBe(777)
    expect(melody.arpCandidate).toBe(shown)
    expect(melody.notes).toEqual(shown.notes)
    expect(takes.takes).toHaveLength(1)
    expect(takes.takes[0].notes).toEqual(shown.notes)
    expect(takes.takes[0].seed).toBe(777)
    expect(shown.notes.every((note) => note.step >= 20 && note.step < 52)).toBe(true)
    expect(new Set(shown.notes.map((note) => Math.floor(note.step / 16)))).toEqual(new Set([1, 2, 3]))
  })

  it('keeps targeted previews reversible and applies the displayed variation as one undoable take', async () => {
    useFallbackModel()
    const { melody, takes, audio, project } = setup()
    const audition = vi.spyOn(audio, 'auditionNotes').mockResolvedValue(undefined)
    await melody.loadArpModels()
    const original = melody.syncArpCandidate()!
    melody.setArpVariationSeed(853)

    expect(melody.rerollArpVariation('feel')).toBe(true)
    const varied = melody.arpCandidate!
    expect(varied.notes).not.toEqual(original.notes)
    expect(varied.baseNotes).toEqual(original.notes)
    expect(varied.variations).toEqual([{ mode: 'feel', seed: 853 }])
    expect(melody.notes).toEqual([])
    expect(takes.takes).toEqual([])
    expect(melody.canUndo).toBe(false)

    await melody.auditionArp()
    expect(audition).toHaveBeenCalledWith(varied.notes, project.bpm, expect.any(String), {
      originStep: project.workRange.startStep,
      durationSteps: project.workRange.endStep - project.workRange.startStep
    })

    await melody.applyArp()
    expect(melody.notes).toEqual(varied.notes)
    expect(takes.takes).toHaveLength(1)
    expect(takes.takes[0].notes).toEqual(varied.notes)
    expect(takes.takes[0].seed).toBe(original.inputs.seed)
    expect(takes.takes[0].arpVariations).toEqual(varied.variations)
    melody.undo()
    expect(melody.notes).toEqual([])
    melody.redo()
    expect(melody.notes).toEqual(varied.notes)

    melody.resetArpVariation()
    expect(melody.arpCandidate!.notes).toEqual(original.notes)
    expect(melody.arpCandidate!.variations).toEqual([])
    expect(melody.notes).toEqual(varied.notes)

    expect(melody.rerollArpVariation('feel')).toBe(true)
    expect(melody.arpCandidate!.notes).toEqual(varied.notes)
    await melody.applyArp()
    expect(takes.takes).toHaveLength(2)
    expect(takes.takes[1].arpVariations).toEqual(varied.variations)
  })

  it('reports a pitch no-op without replacing the candidate or creating history', async () => {
    useFallbackModel()
    const { melody, project, takes } = setup()
    project.setWorkRange({ startStep: 0, endStep: 16 })
    const harmony = useHarmonyStore()
    harmony.useChords = true
    harmony.setChords([
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'C',
        roman: 'I',
        notes: ['C'],
        voicing: ['C4'],
        startBar: 0,
        durationBars: 1
      }
    ])
    melody.setGeneratorParams({ arpPitchSource: 'chord-voicing', arpAdherence: 100 })
    await melody.loadArpModels()
    const displayed = melody.syncArpCandidate()

    expect(melody.rerollArpVariation('pitches')).toBe(false)
    expect(melody.arpCandidate).toBe(displayed)
    expect(melody.arpVariationMessage).toBe('No alternate pitches available')
    expect(melody.canUndo).toBe(false)
    expect(takes.takes).toEqual([])
  })

  it('uses the loaded trained model once and applies the model-based candidate as displayed', async () => {
    vi.spyOn(trainedModelService, 'loadTrainedModelIndex').mockResolvedValue({
      artifactVersion: 1,
      kind: 'melodymate-markov-index',
      models: [modelEntry as TrainedModelIndexEntry]
    })
    const loadModel = vi.spyOn(trainedModelService, 'loadTrainedModel').mockResolvedValue(arpTestModel)
    const generate = vi.spyOn(arpeggioGenerator, 'generateArpeggio')
    const { melody } = setup()
    await melody.loadArpModels()

    const shown = melody.syncArpCandidate()!
    await melody.applyArp()

    expect(melody.arpModelStatus).toBe('available')
    expect(shown.modelId).toBe(arpTestModel.id)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0][0].trainedModel).toBe(arpTestModel)
    expect(loadModel).toHaveBeenCalledTimes(1)
    expect(melody.notes).toEqual(shown.notes)
  })

  it('rebuilds the same candidate with a locked seed and a new one only in Auto', async () => {
    useFallbackModel()
    const { melody } = setup()
    melody.setGeneratorParams({ arpSeedLocked: true })
    await melody.loadArpModels()

    const first = melody.shuffleArp()!
    const refreshed = melody.shuffleArp()!
    expect(refreshed.revision).toBeGreaterThan(first.revision)
    expect(refreshed.notes).toEqual(first.notes)
    expect(melody.generatorParams.arpSeed).toBe(42)

    melody.setGeneratorParams({ arpSeedLocked: false })
    const shuffled = melody.shuffleArp()!
    expect(shuffled.inputs.seed).toBe(melody.generatorParams.arpSeed)
    expect(shuffled.inputs.seed).not.toBe(42)
  })

  it('marks the candidate outdated on input changes and rebuilds it from the new inputs', async () => {
    useFallbackModel()
    const { melody, project } = setup()
    await melody.loadArpModels()
    const first = melody.syncArpCandidate()!
    expect(melody.arpCandidateState).toBe('ready')

    melody.setGeneratorParams({ arpPattern: 'down' })
    expect(melody.arpCandidateState).toBe('stale')
    const second = melody.syncArpCandidate()!
    expect(second.revision).toBeGreaterThan(first.revision)
    expect(second.inputs.pattern).toBe('down')

    project.setWorkRange({ startStep: 0, endStep: 16 })
    expect(melody.arpCandidateState).toBe('stale')
    expect(melody.syncArpCandidate()!.inputs.range).toEqual({ startStep: 0, endStep: 16 })
    expect(melody.arpCandidateState).toBe('ready')
  })

  it('invalidates octave mode changes and captures the displayed mode in the take', async () => {
    useFallbackModel()
    const { melody, takes } = setup()
    melody.setGeneratorParams({ arpOctaveRange: 3, arpOctaveMode: 'up' })
    await melody.loadArpModels()
    const first = melody.syncArpCandidate()!

    melody.setGeneratorParams({ arpOctaveMode: 'down' })
    expect(melody.arpCandidateState).toBe('stale')
    const second = melody.syncArpCandidate()!
    expect(second.inputs.octaveMode).toBe('down')
    expect(second.notes).not.toEqual(first.notes)

    await melody.applyArp()
    expect(takes.takes[0].params.arpOctaveMode).toBe('down')
    expect(takes.takes[0].notes).toEqual(second.notes)
  })

  it.each([2, 4])(
    'enables inversion cycling only with enabled chords held for %s bars and retains the preference',
    async (durationBars) => {
      useFallbackModel()
      const { melody } = setup()
      const harmony = useHarmonyStore()
      const chord = {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'C',
        roman: 'I',
        notes: ['C', 'E', 'G'],
        voicing: ['C3', 'E3', 'G3'],
        startBar: 0,
        durationBars: 1
      }
      harmony.useChords = true
      harmony.setChords([chord, { ...chord, id: '22222222-2222-4222-8222-222222222222', startBar: 1 }])
      melody.setGeneratorParams({ arpInversionCycling: true })
      await melody.loadArpModels()
      expect(melody.syncArpCandidate()!.inputs.inversionCycling).toBe(false)

      harmony.setChords([{ ...chord, durationBars }])
      expect(melody.arpCandidateState).toBe('stale')
      expect(melody.syncArpCandidate()!.inputs.inversionCycling).toBe(true)

      harmony.useChords = false
      expect(melody.arpCandidateState).toBe('stale')
      expect(melody.syncArpCandidate()!.inputs.inversionCycling).toBe(false)
      expect(melody.generatorParams.arpInversionCycling).toBe(true)

      harmony.useChords = true
      expect(melody.syncArpCandidate()!.inputs.inversionCycling).toBe(true)
      melody.setGeneratorParams({ arpInversionCycling: false })
      expect(melody.syncArpCandidate()!.inputs.inversionCycling).toBe(false)

      melody.setGeneratorParams({ arpInversionCycling: true })
      harmony.setChords([{ ...chord, durationBars: 1.75 }])
      expect(melody.syncArpCandidate()!.inputs.inversionCycling).toBe(false)
      harmony.setChords([])
      expect(melody.syncArpCandidate()!.inputs.inversionCycling).toBe(false)
      expect(melody.generatorParams.arpInversionCycling).toBe(true)
    }
  )

  it('builds no candidate and blocks audition while the model is loading, then a late response yields the current one', async () => {
    vi.spyOn(trainedModelService, 'loadTrainedModelIndex').mockResolvedValue({
      artifactVersion: 1,
      kind: 'melodymate-markov-index',
      models: [modelEntry]
    })
    let resolveModel!: (model: TrainedMarkovArtifact | null) => void
    vi.spyOn(trainedModelService, 'loadTrainedModel').mockReturnValue(
      new Promise((resolve) => {
        resolveModel = resolve
      })
    )
    const { melody, audio } = setup()
    const audition = vi.spyOn(audio, 'auditionNotes')
    const loading = melody.loadArpModels()

    expect(melody.arpCandidateState).toBe('loading')
    expect(melody.syncArpCandidate()).toBeNull()
    await melody.auditionArp()
    expect(audition).not.toHaveBeenCalled()

    melody.setGeneratorParams({ arpPattern: 'random' })
    resolveModel(arpTestModel)
    await loading

    const candidate = melody.syncArpCandidate()!
    expect(candidate.inputs.pattern).toBe('random')
    expect(candidate.modelId).toBe(arpTestModel.id)
    expect(melody.arpCandidateState).toBe('ready')
  })

  describe('audition', () => {
    function mockAudio(audio: ReturnType<typeof useAudioStore>) {
      const start = vi.spyOn(audio, 'auditionNotes').mockImplementation(async (_notes, _bpm, id) => {
        audio.auditioningId = id ?? null
      })
      const stop = vi.spyOn(audio, 'stopNotesAudition').mockImplementation(() => {
        audio.auditioningId = null
      })
      return { start, stop }
    }

    it('plays the displayed notes with the work range origin and length, leaving melody and takes untouched', async () => {
      useFallbackModel()
      const { melody, takes, audio, project } = setup()
      const { start } = mockAudio(audio)
      await melody.loadArpModels()
      const shown = melody.syncArpCandidate()!

      await melody.auditionArp()

      expect(start).toHaveBeenCalledWith(shown.notes, project.bpm, expect.stringContaining('arp-candidate'), {
        originStep: 20,
        durationSteps: 32
      })
      expect(melody.isAuditioningArp).toBe(true)
      expect(melody.notes).toEqual([])
      expect(melody.canUndo).toBe(false)
      expect(takes.takes).toEqual([])
    })

    it('stops when the candidate is replaced, discarded or panicked, but never a take audition', async () => {
      useFallbackModel()
      const { melody, audio } = setup()
      const { stop } = mockAudio(audio)
      await melody.loadArpModels()
      melody.syncArpCandidate()

      await melody.auditionArp()
      melody.setGeneratorParams({ arpDensity: 60 })
      melody.syncArpCandidate()
      expect(melody.isAuditioningArp).toBe(false)

      await melody.auditionArp()
      melody.shuffleArp()
      expect(melody.isAuditioningArp).toBe(false)

      await melody.auditionArp()
      melody.discardArpCandidate()
      expect(melody.isAuditioningArp).toBe(false)
      expect(stop).toHaveBeenCalledTimes(3)

      audio.auditioningId = 'take-1'
      melody.syncArpCandidate()
      melody.stopArpAudition()
      expect(audio.auditioningId).toBe('take-1')
      expect(stop).toHaveBeenCalledTimes(3)
    })

    it('does not audition an outdated candidate', async () => {
      useFallbackModel()
      const { melody, audio } = setup()
      const { start } = mockAudio(audio)
      await melody.loadArpModels()
      melody.syncArpCandidate()
      melody.setGeneratorParams({ arpPattern: 'converge' })

      await melody.auditionArp()

      expect(start).not.toHaveBeenCalled()
    })
  })
})

describe('Arp Studio model failure recovery and concurrency', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    trainedModelService.setTrainedModelLoadersForTesting(null)
  })

  afterEach(() => {
    trainedModelService.setTrainedModelLoadersForTesting(null)
  })

  it('shows the fallback state after a failure and recovers to the trained model on retry', async () => {
    const loadIndex = vi
      .spyOn(trainedModelService, 'loadTrainedModelIndex')
      .mockResolvedValueOnce(null)
      .mockResolvedValue(arpIndex())
    const loadModel = vi
      .spyOn(trainedModelService, 'loadTrainedModel')
      .mockResolvedValueOnce(null)
      .mockResolvedValue(arpTestModel)
    const { melody } = setup()

    await melody.loadArpModels()
    expect(melody.arpModelStatus).toBe('fallback')
    expect(melody.arpStatusMessage).toMatch(/fallback/i)
    expect(melody.syncArpCandidate()!.modelId).toBeNull()

    const recovered = await melody.retryArpModel()
    expect(recovered).toBe(arpTestModel)
    // loadArpModels is safe to call repeatedly and now reflects the recovery.
    await melody.loadArpModels()
    expect(melody.arpModelStatus).toBe('available')
    expect(melody.arpStatusMessage).toBe('')
    expect(loadIndex).toHaveBeenCalled()
    expect(loadModel).toHaveBeenCalled()
    expect(melody.syncArpCandidate()!.modelId).toBe(arpTestModel.id)
  })

  it('retries automatically when applying after a fallback, without needing a page refresh', async () => {
    const loadModel = vi
      .spyOn(trainedModelService, 'loadTrainedModel')
      .mockResolvedValueOnce(null)
      .mockResolvedValue(arpTestModel)
    vi.spyOn(trainedModelService, 'loadTrainedModelIndex').mockResolvedValueOnce(null).mockResolvedValue(arpIndex())
    const generate = vi.spyOn(arpeggioGenerator, 'generateArpeggio')
    const { melody } = setup()

    await melody.loadArpModels()
    expect(melody.arpModelStatus).toBe('fallback')

    const applied = await melody.applyArp()
    expect(applied).toBe(true)
    expect(melody.arpModelStatus).toBe('available')
    // The fallback attempt and the apply-driven retry both reached the service.
    expect(loadModel).toHaveBeenCalledTimes(2)
    // First apply generated from the fallback; the recovery drives the final trained take.
    expect(generate.mock.calls.at(-1)![0].trainedModel).toBe(arpTestModel)
  })

  it('de-duplicates concurrent load requests so the underlying loader runs once', async () => {
    let resolveIndex!: (index: unknown) => void
    let resolveArtifact!: (model: unknown) => void
    const indexLoader = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveIndex = resolve
        })
    )
    const artifactLoader = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveArtifact = resolve
        })
    )
    trainedModelService.setTrainedModelLoadersForTesting({
      'index.json': indexLoader,
      'melodymate-markov-arp-default.json': artifactLoader
    })
    const { melody } = setup()

    const pending = [melody.retryArpModel(), melody.retryArpModel(), melody.retryArpModel()]
    expect(melody.arpModelStatus).toBe('loading')
    await Promise.resolve()
    resolveIndex(arpIndex())
    // Flush the fully promise-based chain (no timers): index resolution →
    // continuation → artifact loader invocation.
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve()
    }
    expect(indexLoader).toHaveBeenCalledTimes(1)
    expect(artifactLoader).toHaveBeenCalledTimes(1)
    resolveArtifact(arpTestModel)
    const results = await Promise.all(pending)

    expect(artifactLoader).toHaveBeenCalledTimes(1)
    expect(results.every((model) => model === results[0])).toBe(true)
    expect(results[0]?.id).toBe(arpTestModel.id)
    expect(melody.arpModelStatus).toBe('available')
  })

  it('keeps the arp fallback isolated from the melody role fallback in the same session', async () => {
    // The index is invalid: every role falls back, but each tracks its own state.
    trainedModelService.setTrainedModelLoadersForTesting({
      'index.json': async () => ({ kind: 'invalid-schema' })
    })
    const { melody } = setup()

    await melody.loadArpModels()
    expect(melody.arpModelStatus).toBe('fallback')

    // Melody generation fails independently but must not flip the ARP view model.
    await melody.generate()
    expect(melody.arpModelStatus).toBe('fallback')
    expect(melody.trainedModelStatus.status).toBe('fallback')
    expect(melody.trainedModelStatus.reason).toBe('index-invalid')
    expect(melody.notes.length).toBeGreaterThan(0)

    // ARP state remains a distinct record from the melody role's state.
    expect(trainedModelService.getTrainedModelStatus('arp').status).toBe('fallback')
    expect(trainedModelService.getTrainedModelStatus('melody').status).toBe('fallback')
  })
})
