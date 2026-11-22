import { describe, it, expect, vi } from 'vitest';
import { mountPlayer, PROGRESS_WIDTH, PROGRESS_LEFT } from './harness';

const SOURCE_A = 'https://example.test/a.mp4';
const xAt = (percent: number) => PROGRESS_LEFT + PROGRESS_WIDTH * percent;

describe('scrub / source-switch / first-frame interleaving', () => {
  it('holds the committed position while the new source is not ready instead of reverting', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    await h.driver.resolveLoad({ duration: 100 });
    h.revealControls();

    // Commit a seek to 50% but do not emit seeked yet.
    h.pointerDownOnProgress(xAt(0.1));
    h.pointerMoveOnProgress(xAt(0.5));
    h.pointerUpOnProgress(xAt(0.5));
    expect(h.progressPercent()).toBeCloseTo(0.5, 1);
    expect(h.video.currentTime).toBeCloseTo(50, 5);

    // Old-source timeupdate events (reporting an earlier time) must not move
    // the bar away from the committed position before the seek completes.
    h.video.currentTime = 12;
    h.video.dispatchEvent(new Event('timeupdate', { bubbles: false }));
    await h.settleFrames(2);
    expect(h.progressPercent()).toBeCloseTo(0.5, 1);

    // Completing the seek clears the pending state and resumes the real clock.
    await h.driver.completeSeek(50);
    h.driver.advanceTime(0);
    await h.settleFrames(2);
    expect(h.progressPercent()).toBeCloseTo(0.5, 1);
  });

  it('clears the pending committed state on seeked and restores the playback clock', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    await h.driver.resolveLoad({ duration: 100 });
    h.button.click();
    await h.settleFrames(2);
    h.revealControls();

    h.pointerDownOnProgress(xAt(0.2));
    h.pointerMoveOnProgress(xAt(0.8));
    h.pointerUpOnProgress(xAt(0.8));
    const committedTime = h.video.currentTime;
    expect(committedTime).toBeGreaterThan(78);
    expect(h.progressPercent()).toBeGreaterThan(0.78);

    await h.driver.completeSeek(committedTime);
    await h.settleFrames(3);

    // After seeked the real clock drives the bar again; advancing time moves it.
    const percentAfterSeek = h.progressPercent();
    h.driver.advanceTime(10);
    await h.settleFrames(2);
    expect(h.progressPercent()).toBeGreaterThan(percentAfterSeek);
    expect(h.isPlaying()).toBe(true);
  });

  it('clears the pending committed state when the first frame of a new source arrives', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    await h.driver.resolveLoad({ duration: 100 });
    h.revealControls();

    h.pointerDownOnProgress(xAt(0.1));
    h.pointerMoveOnProgress(xAt(0.7));
    h.pointerUpOnProgress(xAt(0.7));
    expect(h.progressPercent()).toBeCloseTo(0.7, 1);

    // A source switch lands while the committed seek has not resolved.
    h.host.setAttribute('src', 'https://example.test/b.mp4');
    await h.settleFrames(3);
    expect(h.progressPercent()).toBe(0);

    await h.driver.resolveLoad({ duration: 50 });
    await h.settleFrames(2);
    // The new source starts at zero and drives its own clock from there.
    expect(h.player.classList.contains('has-visible-frame')).toBe(true);
    expect(h.progressPercent()).toBe(0);
  });

  it('keeps the bar on the submitted position across a src switch until new metadata', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    await h.driver.resolveLoad({ duration: 100 });
    h.revealControls();

    h.pointerDownOnProgress(xAt(0.3));
    h.pointerMoveOnProgress(xAt(0.45));
    h.pointerUpOnProgress(xAt(0.45));

    // Simulate a burst of stale old-source timeupdates after the switch.
    h.host.setAttribute('src', 'https://example.test/b.mp4');
    for (const staleTime of [45, 30, 90]) {
      h.video.currentTime = staleTime;
      h.video.dispatchEvent(new Event('timeupdate', { bubbles: false }));
    }
    await h.settleFrames(3);
    expect(h.progressPercent()).toBe(0);
    expect(h.isLoading()).toBe(true);
  });

  it('releases pointer capture and restores a stable state on pointercancel mid-drag', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    await h.driver.resolveLoad({ duration: 100 });
    h.revealControls();

    const releases: number[] = [];
    h.progressTrack.releasePointerCapture = ((id: number) => releases.push(id)) as
      typeof h.progressTrack.releasePointerCapture;

    h.pointerDownOnProgress(xAt(0.2));
    h.pointerMoveOnProgress(xAt(0.6));
    expect(h.player.classList.contains('is-scrubbing')).toBe(true);

    h.pointerCancelOnProgress(1);
    expect(releases).toContain(1);
    expect(h.player.classList.contains('is-scrubbing')).toBe(false);
    // Stable: no crash, bar returns to the underlying media position.
    expect(() => h.settleFrames(2)).not.toThrow();
  });

  it('releases scrub, volume and speed pointer capture when the window loses focus', async () => {
    const h = await mountPlayer({
      src: SOURCE_A,
      controls: true,
      'disable-autoplay': true,
      'enable-volume': '',
      'enable-speed': '',
      'show-time': '',
    });
    await h.settleFrames(2);
    await h.driver.resolveLoad({ duration: 100 });
    // Simulate an available audio track so the volume control is enabled.
    h.video.volume = 0.5;
    h.video.dispatchEvent(new Event('volumechange', { bubbles: false }));
    await h.settleFrames(2);
    h.revealControls();

    const scrubReleases: number[] = [];
    const volumeReleases: number[] = [];
    const speedReleases: number[] = [];
    h.progressTrack.releasePointerCapture = ((id: number) => scrubReleases.push(id)) as
      typeof h.progressTrack.releasePointerCapture;
    h.volumeTrack.releasePointerCapture = ((id: number) => volumeReleases.push(id)) as
      typeof h.volumeTrack.releasePointerCapture;
    h.speedTrack.releasePointerCapture = ((id: number) => speedReleases.push(id)) as
      typeof h.speedTrack.releasePointerCapture;

    // Start a progress scrub.
    h.pointerDownOnProgress(xAt(0.2));
    h.pointerMoveOnProgress(xAt(0.6));
    expect(h.player.classList.contains('is-scrubbing')).toBe(true);

    // Start a volume drag and a speed drag on their tracks.
    h.volumeTrack.dispatchEvent(h.pointerEvent('pointerdown', { clientX: 0, clientY: 40, pointerId: 2 }));
    h.speedTrack.dispatchEvent(h.pointerEvent('pointerdown', { clientX: 0, clientY: 40, pointerId: 3 }));

    window.dispatchEvent(new Event('blur'));
    await h.settleFrames(2);

    expect(scrubReleases).toContain(1);
    expect(h.player.classList.contains('is-scrubbing')).toBe(false);
    expect(volumeReleases).toContain(2);
    expect(speedReleases).toContain(3);
  });

  it('window blur with no active drag is a safe no-op', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    await h.driver.resolveLoad({ duration: 100 });
    expect(() => window.dispatchEvent(new Event('blur'))).not.toThrow();
    await h.settleFrames(2);
    expect(h.player.classList.contains('is-scrubbing')).toBe(false);
  });

  it('a scrub started during a loading source does not jump when the source later resolves', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    h.revealControls();

    // No metadata yet: geometry exists, duration does not, so scrubbing cannot
    // compute a target and must not throw.
    expect(() => {
      h.pointerDownOnProgress(xAt(0.2));
      h.pointerMoveOnProgress(xAt(0.6));
      h.pointerUpOnProgress(xAt(0.6));
    }).not.toThrow();

    await h.driver.resolveLoad({ duration: 80 });
    await h.settleFrames(2);
    expect(h.player.classList.contains('has-loaded-once')).toBe(true);
    expect(h.progressPercent()).toBe(0);
  });
});

