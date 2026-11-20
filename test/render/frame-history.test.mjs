import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// The frame-lifecycle trust state, with no GPU behind it: constructed renderer state and frame
// sequences stand in for a real device (the acceptance plan needs no headset). These pin the
// contract the stochastic renderer drives: only FrameHistory's flags decide whether previous-frame
// colour, depth or matrices may be reused.
import { FrameHistory } from '../../src/render/frame-history.ts';

// A small cap keeps the convergence sequences short while exercising the cap logic.
const TAA_MAX = 8;

const signature = (overrides = {}) => ({
    width: 640,
    height: 360,
    targetKey: null,
    historyHalf: false,
    orthographic: false,
    warpKey: '',
    stereo: false,
    ...overrides
});

const outcome = (overrides = {}) => ({
    accumulate: true,
    moved: false,
    sceneChanged: false,
    query: false,
    ...overrides
});

// Run one whole frame: beginFrame draws on the trust it returns, endFrame records what it drew.
const step = (history, sig = signature(), out = outcome(), max = TAA_MAX) => {
    const historyValid = history.beginFrame(sig, out, max);
    history.endFrame(out);
    return historyValid;
};

// Rest the camera for `frames` on-screen accumulating frames and return the histories.
const rest = (history, frames, sig = signature(), max = TAA_MAX) => {
    const reads = [];
    for (let i = 0; i < frames; i++) reads.push(step(history, sig, outcome(), max));
    return reads;
};

describe('FrameHistory: normal resting convergence', () => {
    it('starts trusting nothing, then accumulates from the current frame only', () => {
        const h = new FrameHistory();
        assert.equal(h.historyValid, false);
        assert.equal(h.depthValid, false);
        // the first frame must not read any previous sample
        const read = h.beginFrame(signature(), outcome(), TAA_MAX);
        assert.equal(read, false);
        h.endFrame(outcome());
        assert.equal(h.historyValid, true);
        assert.equal(h.depthValid, true);
        assert.equal(h.restFrames, 1);
    });

    it('reuses the history on every later resting frame and converges within the cap', () => {
        const h = new FrameHistory();
        step(h);
        const reads = rest(h, TAA_MAX + 2);
        assert.ok(reads.every(Boolean), 'every frame after the first reads its history');
        assert.equal(h.restFrames, TAA_MAX + 3);
        assert.equal(h.converged(TAA_MAX), true);
    });

    it('keeps requesting frames until the accumulation fills its cap, then stops asking', () => {
        const h = new FrameHistory();
        const wanted = [];
        for (let i = 0; i < TAA_MAX + 4; i++) {
            h.beginFrame(signature(), outcome(), TAA_MAX);
            wanted.push(h.frameWanted);
            h.endFrame(outcome());
        }
        // restFrames runs 1..cap+2: frames with restFrames below cap+2 (the first cap+1 of
        // them) request, then a settled camera goes quiet
        const lastWanted = TAA_MAX;
        assert.ok(wanted.slice(0, lastWanted + 1).every(Boolean));
        assert.ok(wanted.slice(lastWanted + 1).every((v) => !v));
    });

    it('a moving camera resets the rest count and the recovery restarts the count', () => {
        const h = new FrameHistory();
        rest(h, 4);
        assert.equal(h.restFrames, 4);
        h.beginFrame(signature(), outcome({ moved: true }), TAA_MAX);
        assert.equal(h.restFrames, 0);
        h.endFrame(outcome({ moved: true }));
        rest(h, 2);
        assert.equal(h.restFrames, 2);
        assert.equal(h.converged(TAA_MAX), false);
        rest(h, TAA_MAX);
        assert.equal(h.converged(TAA_MAX), true);
    });
});

describe('FrameHistory: size, target, format and projection changes', () => {
    const changes = [
        ['a canvas resize', { width: 800, height: 450 }, 'resize'],
        ['a render target change', { targetKey: 'capture-rt' }, 'target'],
        ['a history colour format change', { historyHalf: true }, 'history-format'],
        ['a projection type change', { orthographic: true }, 'projection'],
        ['a warp layout change', { warpKey: 'm2:640x360' }, 'warp']
    ];
    for (const [label, override, reason] of changes) {
        it(`invalidates both colour and depth on ${label} and reconverges`, () => {
            const h = new FrameHistory();
            rest(h, TAA_MAX);
            assert.equal(h.converged(TAA_MAX), true);

            const read = h.beginFrame(signature(override), outcome(), TAA_MAX);
            assert.equal(read, false, 'the changed frame must not reproject old samples');
            assert.equal(h.historyValid, false);
            assert.equal(h.depthValid, false);
            assert.equal(h.lastReason, reason);
            // the changed frame still renders and requests the next one to rebuild
            assert.equal(h.frameWanted, true);
            h.endFrame(outcome());

            // recovery: finite resting frames at the new layout converge again
            const next = h.beginFrame(signature(override), outcome(), TAA_MAX);
            assert.equal(next, true, 'the frame after a change reads only the new layout');
            h.endFrame(outcome());
            rest(h, TAA_MAX, signature(override));
            assert.equal(h.converged(TAA_MAX), true);
            assert.equal(h.depthValid, true);
        });
    }

    it('never reprojects old-size samples: the trust is down exactly on the changed frame', () => {
        const h = new FrameHistory();
        rest(h, 3);
        const reads = [];
        reads.push(h.beginFrame(signature({ width: 1024, height: 768 }), outcome(), TAA_MAX));
        h.endFrame(outcome());
        for (let i = 0; i < 3; i++) reads.push(step(h, signature({ width: 1024, height: 768 })));
        assert.deepEqual(reads, [false, true, true, true]);
    });
});

