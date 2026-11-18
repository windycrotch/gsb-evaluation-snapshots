import { describe, expect, it } from "vitest";
import {
    PIXELS_PER_INTERVAL,
    clampResizeEnd,
    clampResizeStart,
    clampTime,
    computeClampedMove,
    computeKeyboardMove,
    computeKeyboardResize,
    computeKeyboardSnapDelta,
    computeMoveDelta,
    computeMoveSnapDelta,
    computeSnapDelta,
    computeSnapDeltas,
    pixelsToSeconds,
    pointerXToTime,
    roundToMillis,
    secondsToPixels,
    toFiniteMillis,
} from "../src/timeline-track-utils";

// Self-made subtitle entries used across the test suites
const entries = [
    { start: 2, end: 4, content: "first" },
    { start: 8, end: 9.5, content: "second" },
    { start: 12, end: 14, content: "third" },
];

const interval = 10; // seconds per timeline interval
const threshold = interval / 20; // snapping threshold & minimum duration

describe("pixel <-> time conversion", () => {
    it("converts pixels to seconds using the shared 8rem-per-interval scale", () => {
        // one full interval (128px at 16px/rem) equals `interval` seconds
        expect(pixelsToSeconds(PIXELS_PER_INTERVAL, interval)).toBe(interval);
        expect(pixelsToSeconds(64, interval)).toBe(5);
        expect(secondsToPixels(5, interval)).toBe(64);
        // round trip
        expect(secondsToPixels(pixelsToSeconds(37, interval), interval)).toBeCloseTo(37);
    });

    it("maps pointer x to time relative to the container center and clamps to [0, duration]", () => {
        const rect = { left: 100, width: 1000 };
        const duration = 60;
        const currentTime = 5;
        // pointer at the horizontal center -> currentTime
        expect(pointerXToTime(100 + 500, rect, currentTime, duration, interval)).toBe(5);
        // 128px right of center -> +interval seconds
        expect(pointerXToTime(100 + 500 + 128, rect, currentTime, duration, interval)).toBe(15);
        // far before the start clamps to 0, far past the end clamps to duration
        expect(pointerXToTime(-10000, rect, currentTime, duration, interval)).toBe(0);
        expect(pointerXToTime(100000, rect, currentTime, duration, interval)).toBe(duration);
    });
});

describe("drag move commit", () => {
    const rect = { left: 0, width: 1000 };
    const duration = 60;
    const currentTime = 5;

    it("commits a delta that matches the pixel-to-time conversion", () => {
        const downX = 500; // container center -> anchorTime = currentTime
        const upX = 500 + 128; // one interval to the right
        const anchorTime = pointerXToTime(downX, rect, currentTime, duration, interval);
        const currentAnchorTime = pointerXToTime(upX, rect, currentTime, duration, interval);
        const delta = computeMoveDelta(anchorTime, currentAnchorTime, 0);
        expect(delta).toBe(pixelsToSeconds(upX - downX, interval));
        expect(delta).toBe(10);
    });

    it("rounds the committed delta to milliseconds to avoid float drift", () => {
        const downX = 500;
        const upX = 500 + 1; // 1px -> 10/128 = 0.078125s
        const anchorTime = pointerXToTime(downX, rect, currentTime, duration, interval);
        const currentAnchorTime = pointerXToTime(upX, rect, currentTime, duration, interval);
        const delta = computeMoveDelta(anchorTime, currentAnchorTime, 0);
        expect(delta).toBe(0.078);
        expect(Number.isFinite(delta)).toBe(true);
    });

    it("applies the snap delta when a snap target is hit", () => {
        // entry { start: 4, end: 6 } is dragged 0.3s right, so its start
        // hovers at 4.3 — 0.3 from the first entry's end (4)
        const selected = { start: 4, end: 6 };
        const anchorTime = 5;
        const currentAnchorTime = 5.3;
        const start = selected.start + (currentAnchorTime - anchorTime); // 4.3
        const end = selected.end + (currentAnchorTime - anchorTime); // 6.3
        const [snapStart, snapEnd] = computeSnapDeltas(entries, start, end, threshold);
        expect(snapStart).toBeCloseTo(4 - 4.3); // snaps to entry end at 4
        expect(snapEnd).toBe(0); // nothing near 6.3
        const snapDelta = computeMoveSnapDelta(snapStart, snapEnd);
        const delta = computeMoveDelta(anchorTime, currentAnchorTime, snapDelta);
        // committed delta moves the entry's start exactly onto the snap target
        expect(selected.start + delta).toBeCloseTo(4);
    });

    it("keeps the raw position when no snap target is within the threshold", () => {
        const [snapStart, snapEnd] = computeSnapDeltas(entries, 5.4, 6.4, threshold);
        expect(snapStart).toBe(0);
        expect(snapEnd).toBe(0);
        const delta = computeMoveDelta(5, 5.4, computeMoveSnapDelta(snapStart, snapEnd));
        expect(delta).toBeCloseTo(0.4);
    });

    it("snaps to the nearest target, not just the first one in range", () => {
        // both 4 (entry end) and 4.4 are within the threshold of 4.35; 4.4 is nearer
        expect(computeSnapDelta([4, 4.4], 4.35, threshold)).toBeCloseTo(0.05);
    });

    it("never snaps an entry to itself while moving", () => {
        const moving = entries[0]!;
        // small move: without exclusion the entry would snap back to its own start
        const [snapStart, snapEnd] = computeSnapDeltas(
            entries,
            moving.start + 0.1,
            moving.end + 0.1,
            threshold,
            moving
        );
        expect(snapStart).toBe(0);
        expect(snapEnd).toBe(0);
    });
});

