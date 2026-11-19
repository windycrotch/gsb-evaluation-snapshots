import type { ProgressMetrics } from './types';

export function getProgressMetrics(rect: DOMRect): ProgressMetrics {
  const sideInset = Math.min(2, Math.max(0, rect.width / 2));
  const innerWidth = Math.max(1, rect.width - (sideInset * 2));

  return { rect, sideInset, innerWidth };
}

export function getProgressXFromPercent(percent: number, rect: DOMRect): number {
  const { sideInset, innerWidth } = getProgressMetrics(rect);
  const clampedPercent = Math.min(1, Math.max(0, percent));

  return sideInset + (clampedPercent * innerWidth);
}

export function getProgressPercentFromClientX(clientX: number, rect: DOMRect): number {
  const { sideInset, innerWidth } = getProgressMetrics(rect);

  return Math.min(1, Math.max(0, (clientX - rect.left - sideInset) / innerWidth));
}

export type VisualTimeInput = {
  currentTime: number;
  duration: number;
  loop: boolean;
  advancing: boolean;
  buffering: boolean;
  initialSettled: boolean;
};

/**
 * Single owner of the "where is the playhead right now" decision.
 *
 * The media element's `currentTime` is not trustworthy on its own: it lags
 * while buffering, keeps moving during a scrub drag, and can sit behind the
 * last rendered frame when playback resumes. This clock keeps the visual
 * playhead (progress fill + time text) coherent across source switches,
 * scrub commits, pause/resume and load retries.
 */
export class ProgressClock {
  #now: () => number;
  #anchorTime = 0;
  #anchorAt = 0;
  #frozenTime: number | null = null;
  #frozenPercent: number | null = null;
  #pendingSeekTime: number | null = null;
  #heldTime: number | null = null;
  #lastRenderedTime = 0;
  #awaitingSource: boolean;

  constructor(now: () => number = () => performance.now(), startAwaitingSource = false) {
    this.#now = now;
    this.#awaitingSource = startAwaitingSource;
  }

  /** Anchor the wall-clock based estimate to a known media time. */
  anchor(time: number): void {
    this.#anchorTime = Number.isFinite(time) ? Math.max(0, time) : 0;
    this.#anchorAt = this.#now();
  }

