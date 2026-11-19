/**
 * A split-frame (`dispatchGuides` → `dispatchUpscale`) lifecycle rule was
 * violated. Thrown instead of silently encoding a half-frame with a
 * rewritten constants buffer, which would reset or mis-accumulate history.
 *
 * The throw is contract-side: it happens before any constants upload or
 * pass encoding, so frame counters, history indices and `guidesPending`
 * are exactly as they were before the call — the caller can finish the
 * in-flight frame correctly (or reconfigure) and retry.
 */
export class SplitFrameError extends Error {
    /** Stable diagnostic code for consumers that cannot use instanceof across bundles. */
    readonly code = 'UPSCALER_SPLIT_FRAME';

    /**
     * Which lifecycle rule was violated:
     * - `guides-already-pending` — `dispatchGuides` ran twice in one frame
     * - `upscale-without-guides` — `dispatchUpscale` ran without a preceding `dispatchGuides`
     * - `dispatch-while-pending` — the monolithic `dispatch` interrupted a split frame
     * - `camera-mismatch` — the two stages received different camera facts
     * - `reset-mismatch` — the two stages disagree on the frame's reset flag
     */
    constructor(
        readonly reason:
            | 'guides-already-pending'
            | 'upscale-without-guides'
            | 'dispatch-while-pending'
            | 'camera-mismatch'
            | 'reset-mismatch',
        detail: string,
    ) {
        super('@pmndrs/upscaler: ' + detail);
        this.name = 'SplitFrameError';
    }
}
