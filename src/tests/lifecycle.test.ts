import { describe, expect, it, vi } from 'vitest';
import { createPlayer, makeTracks } from './helpers';

describe('lifecycle: destroy/reset return to a clean baseline', () => {
  it('destroy kills every session listener and resets queue/loop state', async () => {
    const { player, notifier } = await createPlayer();
    player.addQueue(makeTracks(3), 'DEFAULT');
    player.loop('QUEUE');

    await player.destroy();

    expect(player.getQueue()).toEqual([]);
    expect(player.getCurrentQueueIndex()).toBe(0);
    expect(player.getLoopMode()).toBe('OFF');
    expect(player.isShuffledEnabled()).toBe(false);

    // stale listeners from the destroyed session must not fire anymore
    const playNextSpy = vi.spyOn(player, 'playNext');
    const addMediaAndPlaySpy = vi.spyOn(player, 'addMediaAndPlay');
    notifier.notify('AUDIO_STATE', { playbackState: 'ended' });
    notifier.notify('AUDIO_STATE', { playbackState: 'queueended' });

    expect(playNextSpy).not.toHaveBeenCalled();
    expect(addMediaAndPlaySpy).not.toHaveBeenCalled();
  });

  it('re-init and playback after destroy start from a clean baseline', async () => {
    const { player, AudioX, notifier } = await createPlayer();
    const element = AudioX.getAudioInstance() as any;

    player.addQueue(makeTracks(3, 'old'), 'DEFAULT');
    player.loop('QUEUE');
    const listenersBefore = element.totalListenerCount();

    await player.destroy();
    await player.init({ mode: 'VANILLA', useDefaultEventListeners: true } as any);

    // re-init must not stack duplicate element listeners
    expect(element.totalListenerCount()).toBe(listenersBefore);

    // rebuild a queue session: exactly one auto-advance on track end
    player.addQueue(makeTracks(2, 'new'), 'DEFAULT');
    const playNextSpy = vi.spyOn(player, 'playNext');
    notifier.notify('AUDIO_STATE', { playbackState: 'ended' });

    expect(playNextSpy).toHaveBeenCalledTimes(1);
    expect(player.getCurrentQueueIndex()).toBe(1);
    expect(player.getCurrentTrack()?.id).toBe('new2');
  });

  it('reset invalidates session listeners so a fresh addQueue behaves like a first session', async () => {
    const { player, notifier } = await createPlayer();
    player.addQueue(makeTracks(3), 'DEFAULT');
    player.loop('QUEUE');

    await player.reset();
    expect(player.getQueue()).toEqual([]);
    expect(player.getLoopMode()).toBe('OFF');

    const playNextSpy = vi.spyOn(player, 'playNext');
    notifier.notify('AUDIO_STATE', { playbackState: 'ended' });
    expect(playNextSpy).not.toHaveBeenCalled();

    // a new session after reset works exactly once per track end
    player.addQueue(makeTracks(2), 'DEFAULT');
    notifier.notify('AUDIO_STATE', { playbackState: 'ended' });
    expect(playNextSpy).toHaveBeenCalledTimes(1);
    expect(player.getCurrentQueueIndex()).toBe(1);
  });
});
