import { beforeEach, describe, expect, it, vi } from 'vitest'
import AudioManager from './audio-manager'

// Wiring tests for the audio manager's one rule: every audible path —
// normal playback, an effect-chain rebuild, recovery from bypass, and the
// master-toggle bypass itself — ends … → limiter → destination. Nothing
// wires straight to the destination; when the limiter worklet's module path
// is missing, a gain-1 passthrough stands in (audible, and announced with a
// console warning) rather than a silent direct wire.
//
// Runs against the Web Audio mocks in src/test/setup.ts; the assertions are
// on which node was connected to which.

class MockMediaElement {
    currentSrc = ''
    readyState = 4
    volume = 1
    muted = false
    paused = false
    crossOrigin: string | null = null
    addEventListener = vi.fn()
    removeEventListener = vi.fn()
}

const store = new Map<string, string>()

;(globalThis as Record<string, unknown>).HTMLMediaElement = MockMediaElement
;(globalThis as Record<string, unknown>).sessionStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear()
}

// The tests reach into private fields to assert on the wiring; the manager
// is typed as any here so those accesses don't fight the visibility rules.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyManager = any

async function createManager(): Promise<AnyManager> {
    const manager = new AudioManager(new MockMediaElement() as unknown as HTMLAudioElement)
    await (manager as AnyManager)._setupPromise
    return manager
}

const connectCalls = (node: AudioNode) => (node.connect as ReturnType<typeof vi.fn>).mock.calls

beforeEach(() => {
    store.clear()
    store.set('chorus:soundtouch_path', 'chrome-extension://test/soundtouch.js')
    store.set('chorus:limiter_path', 'chrome-extension://test/limiter-processor.js')
})

describe('audio manager output wiring', () => {
    it('ends the default chain gain → limiter → destination', async () => {
        const m = await createManager()
        expect(m._limiterNode).toBeDefined()
        expect(m._gainNode!.connect).toHaveBeenCalledWith(m._limiterNode)
        expect(m._limiterNode!.connect).toHaveBeenCalledWith(m._destination)
        expect(m._gainNode!.connect).not.toHaveBeenCalledWith(m._destination)
    })

    it('keeps the gain and the limiter in the path while bypassed', async () => {
        const m = await createManager()
        m.setGain(2.5, 'linear')
        vi.clearAllMocks()

        m.bypass()

        // source → gain → limiter → destination, never gain → destination.
        expect(m._source!.connect).toHaveBeenCalledWith(m._gainNode)
        expect(m._gainNode!.connect).toHaveBeenCalledWith(m._limiterNode)
        expect(m._limiterNode!.connect).toHaveBeenCalledWith(m._destination)
        expect(m._gainNode!.connect).not.toHaveBeenCalledWith(m._destination)
        expect(m._source!.connect).not.toHaveBeenCalledWith(m._destination)
    })

    it('restores from bypass through the limiter with the volume intact', async () => {
        const m = await createManager()
        m.setGain(2.5, 'linear')
        m.bypass()
        vi.clearAllMocks()

        m.restoreChain()

        expect(m._soundTouchNode!.connect).toHaveBeenCalledWith(m._gainNode)
        expect(m._gainNode!.connect).toHaveBeenCalledWith(m._limiterNode)
        expect(m._limiterNode!.connect).toHaveBeenCalledWith(m._destination)
        expect(m._gainNode!.connect).not.toHaveBeenCalledWith(m._destination)
        // No loudness jump across the toggle: the stored volume is reapplied.
        expect(m._gainNode!.gain.value).toBe(2.5)
    })

    it('rebuilds the effect chain into the limiter, not the destination', async () => {
        const m = await createManager()
        const eq = (m.audioContext as unknown as AudioContext).createGain()
        vi.clearAllMocks()

        m.connectEqualizer(eq)

        expect(m._gainNode!.connect).toHaveBeenCalledWith(m._limiterNode)
        expect(m._limiterNode!.connect).toHaveBeenCalledWith(m._destination)
        for (const [target] of connectCalls(m._gainNode!)) {
            expect(target).not.toBe(m._destination)
        }
    })

    it('disconnect() also lands back on the limiter', async () => {
        const m = await createManager()
        vi.clearAllMocks()

        m.disconnect()

        expect(m._gainNode!.connect).toHaveBeenCalledWith(m._limiterNode)
        expect(m._gainNode!.connect).not.toHaveBeenCalledWith(m._destination)
    })

    it('warns and degrades to a passthrough node when the limiter path is missing', async () => {
        store.delete('chorus:limiter_path')
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        const m = await createManager()

        // A clear warning, not a silent direct wire.
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('chorus:limiter_path'))
        expect(m._limiterNode).toBeUndefined()
        const fallback = m._outputFallback
        expect(fallback).toBeDefined()
        // Still audible, through the stand-in node — never gain → destination.
        expect(m._gainNode!.connect).toHaveBeenCalledWith(fallback)
        expect(fallback!.connect).toHaveBeenCalledWith(m._destination)
        expect(m._gainNode!.connect).not.toHaveBeenCalledWith(m._destination)

        // The bypass path degrades the same way.
        vi.clearAllMocks()
        m.bypass()
        expect(m._gainNode!.connect).toHaveBeenCalledWith(fallback)
        expect(m._gainNode!.connect).not.toHaveBeenCalledWith(m._destination)

        warn.mockRestore()
    })
})
