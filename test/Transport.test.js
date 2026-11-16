import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Transport, { TOTAL_STEPS, stepDurationForBPM } from '../src/engine/Transport.js'

/**
 * Deterministic frame harness: virtual clock + a single scheduled frame
 * callback, so playback timing can be driven manually instead of by rAF.
 */
function createFrameHarness(startTime = 1000) {
    let virtualNow = startTime
    let scheduled = null

    const now = () => virtualNow
    const requestFrame = (cb) => {
        if (scheduled) throw new Error('a frame is already scheduled')
        scheduled = cb
        return 1
    }
    const cancelFrame = () => {
        scheduled = null
    }
    const advance = (ms) => {
        virtualNow += ms
        const cb = scheduled
        scheduled = null
        if (cb) cb(virtualNow)
    }

    return { now, requestFrame, cancelFrame, advance }
}

function createFakeSoundEngine() {
    const plays = []
    const stopped = []
    const loads = []
    return {
        plays,
        stopped,
        loads,
        loadSequence(tracks) {
            loads.push(tracks.map((t) => t.soundFilePath))
            this.tracks = tracks
            this.stopAll() // mirrors the real SoundEngine contract
            return Promise.resolve()
        },
        play(trackID) {
            plays.push({ trackID, step: null })
            return { fakeSource: true, trackID }
        },
        stopAll() {
            stopped.push(plays.length)
        },
    }
}

const makeTracks = () => [
    { title: 'Kick', soundFilePath: '/sounds/kick.wav', onNotes: [0, 2] },
    { title: 'Snare', soundFilePath: '/sounds/snare.wav', onNotes: [1] },
    { title: 'Open Hat', soundFilePath: '/sounds/hh_open.wav', onNotes: [] },
    { title: 'Closed Hat', soundFilePath: '/sounds/hh_closed.wav', onNotes: [3] },
]

let harness
let sound
let transport

beforeEach(() => {
    harness = createFrameHarness()
    sound = createFakeSoundEngine()
    transport = new Transport({
        soundEngine: sound,
        now: harness.now,
        requestFrame: harness.requestFrame,
        cancelFrame: harness.cancelFrame,
    })
    transport.loadSequence(makeTracks())
})

test('play from stop starts on step 0, triggers its notes and advances in order', () => {
    transport.play()
    assert.equal(transport.getState().currentStepID, 0)
    assert.deepEqual(
        sound.plays.map((p) => p.trackID),
        [0],
        'only the kick has a note on step 0'
    )

    const step = stepDurationForBPM(120) // 250ms
    harness.advance(step)
    assert.equal(transport.getState().currentStepID, 1)
    assert.deepEqual(sound.plays.at(-1).trackID, 1)

    harness.advance(step)
    assert.equal(transport.getState().currentStepID, 2)
    assert.deepEqual(sound.plays.at(-1).trackID, 0)

    harness.advance(step)
    assert.equal(transport.getState().currentStepID, 3)
    assert.deepEqual(sound.plays.at(-1).trackID, 3)
})

test('every triggered step fires exactly once even with many frames inside it', () => {
    transport.play()
    const playsAtZero = sound.plays.length

    for (let i = 0; i < 10; i++) {
        harness.advance(10) // 100ms total, still inside the 250ms step
    }
    assert.equal(transport.getState().currentStepID, 0)
    assert.equal(sound.plays.length, playsAtZero, 'step 0 is not retriggered')
})

test('BPM change mid-play: settled time keeps old length, no retrigger, no skip, no backwards move', () => {
    const oldStep = stepDurationForBPM(120) // 250ms
    const newStep = stepDurationForBPM(60) // 500ms

    transport.play()
    harness.advance(oldStep) // step 0 -> 1 (snare fires)
    assert.equal(transport.getState().currentStepID, 1)
    const playsAtStep1 = sound.plays.length

    // Halfway through step 1 at the old tempo: 125ms of 250ms.
    harness.advance(oldStep / 2)
    const positionBefore = transport.getState()
    assert.ok(Math.abs(positionBefore.stepElapsedMs - oldStep / 2) < 1e-9)

    transport.setBPM(60)

    const positionAfter = transport.getState()
    assert.equal(positionAfter.currentStepID, 1, 'step index unchanged')
    assert.ok(
        Math.abs(positionAfter.stepElapsedMs - newStep / 2) < 1e-9,
        'elapsed fraction is preserved, mapped onto the new step length'
    )
    assert.equal(sound.plays.length, playsAtStep1, 'current step not retriggered')
    assert.ok(
        positionAfter.progressInStep >= positionBefore.progressInStep - 1e-12,
        'playhead never moves backwards'
    )

    // Remaining half of the step now takes the NEW duration's half (250ms),
    // proving time after the change uses the new step length.
    harness.advance(newStep / 2 - 1)
    assert.equal(transport.getState().currentStepID, 1, 'not crossing early')
    harness.advance(1)
    assert.equal(transport.getState().currentStepID, 2, 'crosses exactly at new length')

    // A full new-length step later we reach step 3 — nothing was skipped.
    harness.advance(newStep)
    assert.equal(transport.getState().currentStepID, 3)
})

