import { describe, expect, it, vi } from 'vitest';
import { createPlayer, makeTracks } from './helpers';

describe('loop mode: session-scoped queue-end listeners', () => {
  it('replays the first track when the queue ends in QUEUE loop mode', async () => {
    const { player, notifier } = await createPlayer();
    const tracks = makeTracks(3);
    player.addQueue(tracks, 'DEFAULT');
    player.loop('QUEUE');

    const addMediaAndPlaySpy = vi.spyOn(player, 'addMediaAndPlay');
    notifier.notify('AUDIO_STATE', { playbackState: 'queueended' });

    expect(addMediaAndPlaySpy).toHaveBeenCalledTimes(1);
    expect(addMediaAndPlaySpy.mock.calls[0][0]?.id).toBe('t1');
  });

  it('stops replaying after switching loop mode off', async () => {
    const { player, notifier } = await createPlayer();
    player.addQueue(makeTracks(3), 'DEFAULT');
    player.loop('QUEUE');
    player.loop('OFF');

    const addMediaAndPlaySpy = vi.spyOn(player, 'addMediaAndPlay');
    notifier.notify('AUDIO_STATE', { playbackState: 'queueended' });

    expect(addMediaAndPlaySpy).not.toHaveBeenCalled();
  });

  it('does not stack loop listeners when toggling modes repeatedly', async () => {
    const { player, notifier } = await createPlayer();
    player.addQueue(makeTracks(3), 'DEFAULT');

    // every QUEQUE registration previously added a permanent listener
    player.loop('QUEUE');
    player.loop('SINGLE');
    player.loop('QUEUE');
    player.loop('OFF');
    player.loop('QUEUE');

    const addMediaAndPlaySpy = vi.spyOn(player, 'addMediaAndPlay');
    notifier.notify('AUDIO_STATE', { playbackState: 'queueended' });

    expect(addMediaAndPlaySpy).toHaveBeenCalledTimes(1);
  });

  it('loop listener from an old queue session never fires in a new session', async () => {
    const { player, notifier } = await createPlayer();
    player.addQueue(makeTracks(3, 'old'), 'DEFAULT');
    player.loop('QUEUE');

    // new queue session: loop stays armed but must follow the NEW queue
    const newTracks = makeTracks(2, 'new');
    player.addQueue(newTracks, 'DEFAULT');

    const addMediaAndPlaySpy = vi.spyOn(player, 'addMediaAndPlay');
    notifier.notify('AUDIO_STATE', { playbackState: 'queueended' });

    expect(addMediaAndPlaySpy).toHaveBeenCalledTimes(1);
    expect(addMediaAndPlaySpy.mock.calls[0][0]?.id).toBe('new1');
  });

  it('clearQueue invalidates both queue-end and loop listeners', async () => {
    const { player, notifier } = await createPlayer();
    player.addQueue(makeTracks(3), 'DEFAULT');
    player.loop('QUEUE');
    player.clearQueue();

    const playNextSpy = vi.spyOn(player, 'playNext');
    const addMediaAndPlaySpy = vi.spyOn(player, 'addMediaAndPlay');

    notifier.notify('AUDIO_STATE', { playbackState: 'ended' });
    notifier.notify('AUDIO_STATE', { playbackState: 'queueended' });

    expect(playNextSpy).not.toHaveBeenCalled();
    expect(addMediaAndPlaySpy).not.toHaveBeenCalled();
    expect(player.getQueue()).toEqual([]);
    expect(player.getCurrentQueueIndex()).toBe(0);
  });

  it('toggles the element loop flag for SINGLE and OFF', async () => {
    const { player, AudioX } = await createPlayer();
    player.addQueue(makeTracks(2), 'DEFAULT');
    const element = AudioX.getAudioInstance();

    player.loop('SINGLE');
    expect(element.loop).toBe(true);
    expect(player.getLoopMode()).toBe('SINGLE');

    player.loop('QUEUE');
    expect(element.loop).toBe(false);

    player.loop('OFF');
    expect(element.loop).toBe(false);
    expect(player.getLoopMode()).toBe('OFF');
  });
});