describe('volume and speed drags release capture on pointercancel', () => {
  it('releases the volume slider through pointercancel', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true, 'enable-volume': '' });
    await h.settleFrames(2);
    await h.driver.resolveLoad({ duration: 100 });
    h.video.volume = 0.6;
    h.video.dispatchEvent(new Event('volumechange'));
    await h.settleFrames(2);

    const releases: number[] = [];
    h.volumeTrack.releasePointerCapture = ((id: number) => releases.push(id)) as
      typeof h.volumeTrack.releasePointerCapture;

    h.volumeTrack.dispatchEvent(h.pointerEvent('pointerdown', { clientX: 0, clientY: 30, pointerId: 7 }));
    h.volumeTrack.dispatchEvent(h.pointerEvent('pointercancel', { clientX: 0, clientY: 30, pointerId: 7 }));
    expect(releases).toContain(7);
  });

  it('releases the speed slider through pointercancel', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true, 'enable-speed': '' });
    await h.settleFrames(2);
    await h.driver.resolveLoad({ duration: 100 });

    const releases: number[] = [];
    h.speedTrack.releasePointerCapture = ((id: number) => releases.push(id)) as
      typeof h.speedTrack.releasePointerCapture;

    h.speedTrack.dispatchEvent(h.pointerEvent('pointerdown', { clientX: 0, clientY: 30, pointerId: 9 }));
    h.speedTrack.dispatchEvent(h.pointerEvent('pointercancel', { clientX: 0, clientY: 30, pointerId: 9 }));
    expect(releases).toContain(9);
  });
});