  /**
   * Anchor only when the media time has reached the current anchor. Media
   * timeupdate events can report stale, lagging positions (notably right
   * after resume or while seeking), and re-anchoring there would move the
   * playhead backwards. Forward movement refreshes the anchor normally.
   */
  anchorIfAdvanced(time: number): void {
    const safeTime = Number.isFinite(time) ? Math.max(0, time) : 0;
    if (safeTime + 1e-6 < this.#anchorTime) return;
    this.anchor(safeTime);
  }

  get anchoredAt(): number {
    return this.#anchorAt;
  }

  get lastRenderedTime(): number {
    return this.#lastRenderedTime;
  }

  markRendered(time: number): void {
    this.#lastRenderedTime = Number.isFinite(time) ? Math.max(0, time) : 0;
  }

  // -- Pause freeze -------------------------------------------------------

  freeze(time: number, percent: number | null = null): void {
    this.#frozenTime = Number.isFinite(time) ? Math.max(0, time) : 0;
    this.#frozenPercent = percent !== null && Number.isFinite(percent)
      ? Math.min(1, Math.max(0, percent))
      : null;
    this.anchor(this.#frozenTime);
  }

  unfreeze(): void {
    this.#frozenTime = null;
    this.#frozenPercent = null;
  }

  get isFrozen(): boolean {
    return this.#frozenTime !== null;
  }

  get frozenTime(): number | null {
    return this.#frozenTime;
  }

  get frozenPercent(): number | null {
    return this.#frozenPercent;
  }

  /**
   * Leave a pause freeze without ever rendering a position behind the frozen
   * one. `currentTime` can lag the last rendered frame when playback resumes;
   * anchoring at max(frozen, current) keeps the playhead monotonic. The
   * anchor is re-stamped to "now" so wall-clock time spent paused is never
   * subtracted from the first post-resume estimate.
   */
  resume(currentTime: number): void {
    const safeCurrent = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
    const resumeFrom = this.#frozenTime !== null
      ? Math.max(this.#frozenTime, safeCurrent)
      : safeCurrent;
    this.unfreeze();
    this.#anchorTime = resumeFrom;
    this.#anchorAt = this.#now();
  }

  // -- Committed scrub lock ----------------------------------------------

  lockSeek(time: number): void {
    this.#pendingSeekTime = Number.isFinite(time) ? Math.max(0, time) : 0;
    this.anchor(this.#pendingSeekTime);
  }

  /** Move an already-held seek lock to a new target (used while dragging). */
  updateLockedSeek(time: number): void {
    if (this.#pendingSeekTime === null) return;
    this.lockSeek(time);
  }

  unlockSeek(anchorTime?: number): void {
    if (this.#pendingSeekTime === null) return;
    this.#pendingSeekTime = null;
    if (anchorTime !== undefined && Number.isFinite(anchorTime)) {
      this.anchor(anchorTime);
    }
  }

  get hasPendingSeek(): boolean {
    return this.#pendingSeekTime !== null;
  }

  get pendingSeekTime(): number | null {
    return this.#pendingSeekTime;
  }

  // -- Retry hold ---------------------------------------------------------

  holdForReload(time: number): void {
    this.#heldTime = Number.isFinite(time) ? Math.max(0, time) : 0;
  }

  releaseHold(): void {
    this.#heldTime = null;
  }

  get heldTime(): number | null {
    return this.#heldTime;
  }

  /**
   * Enter the pre-metadata state of a new source. The clock reports zero
   * deterministically until metadata arrives, so no stale render from the
   * previous source can survive a source switch.
   */
  beginAwaitingSource(): void {
    this.#awaitingSource = true;
  }

  /** The new source has metadata: normal clock operation resumes. */
  endAwaitingSource(): void {
    this.#awaitingSource = false;
  }

  get isAwaitingSource(): boolean {
    return this.#awaitingSource;
  }

  // -- Reads --------------------------------------------------------------

  getVisualTime(input: VisualTimeInput): number {
    const {
      currentTime,
      duration,
      loop,
      advancing,
      buffering,
      initialSettled,
    } = input;

    if (this.#awaitingSource || !Number.isFinite(duration) || duration <= 0) {
      // A new source has no playhead position yet: report an exact zero
      // rather than the previous source's leftover media time.
      return 0;
    }
    if (this.#pendingSeekTime !== null) return this.#pendingSeekTime;
    if (this.#frozenTime !== null) return this.#frozenTime;
    // A reload hold pins the playhead at its last rendered moment until the
    // replacement source becomes ready, independent of advancing flags.
    if (this.#heldTime !== null) return this.#heldTime;

    const safeCurrent = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
    if (!advancing) return safeCurrent;

    // Before the initial settle the estimate has no trustworthy anchor yet,
    // so track the media clock directly. After the settle, anchors are owned
    // by play/resume/seek transitions: buffering must not re-anchor, or a
    // lagging media clock during a post-resume buffer would snap the
    // playhead backwards. Buffering simply freezes estimate growth.
    if (!initialSettled) {
      this.anchor(safeCurrent);
      return safeCurrent;
    }

    if (buffering) {
      return Math.min(duration, this.#anchorTime);
    }

    const now = this.#now();
    const elapsed = (now - this.#anchorAt) / 1000;
    const estimatedTime = this.#anchorTime + elapsed;
    const visualTime = loop
      ? estimatedTime % duration
      : Math.min(estimatedTime, duration);

    // Note: there is deliberately no "snap to media currentTime when it
    // diverges" branch here. Anchors are refreshed at every play, resume,
    // seek and buffering transition, so a snap would only ever move the
    // playhead backwards to a media clock that legitimately lags the last
    // rendered frame (e.g. right after resume or a committed scrub).
    return visualTime;
  }

  /** Restore the initial state used by a freshly loaded source. */
  reset(): void {
    this.#anchorTime = 0;
    this.#anchorAt = this.#now();
    this.#frozenTime = null;
    this.#frozenPercent = null;
    this.#pendingSeekTime = null;
    this.#heldTime = null;
    this.#lastRenderedTime = 0;
    this.#awaitingSource = true;
  }
}
