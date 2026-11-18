/**
 * Pure time-conversion and clamping helpers shared by the timeline track
 * interactions (mouse drag, touch drag, resize handles and keyboard nudges).
 *
 * All pointer interactions convert pixels to seconds through the same
 * `pixelsToSeconds` helper so a subtitle's committed start/end always matches
 * its on-screen position, and every value committed to `onEntryMove` /
 * `onEntryResize` passes through `toFiniteMillis` (finite, 3 decimal places).
 */

export interface TimelineBoundary {
    start: number;
    end: number;
}

/** The timeline tape renders 8rem (at 16px/rem) per interval. */
export const PIXELS_PER_INTERVAL = 8 * 16;

/** Convert a pixel offset on the track to seconds. Shared by mouse and touch. */
export function pixelsToSeconds(pixels: number, interval: number): number {
    return (pixels / PIXELS_PER_INTERVAL) * interval;
}

/** Convert a time in seconds to a pixel offset on the track. */
export function secondsToPixels(seconds: number, interval: number): number {
    return (seconds / interval) * PIXELS_PER_INTERVAL;
}

/** Clamp a time value into the [0, duration] range. */
export function clampTime(time: number, duration: number): number {
    return Math.min(duration, Math.max(0, time));
}

/**
 * Convert a pointer x coordinate (mouse or touch) to a time on the track.
 * The playhead sits at the horizontal center of the (possibly scrolled)
 * container, so positions are measured relative to that center.
 */
export function pointerXToTime(
    x: number,
    rect: { left: number; width: number },
    currentTime: number,
    duration: number,
    interval: number
): number {
    const currentTimestampOffset = rect.width / 2;
    const delta = x - rect.left - currentTimestampOffset;
    return clampTime(currentTime + pixelsToSeconds(delta, interval), duration);
}

/** Round to milliseconds so committed values don't accumulate float error. */
export function roundToMillis(value: number): number {
    return Math.round(value * 1000) / 1000;
}

/**
 * Ensure a value committed to onEntryMove/onEntryResize is a finite number
 * with at most three decimal places.
 */
export function toFiniteMillis(value: number, fallback = 0): number {
    if (!Number.isFinite(value)) return fallback;
    return roundToMillis(value);
}

/**
 * Snap delta for a single position against candidate snap points (entry
 * starts/ends). Returns the delta to the nearest point within `threshold`,
 * or 0 when no snap target is close enough (position stays as-is).
 */
export function computeSnapDelta(points: readonly number[], position: number, threshold: number): number {
    let best = 0;
    let bestDistance = Infinity;
    for (const point of points) {
        const distance = Math.abs(point - position);
        if (distance < threshold && distance < bestDistance) {
            bestDistance = distance;
            best = point - position;
        }
    }
    return best;
}

/**
 * Snap deltas for the start and end of the interacting entry against the
 * start/end of every other entry. `exclude` (the entry being moved or
 * resized) is skipped so an entry never snaps to itself.
 */
export function computeSnapDeltas(
    entries: readonly TimelineBoundary[],
    start: number,
    end: number,
    threshold: number,
    exclude?: TimelineBoundary
): [number, number] {
    const points: number[] = [];
    for (const entry of entries) {
        if (exclude && entry.start === exclude.start && entry.end === exclude.end) continue;
        points.push(entry.start, entry.end);
    }
    return [
        computeSnapDelta(points, start, threshold),
        computeSnapDelta(points, end, threshold),
    ];
}

/** Combine the start/end snap deltas into the single delta applied to a move. */
export function computeMoveSnapDelta(snapDeltaStart: number, snapDeltaEnd: number): number {
    if (snapDeltaStart || snapDeltaEnd)
        return Math.min(snapDeltaStart || Infinity, snapDeltaEnd || Infinity);
    return 0;
}

/** Delta committed when a move (pointer or keyboard) ends, rounded to ms. */
export function computeMoveDelta(anchorTime: number, currentAnchorTime: number, snapDelta = 0): number {
    return toFiniteMillis(currentAnchorTime + snapDelta - anchorTime);
}

/** Clamp a resized start: never below 0 and never past (end - minDuration). */
export function clampResizeStart(start: number, end: number, minDuration: number): number {
    return Math.min(Math.max(0, start), end - minDuration);
}

/** Clamp a resized end: never before (start + minDuration), optionally capped at duration. */
export function clampResizeEnd(end: number, start: number, minDuration: number, duration?: number): number {
    const clamped = Math.max(end, start + minDuration);
    return duration === undefined ? clamped : Math.min(clamped, duration);
}

/**
 * Keyboard move: returns the committed delta (never moving the entry before
 * 0) and the time the playhead should follow to — the entry's new start.
 */
export function computeKeyboardMove(entry: TimelineBoundary, delta: number): { delta: number; playhead: number } {
    const clampedDelta = toFiniteMillis(Math.max(delta, -entry.start));
    return { delta: clampedDelta, playhead: toFiniteMillis(entry.start + clampedDelta) };
}

/**
 * Keyboard resize (Alt+arrow shrinks, Ctrl/Cmd+arrow extends). The result
 * always respects the minimum duration and never crosses the other boundary
 * or goes below 0.
 */
export function computeKeyboardResize(
    entry: TimelineBoundary,
    end: boolean,
    shrink: boolean,
    step: number,
    minDuration: number
): TimelineBoundary {
    if (end) {
        const newEnd = shrink
            ? clampResizeEnd(entry.end - step, entry.start, minDuration)
            : entry.end + step;
        return { start: toFiniteMillis(entry.start), end: toFiniteMillis(newEnd) };
    }
    const newStart = shrink
        ? clampResizeStart(entry.start + step, entry.end, minDuration)
        : clampResizeStart(entry.start - step, entry.end, minDuration);
    return { start: toFiniteMillis(newStart), end: toFiniteMillis(entry.end) };
}

/** Delta committed when Shift+arrow snaps an entry against its neighbour. */
export function computeKeyboardSnapDelta(entry: TimelineBoundary, closestEntry: TimelineBoundary, end: boolean): number {
    return toFiniteMillis(end ? closestEntry.start - entry.end : closestEntry.end - entry.start);
}

/**
 * Move a cue by `delta`, clamping the start at 0. When the start is clamped
 * the end is shifted by the same amount so the duration is preserved and the
 * start never goes negative.
 */
export function computeClampedMove(start: number, end: number, delta: number): TimelineBoundary {
    const duration = end - start;
    const newStart = Math.max(0, toFiniteMillis(start + delta));
    return { start: newStart, end: toFiniteMillis(newStart + duration) };
}
