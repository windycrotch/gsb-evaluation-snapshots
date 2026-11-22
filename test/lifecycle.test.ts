import { describe, it, expect } from 'vitest';
import { mountPlayer, realDelay, RETRY_DELAY } from './harness';

const SOURCE_A = 'https://example.test/a.mp4';

describe('element teardown and reconnection', () => {
  it('stops retry timers when removed from the document', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    h.driver.failLoad();

    // Watch for any src re-assignment attempted by a detached retry.
    const srcWrites: string[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')!;
    Object.defineProperty(h.video, 'src', {
      configurable: true,
      enumerable: true,
      get: descriptor.get,
      set(value: string) {
        srcWrites.push(String(value));
        descriptor.set!.call(h.video, value);
      },
    });

    h.host.remove();
    await realDelay(RETRY_DELAY * 2);

    // Disconnect clears the retry timer, so no re-hydration src is ever written.
    expect(srcWrites).toEqual([]);
  });

  it('can be reconnected after a src switch without leaking the old lifecycle', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    await h.driver.resolveLoad({ duration: 40 });

    h.host.remove();
    // Reconnect first, then switch src (attribute changes while disconnected are
    // applied by connectedCallback's sync step, matching the custom-element spec).
    document.body.append(h.host);
    h.host.setAttribute('src', 'https://example.test/b.mp4');
    await h.settleFrames(4);

    expect(h.driver.currentSrc()).toBe('https://example.test/b.mp4');
    expect(h.isLoading()).toBe(true);
    expect(h.player.classList.contains('has-loaded-once')).toBe(false);

    await h.driver.resolveLoad({ duration: 20 });
    expect(h.isLoading()).toBe(false);
    expect(h.player.classList.contains('has-loaded-once')).toBe(true);
  });

  it('releases an in-flight scrub and its pointer capture on disconnect', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    await h.driver.resolveLoad({ duration: 100 });
    h.revealControls();

    const releases: number[] = [];
    h.progressTrack.releasePointerCapture = ((id: number) => releases.push(id)) as
      typeof h.progressTrack.releasePointerCapture;

    h.pointerDownOnProgress(110);
    h.pointerMoveOnProgress(150);
    expect(h.player.classList.contains('is-scrubbing')).toBe(true);

    h.host.remove();
    // disconnectedCallback cancels the scrub and releases the captured pointer.
    expect(h.player.classList.contains('is-scrubbing')).toBe(false);
    expect(releases).toContain(1);
    expect(() => h.settleFrames(2)).not.toThrow();
  });

  it('does not throw on blur or pointer events after disconnection', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    h.host.remove();
    expect(() => window.dispatchEvent(new Event('blur'))).not.toThrow();
    expect(() =>
      h.progressTrack.dispatchEvent(h.pointerEvent('pointerup', { clientX: 50 })),
    ).not.toThrow();
  });
});

describe('autoplay source switching', () => {
  it('a muted autoplay player keeps the new source loading and converges on it', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true });
    await h.settleFrames(3);
    await h.driver.resolveLoad({ duration: 30 });

    h.host.setAttribute('src', 'https://example.test/auto.mp4');
    await h.settleFrames(4);

    expect(h.driver.currentSrc()).toBe('https://example.test/auto.mp4');
    expect(h.progressPercent()).toBe(0);
    expect(h.player.classList.contains('has-loaded-once')).toBe(false);

    await h.driver.resolveLoad({ duration: 12 });
    expect(h.player.classList.contains('has-loaded-once')).toBe(true);
    expect(h.isLoading()).toBe(false);
  });

  it('a play click racing a src switch cannot leave the play icon stuck on the old source', async () => {
    const h = await mountPlayer({ src: SOURCE_A, controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);

    // Interleave a play request with the src switch; the switch's reset must
    // win and leave the UI matching the paused, loading new source.
    h.button.click();
    h.host.setAttribute('src', 'https://example.test/race.mp4');
    await h.settleFrames(4);

    expect(h.isPlaying()).toBe(false);
    expect(h.button.getAttribute('aria-label')).toBe('Play video');
    expect(h.isLoading()).toBe(true);
    expect(h.driver.currentSrc()).toBe('https://example.test/race.mp4');
  });
});
