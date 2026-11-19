import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPlayer,
  emit,
  flushFrames,
  makeReady,
  pointer,
  progressInsetPercent,
  simulateMediaLoadReset,
  type PlayerParts,
} from './harness';

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('source switching (src attribute)', () => {
  it('resets playhead, time text, first-frame, audio and retry state for the new source', async () => {
    const parts = await createPlayer({ src: 'https://example.test/a.mp4', controls: '', 'show-time': '' });
    const { player, video, host, trayTimeText, track } = parts;

    // First source reaches playback and renders a non-zero playhead.
    await makeReady(parts, 10);
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 6 });
    emit(video, 'timeupdate');
    await flushFrames();
    expect(progressInsetPercent(host)).toBeCloseTo(0.6, 1);
    expect(trayTimeText.textContent).toBe('0:06');
    expect(host.classList.contains('has-visible-frame')).toBe(true);
    expect(player.videoLoadAttempt).toBe(1);

    // Simulate an exhausted retry budget on the old source. Fake timers must
    // be installed before the first error schedules its retry timer.
    vi.useFakeTimers();
    Object.defineProperty(video, 'error', { configurable: true, get: () => ({ code: 4 }) });
    emit(video, 'error');
    await vi.advanceTimersByTimeAsync(2000);
    emit(video, 'error');
    await vi.advanceTimersByTimeAsync(2000);
    emit(video, 'error');
    expect(player.hasVideoLoadFailed).toBe(true);
    vi.useRealTimers();

    // Switch to a new source: everything must return to initial state.
    Object.defineProperty(video, 'error', { configurable: true, get: () => null });
    player.setAttribute('src', 'https://example.test/b.mp4');
    await Promise.resolve();
    simulateMediaLoadReset(video);
    emit(video, 'loadstart');

    // Retry counter is back at the new source's initial state and no terminal
    // failure state carried over. (Hydration happens synchronously below and
    // then counts the new source's first attempt independently.)
    expect(player.hasVideoLoadFailed).toBe(false);
    expect(host.classList.contains('has-visible-frame')).toBe(false);
    expect(host.classList.contains('has-loaded-once')).toBe(false);
    expect(host.classList.contains('is-load-failed')).toBe(false);
    expect(progressInsetPercent(host)).toBe(0);
    expect(trayTimeText.textContent).toBe('0:00');
    expect(track.getAttribute('aria-valuenow')).toBe('0');
    // jsdom hydrates immediately (no IntersectionObserver), so the new
    // source's URL is already assigned; the lazy-load dataset matches it.
    expect(video.getAttribute('src')).toBe('https://example.test/b.mp4');
    expect(video.dataset.src).toBe('https://example.test/b.mp4');
  });

  it('lets a stale error event from the old source schedule no retries against the new source', async () => {
    const parts = await createPlayer({ src: 'https://example.test/a.mp4' });
    const { player, video } = parts;
    await makeReady(parts, 10);

    player.setAttribute('src', 'https://example.test/b.mp4');
    await Promise.resolve();
    const attemptsAfterSwitch = player.videoLoadAttempt;

    // An error event arriving after the switch must be ignored: no source is
    // hydrated yet, and no retry timer may run.
    Object.defineProperty(video, 'error', { configurable: true, get: () => ({ code: 2 }) });
    emit(video, 'error');

    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(5000);
    expect(player.videoLoadAttempt).toBe(attemptsAfterSwitch);
    expect(player.hasVideoLoadFailed).toBe(false);
    vi.useRealTimers();
  });

  it('re-detects audio availability from scratch for the new source', async () => {
    const parts = await createPlayer({ src: 'https://example.test/a.mp4', controls: '' });
    const { player, video } = parts;
    const audioTracksHolder = video as HTMLVideoElement & {
      audioTracks?: { length: number };
    };

    // Declare the audio track before readiness events run, so detection
    // observes it on the first source's metadata/ready lifecycle.
    Object.defineProperty(audioTracksHolder, 'audioTracks', {
      configurable: true,
      value: { length: 1 },
    });
    await makeReady(parts, 10);
    emit(video, 'timeupdate');
    const volumeButton = player.shadowRoot!.querySelector<HTMLButtonElement>('[data-sp-volume-control]')!;
    expect(volumeButton.disabled).toBe(false);

    // Simulate the replacement media element exposing no audio track, then
    // switch sources. The player must re-run detection instead of carrying
    // over the old source's "has audio" result.
    Object.defineProperty(audioTracksHolder, 'audioTracks', {
      configurable: true,
      value: { length: 0 },
    });
    player.setAttribute('src', 'https://example.test/b.mp4');
    await Promise.resolve();
    simulateMediaLoadReset(video);

    // Drive the new source to metadata: empty audioTracks resolves to
    // "unavailable" at HAVE_METADATA, re-hiding the volume control.
    Object.defineProperty(video, 'duration', { configurable: true, value: 8 });
    Object.defineProperty(video, 'readyState', {
      configurable: true,
      writable: true,
      value: HTMLMediaElement.HAVE_METADATA,
    });
    emit(video, 'loadedmetadata');
    expect(volumeButton.disabled).toBe(true);
  });
});