describe("resize clamping", () => {
    it("does not let the start pass the end minus the minimum duration", () => {
        expect(clampResizeStart(5.9, 6, threshold)).toBeCloseTo(6 - threshold);
        expect(clampResizeStart(3, 6, threshold)).toBe(3);
    });

    it("does not let the end pass the start plus the minimum duration", () => {
        expect(clampResizeEnd(2.1, 2, threshold)).toBeCloseTo(2 + threshold);
        expect(clampResizeEnd(8, 2, threshold)).toBe(8);
    });

    it("clamps the resized start at 0", () => {
        expect(clampResizeStart(-1.5, 6, threshold)).toBe(0);
    });

    it("keeps keyboard resize (Alt/Ctrl+arrows) within the minimum duration", () => {
        const entry = { start: 2, end: 2.6 };
        // shrinking the end by more than the duration allows clamps to start + minDuration
        const shrunk = computeKeyboardResize(entry, true, true, 0.5, threshold);
        expect(shrunk.end).toBeCloseTo(2 + threshold);
        expect(shrunk.end - shrunk.start).toBeCloseTo(threshold);
        // shrinking the start clamps to end - minDuration
        const shrunkStart = computeKeyboardResize({ start: 1.9, end: 2 }, false, true, 0.5, threshold);
        expect(shrunkStart.start).toBeCloseTo(2 - threshold);
        // extending the start never goes below 0
        const extended = computeKeyboardResize({ start: 0.2, end: 3 }, false, false, 0.5, threshold);
        expect(extended.start).toBe(0);
        // extending the end is unconstrained but rounded to ms
        const extendedEnd = computeKeyboardResize({ start: 2, end: 3 }, true, false, 0.078125, threshold);
        expect(extendedEnd.end).toBe(3.078);
    });
});

describe("keyboard move", () => {
    it("moves the entry and reports the playhead at the new start", () => {
        const entry = { start: 3.4567, end: 5 };
        const { delta, playhead } = computeKeyboardMove(entry, 0.078125);
        expect(delta).toBe(0.078);
        expect(playhead).toBe(roundToMillis(entry.start + 0.078));
        expect(playhead).toBe(3.535);
    });

    it("clamps the move so the entry never starts before 0", () => {
        const entry = { start: 0.1, end: 1 };
        const { delta, playhead } = computeKeyboardMove(entry, -0.5);
        expect(delta).toBeCloseTo(-0.1);
        expect(entry.start + delta).toBe(0);
        expect(playhead).toBe(0);
    });

    it("snaps to the adjacent entry with Shift+arrow", () => {
        const entry = entries[0]!; // { start: 2, end: 4 }
        const next = entries[1]!; // { start: 8, end: 9.5 }
        // snap right: entry end lands on the next entry's start
        expect(computeKeyboardSnapDelta(entry, next, true)).toBeCloseTo(8 - 4);
        // snap left onto the previous entry's end
        const prev = { start: 0, end: 1.5 };
        expect(computeKeyboardSnapDelta(entry, prev, false)).toBeCloseTo(1.5 - 2);
    });
});

describe("subtitle cue clamping (TimelineSubtitlesTrack)", () => {
    it("clamps the start at 0 and shifts the end to preserve duration", () => {
        const moved = computeClampedMove(0.5, 2, -1);
        expect(moved.start).toBe(0);
        expect(moved.end).toBe(1.5); // duration (1.5) preserved
        expect(moved.end - moved.start).toBeCloseTo(1.5);
    });

    it("moves freely when the start stays non-negative", () => {
        const moved = computeClampedMove(1, 2.5, 0.4);
        expect(moved.start).toBeCloseTo(1.4);
        expect(moved.end).toBeCloseTo(2.9);
    });

    it("never produces a negative start even for huge negative deltas", () => {
        const moved = computeClampedMove(3, 4, -1000);
        expect(moved.start).toBe(0);
        expect(moved.end).toBe(1);
    });
});

describe("committed value hygiene", () => {
    it("rounds to three decimal places", () => {
        expect(toFiniteMillis(1.23456)).toBe(1.235);
        expect(toFiniteMillis(0.078125)).toBe(0.078);
    });

    it("replaces non-finite values with the fallback", () => {
        expect(toFiniteMillis(NaN)).toBe(0);
        expect(toFiniteMillis(Infinity)).toBe(0);
        expect(toFiniteMillis(-Infinity, 1.5)).toBe(1.5);
    });

    it("clampTime keeps times inside [0, duration]", () => {
        expect(clampTime(-3, 60)).toBe(0);
        expect(clampTime(90, 60)).toBe(60);
        expect(clampTime(30, 60)).toBe(30);
    });
});
