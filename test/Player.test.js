import assert from 'assert';
import './helpers/setup';
import Player from '../src/Player';
import EventEmitter from '../src/EventEmitter';

// A controllable stand-in for Clip. It implements just the surface that the
// Player drives: the playback position, duration, seek entry point and the
// lifecycle methods. No AudioContext or fetching is involved.
class FakeClip extends EventEmitter {
  constructor({ duration = 10, currentTime = 0 } = {}) {
    super();
    this._duration = duration;
    this._currentTime = currentTime;
    this.seekCalls = [];
    this.stopCount = 0;
    this.disposed = false;
  }

  get duration() {
    return this._duration;
  }

  get currentTime() {
    return this._currentTime;
  }

  setCurrentPosition(position, lastAllowedPosition) {
    this.seekCalls.push({ position, lastAllowedPosition });
    this._currentTime = position * this._duration;
    return Promise.resolve();
  }

  play() {
    return Promise.resolve();
  }

  resume() {
    return Promise.resolve();
  }

  pause() {
    return Promise.resolve();
  }

  stop() {
    this.stopCount += 1;
  }

  dispose() {
    this.disposed = true;
  }

  offAll() {}
}

// Build a Player without running its constructor (which wires up the silence
// loader and DOM audio element), then attach the minimal state its methods
// touch.
const createPlayer = ({ clip, track = { url: 'track-1' }, nextTrack = null } = {}) => {
  const player = Object.create(Player.prototype);
  player.clips = { [track.url]: clip };
  player.currentlyPlaying = {
    clip,
    track,
    url: track.url,
    lastReportedProgress: 0,
  };
  player.nextTrack = nextTrack;
  player._playbackPositionInterval = null;

  player.onPreviousTrackCalls = 0;
  player.onNextTrackCalls = [];
  player.onPreviousTrack = () => {
    player.onPreviousTrackCalls += 1;
  };
  player.onNextTrack = (current, next) => {
    player.onNextTrackCalls.push({ current, next });
  };
  player.onPlaybackProgress = () => {};
  player.onPlaybackEnded = () => {};
  player.onError = () => {};
  player.onTrackChanged = () => {};
  player.onReady = () => {};
  player.onVolumeChanged = () => {};

  return player;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

context('Player', () => {
  context('#seek boundary behavior', () => {
    it('triggers the previous-track callback and stops when seeking before 0', async () => {
      const clip = new FakeClip({ duration: 10, currentTime: 2 });
      const player = createPlayer({ clip });

      await player.seek(-5); // (2 - 5) / 10 = -0.3

      assert.equal(player.onPreviousTrackCalls, 1);
      assert.equal(player.currentlyPlaying, null);
      assert.ok(clip.stopCount >= 1);
      // The current clip must not be restarted at any position.
      assert.deepEqual(clip.seekCalls, []);
    });

    it('switches to the next track when seeking past the end and one is queued', async () => {
      const clip = new FakeClip({ duration: 10, currentTime: 9 });
      const nextTrack = { url: 'track-2' };
      const player = createPlayer({ clip, nextTrack });
      player.playTrack = (track) => {
        player.switchedTo = track;
        return Promise.resolve();
      };

      await player.seek(3); // (9 + 3) / 10 = 1.2

      assert.equal(player.nextTrack, null);
      assert.deepEqual(player.switchedTo, nextTrack);
      assert.equal(player.onNextTrackCalls.length, 1);
      assert.equal(player.onNextTrackCalls[0].next, nextTrack);
      // The old clip must not receive an in-place seek.
      assert.deepEqual(clip.seekCalls, []);
    });

    it('does not switch tracks when seeking past the end without a next track', async () => {
      const clip = new FakeClip({ duration: 10, currentTime: 9 });
      const player = createPlayer({ clip, nextTrack: null });
      player.playTrack = () => {
        throw new Error('playTrack must not be called');
      };

      await player.seek(3); // 1.2 >= 1, but nothing is queued

      assert.deepEqual(player.onNextTrackCalls, []);
      // Clamp to the end of the current track instead of switching.
      assert.deepEqual(clip.seekCalls, [{ position: 1, lastAllowedPosition: undefined }]);
      assert.ok(player.currentlyPlaying);
    });

    it('seeks within the current track for an in-range position', async () => {
      const clip = new FakeClip({ duration: 10, currentTime: 2 });
      const player = createPlayer({ clip });

      await player.seek(3); // (2 + 3) / 10 = 0.5

      assert.equal(player.onPreviousTrackCalls, 0);
      assert.deepEqual(player.onNextTrackCalls, []);
      assert.deepEqual(clip.seekCalls, [
        { position: 0.5, lastAllowedPosition: undefined },
      ]);
    });

    it('rejects when nothing is currently playing', () => {
      const player = createPlayer({ clip: new FakeClip() });
      player.currentlyPlaying = null;

      return player.seek(5).then(
        () => assert.fail('expected a rejection'),
        () => assert.ok(true)
      );
    });
  });

  context('250ms playback progress reporting', () => {
    let clip;
    let player;
    let reports;

    // Install and start the *real* reporting interval by running the same
    // entry point production uses, against a fake clip.
    const startReporting = async (initialTime = 0) => {
      clip = new FakeClip({ duration: 10, currentTime: initialTime });
      player = createPlayer({ clip });
      // Start with no active track so __DEPRECATED__playTrack takes the full
      // setup path (which installs the reporting interval) rather than its
      // early "same URL -> resume" branch.
      player.currentlyPlaying = null;
      player.ready = true;
      reports = [];
      player.onPlaybackProgress = (progress) => reports.push(progress);

      const track = {
        url: 'track-1',
        fileSize: 1000,
        onBufferChange: () => {},
        onBufferProgress: () => {},
      };
      // The clip is already cached, so this wires up the interval and starts
      // playback without touching the network or the DOM.
      await player.__DEPRECATED__playTrack(track, track);
      // `__DEPRECATED__playTrack` rebuilds `currentlyPlaying`; keep the
      // reference the reporting interval actually reads.
      clip = player.currentlyPlaying.clip;
    };

    afterEach(() => {
      if (player) player._clearIntervals();
    });

    it('reports progress within [0, 1] and freezes it while paused', async () => {
      await startReporting();

      // Simulate playback advancing, then a pause that holds the position.
      clip._currentTime = 3;
      await wait(300);
      clip._currentTime = 3; // paused: the observable position is frozen
      await wait(300);

      assert.ok(reports.length >= 2);
      reports.forEach((progress) => {
        assert.ok(progress >= 0 && progress <= 1);
      });

      const lastWhilePlaying = reports[reports.length - 2];
      const whilePaused = reports[reports.length - 1];
      assert.equal(whilePaused, lastWhilePlaying);
      assert.equal(whilePaused, 0.3);
    });

    it('clamps an overshooting currentTime down to 1', async () => {
      await startReporting(12);

      await wait(300);

      // Ignore the initial synchronous report emitted during track setup; the
      // assertions target the 250ms interval reports driven by currentTime.
      const intervalReports = reports.slice(1);
      assert.ok(intervalReports.length >= 1);
      intervalReports.forEach((progress) => assert.equal(progress, 1));
    });

    it('clamps a negative currentTime up to 0', async () => {
      await startReporting(-4);

      await wait(300);

      const intervalReports = reports.slice(1);
      assert.ok(intervalReports.length >= 1);
      intervalReports.forEach((progress) => assert.equal(progress, 0));
    });
  });
});
