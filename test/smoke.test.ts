import { describe, it, expect } from 'vitest';
import { mountPlayer } from './harness';

describe('smoke: real custom element entry', () => {
  it('hydrates the source through the lazy observer and reaches a first frame', async () => {
    const h = await mountPlayer({ src: 'https://example.test/a.mp4', controls: true, 'disable-autoplay': true });

    expect(h.video.dataset.src).toBe('https://example.test/a.mp4');
    await h.settleFrames(1);
    expect(h.driver.currentSrc()).toBe('https://example.test/a.mp4');
    expect(h.isLoading()).toBe(true);

    await h.driver.resolveLoad({ duration: 60 });

    expect(h.isLoading()).toBe(false);
    expect(h.player.classList.contains('has-loaded-once')).toBe(true);
    expect(h.player.classList.contains('has-visible-frame')).toBe(true);
  });

  it('toggles the play button through the public button click', async () => {
    const h = await mountPlayer({ src: 'https://example.test/a.mp4', controls: true, 'disable-autoplay': true });
    await h.settleFrames(2);
    await h.driver.resolveLoad({ duration: 60 });

    expect(h.isPlaying()).toBe(false);
    h.button.click();
    await h.settleFrames(2);
    expect(h.isPlaying()).toBe(true);
    expect(h.video.paused).toBe(false);

    h.button.click();
    await h.settleFrames(2);
    expect(h.isPlaying()).toBe(false);
    expect(h.video.paused).toBe(true);
  });
});