describe('scrub drag and commit', () => {
  it('suspends progress estimation while dragging and stays on the target after commit', async () => {
    const parts = await createPlayer({ src: 'https://example.test/a.mp4', controls: '', 'show-time': '' });
    const { player, video, host, track, trayTimeText } = parts;
    await makeReady(parts, 10);
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 1 });
    emit(video, 'timeupdate');
    await flushFrames();

    const playSpy = vi.spyOn(video, 'play').mockResolvedValue(undefined);
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => undefined);

    // Pointer down, move past the drag threshold (4px) to enter scrub mode.
    track.dispatchEvent(pointer('pointerdown', 20));
    track.dispatchEvent(pointer('pointermove', 30));
    expect(host.classList.contains('is-scrubbing')).toBe(true);
    expect(pauseSpy).toHaveBeenCalled();

    // While dragging, timeupdate noise from the media element cannot move
    // the playhead away from the scrub target.
    const targetPercent = progressInsetPercent(host);
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 9.9 });
    emit(video, 'timeupdate');
    expect(progressInsetPercent(host)).toBeCloseTo(targetPercent, 5);

    // Release at 50% -> target time 5s.
    track.dispatchEvent(pointer('pointerup', 100));
    expect(video.currentTime).toBeCloseTo(5);
    expect(progressInsetPercent(host)).toBeCloseTo(0.5, 2);
    expect(trayTimeText.textContent).toBe('0:05');
    expect(playSpy).toHaveBeenCalled();

    // Media is still buffering and reports the pre-seek position: the
    // playhead must not jump back to the old value.
    Object.defineProperty(video, 'readyState', {
      configurable: true,
      writable: true,
      value: HTMLMediaElement.HAVE_METADATA,
    });
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 1 });
    emit(video, 'timeupdate');
    emit(video, 'waiting');
    expect(progressInsetPercent(host)).toBeCloseTo(0.5, 2);
    expect(trayTimeText.textContent).toBe('0:05');

    // Once the media catches up at the target, normal rendering resumes from
    // the target — still no backward jump.
    Object.defineProperty(video, 'readyState', {
      configurable: true,
      writable: true,
      value: HTMLMediaElement.HAVE_FUTURE_DATA,
    });
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 5 });
    emit(video, 'seeked');
    await flushFrames();
    // The estimate advances from the 5s anchor in real wall-clock time; allow
    // sub-percent rAF scheduling drift but assert it never fell back below 5.
    const finalPercent = progressInsetPercent(host);
    expect(finalPercent).toBeGreaterThanOrEqual(0.5 - 0.001);
    expect(finalPercent).toBeLessThan(0.52);

    playSpy.mockRestore();
    pauseSpy.mockRestore();
  });
});

