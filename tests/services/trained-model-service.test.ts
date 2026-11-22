import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getTrainedIndexStatus,
  getTrainedModelStatus,
  loadTrainedModel,
  loadTrainedModelIndex,
  resetTrainedModelCache,
  setTrainedModelLoadersForTesting,
  subscribeTrainedModelStatus
} from '../../src/services/trained-model-service'

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

function makeIndex(overrides: Record<string, unknown> = {}) {
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
    ],
    ...overrides
  }
}

describe('trained-model-service', () => {
  beforeEach(() => {
    resetTrainedModelCache()
    setTrainedModelLoadersForTesting(null)
  })

  afterEach(() => {
    setTrainedModelLoadersForTesting(null)
  })

  it('loads real shipped tables for melody, bass, and arp out of the box', async () => {
    const melody = await loadTrainedModel('melody')
    expect(melody?.role).toBe('melody')
    expect(melody?.counts['']).toBeDefined()

    const arp = await loadTrainedModel('arp')
    expect(arp?.role).toBe('arp')

    const bass = await loadTrainedModel('bass')
    expect(bass?.role).toBe('bass')
  })

  it('loads, validates and returns the selected artifact with custom loaders', async () => {
    setTrainedModelLoadersForTesting({
      'index.json': async () => makeIndex(),
      'melodymate-markov-melody-default.json': async () => ARTIFACT
    })

    const model = await loadTrainedModel('melody')
    expect(model?.id).toBe('melody:default')
    expect(model?.counts['']).toEqual({ '0': 2, '2': 1, '4': 1 })
  })

  it('caches the index and artifact across calls', async () => {
    const indexLoader = vi.fn(async () => makeIndex())
    const artifactLoader = vi.fn(async () => ARTIFACT)

    setTrainedModelLoadersForTesting({
      'index.json': indexLoader,
      'melodymate-markov-melody-default.json': artifactLoader
    })

    await loadTrainedModel('melody')
    await loadTrainedModel('melody')
    await loadTrainedModelIndex()

    expect(indexLoader).toHaveBeenCalledTimes(1)
    expect(artifactLoader).toHaveBeenCalledTimes(1)
  })

  it('falls back to null when a file is missing in loaders', async () => {
    setTrainedModelLoadersForTesting({
      'index.json': async () => null
    })

    expect(await loadTrainedModel('melody')).toBeNull()
    expect(await loadTrainedModel('melody')).toBeNull()
  })

  it('falls back to null on loader errors', async () => {
    setTrainedModelLoadersForTesting({
      'index.json': async () => {
        throw new Error('disk read failed')
      }
    })

    expect(await loadTrainedModel('melody')).toBeNull()
  })

  it('falls back to null when the index fails validation', async () => {
    setTrainedModelLoadersForTesting({
      'index.json': async () => ({ kind: 'invalid-schema' })
    })

    expect(await loadTrainedModelIndex()).toBeNull()
    expect(await loadTrainedModel('melody')).toBeNull()
  })

  it('falls back to null when the artifact fails validation', async () => {
    const broken = { ...ARTIFACT, counts: { '': { '13': 1 } } }
    setTrainedModelLoadersForTesting({
      'index.json': async () => makeIndex(),
      'melodymate-markov-melody-default.json': async () => broken
    })

    expect(await loadTrainedModel('melody')).toBeNull()
  })

  it('returns null when no model exists for the requested role', async () => {
    setTrainedModelLoadersForTesting({
      'index.json': async () => makeIndex(),
      'melodymate-markov-melody-default.json': async () => ARTIFACT
    })

    expect(await loadTrainedModel('bass')).toBeNull()
  })

  it('loads each role from its own indexed artifact', async () => {
    const arp = { ...ARTIFACT, id: 'arp:default', role: 'arp' }
    const bass = { ...ARTIFACT, id: 'bass:default', role: 'bass' }
    const index = makeIndex({
      models: [
        {
          file: 'arp.json',
          id: arp.id,
          role: 'arp',
          style: arp.style,
          sha256: '0'.repeat(64),
          maxOrder: arp.maxOrder,
          stats: arp.stats
        },
        {
          file: 'bass.json',
          id: bass.id,
          role: 'bass',
          style: bass.style,
          sha256: '0'.repeat(64),
          maxOrder: bass.maxOrder,
          stats: bass.stats
        },
        {
          file: 'melody.json',
          id: ARTIFACT.id,
          role: ARTIFACT.role,
          style: ARTIFACT.style,
          sha256: '0'.repeat(64),
          maxOrder: ARTIFACT.maxOrder,
          stats: ARTIFACT.stats
        }
      ]
    })

    setTrainedModelLoadersForTesting({
      'index.json': async () => index,
      'arp.json': async () => arp,
      'bass.json': async () => bass,
      'melody.json': async () => ARTIFACT
    })

    expect((await loadTrainedModel('arp'))?.id).toBe(arp.id)
    expect((await loadTrainedModel('bass'))?.id).toBe(bass.id)
    expect((await loadTrainedModel('melody'))?.id).toBe(ARTIFACT.id)
  })

  describe('observable status', () => {
    it('moves a role through loading and available, exposing the validated artifact', async () => {
      const events: string[] = []
      const unsubscribe = subscribeTrainedModelStatus(() => events.push(getTrainedModelStatus('melody').status))
      setTrainedModelLoadersForTesting({
        'index.json': async () => makeIndex(),
        'melodymate-markov-melody-default.json': async () => ARTIFACT
      })

      const pending = loadTrainedModel('melody')
      expect(getTrainedModelStatus('melody').status).toBe('loading')
      expect(getTrainedIndexStatus().status).toBe('loading')

      const model = await pending
      expect(model?.id).toBe('melody:default')

      const status = getTrainedModelStatus('melody')
      expect(status.status).toBe('available')
      expect(status.model).toBe(model)
      expect(status.reason).toBeNull()
      expect(status.attempts).toBe(1)
      expect(getTrainedIndexStatus().status).toBe('available')
      expect(events).toContain('available')
      unsubscribe()
    })

    it('reports a categorized fallback with a user-facing message on index failure', async () => {
      setTrainedModelLoadersForTesting({
        'index.json': async () => {
          throw new Error('network down')
        }
      })

      expect(await loadTrainedModel('melody')).toBeNull()

      const indexStatus = getTrainedIndexStatus()
      expect(indexStatus.status).toBe('fallback')
      expect(indexStatus.reason).toBe('index-load-error')
      expect(indexStatus.message).toMatch(/index unavailable/i)

      const roleStatus = getTrainedModelStatus('melody')
      expect(roleStatus.status).toBe('fallback')
      expect(roleStatus.model).toBeNull()
      expect(roleStatus.reason).toBe('index-load-error')
      expect(roleStatus.message).toMatch(/scale table/)
    })

    it('distinguishes invalid index content from a thrown load error', async () => {
      setTrainedModelLoadersForTesting({
        'index.json': async () => ({ kind: 'invalid-schema' })
      })

      await loadTrainedModelIndex()

      expect(getTrainedIndexStatus().reason).toBe('index-invalid')
      expect(getTrainedModelStatus('bass').reason).toBe('index-invalid')
      expect(getTrainedModelStatus('arp').reason).toBe('index-invalid')
    })

    it('classifies artifact validation and mismatch failures per role', async () => {
      const broken = { ...ARTIFACT, counts: { '': { '13': 1 } } }
      setTrainedModelLoadersForTesting({
        'index.json': async () => makeIndex(),
        'melodymate-markov-melody-default.json': async () => broken
      })

      expect(await loadTrainedModel('melody')).toBeNull()
      const status = getTrainedModelStatus('melody')
      expect(status.status).toBe('fallback')
      expect(status.reason).toBe('model-invalid')
      expect(status.message).toMatch(/melody/i)
      // The index itself stayed healthy.
      expect(getTrainedIndexStatus().status).toBe('available')

      const mismatched = { ...ARTIFACT, id: 'melody:tampered' }
      setTrainedModelLoadersForTesting({
        'index.json': async () => makeIndex(),
        'melodymate-markov-melody-default.json': async () => mismatched
      })
      expect(await loadTrainedModel('melody')).toBeNull()
      expect(getTrainedModelStatus('melody').reason).toBe('model-mismatch')
    })

    it('records no-entry when the index has no model for the requested role', async () => {
      setTrainedModelLoadersForTesting({
        'index.json': async () => makeIndex(),
        'melodymate-markov-melody-default.json': async () => ARTIFACT
      })

      expect(await loadTrainedModel('bass')).toBeNull()
      expect(getTrainedModelStatus('bass').reason).toBe('no-entry')
    })
  })

  describe('recovery after failure', () => {
    it('retries the index on the next request after a failure instead of caching it', async () => {
      const indexLoader = vi
        .fn<() => Promise<unknown>>()
        .mockRejectedValueOnce(new Error('first attempt fails'))
        .mockResolvedValueOnce(makeIndex())
      const artifactLoader = vi.fn(async () => ARTIFACT)
      setTrainedModelLoadersForTesting({
        'index.json': indexLoader,
        'melodymate-markov-melody-default.json': artifactLoader
      })

      expect(await loadTrainedModel('melody')).toBeNull()
      expect(getTrainedModelStatus('melody').status).toBe('fallback')

      const recovered = await loadTrainedModel('melody')
      expect(recovered?.id).toBe('melody:default')
      expect(indexLoader).toHaveBeenCalledTimes(2)
      expect(artifactLoader).toHaveBeenCalledTimes(1)
      expect(getTrainedModelStatus('melody').status).toBe('available')
      expect(getTrainedIndexStatus().status).toBe('available')
    })

    it('retries a failed artifact load while keeping the healthy index cached', async () => {
      const artifactLoader = vi
        .fn<() => Promise<unknown>>()
        .mockRejectedValueOnce(new Error('chunk missing'))
        .mockResolvedValueOnce(ARTIFACT)
      const indexLoader = vi.fn(async () => makeIndex())
      setTrainedModelLoadersForTesting({
        'index.json': indexLoader,
        'melodymate-markov-melody-default.json': artifactLoader
      })

      expect(await loadTrainedModel('melody')).toBeNull()
      expect(getTrainedModelStatus('melody').reason).toBe('model-load-error')

      const recovered = await loadTrainedModel('melody')
      expect(recovered?.id).toBe('melody:default')
      expect(indexLoader).toHaveBeenCalledTimes(1)
      expect(artifactLoader).toHaveBeenCalledTimes(2)
      expect(getTrainedModelStatus('melody').status).toBe('available')
    })

    it('keeps retrying after repeated failures and increments the attempt counter', async () => {
      const indexLoader = vi
        .fn<() => Promise<unknown>>()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValueOnce(makeIndex())
      setTrainedModelLoadersForTesting({
        'index.json': indexLoader,
        'melodymate-markov-melody-default.json': async () => ARTIFACT
      })

      await loadTrainedModel('melody')
      await loadTrainedModel('melody')
      expect(getTrainedModelStatus('melody').attempts).toBe(2)
      expect(getTrainedModelStatus('melody').status).toBe('fallback')

      expect((await loadTrainedModel('melody'))?.id).toBe('melody:default')
      expect(getTrainedModelStatus('melody').attempts).toBe(3)
      expect(indexLoader).toHaveBeenCalledTimes(3)
    })

    it('caches a successful load so later requests do not re-import', async () => {
      const indexLoader = vi.fn(async () => makeIndex())
      const artifactLoader = vi.fn(async () => ARTIFACT)
      setTrainedModelLoadersForTesting({
        'index.json': indexLoader,
        'melodymate-markov-melody-default.json': artifactLoader
      })

      const first = await loadTrainedModel('melody')
      const second = await loadTrainedModel('melody')
      expect(second).toBe(first)
      expect(indexLoader).toHaveBeenCalledTimes(1)
      expect(artifactLoader).toHaveBeenCalledTimes(1)
      // Attempts do not grow once a model is healthy.
      expect(getTrainedModelStatus('melody').attempts).toBe(1)
    })
  })

  describe('concurrency', () => {
    it('shares one in-flight index and artifact load between concurrent role requests', async () => {
      const indexLoader = vi.fn(async () => makeIndex())
      const artifactLoader = vi.fn(async () => ARTIFACT)
      setTrainedModelLoadersForTesting({
        'index.json': indexLoader,
        'melodymate-markov-melody-default.json': artifactLoader
      })

      const [a, b, c] = await Promise.all([
        loadTrainedModel('melody'),
        loadTrainedModel('melody'),
        loadTrainedModel('melody')
      ])

      expect(a).toBe(b)
      expect(b).toBe(c)
      expect(indexLoader).toHaveBeenCalledTimes(1)
      expect(artifactLoader).toHaveBeenCalledTimes(1)
    })

    it('gives every concurrent waiter the same fallback result on failure', async () => {
      const indexLoader = vi.fn(async () => {
        throw new Error('boom')
      })
      setTrainedModelLoadersForTesting({ 'index.json': indexLoader })

      const results = await Promise.all([loadTrainedModel('melody'), loadTrainedModel('melody')])
      expect(results).toEqual([null, null])
      expect(indexLoader).toHaveBeenCalledTimes(1)
    })

    it('starts a fresh load for the next wave of requests after the shared failure settles', async () => {
      const indexLoader = vi
        .fn<() => Promise<unknown>>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(makeIndex())
      const artifactLoader = vi.fn(async () => ARTIFACT)
      setTrainedModelLoadersForTesting({
        'index.json': indexLoader,
        'melodymate-markov-melody-default.json': artifactLoader
      })

      const firstWave = await Promise.all([loadTrainedModel('melody'), loadTrainedModel('melody')])
      expect(firstWave).toEqual([null, null])

      const secondWave = await Promise.all([loadTrainedModel('melody'), loadTrainedModel('melody')])
      expect(secondWave[0]?.id).toBe('melody:default')
      expect(secondWave[0]).toBe(secondWave[1])
      expect(indexLoader).toHaveBeenCalledTimes(2)
      expect(artifactLoader).toHaveBeenCalledTimes(1)
    })
  })

  describe('role isolation', () => {
    function multiRoleIndex() {
      const arp = { ...ARTIFACT, id: 'arp:default', role: 'arp' as const }
      const bass = { ...ARTIFACT, id: 'bass:default', role: 'bass' as const }
      const melody = ARTIFACT
      const index = makeIndex({
        models: [
          {
            file: 'arp.json',
            id: arp.id,
            role: arp.role,
            style: arp.style,
            sha256: '0'.repeat(64),
            maxOrder: arp.maxOrder,
            stats: arp.stats
          },
          {
            file: 'bass.json',
            id: bass.id,
            role: bass.role,
            style: bass.style,
            sha256: '0'.repeat(64),
            maxOrder: bass.maxOrder,
            stats: bass.stats
          },
          {
            file: 'melody.json',
            id: melody.id,
            role: melody.role,
            style: melody.style,
            sha256: '0'.repeat(64),
            maxOrder: melody.maxOrder,
            stats: melody.stats
          }
        ]
      })
      return { index, arp, bass, melody }
    }

    it('does not let one role failure invalidate another role cached artifact', async () => {
      const { index, arp, bass, melody } = multiRoleIndex()
      const bassLoader = vi
        .fn<() => Promise<unknown>>()
        .mockRejectedValueOnce(new Error('bass corrupt'))
        .mockResolvedValueOnce(bass)
      setTrainedModelLoadersForTesting({
        'index.json': async () => index,
        'arp.json': async () => arp,
        'bass.json': bassLoader,
        'melody.json': async () => melody
      })

      // All three roles load; bass fails once.
      expect((await loadTrainedModel('melody'))?.id).toBe('melody:default')
      expect((await loadTrainedModel('arp'))?.id).toBe('arp:default')
      expect(await loadTrainedModel('bass')).toBeNull()

      expect(getTrainedModelStatus('melody').status).toBe('available')
      expect(getTrainedModelStatus('arp').status).toBe('available')
      expect(getTrainedModelStatus('bass').status).toBe('fallback')

      // Healthy roles stay cached while bass recovers independently.
      await loadTrainedModel('melody')
      await loadTrainedModel('arp')
      const recoveredBass = await loadTrainedModel('bass')
      expect(recoveredBass?.id).toBe('bass:default')
      expect(bassLoader).toHaveBeenCalledTimes(2)
      expect(getTrainedModelStatus('bass').status).toBe('available')
      expect(getTrainedModelStatus('melody').model?.id).toBe('melody:default')
    })

    it('puts every role into fallback when the index fails, then restores them on retry', async () => {
      const { index, arp, bass, melody } = multiRoleIndex()
      const indexLoader = vi
        .fn<() => Promise<unknown>>()
        .mockRejectedValueOnce(new Error('index gone'))
        .mockResolvedValueOnce(index)
      setTrainedModelLoadersForTesting({
        'index.json': indexLoader,
        'arp.json': async () => arp,
        'bass.json': async () => bass,
        'melody.json': async () => melody
      })

      await Promise.all([loadTrainedModel('melody'), loadTrainedModel('bass'), loadTrainedModel('arp')])
      for (const role of ['melody', 'bass', 'arp'] as const) {
        expect(getTrainedModelStatus(role).status).toBe('fallback')
      }

      // Retry each role; the shared recovered index lets all of them succeed.
      expect((await loadTrainedModel('melody'))?.role).toBe('melody')
      expect((await loadTrainedModel('bass'))?.role).toBe('bass')
      expect((await loadTrainedModel('arp'))?.role).toBe('arp')
      for (const role of ['melody', 'bass', 'arp'] as const) {
        expect(getTrainedModelStatus(role).status).toBe('available')
      }
    })
  })
})
