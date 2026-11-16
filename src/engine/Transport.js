/**
 * Transport
 *
 * Framework-independent playback clock for the 808. It advances a step
 * position from a monotonic clock (rAF + performance.now in the browser,
 * injectable fakes in tests) and triggers the currently active sequence's
 * notes exactly when each step boundary is reached.
 *
 * Timing model
 * ------------
 * Position is stored as (currentStepID, stepElapsedMs), where stepElapsedMs
 * is the time already travelled *inside* the current step. Time that belongs
 * to finished steps is settled forever and is never recomputed.
 *
 * BPM change: only the step duration used from that instant on changes.
 * The elapsed fraction of the current step is mapped onto the new step
 * duration (elapsed/newDur == oldElapsed/oldDur), so:
 *   - finished steps keep their old-length settlement,
 *   - the playhead keeps the same fractional position (no backward jump),
 *   - the current step is not retriggered and no step is skipped.
 *
 * Sequence change: the track list (and therefore its samples) is swapped
 * immediately while (currentStepID, stepElapsedMs) is left untouched, so the
 * playhead continues at the exact same position with no restart, no jump.
 */

export const TOTAL_STEPS = 16

export const stepDurationForBPM = (bpm) =>
    // 8th notes: 4 beats/bar, 8 steps/bar => 2 steps per beat
    (60 / Number(bpm) / 2) * 1000

class Transport {
    constructor({
        soundEngine,
        now,
        requestFrame,
        cancelFrame,
        totalSteps = TOTAL_STEPS,
    }) {
        this.soundEngine = soundEngine
        this.totalSteps = totalSteps
        this.tracks = []

        this.isPlaying = false
        this.bpm = 120
        this.stepDuration = stepDurationForBPM(this.bpm)
        this.currentStepID = null
        this.stepElapsedMs = 0
        this.lastTickTime = null
        this.rafId = null
        this.listeners = new Set()

        // Injected clock/frame scheduler; default to browser globals.
        this.now =
            now ||
            (typeof performance !== 'undefined'
                ? () => performance.now()
                : () => Date.now())
        this.requestFrame =
            requestFrame ||
            (typeof requestAnimationFrame !== 'undefined'
                ? requestAnimationFrame
                : (cb) => setTimeout(() => cb(this.now()), 16))
        this.cancelFrame =
            cancelFrame ||
            (typeof cancelAnimationFrame !== 'undefined'
                ? cancelAnimationFrame
                : clearTimeout)

        this.tick = this.tick.bind(this)
    }

    subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    emit() {
        const snapshot = this.getState()
        this.listeners.forEach((listener) => listener(snapshot))
    }

    getState() {
        return {
            isPlaying: this.isPlaying,
            bpm: this.bpm,
            currentStepID: this.currentStepID,
            stepElapsedMs: this.stepElapsedMs,
            stepDuration: this.stepDuration,
            progressInStep: Math.min(
                1,
                this.stepElapsedMs / this.stepDuration
            ),
            tracks: this.tracks,
        }
    }

    /**
     * Swap the playing pattern. Samples are (re)loaded by the sound engine
     * for every track slot; the playhead position is intentionally not
     * modified. Returns the sound engine's loading promise so callers can
     * await it in tests if they need deterministic buffer readiness.
     */
    loadSequence(tracks) {
        this.tracks = tracks.map((track) => ({ ...track }))
        return this.soundEngine.loadSequence(this.tracks)
    }

    /** Replace only the note pattern without touching loaded samples. */
    updateTracks(tracks) {
        this.tracks = tracks.map((track) => ({ ...track }))
        this.emit()
    }

    setBPM(nextBPM) {
        const parsed = Number(nextBPM)
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return
        }

        if (this.currentStepID !== null) {
            // Preserve the fractional position inside the current step so
            // the playhead never moves backwards and the current step is
            // neither repeated nor skipped.
            const fraction = this.stepElapsedMs / this.stepDuration
            this.stepDuration = stepDurationForBPM(parsed)
            this.stepElapsedMs = fraction * this.stepDuration
        } else {
            this.stepDuration = stepDurationForBPM(parsed)
        }
        this.bpm = parsed
        this.emit()
    }

    play() {
        if (this.isPlaying) {
            return
        }
        this.isPlaying = true

        if (this.currentStepID === null) {
            // Starting from stop (or first run): begin on step 0 and
            // trigger its notes immediately.
            this.currentStepID = 0
            this.stepElapsedMs = 0
            this.triggerStep(this.currentStepID)
        }

        this.lastTickTime = this.now()
        this.rafId = this.requestFrame(this.tick)
        this.emit()
    }

    pause() {
        if (!this.isPlaying) {
            return
        }
        this.isPlaying = false
        this.cancelFrame(this.rafId)
        this.rafId = null
        this.lastTickTime = null
        // currentStepID / stepElapsedMs are frozen: resume continues here.
        this.emit()
    }

    stop() {
        this.isPlaying = false
        if (this.rafId !== null) {
            this.cancelFrame(this.rafId)
            this.rafId = null
        }
        this.lastTickTime = null
        this.currentStepID = null
        this.stepElapsedMs = 0
        this.soundEngine.stopAll()
        this.emit()
    }

    /** Manual audition from a grid click — independent of playback. */
    preview(trackID) {
        return this.soundEngine.play(trackID)
    }

    tick(tickTime = this.now()) {
        if (!this.isPlaying) {
            return
        }

        const delta = Math.max(0, tickTime - (this.lastTickTime ?? tickTime))
        this.lastTickTime = tickTime
        this.advance(delta)

        this.rafId = this.requestFrame(this.tick)
        this.emit()
    }

    advance(deltaMs) {
        this.stepElapsedMs += deltaMs

        while (this.stepElapsedMs >= this.stepDuration) {
            this.stepElapsedMs -= this.stepDuration
            this.currentStepID =
                (this.currentStepID + 1) % this.totalSteps
            this.triggerStep(this.currentStepID)
        }
    }

    triggerStep(stepID) {
        this.tracks.forEach((track, trackID) => {
            if (Array.isArray(track.onNotes) && track.onNotes.includes(stepID)) {
                this.soundEngine.play(trackID)
            }
        })
    }
}

export default Transport