describe('FrameHistory: query (capture) frames', () => {
    it('drops the on-screen trust for a capture and restores it on the next on-screen frame', () => {
        const h = new FrameHistory();
        rest(h, 4);
        // capture into another target at another size
        h.beginFrame(signature({ width: 100, height: 100, targetKey: 'pick' }), outcome({ query: true }), TAA_MAX);
        assert.equal(h.historyValid, false);
        assert.equal(h.depthValid, false);
        h.endFrame(outcome({ query: true }));
        assert.equal(h.depthValid, false, 'a query frame never becomes the previous frame');
        // back on screen: rebuilds from its own sample, then converges again
        assert.equal(step(h), false);
        rest(h, TAA_MAX);
        assert.equal(h.converged(TAA_MAX), true);
    });
});

describe('FrameHistory: resident node removal and arrival', () => {
    it('removal disables depth reuse for the cull but keeps the colour history', () => {
        const h = new FrameHistory();
        rest(h, 4);
        h.noteNodesRemoved();
        assert.equal(h.depthValid, false);
        assert.equal(h.historyValid, true, 'the TAA colour history is not discarded on a removal');
        assert.equal(h.lastReason, 'node-removal');
        // the frame is still drawn (its own fresh depth), and the next frame may cull again
        h.beginFrame(signature(), outcome({ sceneChanged: true }), TAA_MAX);
        h.endFrame(outcome({ sceneChanged: true }));
        assert.equal(h.depthValid, true, 'culling comes back once a frame has rebuilt the depth');
        assert.equal(h.historyValid, true);
    });

    it('new nodes arriving leave both trusts and the cull untouched', () => {
        const h = new FrameHistory();
        rest(h, 4);
        h.beginFrame(signature(), outcome({ sceneChanged: true }), TAA_MAX);
        assert.equal(h.depthValid, true, 'arrivals must not switch the occlusion cull off');
        assert.equal(h.historyValid, true);
        h.endFrame(outcome({ sceneChanged: true }));
        assert.equal(h.depthValid, true);
    });

    it('a removal followed by an arrival still culls once the depth is rebuilt', () => {
        const h = new FrameHistory();
        rest(h, 4);
        h.noteNodesRemoved();
        h.beginFrame(signature(), outcome({ sceneChanged: true }), TAA_MAX);
        h.endFrame(outcome({ sceneChanged: true }));
        // another streaming change, arrivals only
        h.beginFrame(signature(), outcome({ sceneChanged: true }), TAA_MAX);
        assert.equal(h.depthValid, true);
        h.endFrame(outcome({ sceneChanged: true }));
    });
});

describe('FrameHistory: stereo session start and end', () => {
    // each eye owns its own history, as the renderer gives each SplatView one
    const eyes = () => [new FrameHistory(), new FrameHistory()];

    it('starting a session invalidates the flat view, and each eye then keeps its own trust', () => {
        const [left, right] = eyes();
        // flat session first
        rest(left, TAA_MAX);
        assert.equal(left.converged(TAA_MAX), true);

        // the session starts: the flat view's remembered frame cannot serve either eye
        const stereoSig = signature({ stereo: true });
        assert.equal(left.beginFrame(stereoSig, outcome(), TAA_MAX), false);
        assert.equal(left.lastReason, 'stereo');
        left.endFrame(outcome());
        // a brand-new eye has no history of its own
        assert.equal(right.beginFrame(stereoSig, outcome(), TAA_MAX), false);
        right.endFrame(outcome());

        // the eyes converge independently; resetting one never touches the other
        rest(left, TAA_MAX, stereoSig);
        rest(right, 2, stereoSig);
        assert.equal(left.converged(TAA_MAX), true);
        assert.equal(right.converged(TAA_MAX), false);
        right.noteNodesRemoved();
        assert.equal(left.depthValid, true, 'an eye invalidation cannot reach the other eye');
    });

    it('ending a session invalidates the eyes before the flat view reuses anything', () => {
        const [left] = eyes();
        const stereoSig = signature({ stereo: true });
        step(left, stereoSig);
        rest(left, TAA_MAX, stereoSig);
        assert.equal(left.converged(TAA_MAX), true);
        // back to one flat view: an eye's previous matrices must never be reused
        assert.equal(left.beginFrame(signature(), outcome(), TAA_MAX), false);
        assert.equal(left.lastReason, 'stereo');
        assert.equal(left.depthValid, false);
        left.endFrame(outcome());
        rest(left, TAA_MAX);
        assert.equal(left.converged(TAA_MAX), true);
    });

    it('two eyes never share a trust flag (no eye uses the other eye’s previous frame)', () => {
        const [left, right] = eyes();
        const stereoSig = signature({ stereo: true });
        step(left, stereoSig);
        step(right, stereoSig);
        // eye 0 resizes its target; eye 1's state is independent
        left.beginFrame(signature({ stereo: true, width: 900, height: 900 }), outcome(), TAA_MAX);
        assert.equal(left.historyValid, false);
        assert.equal(right.historyValid, true);
        assert.equal(right.depthValid, true);
    });
});

