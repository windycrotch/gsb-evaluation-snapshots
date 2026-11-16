/**
 * SoundEngine
 *
 * Owns exactly ONE AudioContext for the whole app and one sound entry per
 * track slot. Every sequence switch calls `loadSequence`, which replaces the
 * entries for every track from that sequence's `soundFile` list. Old samples
 * lose all references at that moment and can therefore never be triggered
 * again; anything still ringing is stopped explicitly.
 *
 * All browser globals are injected through the constructor so the same code
 * can be exercised deterministically in Node tests.
 */
class SoundEngine {
    constructor({
        audioContext,
        fetchFn,
        decode = (ctx, arrayBuffer) => ctx.decodeAudioData(arrayBuffer),
    } = {}) {
        if (!audioContext) {
            const AudioContextCtor =
                (typeof window !== 'undefined' &&
                    (window.AudioContext ||
                        window.webkitAudioContext ||
                        window.MozAudioContext)) ||
                null
            if (!AudioContextCtor) {
                throw new Error('Web Audio API is not available')
            }
            audioContext = new AudioContextCtor()
        }
        if (typeof fetchFn === 'undefined' && typeof fetch === 'function') {
            fetchFn = fetch
        }

        this.audioContext = audioContext
        this.fetchFn = fetchFn
        this.decode = decode
        this.sounds = []
        this.activeSources = new Set()
        this.loadGeneration = 0
    }

    /**
     * (Re)load one sound entry per track slot. A monotonically increasing
     * generation token makes sure a slow fetch from an older sequence can
     * never overwrite a newer sequence's buffer.
     */
    async loadSequence(tracks) {
        const generation = ++this.loadGeneration
        this.stopAll()
        this.sounds = tracks.map((track) => ({
            path: track.soundFilePath,
            buffer: null,
            loaded: false,
        }))

        await Promise.all(
            this.sounds.map(async (entry) => {
                try {
                    const response = await this.fetchFn(entry.path)
                    const arrayBuffer = await response.arrayBuffer()
                    const buffer = await this.decode(
                        this.audioContext,
                        arrayBuffer
                    )
                    if (generation !== this.loadGeneration) {
                        // A newer sequence has been loaded since; discard.
                        return
                    }
                    entry.buffer = buffer
                    entry.loaded = true
                } catch (error) {
                    if (generation === this.loadGeneration) {
                        entry.error = error
                    }
                }
            })
        )
    }

    play(trackID, { gainValue = 1, rateValue = 1 } = {}) {
        const entry = this.sounds[trackID]
        if (!entry || !entry.loaded || !entry.buffer) {
            return null
        }

        this.audioContext.resume?.()

        const gain = this.audioContext.createGain()
        const source = this.audioContext.createBufferSource()
        gain.gain.value = gainValue
        source.playbackRate.value = rateValue
        source.buffer = entry.buffer
        source.connect(gain)
        gain.connect(this.audioContext.destination)

        this.activeSources.add(source)
        const forget = () => {
            this.activeSources.delete(source)
        }
        source.onended = forget
        source.start(0)
        return source
    }

    /** Stop every sample that is currently ringing. */
    stopAll() {
        this.activeSources.forEach((source) => {
            try {
                source.onended = null
                source.stop()
            } catch {
                // already stopped — nothing to do
            }
        })
        this.activeSources.clear()
    }

    dispose() {
        this.stopAll()
        this.sounds = []
        this.loadGeneration++
        if (this.audioContext.state !== 'closed') {
            this.audioContext.close?.()
        }
    }
}

export default SoundEngine
