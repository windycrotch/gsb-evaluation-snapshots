import { effectScope, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getTrainedModelStatus,
  resetTrainedModelCache,
  setTrainedModelLoadersForTesting
} from '../../src/services/trained-model-service'
import { refreshTrainedModelStatusForTesting, useTrainedModelStatus } from '../../src/composables/useTrainedModelStatus'

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

function makeIndex() {
  return {
    artifactVersion: 1,
    kind: 'melodymate-markov-index',
    models: [
      {
        file: 'melodymate-markov-melody-default.json',
        id: 'melody:default',
        role: 'melody',
        style: 'default',
        sha256: '0'.repeat(64),
        maxOrder: 4,
        stats: ARTIFACT.stats
      }
    ]
  }
}

describe('useTrainedModelStatus', () => {
  let scope: ReturnType<typeof effectScope>

  beforeEach(() => {
    resetTrainedModelCache()
    setTrainedModelLoadersForTesting(null)
    scope = effectScope()
    refreshTrainedModelStatusForTesting()
  })

  afterEach(() => {
    scope.stop()
    setTrainedModelLoadersForTesting(null)
  })

  it('starts idle and mirrors service transitions reactively through fallback to available', async () => {
    let attempt = 0
    setTrainedModelLoadersForTesting({
      'index.json': async () => {
        attempt += 1
        if (attempt === 1) throw new Error('offline')
        return makeIndex()
      },
      'melodymate-markov-melody-default.json': async () => ARTIFACT
    })

    await scope.run(async () => {
      const api = useTrainedModelStatus('melody')
      expect(api.status.value.status).toBe('idle')
      expect(api.model.value).toBeNull()

      await api.retry()
      await nextTick()
      expect(api.status.value.status).toBe('fallback')
      expect(api.status.value.reason).toBe('index-load-error')
      expect(getTrainedModelStatus('melody').status).toBe('fallback')

      const recovered = await api.retry()
      await nextTick()
      expect(api.status.value.status).toBe('available')
      expect(api.model.value).toBe(recovered)
      expect(api.indexStatus.value.status).toBe('available')
    })
  })

  it('shares one singleton view across role composables and isolates role state', async () => {
    const bassArtifact = { ...ARTIFACT, id: 'bass:default', role: 'bass' as const }
    const index = makeIndex()
    index.models.push({
      file: 'bass.json',
      id: bassArtifact.id,
      role: 'bass',
      style: bassArtifact.style,
      sha256: '0'.repeat(64),
      maxOrder: bassArtifact.maxOrder,
      stats: bassArtifact.stats
    })
    const bassLoader = () => Promise.reject(new Error('bass missing'))
    setTrainedModelLoadersForTesting({
      'index.json': async () => index,
      'melodymate-markov-melody-default.json': async () => ARTIFACT,
      'bass.json': bassLoader
    })

    await scope.run(async () => {
      const melody = useTrainedModelStatus('melody')
      const bass = useTrainedModelStatus('bass')

      expect((await melody.retry())?.id).toBe('melody:default')
      expect(await bass.retry()).toBeNull()
      await nextTick()

      expect(melody.status.value.status).toBe('available')
      expect(bass.status.value.status).toBe('fallback')
      expect(bass.status.value.reason).toBe('model-load-error')
      // The healthy melody view is untouched by the bass failure.
      expect(melody.model.value?.id).toBe('melody:default')
    })
  })
})