describe('FrameHistory: recovery and the no-shortcut contract', () => {
    it('re-converges in a finite number of frames after any invalidation', () => {
        const h = new FrameHistory();
        rest(h, TAA_MAX);
        h.invalidate('variant');
        assert.equal(h.historyValid, false);
        assert.equal(h.depthValid, false);
        let frames = 0;
        while (!h.converged(TAA_MAX) && frames < 100) {
            step(h);
            frames++;
        }
        assert.ok(frames <= TAA_MAX + 1);
        assert.equal(h.converged(TAA_MAX), true);
        // and it asked for every one of those frames
        assert.ok(h.framesRequested >= frames);
    });

    it('does not permanently disable accumulation: trust and requests recover, not stay off', () => {
        const h = new FrameHistory();
        rest(h, 4);
        h.invalidate('reset');
        // the anti-shortcut rule: the recovery keeps accumulating rather than leaving TAA off
        const read = h.beginFrame(signature(), outcome({ accumulate: true }), TAA_MAX);
        assert.equal(read, false);
        h.endFrame(outcome());
        assert.equal(h.beginFrame(signature(), outcome({ accumulate: true }), TAA_MAX), true);
    });

    it('does not permanently disable culling: depth trust recovers after every invalidation', () => {
        const h = new FrameHistory();
        const knockDown = () => {
            h.noteNodesRemoved();
            assert.equal(h.depthValid, false);
            step(h);
            assert.equal(h.depthValid, true, 'the cull must be available again, not switched off for good');
        };
        rest(h, 2);
        knockDown();
        knockDown();
        // a resize likewise
        h.beginFrame(signature({ width: 320, height: 240 }), outcome(), TAA_MAX);
        assert.equal(h.depthValid, false);
        h.endFrame(outcome());
        assert.equal(h.depthValid, true);
    });

    it('an accumulation that is switched off writes nothing and forces a fresh start', () => {
        const h = new FrameHistory();
        rest(h, 4);
        h.beginFrame(signature(), outcome({ accumulate: false }), TAA_MAX);
        assert.equal(h.historyValid, false);
        h.endFrame(outcome({ accumulate: false }));
        assert.equal(h.historyValid, false, 'no history was written while TAA was off');
        assert.equal(step(h), false, 'the next accumulating frame starts over');
    });
});

// A driver that performs the same per-view calls the renderer's frame()/frameView do, so the
// acceptance scenarios run as frame sequences against the real state machine without a GPU.
class RendererDriver {
    constructor(max = TAA_MAX) {
        this.max = max;
        this.views = [new FrameHistory()];
        this.stereo = false;
        this.size = { width: 640, height: 360 };
        this.half = false;
        this.orthographic = false;
        this.warpKey = '';
        this.requests = 0;
    }

    // one frame for every current view; mirrors beginFrame/endFrame and the frameWanted request.
    // Returns each view's beginFrame decision: whether that frame read any previous sample.
    frame({ moved = false, sceneChanged = false, query = false, accumulate = true } = {}) {
        const out = outcome({ moved, sceneChanged, query, accumulate });
        const reads = [];
        for (const view of this.views) {
            reads.push(
                view.beginFrame(
                    signature({
                        ...this.size,
                        historyHalf: this.half,
                        orthographic: this.orthographic,
                        warpKey: this.warpKey,
                        stereo: this.stereo
                    }),
                    out,
                    this.max
                )
            );
            if (view.frameWanted) this.requests++;
            view.endFrame(out);
        }
        return reads;
    }

