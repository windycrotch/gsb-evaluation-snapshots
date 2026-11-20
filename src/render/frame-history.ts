// The frame lifecycle's single source of truth for whether the data a view remembers from its
// previous on-screen frame may be reused by the next one. Everything that makes a remembered
// frame describe a different image than the one being rendered — another canvas size, another
// render target, another history colour format, another projection type, the start or end of a
// stereo session, or a removed resident node — is reported here, and only this object's two
// trust flags may be tested before any previous-frame data is touched:
//
//   historyValid  — the temporal accumulation's ping-pong colour/info and the previous TAA
//                   matrices describe the previous frame in this frame's layout, so the resolve
//                   may reproject them. When false the resolve starts from this frame's sample.
//   depthValid    — the depth texture and the occlusion grid reduced from it, and the previous
//                   frame's projector matrices, describe the same world at the same size, so the
//                   occlusion cull and a shared stereo projection may reuse them. A removed
//                   resident node invalidates the depth alone: arrivals never do.
//
// The class holds no GPU objects and no engine imports, so the whole lifecycle is unit-testable
// with constructed frame sequences (test/render/frame-history.test.mjs); the renderer feeds it
// the plain facts of each frame and reads the decisions back.

/** Why a view's remembered data was dropped, for tests and diagnostics. */
type InvalidationReason =
    | 'resize'
    | 'target'
    | 'history-format'
    | 'projection'
    | 'warp'
    | 'variant'
    | 'stereo'
    | 'node-removal'
    | 'query'
    | 'reset'
    | 'detach';

/**
 * The facts of the frame about to be rendered that must match the previous frame for any of its
 * samples to be reprojected into this one.
 */
type FrameSignature = {
    /** The framebuffer size the view renders into this frame. */
    width: number;
    height: number;
    /**
     * Identifies the render target: the backbuffer (null) or an offscreen target. A capture frame
     * draws elsewhere, so the on-screen history and depth never describe it.
     */
    targetKey: string | null;
    /** The history colour format: half floats versus 16-bit fixed point. */
    historyHalf: boolean;
    /** Perspective versus orthographic: the two are reprojected with different clip mappings. */
    orthographic: boolean;
    /** Variant warp: the key of the rate/warp table the view renders through, '' for none. */
    warpKey: string;
    /** Whether the frame renders one view per eye of a stereo session. */
    stereo: boolean;
};

/** What the view did this frame, beyond the signature. */
type FrameOutcome = {
    /** The temporal accumulation ran this frame (variant taa on, an on-screen frame at its size). */
    accumulate: boolean;
    /** The view or its projection differed from the previous frame's beyond float noise. */
    moved: boolean;
    /** The resident set changed this frame (a node streamed in, was removed, or a model moved). */
    sceneChanged: boolean;
    /** An offscreen/query frame: never accumulated into and never made a previous frame. */
    query: boolean;
};

const sameSignature = (a: FrameSignature | null, b: FrameSignature) =>
    !!a &&
    a.width === b.width &&
    a.height === b.height &&
    a.targetKey === b.targetKey &&
    a.historyHalf === b.historyHalf &&
    a.orthographic === b.orthographic &&
    a.warpKey === b.warpKey &&
    a.stereo === b.stereo;

/**
 * One view's remembered-frame trust, carried through the whole frame lifecycle. A view owns one
 * for its lifetime; the renderer calls {@link FrameHistory.beginFrame} before any previous-frame
 * texture or matrix is bound and {@link FrameHistory.endFrame} once the frame has drawn.
 */
class FrameHistory {
    /** May the temporal accumulation read its previous colour/info and TAA matrices? */
    historyValid = false;

    /** May the occlusion cull and a shared stereo projection read the previous depth and matrices? */
    depthValid = false;

    /** Frames the view has rested (same view, projection and scene) while accumulating. */
    restFrames = 0;

    /** The signature of the frame the remembered data belongs to, null before the first. */
    private signature: FrameSignature | null = null;

    /** Set by {@link FrameHistory.beginFrame}: this frame's signature, for {@link endFrame}. */
    private current: FrameSignature | null = null;

    /** The last reason the trust was dropped, for diagnostics. */
    lastReason: InvalidationReason | null = null;

