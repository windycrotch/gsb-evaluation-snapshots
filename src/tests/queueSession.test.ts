import { describe, expect, it, vi } from 'vitest';
import type { AudioState } from '../types/audio.types';
import { createPlayer, makeTracks } from './helpers';

describe('queue session: track change & queue-end auto advance', () => {
  it('advances to the next track exactly once when a track ends', async () => {
    const { player, notifier } = await createPlayer();
    const tracks = makeTracks(3);
    player.addQueue(tracks, 'DEFAULT');

    expect(player.getQueue().map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(player.getCurrentQueueIndex()).toBe(0);

    const playNextSpy = vi.spyOn(player, 'playNext');
    notifier.notify('AUDIO_STATE', { playbackState: 'ended' });

    expect(playNextSpy).toHaveBeenCalledTimes(1);
    expect(player.getCurrentQueueIndex()).toBe(1);
    expect(player.getCurrentTrack()?.id).toBe('t2');
  });

  it('does not stack queue-end listeners across repeated addQueue calls', async () => {
    const { player, notifier } = await createPlayer();
    const tracks = makeTracks(3);

    // each addQueue previously leaked one more 'ended' listener, causing
    // a single track end to skip multiple tracks
    player.addQueue(tracks, 'DEFAULT');
    player.addQueue(tracks, 'DEFAULT');
    player.addQueue(tracks, 'DEFAULT');

    const playNextSpy = vi.spyOn(player, 'playNext');
    notifier.notify('AUDIO_STATE', { playbackState: 'ended' });

    expect(playNextSpy).toHaveBeenCalledTimes(1);
    expect(player.getCurrentQueueIndex()).toBe(1);
  });

  it('keeps index and playing track consistent during rapid consecutive track changes', async () => {
    const { player } = await createPlayer();
    const tracks = makeTracks(5);
    player.addQueue(tracks, 'DEFAULT');

    // rapid consecutive skips without waiting for playback
    player.playNext();
    player.playNext();
    player.playNext();

    expect(player.getCurrentQueueIndex()).toBe(3);
    expect(player.getCurrentTrack()?.id).toBe('t4');
    expect(player.getQueue()[player.getCurrentQueueIndex()].id).toBe(player.getCurrentTrack()?.id);

    player.playPrevious();
    player.playPrevious();

    expect(player.getCurrentQueueIndex()).toBe(1);
    expect(player.getCurrentTrack()?.id).toBe('t2');
    expect(player.getQueue()[player.getCurrentQueueIndex()].id).toBe(player.getCurrentTrack()?.id);
  });

  it('emits queueended only when the last track finishes', async () => {
    const { player, notifier } = await createPlayer();
    const tracks = makeTracks(2);
    player.addQueue(tracks, 'DEFAULT');

    let latestState: AudioState | undefined;
    player.subscribe('AUDIO_X_STATE', (state: AudioState) => {
      latestState = state;
    });

    notifier.notify('AUDIO_STATE', { playbackState: 'ended' }); // -> t2
    expect(player.getCurrentQueueIndex()).toBe(1);

    notifier.notify('AUDIO_STATE', { playbackState: 'ended' }); // -> queue end
    expect(latestState?.playbackState).toBe('queueended');
  });
});

describe('queue session: shuffle round trip', () => {
  it('restores the original order and keeps the current track playable after unshuffle', async () => {
    const { player, notifier } = await createPlayer();
    const tracks = makeTracks(4);
    player.addQueue(tracks, 'DEFAULT');

    // simulate t2 being the currently playing track
    await player.addMedia(tracks[1]);
    expect(player.getCurrentQueueIndex()).toBe(1);

    player.toggleShuffle();
    expect(player.isShuffledEnabled()).toBe(true);
    const shuffled = player.getQueue();
    // same multiset of tracks, current track still at its position
    expect([...shuffled].map((t) => t.id).sort()).toEqual(['t1', 't2', 't3', 't4']);
    expect(shuffled[player.getCurrentQueueIndex()].id).toBe('t2');

    player.toggleShuffle();
    expect(player.isShuffledEnabled()).toBe(false);
    // original order restored and index re-anchored on the current track
    expect(player.getQueue().map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4']);
    expect(player.getCurrentQueueIndex()).toBe(1);
    expect(player.getQueue()[player.getCurrentQueueIndex()].id).toBe('t2');

    // playback continues from the current track in the restored order
    notifier.notify('AUDIO_STATE', { playbackState: 'ended' });
    expect(player.getCurrentTrack()?.id).toBe('t3');
    expect(player.getCurrentQueueIndex()).toBe(2);
  });

  it('addQueue with SHUFFLE keeps the original queue for a later unshuffle', async () => {
    const { player } = await createPlayer();
    const tracks = makeTracks(4);
    player.addQueue(tracks, 'SHUFFLE');

    expect(player.isShuffledEnabled()).toBe(true);
    expect(player.getQueue()).toHaveLength(4);

    player.toggleShuffle();
    expect(player.getQueue().map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4']);
  });
});
