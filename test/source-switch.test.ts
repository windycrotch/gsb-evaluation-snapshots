import { describe, it, expect } from 'vitest';
import { mountPlayer, PROGRESS_WIDTH, PROGRESS_LEFT } from './harness';

const SOURCE_A = 'https://example.test/a.mp4';
const SOURCE_B = 'https://example.test/b.mp4';

describe('source switch lifecycle', () => {
  it('clears the loading, ready-frame and play-icon state left by the previous source', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    await h.driver.resolveLoad({ duration: 60 });
    expect(h.isLoading()).toBe(false);

    h.button.click();
    await h.settleFrames(2);
    expect(h.isPlaying()).toBe(true);

    h.host.setAttribute('src', SOURCE_B);
    await h.settleFrames(3);

    // The old media element is detached from the old source and paused.
    expect(h.driver.currentSrc()).toBe(SOURCE_B);
    expect(h.video.paused).toBe(true);
    // UI reflects a fresh load, not the old source's ready/playing state.
    expect(h.isLoading()).toBe(true);
    expect(h.isPlaying()).toBe(false);
    expect(h.player.classList.contains('has-loaded-once')).toBe(false);
    expect(h.player.classList.contains('has-visible-frame')).toBe(false);
    expect(h.progressPercent()).toBe(0);
    expect(h.button.getAttribute('aria-label')).toBe('Play video');

    // The new source hydrates through the real lazy observer path.
    expect(h.video.dataset.src).toBe(SOURCE_B);
  });

  it('re-sets the video element src exactly once for the new lifecycle', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    const assignments: string[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    Object.defineProperty(h.video, 'src', {
      configurable: true,
      enumerable: true,
      get: descriptor?.get,
      set(value: string) {
        assignments.push(value);
        descriptor?.set?.call(h.video, value);
      },
    });

    h.host.setAttribute('src', SOURCE_B);
    await h.settleFrames(3);

    // resetSource removes the old src, then hydration assigns exactly the new one.
    expect(assignments.filter((value) => value === SOURCE_B)).toHaveLength(1);
    expect(assignments).not.toContain(SOURCE_A);
  });

  it('does not let a first frame from the old load mark the new source as loaded', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);

    // Start resolving A, but switch before the two-frame first-frame confirmation.
    h.video.dispatchEvent(new Event('loadeddata', { bubbles: false }));
    await h.settleFrames(1);
    h.host.setAttribute('src', SOURCE_B);
    await h.settleFrames(4);

    expect(h.player.classList.contains('has-visible-frame')).toBe(false);
    expect(h.player.classList.contains('has-loaded-once')).toBe(false);
    expect(h.isLoading()).toBe(true);

    // B completes its own load and becomes the only source reflected in the UI.
    await h.driver.resolveLoad({ duration: 30 });
    expect(h.player.classList.contains('has-loaded-once')).toBe(true);
    expect(h.isLoading()).toBe(false);
  });

  it('converges on the last src when switched repeatedly before hydration', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    h.host.setAttribute('src', 'https://example.test/mid.mp4');
    h.host.setAttribute('src', SOURCE_B);
    await h.settleFrames(4);

    expect(h.driver.currentSrc()).toBe(SOURCE_B);
    expect(h.video.dataset.src).toBe(SOURCE_B);
    expect(h.isLoading()).toBe(true);

    await h.driver.resolveLoad({ duration: 12 });
    expect(h.isLoading()).toBe(false);
    expect(h.player.classList.contains('has-loaded-once')).toBe(true);
  });

  it('resets the progress bar even when the old source had advanced playback', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    await h.driver.resolveLoad({ duration: 100 });
    h.button.click();
    await h.settleFrames(2);
    h.video.currentTime = 40;
    h.video.dispatchEvent(new Event('timeupdate', { bubbles: false }));
    await h.settleFrames(2);
    expect(h.progressPercent()).toBeGreaterThan(0.3);

    h.host.setAttribute('src', SOURCE_B);
    await h.settleFrames(2);
    expect(h.progressPercent()).toBe(0);

    // Old-source timeupdates arriving after the switch cannot move the new bar.
    h.video.currentTime = 88;
    h.video.dispatchEvent(new Event('timeupdate', { bubbles: false }));
    await h.settleFrames(2);
    expect(h.progressPercent()).toBe(0);
  });

  it('keeps the loading mask on until the new source presents a frame', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    await h.driver.resolveLoad({ duration: 60 });
    expect(h.isLoading()).toBe(false);

    h.host.setAttribute('src', SOURCE_B);
    await h.settleFrames(3);
    expect(h.isLoading()).toBe(true);

    // The new source has hydrated but has not presented a frame, so the mask
    // stays on even though the media element has begun its new load.
    expect(h.driver.currentSrc()).toBe(SOURCE_B);
    expect(h.player.classList.contains('has-visible-frame')).toBe(false);
    expect(h.isLoading()).toBe(true);

    await h.driver.resolveLoad({ duration: 60 });
    expect(h.isLoading()).toBe(false);
    expect(h.player.classList.contains('has-visible-frame')).toBe(true);
  });

  it('restores the play icon to match real media state after the new source resolves', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    await h.driver.resolveLoad({ duration: 60 });
    h.button.click();
    await h.settleFrames(2);
    expect(h.isPlaying()).toBe(true);

    h.host.setAttribute('src', SOURCE_B);
    await h.settleFrames(2);
    expect(h.video.paused).toBe(true);
    expect(h.isPlaying()).toBe(false);

    await h.driver.resolveLoad({ duration: 60 });
    // Autoplay was disabled, so the resolved source stays paused and shows play.
    expect(h.video.paused).toBe(true);
    expect(h.isPlaying()).toBe(false);
    expect(h.button.getAttribute('aria-label')).toBe('Play video');
  });

  it('releases an in-flight scrub when the src changes', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    await h.driver.resolveLoad({ duration: 100 });
    h.revealControls();

    const releases: number[] = [];
    h.progressTrack.releasePointerCapture = ((id: number) => {
      releases.push(id);
    }) as typeof h.progressTrack.releasePointerCapture;

    h.pointerDownOnProgress(PROGRESS_LEFT + PROGRESS_WIDTH * 0.5);
    h.pointerMoveOnProgress(PROGRESS_LEFT + PROGRESS_WIDTH * 0.6);
    expect(h.player.classList.contains('is-scrubbing')).toBe(true);

    h.host.setAttribute('src', SOURCE_B);
    await h.settleFrames(2);
    expect(releases).toContain(1);
    expect(h.player.classList.contains('is-scrubbing')).toBe(false);
    expect(h.progressPercent()).toBe(0);
  });
});