    /** How many frames the lifecycle asked for since construction (the renderer keeps requesting them). */
    framesRequested = 0;

    /** Whether {@link beginFrame} needs another frame rendered (a fresh accumulation or an unfilled cap). */
    frameWanted = false;

    /**
     * Drop every trust both flags hold. Used for events with no frame signature of their own:
     * a variant switch, an explicit history reset, or the renderer detaching.
     */
    invalidate(reason: InvalidationReason) {
        this.historyValid = false;
        this.depthValid = false;
        this.restFrames = 0;
        this.lastReason = reason;
    }

    /**
     * A resident node left the set. Its depth may have hidden what is now behind it, so the
     * previous depth can no longer cull; the colour history itself is kept and re-clamped by the
     * resolve. New nodes arriving are not reported here and leave the cull untouched.
     */
    noteNodesRemoved() {
        this.depthValid = false;
        this.lastReason = 'node-removal';
    }

    /**
     * Account for the frame about to render. Invalidates the trust whose layout no longer matches
     * and updates the resting count; returns whether the accumulation's history may be read.
     * Must run before any previous-frame texture or matrix is bound.
     */
    beginFrame(signature: FrameSignature, outcome: FrameOutcome, taaMax: number) {
        this.current = signature;
        this.frameWanted = false;
        const previous = this.signature;

        if (!sameSignature(previous, signature)) {
            // The layout the remembered samples were laid out in no longer holds. A size, target,
            // format, warp or stereo change makes both the colour and the depth unreadable; a
            // projection-type change keeps the texture sizes but changes the clip mapping both are
            // reprojected through, so neither may be reused.
            this.invalidate(this.reasonFor(previous, signature));
        }

        if (outcome.query) {
            // A capture draws into another target: it never reads the on-screen history and, being
            // no one's previous frame, leaves nothing behind for the next one either.
            this.invalidate('query');
            return false;
        }

        if (outcome.accumulate) {
            if (outcome.moved || outcome.sceneChanged) {
                this.restFrames = 0;
            } else {
                this.restFrames++;
            }
            // Keep rendering while a resting camera has not filled its sample cap (plus two frames
            // of margin), and while a fresh accumulation has not had a frame to converge.
            if (this.restFrames < taaMax + 2 || !this.historyValid) {
                this.frameWanted = true;
                this.framesRequested++;
            }
        } else {
            // The accumulation is switched off or cannot run at this size: no history is written,
            // so none may be read on the next frame either.
            this.historyValid = false;
            this.restFrames = 0;
        }
        return this.historyValid;
    }

    /**
     * Record the frame now drawn as the one a later frame may remember. Query frames draw
     * elsewhere and are deliberately not recorded, so the previous on-screen frame's trust stays
     * dropped (beginFrame already did so) until another on-screen frame succeeds them.
     */
    endFrame(outcome: FrameOutcome) {
        if (outcome.query) {
            this.depthValid = false;
            this.historyValid = false;
            return;
        }
        this.signature = this.current;
        // An on-screen frame always leaves its own fresh depth and colour behind. A removal noted
        // on a later frame (noteNodesRemoved) drops depthValid again before that frame's cull runs,
        // so the depth written here is only reused while the world is unchanged.
        this.depthValid = true;
        if (outcome.accumulate) this.historyValid = true;
    }

    /** Whether a resting accumulation has filled its sample cap. */
    converged(taaMax: number) {
        return this.historyValid && this.restFrames >= taaMax;
    }

    private reasonFor(previous: FrameSignature | null, next: FrameSignature): InvalidationReason {
        if (!previous) return 'reset';
        if (previous.width !== next.width || previous.height !== next.height) return 'resize';
        if (previous.targetKey !== next.targetKey) return 'target';
        if (previous.historyHalf !== next.historyHalf) return 'history-format';
        if (previous.orthographic !== next.orthographic) return 'projection';
        if (previous.warpKey !== next.warpKey) return 'warp';
        if (previous.stereo !== next.stereo) return 'stereo';
        return 'reset';
    }
}

export { FrameHistory };
export type { FrameSignature, FrameOutcome, InvalidationReason };
