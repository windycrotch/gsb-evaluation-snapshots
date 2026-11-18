import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { notify } from '../src/helpers/notifier';
import { AudioX } from '../src/index';
import { getCurrentTrackId, getTrackIds, makeTracks, resetPlayer, setupPlayer } from './fixtures';

describe('queue operations', () => {
  let audio: AudioX;

  beforeAll(async () => {
    audio = await setupPlayer();
  });

  beforeEach(() => {
    resetPlayer(audio);
  });

  afterAll(() => {
    resetPlayer(audio);
  });

  describe('removeFromQueue', () => {
    it('removes only the requested track and keeps the remaining order', () => {
      const tracks = makeTracks(['a', 'b', 'c', 'd']);
      audio.addQueue(tracks, 'DEFAULT');

      audio.removeFromQueue(tracks[2]);

      expect(getTrackIds(audio)).toEqual(['a', 'b', 'd']);
    });

    it('keeps the cursor on the current track when an earlier track is removed', () => {
      const tracks = makeTracks(['a', 'b', 'c', 'd']);
      audio.addQueue(tracks, 'DEFAULT');

      audio.playNext(); // b
      audio.playNext(); // c
      expect(getCurrentTrackId()).toBe('c');

      audio.removeFromQueue(tracks[0]); // remove a, before the cursor
      expect(getTrackIds(audio)).toEqual(['b', 'c', 'd']);

      audio.playNext();
      // c shifted from index 2 to 1, so the next track is still d
      expect(getCurrentTrackId()).toBe('d');
    });

    it('removes the current track without breaking playNext continuation', () => {
      const tracks = makeTracks(['a', 'b', 'c', 'd']);
      audio.addQueue(tracks, 'DEFAULT');

      audio.playNext(); // b, index 1
      expect(getCurrentTrackId()).toBe('b');

      audio.removeFromQueue(tracks[1]); // remove the playing track
      expect(getTrackIds(audio)).toEqual(['a', 'c', 'd']);

      // b's successor in the original order is c
      audio.playNext();
      expect(getCurrentTrackId()).toBe('c');

      // and the cursor keeps moving forward normally
      audio.playNext();
      expect(getCurrentTrackId()).toBe('d');
    });

    it('removes the current first track and continues with the new first track', () => {
      const tracks = makeTracks(['a', 'b', 'c']);
      audio.addQueue(tracks, 'DEFAULT');

      expect(getTrackIds(audio)).toEqual(['a', 'b', 'c']);
      audio.removeFromQueue(tracks[0]);

      expect(getTrackIds(audio)).toEqual(['b', 'c']);
      audio.playNext();
      expect(getCurrentTrackId()).toBe('b');
    });

    it('does not let the index run past the end when the last track is removed', () => {
      const tracks = makeTracks(['a', 'b', 'c']);
      audio.addQueue(tracks, 'DEFAULT');

      audio.playNext(); // b
      audio.playNext(); // c (last)
      expect(getCurrentTrackId()).toBe('c');

      audio.removeFromQueue(tracks[2]);

      expect(getTrackIds(audio)).toEqual(['a', 'b']);
      const states: string[] = [];
      const unsubscribe = audio.subscribe('AUDIO_STATE', (state) => {
        states.push(state.playbackState);
      });

      expect(() => audio.playNext()).not.toThrow();
      expect(states).toContain('queueended');
      unsubscribe();
    });

    it('ignores unknown ids and removing the last entry resets the queue', () => {
      const tracks = makeTracks(['a']);
      audio.addQueue(tracks, 'DEFAULT');

      audio.removeFromQueue({ ...tracks[0], id: 'missing' });
      expect(getTrackIds(audio)).toEqual(['a']);

      audio.removeFromQueue(tracks[0]);
      expect(audio.getQueue()).toEqual([]);
      expect(() => audio.playNext()).not.toThrow();
    });
  });

  describe('addToQueue', () => {
    it('accepts a single track on an empty queue', () => {
      audio.clearQueue();
      audio.addToQueue(makeTracks(['x'])[0]);

      expect(getTrackIds(audio)).toEqual(['x']);
    });

    it('appends arrays on an empty queue and ignores empty arrays', () => {
      audio.clearQueue();
      audio.addToQueue(makeTracks(['x', 'y']));

      expect(getTrackIds(audio)).toEqual(['x', 'y']);

      audio.addToQueue([]);
      expect(getTrackIds(audio)).toEqual(['x', 'y']);

      audio.addToQueue(makeTracks(['z'])[0]);
      expect(getTrackIds(audio)).toEqual(['x', 'y', 'z']);
    });

    it('appends to a populated queue without dropping existing tracks', () => {
      audio.addQueue(makeTracks(['a', 'b']), 'DEFAULT');
      audio.addToQueue(makeTracks(['c'])[0]);
      audio.addToQueue(makeTracks(['d', 'e']));

      expect(getTrackIds(audio)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });
  });

  describe('toggleShuffle', () => {
    it('restores the exact pre-shuffle order after two toggles', () => {
      const tracks = makeTracks(['a', 'b', 'c', 'd', 'e', 'f']);
      audio.addQueue(tracks, 'DEFAULT');
      audio.playNext();
      audio.playNext(); // current: c

      const before = getTrackIds(audio);

      audio.toggleShuffle();
      expect(audio.isShuffledEnabled()).toBe(true);
      expect([...getTrackIds(audio)].sort()).toEqual([...before].sort());
      expect(getTrackIds(audio).filter((id) => id === 'c')).toHaveLength(1);

      audio.toggleShuffle();
      expect(audio.isShuffledEnabled()).toBe(false);
      expect(getTrackIds(audio)).toEqual(before);

      // current track stays reachable, playNext continues with d
      audio.playNext();
      expect(getCurrentTrackId()).toBe('d');
    });

    it('does not treat the shuffled order as the original order on repeated toggles', () => {
      const tracks = makeTracks(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
      audio.addQueue(tracks, 'DEFAULT');
      const before = getTrackIds(audio);

      for (let i = 0; i < 3; i++) {
        audio.toggleShuffle();
        audio.toggleShuffle();
        expect(getTrackIds(audio)).toEqual(before);
      }
      expect(audio.isShuffledEnabled()).toBe(false);
    });

    it('keeps the current track once when addQueue is called with SHUFFLE', () => {
      const tracks = makeTracks(['x', 'a', 'y', 'a', 'z']);
      audio.addQueue(tracks, 'DEFAULT');
      audio.playNext(); // current: a
      expect(getCurrentTrackId()).toBe('a');

      audio.addQueue(makeTracks(['x', 'a', 'y', 'a', 'z']), 'SHUFFLE');

      const ids = getTrackIds(audio);
      expect(ids).toHaveLength(4);
      expect(ids.filter((id) => id === 'a')).toHaveLength(1);
      expect([...ids].sort()).toEqual(['a', 'x', 'y', 'z']);

      // the cursor still points at a, so playNext moves on to another track
      audio.playNext();
      expect(getCurrentTrackId()).not.toBe('a');
      expect(ids).toContain(getCurrentTrackId());
    });

    it('keeps newly added tracks in the restored original order', () => {
      audio.addQueue(makeTracks(['a', 'b']), 'DEFAULT');
      audio.toggleShuffle();
      audio.addToQueue(makeTracks(['c'])[0]);
      audio.toggleShuffle();

      expect(getTrackIds(audio)).toEqual(['a', 'b', 'c']);
      expect(audio.isShuffledEnabled()).toBe(false);
    });
  });

  describe('addQueue SHUFFLE', () => {
    it('produces a permutation of the input without losing tracks', () => {
      const tracks = makeTracks(['a', 'b', 'c', 'd', 'e']);
      audio.addQueue(tracks, 'SHUFFLE');

      const ids = getTrackIds(audio);
      expect(audio.isShuffledEnabled()).toBe(true);
      expect([...ids].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);

      audio.toggleShuffle();
      expect(getTrackIds(audio)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });
  });

  describe('queue advance on track end', () => {
    it('advances exactly one track per ended event', () => {
      const tracks = makeTracks(['a', 'b', 'c', 'd']);
      const advanced: string[] = [];
      const original = AudioX.prototype.addMediaAndPlay;
      AudioX.prototype.addMediaAndPlay = function (this: AudioX, track, fetchFn) {
        if (track) {
          advanced.push(track.id);
        }
        return original.call(this, track, fetchFn);
      } as typeof original;

      try {
        // Every addQueue call registers queue playback handling; a single
        // ended event must still advance the queue only once.
        audio.addQueue(tracks, 'DEFAULT');
        audio.addQueue(tracks, 'DEFAULT');
        audio.addQueue(tracks, 'DEFAULT');

        notify('AUDIO_STATE', { playbackState: 'ended' });

        expect(advanced).toHaveLength(1);
        expect(advanced[0]).toBe('b');
      } finally {
        AudioX.prototype.addMediaAndPlay = original;
      }
    });
  });
});
