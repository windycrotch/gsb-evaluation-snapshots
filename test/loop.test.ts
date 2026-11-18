import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { notify } from '../src/helpers/notifier';
import { AudioX } from '../src/index';
import type { MediaTrack } from '../src/types';
import { makePlayableTracks, makeTracks, resetPlayer, setupPlayer, waitFor } from './fixtures';

type AddMediaAndPlay = AudioX['addMediaAndPlay'];

/**
 * Records every real playback start. Observing calls (rather than state
 * notifications) keeps the assertions immune to listener reentrancy inside the
 * notifier: a single queue end must produce exactly one restart of track a.
 */
const recordPlaybackCalls = () => {
  const calls: string[] = [];
  const original = AudioX.prototype.addMediaAndPlay as AddMediaAndPlay;
  AudioX.prototype.addMediaAndPlay = function (this: AudioX, track: MediaTrack, fetchFn) {
    if (track) {
      calls.push(track.id);
    }
    return original.call(this, track, fetchFn);
  } as AddMediaAndPlay;
  return {
    calls,
    startCount: (id: string) => calls.filter((call) => call === id).length,
    restore: () => {
      AudioX.prototype.addMediaAndPlay = original;
    },
  };
};

/** Replaces playback with a recorder, for pure listener-lifecycle assertions. */
const stubPlayback = () => {
  const calls: string[] = [];
  const original = AudioX.prototype.addMediaAndPlay as AddMediaAndPlay;
  AudioX.prototype.addMediaAndPlay = (async (track: MediaTrack) => {
    if (track) {
      calls.push(track.id);
    }
  }) as AddMediaAndPlay;
  return {
    calls,
    restore: () => {
      AudioX.prototype.addMediaAndPlay = original;
    },
  };
};

/** Emits the same event the player emits when the queue runs out. */
const emitQueueEnded = () => {
  notify('AUDIO_STATE', { playbackState: 'queueended' });
};

describe('loop modes', () => {
  let audio: AudioX;

  beforeAll(async () => {
    audio = await setupPlayer();
  });

  afterEach(() => {
    resetPlayer(audio);
  });

  afterAll(() => {
    resetPlayer(audio);
  });

  it('attaches a single queue loop listener even when QUEUE is set repeatedly', () => {
    const stub = stubPlayback();
    try {
      audio.addQueue(makeTracks(['a', 'b']), 'DEFAULT');
      audio.loop('QUEUE');
      audio.loop('QUEUE');
      audio.loop('QUEUE');

      emitQueueEnded();
      expect(stub.calls).toEqual(['a']);

      emitQueueEnded();
      expect(stub.calls).toEqual(['a', 'a']);
    } finally {
      stub.restore();
    }
  });

  it('stops queue looping when switching back to OFF', () => {
    const stub = stubPlayback();
    try {
      audio.addQueue(makeTracks(['a', 'b']), 'DEFAULT');
      audio.loop('QUEUE');
      audio.loop('OFF');

      expect(audio.getLoopMode()).toBe('OFF');
      expect(AudioX.getAudioInstance().loop).toBe(false);

      emitQueueEnded();
      expect(stub.calls).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  it('stops queue looping when switching to SINGLE', () => {
    const stub = stubPlayback();
    try {
      audio.addQueue(makeTracks(['a', 'b']), 'DEFAULT');
      audio.loop('QUEUE');
      audio.loop('SINGLE');

      expect(audio.getLoopMode()).toBe('SINGLE');
      expect(AudioX.getAudioInstance().loop).toBe(true);

      emitQueueEnded();
      expect(stub.calls).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  it('resumes queue looping when QUEUE is re-enabled after OFF', () => {
    const stub = stubPlayback();
    try {
      audio.addQueue(makeTracks(['a', 'b']), 'DEFAULT');
      audio.loop('QUEUE');
      audio.loop('OFF');
      audio.loop('QUEUE');

      emitQueueEnded();
      expect(stub.calls).toEqual(['a']);
    } finally {
      stub.restore();
    }
  });

  it('restarts real playback from the first track once per queue end', async () => {
    const recorder = recordPlaybackCalls();

    const tracks = makePlayableTracks(['a', 'b']);
    audio.addQueue(tracks, 'DEFAULT');
    audio.loop('QUEUE');
    // Re-enabling the same mode must not stack listeners.
    audio.loop('QUEUE');
    audio.addMediaAndPlay(tracks[0]);

    // a -> b -> a proves one loop; a -> b -> a -> b -> a proves it repeats.
    await waitFor(() => recorder.startCount('a') >= 3, {
      timeout: 30000,
      label: 'the queue to restart twice',
    });

    const sequence = recorder.calls.slice(0, recorder.calls.length);
    recorder.restore();

    expect(sequence.slice(0, 5)).toEqual(['a', 'b', 'a', 'b', 'a']);
    expect(audio.getLoopMode()).toBe('QUEUE');
  }, 45000);

  it('stops restarting the queue after switching to OFF', async () => {
    const recorder = recordPlaybackCalls();

    const tracks = makePlayableTracks(['a', 'b']);
    audio.addQueue(tracks, 'DEFAULT');
    audio.loop('QUEUE');
    audio.addMediaAndPlay(tracks[0]);

    await waitFor(() => recorder.startCount('a') >= 2, {
      timeout: 30000,
      label: 'the first queue restart',
    });

    audio.loop('OFF');
    expect(audio.getLoopMode()).toBe('OFF');

    const callsAtSwitch = recorder.calls.length;
    // Let whatever is playing finish; with looping off the player must stop at
    // the end of the queue instead of restarting it.
    await new Promise((resolve) => setTimeout(resolve, 4000));

    const callsAfterOff = recorder.calls.slice(callsAtSwitch);
    recorder.restore();

    expect(callsAfterOff).not.toContain('a');
    expect(AudioX.getAudioInstance().loop).toBe(false);
  }, 45000);

  it('stops restarting the queue after switching to SINGLE', async () => {
    const recorder = recordPlaybackCalls();

    const tracks = makePlayableTracks(['a', 'b']);
    audio.addQueue(tracks, 'DEFAULT');
    audio.loop('QUEUE');
    audio.addMediaAndPlay(tracks[0]);

    await waitFor(() => recorder.startCount('a') >= 2, {
      timeout: 30000,
      label: 'the first queue restart',
    });

    audio.loop('SINGLE');
    expect(audio.getLoopMode()).toBe('SINGLE');
    expect(AudioX.getAudioInstance().loop).toBe(true);

    const callsAtSwitch = recorder.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const callsAfterSwitch = recorder.calls.slice(callsAtSwitch);
    recorder.restore();

    expect(callsAfterSwitch).not.toContain('a');
  }, 45000);
});
