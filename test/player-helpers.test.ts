import { describe, expect, it, vi } from 'vitest';
import {
  getProgressMetrics,
  getProgressPercentFromClientX,
  getProgressXFromPercent,
  ProgressClock,
} from '../src/player/progress';
import { MediaLoadSession } from '../src/player/media';

const rect = (width: number, left = 0) =>
  ({ width, left, right: left + width, top: 0, bottom: 4, x: left, y: 0, height: 4, toJSON: () => ({}) }) as DOMRect;

describe('progress geometry helpers', () => {
  it('clamps client-x derived percents to the [0, 1] track range', () => {
    const metrics = getProgressMetrics(rect(104));
    expect(metrics.innerWidth).toBe(100);
    expect(getProgressPercentFromClientX(-50, rect(104))).toBe(0);
    expect(getProgressPercentFromClientX(500, rect(104))).toBe(1);
    expect(getProgressPercentFromClientX(52, rect(104))).toBeCloseTo(0.5);
  });

  it('maps percents back to x positions round-trip', () => {
    const track = rect(104);
    const x = getProgressXFromPercent(0.5, track);
    expect(getProgressPercentFromClientX(x, track)).toBeCloseTo(0.5);
  });
});

describe('ProgressClock', () => {
  const baseInput = {
    currentTime: 0,
    duration: 10,
    loop: false,
    advancing: true,
    buffering: false,
    initialSettled: true,
  };

  it('estimates advancing time from the wall clock while playback advances', () => {
    let now = 1000;
    const clock = new ProgressClock(() => now);
    clock.anchor(2);
    now = 3500;
    expect(clock.getVisualTime({ ...baseInput, currentTime: 2.01 })).toBeCloseTo(4.5);
  });

  it('locks to the scrub target and ignores wall-clock drift while a seek is pending', () => {
    let now = 1000;
    const clock = new ProgressClock(() => now);
    const input = { ...baseInput, duration: 20 };
    clock.anchor(1);
    clock.lockSeek(7);
    now = 5000;
    // Even while "advancing", a pending seek wins over every other signal.
    expect(clock.getVisualTime({ ...input, currentTime: 1 })).toBe(7);
    // Unlocking without an argument keeps the anchor recorded at lock time;
    // callers that want a fresh anchor pass it explicitly (element cancel).
    clock.unlockSeek();
    expect(clock.anchoredAt).toBe(1000);
    clock.anchor(7);
    // The new estimate starts from 7 (target), not from media currentTime 1.
    now = 6000;
    expect(clock.getVisualTime({ ...input, currentTime: 1 })).toBeCloseTo(8);
  });

  it('unlockSeek can anchor to an explicit catch-up time without jumping back', () => {
    const clock = new ProgressClock(() => 1000);
    clock.lockSeek(8);
    clock.unlockSeek(8.02);
    expect(clock.getVisualTime({ ...baseInput, currentTime: 8.02 })).toBeCloseTo(8.02);
  });

  it('freezes time while paused and resumes without going backwards', () => {
    let now = 1000;
    const clock = new ProgressClock(() => now);
    clock.anchor(4);
    clock.markRendered(4.2);
    clock.freeze(4.2, 0.42);
    now = 4000;
    expect(clock.isFrozen).toBe(true);
    expect(clock.getVisualTime({ ...baseInput, advancing: false, currentTime: 4.2 })).toBe(4.2);

    // Media clock still lags (4.05) when the play event arrives: resume must
    // anchor at the frozen 4.2, not jump the playhead backwards.
    clock.resume(4.05);
    expect(clock.isFrozen).toBe(false);
    expect(clock.getVisualTime({ ...baseInput, currentTime: 4.05 })).toBeCloseTo(4.2);

    // A media clock that has already moved ahead is allowed to win.
    clock.freeze(5, 0.5);
    clock.resume(5.4);
    expect(clock.getVisualTime({ ...baseInput, currentTime: 5.4 })).toBeCloseTo(5.4);
  });

  it('holds the last rendered position across a reload regardless of advancing state', () => {
    const clock = new ProgressClock(() => 1000);
    clock.markRendered(6.5);
    clock.holdForReload(clock.lastRenderedTime);
    expect(clock.getVisualTime({ ...baseInput, advancing: false, currentTime: 0 })).toBe(6.5);
    // Even if the replacement hydrate briefly reports advancing, the hold
    // still wins so the playhead cannot drift or reset during the reload.
    expect(clock.getVisualTime({ ...baseInput, advancing: true, currentTime: 0 })).toBe(6.5);
    clock.releaseHold();
    expect(clock.getVisualTime({ ...baseInput, advancing: false, currentTime: 0 })).toBe(0);
  });

  it('holds at the anchor instead of inventing progress while buffering after settle', () => {
    let now = 1000;
    const clock = new ProgressClock(() => now);
    clock.anchor(3);
    now = 4000;
    // Buffering freezes estimate growth at the anchor (no phantom progress);
    // the lagging media clock cannot re-anchor the playhead backwards.
    expect(clock.getVisualTime({ ...baseInput, buffering: true, currentTime: 2.4 })).toBe(3);
  });

  it('keeps estimating from the anchor instead of snapping to a lagging media clock', () => {
    let now = 1000;
    const clock = new ProgressClock(() => now);
    clock.anchor(4);
    now = 1300;
    // The media clock still reports the pre-resume value while the estimate
    // has advanced from its anchor: the playhead must follow the estimate.
    expect(clock.getVisualTime({ ...baseInput, currentTime: 3.7 })).toBeCloseTo(4.3);
  });

  it('returns the media clock directly before the initial settle completes', () => {
    const clock = new ProgressClock(() => 1000);
    clock.anchor(0);
    expect(clock.getVisualTime({ ...baseInput, initialSettled: false, currentTime: 1.2 })).toBe(1.2);
  });

  it('reset returns every latch to the initial source state', () => {
    const clock = new ProgressClock(() => 1000);
    clock.anchor(9);
    clock.markRendered(9);
    clock.freeze(9, 0.9);
    clock.lockSeek(9);
    clock.holdForReload(9);
    clock.reset();
    expect(clock.isFrozen).toBe(false);
    expect(clock.hasPendingSeek).toBe(false);
    expect(clock.heldTime).toBeNull();
    expect(clock.lastRenderedTime).toBe(0);
    expect(clock.isAwaitingSource).toBe(true);
    // Even with a stale leftover media clock, the new source reports zero.
    expect(clock.getVisualTime({ ...baseInput, currentTime: 9, duration: 10 })).toBe(0);
    clock.endAwaitingSource();
    expect(clock.getVisualTime({ ...baseInput, currentTime: 0 })).toBe(0);
  });

  it('reports zero while awaiting a new source until metadata arrives', () => {
    const clock = new ProgressClock(() => 1000);
    clock.endAwaitingSource();
    clock.anchor(8);
    clock.beginAwaitingSource();
    expect(clock.getVisualTime({ ...baseInput, currentTime: 8, duration: 10 })).toBe(0);
    clock.endAwaitingSource();
    // Before the initial settle the clock follows the media clock directly.
    expect(clock.getVisualTime({ ...baseInput, initialSettled: false, currentTime: 2 })).toBe(2);
  });
});

