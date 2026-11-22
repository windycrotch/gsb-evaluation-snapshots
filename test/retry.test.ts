import { describe, it, expect } from 'vitest';
import { mountPlayer, realDelay, RETRY_DELAY, MAX_LOAD_ATTEMPTS } from './harness';

const SOURCE_A = 'https://example.test/a.mp4';
const SOURCE_B = 'https://example.test/b.mp4';

describe('retry bound to the current source', () => {
  it('retries a failed load up to the configured attempt ceiling', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    const initialSrc = h.driver.currentSrc();

    // Attempt 1 fails.
    h.driver.failLoad();
    expect(h.isLoading()).toBe(true);

    // Each scheduled retry re-hydrates on the real 2s delay; fail every attempt.
    for (let attempt = 2; attempt <= MAX_LOAD_ATTEMPTS; attempt += 1) {
      await realDelay(RETRY_DELAY);
      expect(h.driver.currentSrc()).toBe(initialSrc);
      h.driver.failLoad();
    }

    // Retries are exhausted: no further re-hydration happens on its own.
    const srcAfterExhaustion = h.driver.currentSrc();
    await realDelay(RETRY_DELAY * 2);
    expect(h.driver.currentSrc()).toBe(srcAfterExhaustion);
    expect(h.isLoading()).toBe(true);
    expect(h.player.classList.contains('has-loaded-once')).toBe(false);
  });

  it('recovers automatically when a retried attempt loads successfully', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);

    h.driver.failLoad();
    await realDelay(RETRY_DELAY);
    // The second attempt succeeds.
    await h.driver.resolveLoad({ duration: 40 });

    expect(h.isLoading()).toBe(false);
    expect(h.player.classList.contains('has-loaded-once')).toBe(true);
    expect(h.video.error).toBeNull();
  });

  it('cancels a queued retry from the old source when src changes', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    h.driver.failLoad();

    // Switch while A's retry is queued.
    h.host.setAttribute('src', SOURCE_B);
    await h.settleFrames(3);

    // Wait past A's retry window; it must never re-fire for A.
    await realDelay(RETRY_DELAY * 2);
    expect(h.driver.currentSrc()).toBe(SOURCE_B);
    expect(h.video.dataset.src).toBe(SOURCE_B);

    // B loads cleanly and is never marked as failed.
    await h.driver.resolveLoad({ duration: 20 });
    expect(h.isLoading()).toBe(false);
    expect(h.player.classList.contains('has-loaded-once')).toBe(true);
  });

  it('does not mark the new source as loaded via an old-source error', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    h.driver.failLoad();
    h.host.setAttribute('src', SOURCE_B);
    await h.settleFrames(3);

    expect(h.player.classList.contains('has-loaded-once')).toBe(false);
    expect(h.player.classList.contains('has-visible-frame')).toBe(false);
    expect(h.isLoading()).toBe(true);

    // Even after the old retry window elapses, B remains in its own loading state.
    await realDelay(RETRY_DELAY * 2);
    expect(h.player.classList.contains('has-loaded-once')).toBe(false);
    expect(h.isLoading()).toBe(true);
  });

  it('keeps separate retry budgets per source lifecycle', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);

    // Exhaust A's retries.
    h.driver.failLoad();
    for (let attempt = 2; attempt <= MAX_LOAD_ATTEMPTS; attempt += 1) {
      await realDelay(RETRY_DELAY);
      h.driver.failLoad();
    }
    await realDelay(RETRY_DELAY);
    expect(h.isLoading()).toBe(true);

    // Re-setting the same src starts a brand new budget and succeeds.
    h.host.setAttribute('src', SOURCE_A);
    await h.settleFrames(3);
    expect(h.isLoading()).toBe(true);
    await h.driver.resolveLoad({ duration: 10 });
    expect(h.player.classList.contains('has-loaded-once')).toBe(true);
    expect(h.isLoading()).toBe(false);
  });

  it('allows manual play to start a fresh load after retries are exhausted', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);

    h.driver.failLoad();
    for (let attempt = 2; attempt <= MAX_LOAD_ATTEMPTS; attempt += 1) {
      await realDelay(RETRY_DELAY);
      h.driver.failLoad();
    }
    await realDelay(RETRY_DELAY);
    expect(h.isLoading()).toBe(true);
    expect(h.video.paused).toBe(true);

    // A manual click must remain able to recover the player.
    h.button.click();
    await h.settleFrames(3);
    expect(h.driver.currentSrc()).toBe(SOURCE_A);
    expect(h.isLoading()).toBe(true);

    await h.driver.resolveLoad({ duration: 15 });
    await h.settleFrames(2);

    // Mask, progress and play icon all converge on the real media state.
    expect(h.isLoading()).toBe(false);
    expect(h.player.classList.contains('has-loaded-once')).toBe(true);
    expect(h.video.error).toBeNull();
    // The click requested playback and the resolved media is now "playing".
    expect(h.isPlaying()).toBe(true);
    expect(h.video.paused).toBe(false);
  });

  it('manual play after exhaustion stays recoverable even if the fresh load also fails once', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);

    h.driver.failLoad();
    for (let attempt = 2; attempt <= MAX_LOAD_ATTEMPTS; attempt += 1) {
      await realDelay(RETRY_DELAY);
      h.driver.failLoad();
    }
    await realDelay(RETRY_DELAY);

    h.button.click();
    await h.settleFrames(3);
    // Fresh manual cycle fails its first attempt; auto retry still applies.
    h.driver.failLoad();
    await realDelay(RETRY_DELAY);
    await h.driver.resolveLoad({ duration: 12 });

    expect(h.isLoading()).toBe(false);
    expect(h.player.classList.contains('has-loaded-once')).toBe(true);
  });
});