test('BPM increase does not skip or repeat steps', () => {
    const oldStep = stepDurationForBPM(120) // 250ms
    const newStep = stepDurationForBPM(240) // 125ms

    transport.play()
    harness.advance(oldStep) // -> step 1
    harness.advance(oldStep * 0.8) // 200ms into step 1 (fraction 0.8)

    transport.setBPM(240)
    const state = transport.getState()
    assert.equal(state.currentStepID, 1)
    assert.ok(Math.abs(state.stepElapsedMs - newStep * 0.8) < 1e-9)

    // 0.2 of the new step remains (25ms) before step 2.
    harness.advance(newStep * 0.2 - 1)
    assert.equal(transport.getState().currentStepID, 1)
    harness.advance(1)
    assert.equal(transport.getState().currentStepID, 2)
    assert.deepEqual(sound.plays.map((p) => p.trackID), [0, 1, 0])
})

test('BPM change while paused keeps the frozen position; resume uses the new step length', () => {
    const oldStep = stepDurationForBPM(120) // 250ms
    transport.play()
    harness.advance(oldStep) // -> step 1
    harness.advance(oldStep * 0.5) // 125ms into step 1
    transport.pause()

    transport.setBPM(60) // new step 500ms
    const state = transport.getState()
    assert.equal(state.currentStepID, 1)
    assert.ok(Math.abs(state.stepElapsedMs - 250) < 1e-9, 'half of the new 500ms step')

    // While paused the clock still cannot move the position.
    harness.advance(5000)
    assert.equal(transport.getState().currentStepID, 1)

    transport.play()
    // 250ms remains (half of the new step length) before reaching step 2.
    harness.advance(249)
    assert.equal(transport.getState().currentStepID, 1)
    harness.advance(1)
    assert.equal(transport.getState().currentStepID, 2)
})

test('consecutive BPM changes never move the playhead backwards', () => {
    const step = stepDurationForBPM(120)
    transport.play()
    harness.advance(step)
    harness.advance(step * 0.3)

    let previousFraction = transport.getState().progressInStep
    for (const bpm of [60, 240, 90, 300, 120]) {
        transport.setBPM(bpm)
        const fraction = transport.getState().progressInStep
        assert.ok(fraction >= previousFraction - 1e-12, `bpm ${bpm} must not reverse`)
        assert.equal(transport.getState().currentStepID, 1)
        previousFraction = fraction
    }
    // Fraction is tempo-invariant: 0.3 of a step is always 0.3 of a step.
    assert.ok(Math.abs(previousFraction - 0.3) < 1e-12)
})

test('sequence switch while playing keeps the playhead continuous and replaces the samples', () => {
    const step = stepDurationForBPM(120)
    transport.play()
    harness.advance(step * 3) // -> step 3
    const stepAtSwitch = transport.getState().currentStepID
    const elapsedAtSwitch = transport.getState().stepElapsedMs

    const nextTracks = [
        { title: 'Kick', soundFilePath: '/sounds/kick.wav', onNotes: [3, 5] },
        { title: 'Snare', soundFilePath: '/sounds/snare.wav', onNotes: [4] },
        { title: 'Open Hat', soundFilePath: '/sounds/hh_open.wav', onNotes: [] },
        { title: 'Closed Hat', soundFilePath: '/sounds/hh_closed.wav', onNotes: [] },
    ]
    const playsBeforeSwitch = sound.plays.length
    transport.loadSequence(nextTracks)

    const state = transport.getState()
    assert.equal(state.currentStepID, stepAtSwitch, 'no restart and no step jump')
    assert.equal(state.stepElapsedMs, elapsedAtSwitch)
    // beforeEach already loaded one sequence; the switch is the second load,
    // reloading every track slot from the new sequence's soundFile paths.
    assert.equal(sound.loads.length, 2, 'samples reloaded for every track slot')
    assert.deepEqual(
        sound.loads[1],
        nextTracks.map((t) => t.soundFilePath),
        'reload uses the new sequence soundFile paths'
    )
    assert.ok(sound.stopped.length >= 1, 'old ringing samples are silenced')
    assert.equal(sound.plays.length, playsBeforeSwitch, 'switch itself triggers no sound')

    // Next boundary plays the NEW sequence's step-4 note (snare), not the old one.
    harness.advance(step)
    assert.equal(transport.getState().currentStepID, 4)
    assert.deepEqual(sound.plays.at(-1).trackID, 1)
})

