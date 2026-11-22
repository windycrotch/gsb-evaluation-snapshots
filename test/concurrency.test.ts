import { describe, it, expect } from 'vitest';
import { mountPlayer, realDelay, RETRY_DELAY, PROGRESS_WIDTH, PROGRESS_LEFT } from './harness';

const xAt = (percent: number) => PROGRESS_LEFT + PROGRESS_WIDTH * percent;

describe('concurrent lifecycle interleaving', () => {
  it('survives src switches interleaved with play clicks and settles on the final source', async () => {
    const h = await mountPlayer({ src: 'https://example.test/a.mp4', controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);

    h.button.click();
    h.host.setAttribute('src', 'https://example.test/b.mp4');
    h.button.click();
    h.host.setAttribute('src', 'https://example.test/c.mp4');
    await h.settleFrames(4);

    expect(h.driver.currentSrc()).toBe('https://example.test/c.mp4');
    expect(h.player.classList.contains('has-loaded-once')).toBe(false);
    expect(h.isLoading()).toBe(true);

    await h.driver.resolveLoad({ duration: 24 });
    expect(h.player.classList.contains('has-loaded-once')).toBe(true);
    expect(h.isLoading()).toBe(false);
    expect(h.progressPercent()).toBe(0);
  });

  it('an error arriving for a queued retry cannot resurrect a superseded source', async () => {
    const h = await mountPlayer({ src: 'https://example.test/a.mp4', controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    h.driver.failLoad();

    h.host.setAttribute('src', 'https://example.test/b.mp4');
    await h.settleFrames(3);

    // A late, spurious error (e.g. an aborted old request) after the switch.
    h.driver.failLoad();
    await h.settleFrames(2);

    // The new source remains in control; waiting past A's retry window does not
    // cause A to reload.
    await realDelay(RETRY_DELAY * 2);
    expect(h.driver.currentSrc()).toBe('https://example.test/b.mp4');
    expect(h.video.dataset.src).toBe('https://example.test/b.mp4');
  });

  it('recovers the loading mask and play icon after buffering resolves on the current source', async () => {
    const h = await mountPlayer({ src: 'https://example.test/a.mp4', controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    await h.driver.resolveLoad({ duration: 100 });
    h.button.click();
    await h.settleFrames(2);
    expect(h.isPlaying()).toBe(true);
    // Let the one-shot initial-progress settle window (380ms) finish first.
    await new Promise((resolve) => setTimeout(resolve, 450));

    // Advance the playhead, then drain the buffer ahead of it so waiting
    // genuinely means rebuffering (buffer ends before the current time).
    h.video.currentTime = 50;
    h.driver.setBuffered([[0, 50.5]]);
    h.driver.simulateWaiting();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await h.settleFrames(2);
    expect(h.isLoading()).toBe(true);
    // The play icon still reflects the intended playing state while buffering.
    expect(h.isPlaying()).toBe(true);

    h.driver.setBuffered([[0, 100]]);
    await h.driver.simulatePlaying();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await h.settleFrames(2);
    expect(h.isLoading()).toBe(false);
    expect(h.isPlaying()).toBe(true);
  });

  it('a src switch during buffering drops the stale buffering mask via the new lifecycle', async () => {
    const h = await mountPlayer({ src: 'https://example.test/a.mp4', controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    await h.driver.resolveLoad({ duration: 100 });
    h.button.click();
    await h.settleFrames(2);
    h.video.currentTime = 50;
    h.driver.setBuffered([[0, 50.5]]);
    h.driver.simulateWaiting();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await h.settleFrames(2);
    expect(h.isLoading()).toBe(true);

    h.host.setAttribute('src', 'https://example.test/b.mp4');
    await h.settleFrames(3);
    // The mask now belongs to the new source, and the old playing state is gone.
    expect(h.isLoading()).toBe(true);
    expect(h.isPlaying()).toBe(false);
    expect(h.player.classList.contains('has-loaded-once')).toBe(false);

    await h.driver.resolveLoad({ duration: 30 });
    expect(h.isLoading()).toBe(false);
  });

  it('scrub commits and a rapid src switch never leave a stuck progress loop', async () => {
    const h = await mountPlayer({ src: 'https://example.test/a.mp4', controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    await h.driver.resolveLoad({ duration: 100 });
    h.revealControls();

    h.pointerDownOnProgress(xAt(0.1));
    h.pointerMoveOnProgress(xAt(0.4));
    h.pointerUpOnProgress(xAt(0.4));
    h.host.setAttribute('src', 'https://example.test/b.mp4');
    h.host.setAttribute('src', 'https://example.test/c.mp4');
    await h.settleFrames(4);

    expect(h.progressPercent()).toBe(0);
    expect(h.player.classList.contains('is-scrubbing')).toBe(false);

    await h.driver.resolveLoad({ duration: 16 });
    h.button.click();
    await h.settleFrames(3);
    expect(h.isPlaying()).toBe(true);
    expect(h.progressPercent()).toBe(0);
  });

  it('retry exhaustion then a fresh src restores mask, progress and icon consistency', async () => {
    const h = await mountPlayer({ src: 'https://example.test/a.mp4', controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    h.driver.failLoad();
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      await realDelay(RETRY_DELAY);
      h.driver.failLoad();
    }
    await realDelay(RETRY_DELAY);
    expect(h.isLoading()).toBe(true);

    h.host.setAttribute('src', 'https://example.test/b.mp4');
    await h.settleFrames(3);
    expect(h.progressPercent()).toBe(0);
    expect(h.isPlaying()).toBe(false);
    expect(h.button.getAttribute('aria-label')).toBe('Play video');

    await h.driver.resolveLoad({ duration: 18 });
    expect(h.isLoading()).toBe(false);
    expect(h.player.classList.contains('has-loaded-once')).toBe(true);
    expect(h.progressPercent()).toBe(0);
  });
});
