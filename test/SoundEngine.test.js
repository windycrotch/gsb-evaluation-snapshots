import { test } from 'node:test'
import assert from 'node:assert/strict'
import SoundEngine from '../src/engine/SoundEngine.js'

function createFakeAudioContext() {
    const active = new Set()
    const ctx = {
        state: 'suspended',
        resumeCalls: 0,
        closed: false,
        resume() {
            this.resumeCalls++
            this.state = 'running'
        },
        close() {
            this.closed = true
            this.state = 'closed'
        },
        createGain() {
            return { gain: { value: 0 }, connect() {}, disconnect() {} }
        },
        createBufferSource() {
            const source = {
                buffer: null,
                playbackRate: { value: 1 },
                onended: null,
                started: false,
                stopped: false,
                connect() {},
                start() {
                    this.started = true
                    active.add(this)
                },
                stop() {
                    if (this.stopped) throw new Error('already stopped')
                    this.stopped = true
                    active.delete(this)
                    if (this.onended) this.onended()
                },
            }
            return source
        },
        decodeAudioData(arrayBuffer) {
            return Promise.resolve({ fake: true, bytes: arrayBuffer.byteLength })
        },
        _active: active,
    }
    return ctx
}

function createFetch(buffers) {
    const calls = []
    const fetchFn = async (path) => {
        calls.push(path)
        return {
            arrayBuffer: async () => buffers[path],
        }
    }
    return { fetchFn, calls }
}

const tracksFor = (paths) =>
    paths.map((p) => ({ soundFilePath: p }))

test('loadSequence fetches and decodes one buffer per track slot', async () => {
    const ctx = createFakeAudioContext()
    const { fetchFn, calls } = createFetch({
        '/sounds/kick.wav': new ArrayBuffer(11),
        '/sounds/snare.wav': new ArrayBuffer(22),
    })
    const engine = new SoundEngine({ audioContext: ctx, fetchFn })

    await engine.loadSequence(
        tracksFor(['/sounds/kick.wav', '/sounds/snare.wav'])
    )

    assert.deepEqual(calls, ['/sounds/kick.wav', '/sounds/snare.wav'])
    assert.equal(engine.sounds[0].loaded, true)
    assert.equal(engine.sounds[0].buffer.bytes, 11)
    assert.equal(engine.sounds[1].buffer.bytes, 22)
})

test('a second loadSequence makes old samples unplayable and stops ringing sources', async () => {
    const ctx = createFakeAudioContext()
    const { fetchFn } = createFetch({
        '/sounds/kick.wav': new ArrayBuffer(1),
        '/sounds/snare.wav': new ArrayBuffer(2),
    })
    const engine = new SoundEngine({ audioContext: ctx, fetchFn })

    await engine.loadSequence(tracksFor(['/sounds/kick.wav']))
    const firstSource = engine.play(0)
    assert.ok(firstSource.started)
    assert.equal(ctx._active.size, 1)

    await engine.loadSequence(tracksFor(['/sounds/snare.wav']))

    // The ringing old source was stopped and the old slot was replaced.
    assert.equal(firstSource.stopped, true)
    assert.equal(ctx._active.size, 0)
    assert.equal(engine.sounds.length, 1)
    assert.equal(engine.sounds[0].path, '/sounds/snare.wav')
})

test('a stale slow fetch cannot overwrite a newer sequence buffer', async () => {
    const ctx = createFakeAudioContext()
    let resolveOld
    const fetchFn = (path) => {
        if (path === '/sounds/old.wav') {
            return new Promise((resolve) => {
                resolveOld = resolve
            })
        }
        return Promise.resolve({
            arrayBuffer: async () => new ArrayBuffer(9),
        })
    }
    const engine = new SoundEngine({ audioContext: ctx, fetchFn })

    // Kick off a slow load, then replace it before it resolves.
    const slowLoad = engine.loadSequence(tracksFor(['/sounds/old.wav']))
    await engine.loadSequence(tracksFor(['/sounds/new.wav']))
    resolveOld({ arrayBuffer: async () => new ArrayBuffer(1) })
    await slowLoad

    assert.equal(engine.sounds[0].path, '/sounds/new.wav')
    assert.equal(engine.sounds[0].buffer.bytes, 9)
})

test('play before a buffer is loaded is a safe no-op', async () => {
    const ctx = createFakeAudioContext()
    const engine = new SoundEngine({
        audioContext: ctx,
        fetchFn: () => new Promise(() => {}), // never resolves
    })
    engine.loadSequence(tracksFor(['/sounds/kick.wav']))
    const result = engine.play(0)
    assert.equal(result, null)
    assert.equal(ctx._active.size, 0)
})

test('stopAll stops every active source exactly once', async () => {
    const ctx = createFakeAudioContext()
    const { fetchFn } = createFetch({
        '/sounds/kick.wav': new ArrayBuffer(1),
        '/sounds/snare.wav': new ArrayBuffer(2),
    })
    const engine = new SoundEngine({ audioContext: ctx, fetchFn })
    await engine.loadSequence(
        tracksFor(['/sounds/kick.wav', '/sounds/snare.wav'])
    )

    const a = engine.play(0)
    const b = engine.play(1)
    assert.equal(ctx._active.size, 2)

    engine.stopAll()
    assert.equal(a.stopped, true)
    assert.equal(b.stopped, true)
    assert.equal(ctx._active.size, 0)

    // Repeated stopAll must not throw on already-stopped sources.
    assert.doesNotThrow(() => engine.stopAll())
})

test('React StrictMode double-effect (same sequence loaded twice) ends with the correct buffers', async () => {
    const ctx = createFakeAudioContext()
    let fetchCount = 0
    const { fetchFn } = createFetch({
        '/sounds/kick.wav': new ArrayBuffer(7),
    })
    const countingFetch = async (path) => {
        fetchCount++
        return fetchFn(path)
    }
    const engine = new SoundEngine({ audioContext: ctx, fetchFn: countingFetch })

    // StrictMode mounts, cleans up, and mounts again: same load twice.
    await engine.loadSequence(tracksFor(['/sounds/kick.wav']))
    await engine.loadSequence(tracksFor(['/sounds/kick.wav']))

    assert.equal(fetchCount, 2)
    assert.equal(engine.sounds.length, 1)
    assert.equal(engine.sounds[0].loaded, true)
    assert.equal(engine.sounds[0].buffer.bytes, 7)

    const source = engine.play(0)
    assert.ok(source.started)
})