describe('pause and resume', () => {
  it('freezes the rendered playhead while paused and never goes backwards on resume', async () => {
    const parts = await createPlayer({ src: 'https://example.test/a.mp4', controls: '', 'show-time': '' });
    const { player, video, host, trayTimeText } = parts;
    await makeReady(parts, 10);

    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 4 });
    emit(video, 'timeupdate');
    await flushFrames();
    const frozenPercent = progressInsetPercent(host);
    expect(frozenPercent).toBeCloseTo(0.4, 1);

    // Pause: playhead freezes even if time keeps ticking on the media clock.
    Object.defineProperty(video, 'paused', { configurable: true, writable: true, value: true });
    emit(video, 'pause');
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 4.8 });
    emit(video, 'timeupdate');
    expect(progressInsetPercent(host)).toBeCloseTo(frozenPercent, 5);
    expect(trayTimeText.textContent).toBe('0:04');

    // Resume with a media clock that lags the frozen render point: no jump back.
    Object.defineProperty(video, 'paused', { configurable: true, writable: true, value: false });
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 3.7 });
    emit(video, 'play');
    emit(video, 'timeupdate');
    expect(progressInsetPercent(host)).toBeGreaterThanOrEqual(frozenPercent - 0.001);
  });
});

describe('load failure retry', () => {
  it('retries up to the cap, keeps progress determinate while retrying, then stops', async () => {
    const parts = await createPlayer({ src: 'https://example.test/fail.mp4' });
    const { player, video, host } = parts;

    Object.defineProperty(video, 'error', { configurable: true, get: () => ({ code: 4 }) });
    Object.defineProperty(video, 'readyState', { configurable: true, writable: true, value: 0 });

    // Initial hydrate fails, then two retries: 3 attempts total. Fake timers
    // are installed first so every scheduled retry is driven deterministically.
    vi.useFakeTimers();
    emit(video, 'error');
    expect(player.videoLoadAttempt).toBe(1);
    expect(host.classList.contains('is-loading')).toBe(true);

    await vi.advanceTimersByTimeAsync(2000);
    expect(player.videoLoadAttempt).toBe(2);
    emit(video, 'error');
    await vi.advanceTimersByTimeAsync(2000);
    expect(player.videoLoadAttempt).toBe(3);
    emit(video, 'error');
    expect(player.hasVideoLoadFailed).toBe(true);
    expect(host.classList.contains('is-load-failed')).toBe(true);

    // No further attempts are scheduled no matter how long we wait.
    await vi.advanceTimersByTimeAsync(10000);
    expect(player.videoLoadAttempt).toBe(3);
    vi.useRealTimers();

    // Progress remains in a defined 0 state rather than a stale/NaN value.
    expect(progressInsetPercent(host)).toBe(0);
    expect(host.classList.contains('is-loading')).toBe(true);
  });

  it('holds the last rendered position during a retry after playback had started', async () => {
    const parts = await createPlayer({ src: 'https://example.test/a.mp4', controls: '', 'show-time': '' });
    const { player, video, host, trayTimeText } = parts;
    await makeReady(parts, 10);

    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 5 });
    emit(video, 'timeupdate');
    await flushFrames();
    expect(progressInsetPercent(host)).toBeGreaterThan(0.49);

    Object.defineProperty(video, 'error', { configurable: true, get: () => ({ code: 2 }) });
    vi.useFakeTimers();
    emit(video, 'error');
    await vi.advanceTimersByTimeAsync(2000);
    // Retry hydrate resets the media clock to 0, but the reload hold pins the
    // playhead to the last rendered position (the 5s mark): it must never
    // reset to 0 or jump backwards while the replacement source loads.
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 0 });
    const retryPercent = progressInsetPercent(host);
    expect(retryPercent).toBeCloseTo(0.5, 2);
    expect(trayTimeText.textContent).toBe('0:05');
    vi.useRealTimers();
  });
});