describe('MediaLoadSession', () => {
  it('caps retries at the configured attempt limit and records terminal failure', () => {
    const session = new MediaLoadSession(3);
    // beginSource resets counters without counting an attempt; the first
    // concrete hydration counts via beginAttempt.
    expect(session.beginSource()).toBe(1);
    expect(session.attempts).toBe(0);
    session.beginAttempt();
    expect(session.attempts).toBe(1);
    expect(session.canRetry()).toBe(true);

    // Two retries bring the total to the cap of 3 attempts.
    session.beginAttempt();
    session.beginAttempt();
    expect(session.attempts).toBe(3);
    expect(session.canRetry()).toBe(false);

    session.markFailed();
    expect(session.hasFailed).toBe(true);
    expect(session.canRetry()).toBe(false);
  });

  it('beginSource resets attempts and failure state for a new source', () => {
    const session = new MediaLoadSession(3);
    session.beginSource();
    session.beginAttempt();
    session.beginAttempt();
    session.markFailed();
    const nextEpoch = session.beginSource();
    expect(session.attempts).toBe(0);
    expect(session.hasFailed).toBe(false);
    expect(session.canRetry()).toBe(true);
    expect(session.isCurrent(nextEpoch)).toBe(true);
  });

  it('epoch tokens invalidate stale callbacks after later attempts', () => {
    const session = new MediaLoadSession(3);
    const firstEpoch = session.beginSource();
    const secondEpoch = session.beginAttempt();
    expect(session.isCurrent(firstEpoch)).toBe(false);
    expect(session.isCurrent(secondEpoch)).toBe(true);
  });
});