    setStereo(on) {
        if (this.stereo === on) return;
        this.stereo = on;
        // the renderer invalidates every surviving view, then grows/shrinks the eye list
        for (const view of this.views) view.invalidate('stereo');
        this.views = on ? [this.views[0], new FrameHistory()] : [this.views[0]];
    }

    resize(width, height) {
        this.size = { width, height };
    }

    removeNode() {
        for (const view of this.views) view.noteNodesRemoved();
    }

    trust(index = 0) {
        const h = this.views[index];
        return { historyValid: h.historyValid, depthValid: h.depthValid, restFrames: h.restFrames };
    }
}

describe('FrameHistory: renderer frame-sequence acceptance', () => {
    it('rest -> resize -> reconverge with no old-size sample read and continuous frame requests', () => {
        const r = new RendererDriver();
        for (let i = 0; i < TAA_MAX + 2; i++) r.frame();
        assert.equal(r.trust().historyValid, true);
        assert.equal(r.trust().depthValid, true);

        r.resize(1024, 768);
        const reads = r.frame();
        assert.deepEqual(reads, [false], 'the resized frame starts from its own sample');
        // the frame rebuilt the depth for the next one; the guarantee is that it read no old data
        assert.equal(r.trust().depthValid, true);
        // recovery asks for frames until the cap fills again
        const before = r.requests;
        for (let i = 0; i < TAA_MAX + 2; i++) r.frame();
        assert.ok(r.requests > before);
        assert.equal(r.trust().historyValid, true);
        assert.equal(r.trust().depthValid, true);
    });

    it('node removal turns the cull off for one frame, arrivals keep it on, then it returns', () => {
        const r = new RendererDriver();
        for (let i = 0; i < 3; i++) r.frame();
        r.removeNode();
        assert.equal(r.trust().depthValid, false, 'removal forbids the previous-frame depth');
        assert.equal(r.trust().historyValid, true, 'the colour history is kept through a removal');
        // the changed frame rebuilds the depth; arrivals alone never knock it down again
        r.frame({ sceneChanged: true });
        assert.equal(r.trust().depthValid, true);
        const depthAfterArrival = r.trust().depthValid;
        r.frame({ sceneChanged: true });
        assert.equal(r.trust().depthValid, depthAfterArrival);
    });

    it('a stereo session rebuilds each eye independently and ends without cross-eye reuse', () => {
        const r = new RendererDriver();
        for (let i = 0; i < TAA_MAX; i++) r.frame();

        r.setStereo(true);
        assert.equal(r.views.length, 2);
        const firstEyeReads = r.frame();
        assert.deepEqual(firstEyeReads, [false, false], 'neither eye may read the flat history');
        // the first stereo frame rebuilt each eye's depth for the next one
        assert.equal(r.trust(0).depthValid, true);
        for (let i = 0; i < TAA_MAX - 1; i++) r.frame();
        assert.equal(r.trust(0).restFrames, TAA_MAX);
        assert.equal(r.trust(1).restFrames, TAA_MAX);
        // each eye is its own state: disturbing eye 0 leaves eye 1 converged
        r.removeNode();
        assert.equal(r.trust(0).depthValid, false);
        assert.equal(r.trust(1).depthValid, false, 'a world removal applies to every eye');

        r.setStereo(false);
        assert.equal(r.views.length, 1);
        const flatReads = r.frame();
        assert.deepEqual(flatReads, [false], 'the flat view must not reuse an eye matrix');
        for (let i = 0; i < TAA_MAX; i++) r.frame();
        assert.equal(r.trust().historyValid, true);
        assert.equal(r.trust().depthValid, true);
    });

    it('a history format switch is never read as the old format, then accumulates the new one', () => {
        const r = new RendererDriver();
        for (let i = 0; i < 4; i++) r.frame();
        // the renderer destroys the old textures and marks the format change before the frame
        r.views[0].invalidate('history-format');
        r.half = true;
        const reads = r.frame();
        assert.deepEqual(reads, [false], 'the new-format frame never reads the old textures');
        for (let i = 0; i < TAA_MAX; i++) r.frame();
        assert.equal(r.trust().historyValid, true);
    });

    it('the anti-shortcut contract: neither TAA nor culling stays disabled', () => {
        const r = new RendererDriver();
        for (let i = 0; i < 4; i++) r.frame();
        // every disturbance the lifecycle knows
        r.resize(800, 450);
        r.frame();
        r.removeNode();
        r.frame({ sceneChanged: true });
        r.orthographic = true;
        r.frame();
        // after settling, both trusts are live again rather than switched off permanently
        for (let i = 0; i < TAA_MAX + 2; i++) r.frame();
        const t = r.trust();
        assert.equal(t.historyValid, true, 'TAA is accumulating, not permanently off');
        assert.equal(t.depthValid, true, 'culling is available, not permanently disabled');
        assert.ok(r.requests > 0, 'the renderer kept requesting frames through the recovery');
    });
});