test('Sequence 4 style empty tracks: steps advance but no hats/snare sound is ever triggered', () => {
    const emptyTracks = [
        { title: 'Kick', soundFilePath: '/sounds/kick.wav', onNotes: [0, 4, 8, 12] },
        { title: 'Snare', soundFilePath: '/sounds/snare.wav', onNotes: [] },
        { title: 'Open Hat', soundFilePath: '/sounds/hh_open.wav', onNotes: [] },
        { title: 'Closed Hat', soundFilePath: '/sounds/hh_closed.wav', onNotes: [] },
    ]
    transport.loadSequence(emptyTracks)
    transport.play()

    const step = stepDurationForBPM(120)
    for (let i = 0; i < TOTAL_STEPS; i++) {
        harness.advance(step)
    }

    // One full loop: kick fires on steps 0,4,8,12, plus step 0 again on
    // wrap-around; the three empty tracks never trigger.
    const triggeredTracks = new Set(sound.plays.map((p) => p.trackID))
    assert.deepEqual([...triggeredTracks], [0])
    assert.equal(sound.plays.length, 5)
    // Wrapped back to step 0.
    assert.equal(transport.getState().currentStepID, 0)
})

test('switching to an empty sequence mid-play silences old-pattern notes for all remaining steps', () => {
    const step = stepDurationForBPM(120)
    transport.play()
    harness.advance(step * 2) // -> step 2, some notes already played

    const allEmpty = [
        { title: 'Kick', soundFilePath: '/sounds/kick.wav', onNotes: [] },
        { title: 'Snare', soundFilePath: '/sounds/snare.wav', onNotes: [] },
        { title: 'Open Hat', soundFilePath: '/sounds/hh_open.wav', onNotes: [] },
        { title: 'Closed Hat', soundFilePath: '/sounds/hh_closed.wav', onNotes: [] },
    ]
    transport.loadSequence(allEmpty)
    const playsAtSwitch = sound.plays.length

    for (let i = 0; i < TOTAL_STEPS * 2; i++) {
        harness.advance(step)
    }
    assert.equal(
        sound.plays.length,
        playsAtSwitch,
        'no note from the empty sequence is ever triggered'
    )
})

test('pause freezes position; resume continues from the same place with no retrigger', () => {
    const step = stepDurationForBPM(120)
    transport.play()
    harness.advance(step) // -> step 1
    harness.advance(step * 0.4) // partway through step 1

    const frozen = transport.getState()
    transport.pause()
    const playsAtPause = sound.plays.length

    assert.equal(transport.getState().currentStepID, frozen.currentStepID)
    assert.equal(transport.getState().stepElapsedMs, frozen.stepElapsedMs)
    assert.equal(transport.getState().isPlaying, false)

    // Time passing while paused has no effect.
    harness.advance(step * 5)
    assert.equal(transport.getState().currentStepID, frozen.currentStepID)
    assert.equal(sound.plays.length, playsAtPause)

    transport.play()
    assert.equal(transport.getState().currentStepID, frozen.currentStepID, 'resume keeps the step')
    assert.equal(sound.plays.length, playsAtPause, 'resume does not retrigger the current step')

    // The remaining 0.6 of the step still needs to elapse before step 2.
    harness.advance(step * 0.6 - 1)
    assert.equal(transport.getState().currentStepID, 1)
    harness.advance(1)
    assert.equal(transport.getState().currentStepID, 2)
})

test('stop rewinds the playhead to null and silences all sound; nothing fires afterwards', () => {
    const step = stepDurationForBPM(120)
    transport.play()
    harness.advance(step * 2)
    assert.equal(transport.getState().currentStepID, 2)
    assert.ok(sound.plays.length > 0)

    transport.stop()
    assert.equal(transport.getState().currentStepID, null)
    assert.equal(transport.getState().stepElapsedMs, 0)
    assert.equal(transport.getState().isPlaying, false)
    assert.ok(sound.stopped.length >= 1, 'stopAll is called so no sample keeps ringing')

    // No frame is scheduled after stop, so advancing the clock does nothing.
    const playsAfterStop = sound.plays.length
    harness.advance(step * 10)
    assert.equal(sound.plays.length, playsAfterStop)

    // Restart begins cleanly on step 0.
    transport.play()
    assert.equal(transport.getState().currentStepID, 0)
})

test('preview plays the requested track without moving the playhead', () => {
    assert.equal(transport.getState().currentStepID, null)
    transport.preview(2)
    assert.deepEqual(sound.plays.at(-1), { trackID: 2, step: null })
    assert.equal(transport.getState().currentStepID, null, 'preview never advances steps')
})

test('updateTracks changes notes without reloading samples', () => {
    const loadsBefore = sound.loads.length
    const edited = makeTracks()
    edited[2].onNotes = [7]
    transport.updateTracks(edited)
    assert.equal(sound.loads.length, loadsBefore, 'no sample reload on note edit')

    transport.play()
    const step = stepDurationForBPM(120)
    for (let i = 0; i < 8; i++) harness.advance(step)
    assert.ok(
        sound.plays.some((p) => p.trackID === 2),
        'edited open-hat note is triggered'
    )
})
