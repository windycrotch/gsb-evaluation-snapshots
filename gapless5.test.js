const xhrMockClass = () => ({
  open            : jest.fn(),
  send            : jest.fn(),
  setRequestHeader: jest.fn(),
  abort           : jest.fn(),
});
XMLHttpRequest = jest.fn().mockImplementation(xhrMockClass);

const audioMockClass = () => ({
  addEventListener: jest.fn(),
  load: jest.fn(),
  pause: jest.fn(),
  play: jest.fn(() => Promise.resolve(jest.fn())),
});
Audio = jest.fn().mockImplementation(audioMockClass);

const audioContextMockClass = () => ({
  createGain: () => ({
    gain: { value: 1 },
    connect: jest.fn(),
  }),
});

window = {
  clearTimeout     : jest.fn(),
  setTimeout       : jest.fn(),
  AudioContext     : jest.fn().mockImplementation(audioContextMockClass),
};

const { Gapless5, Gapless5State, LogLevel } = require('./gapless5.js');

/** test data **/

const TRACKS = [ '0.mp3', '1.mp3', '2.mp3', '3.mp3', '4.mp3' ];
const INIT_OPTIONS = {
  logLevel: LogLevel.None,
  useWebAudio: false,
  useHTML5Audio: false,
};

/** test suite **/

describe('Gapless-5 object', () => {
  let player = null;

  beforeEach(() => {
    player = new Gapless5(INIT_OPTIONS);
  });

  it('has correct initial state', () => {
    expect(player.getTracks()).toStrictEqual([]);
    expect(player.totalTracks()).toBe(0);
    expect(player.getIndex()).toBe(-1);
    expect(player.getPosition()).toBe(0);
    expect(player.canShuffle()).toBe(false);
    expect(player.initialized).toBe(true);
    expect(player.hasGUI).toBe(false);
  });

  it('can manipulate tracklist and position', () => {
    player.addTrack(TRACKS[1]);
    expect(player.getIndex()).toBe(0);
    player.insertTrack(0, TRACKS[0]);
    expect(player.getTracks()).toStrictEqual([ TRACKS[0], TRACKS[1] ]);
    expect(player.findTrack(TRACKS[1])).toBe(1);
    player.setPlaybackRate(0.1);
    player.setPosition(10);
    expect(player.getPosition()).toBe(10);

    player.removeTrack(0);
    expect(player.getTracks()).toStrictEqual([ TRACKS[1] ]);
    player.removeAllTracks();
    expect(player.getTracks()).toStrictEqual([]);
    player.setPosition(10);
    expect(player.getPosition()).toBe(0); // setPosition should do nothing without a track
  });
});

describe('Gapless-5 object with tracklist', () => {
  let player = null;

  beforeEach(() => {
    player = new Gapless5({
      ...INIT_OPTIONS,
      tracks: TRACKS,
    });
  });

  it('has correct initial state', () => {
    expect(player.getTracks()).toStrictEqual(TRACKS);
    expect(player.getIndex()).toBe(0);
    expect(player.getPosition()).toBe(0);
    expect(player.initialized).toBe(true);
    expect(player.hasGUI).toBe(false);
  });

  it('can shuffle and un-shuffle tracklist', () => {
    expect(player.canShuffle()).toBe(true);
    expect(player.isShuffled()).toBe(false);
    player.shuffle();
    expect(player.isShuffled()).toBe(true);

    // shouldn't actually shuffle until we change tracks
    expect(player.getTracks()).toStrictEqual(TRACKS);
    player.next();
    expect(player.getTracks()).not.toStrictEqual(TRACKS);
    expect(player.totalTracks()).toBe(TRACKS.length);

    // shouldn't actually unshuffle until we change tracks
    player.toggleShuffle();
    expect(player.isShuffled()).toBe(false);
    expect(player.getTracks()).not.toStrictEqual(TRACKS);
    player.next();
    expect(player.getTracks()).toStrictEqual(TRACKS);
  });

  it('can navigate the tracklist', () => {
    expect(player.getIndex()).toBe(0);
    player.next();
    expect(player.getIndex()).toBe(1);
    player.prev();
    expect(player.getIndex()).toBe(0);
    player.gotoTrack(2);
    expect(player.getIndex()).toBe(2);

    // should loop around
    player.loop = true;
    TRACKS.forEach(() => player.next());
    expect(player.getIndex()).toBe(2);

    // should not loop around
    player.loop = false;
    TRACKS.forEach(() => player.next());
    expect(player.getIndex()).toBe(TRACKS.length - 1);
  });

  it('triggers navigation callbacks', () => {
    player.onprev = jest.fn();
    player.onnext = jest.fn();
    player.onplayrequest = jest.fn();
    player.onpause = jest.fn();
    player.onstop = jest.fn();

    player.next();
    expect(player.onnext).toHaveBeenCalledWith(TRACKS[0], TRACKS[1]);
    player.prev();
    expect(player.onprev).toHaveBeenCalledWith(TRACKS[1], TRACKS[0]);
    player.play();
    expect(player.onplayrequest).toHaveBeenCalledWith(TRACKS[0]);
    player.pause();
    expect(player.onpause).toHaveBeenCalledWith(TRACKS[0]);
    player.stop();
    expect(player.onstop).toHaveBeenCalledWith(TRACKS[0]);
  });

  it('regression: maintains correct index when removing tracks that come after the currently playing track', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
    });

    // Verify initial state
    expect(testPlayer.getIndex()).toBe(0);
    expect(testPlayer.getTracks()).toStrictEqual(testTracks);

    // Move to track 1
    testPlayer.gotoTrack(1);
    expect(testPlayer.getIndex()).toBe(1);

    // Remove track at index 2
    testPlayer.removeTrack(2);

    // Check index is still 1 and track list is updated
    expect(testPlayer.getIndex()).toBe(1);
    expect(testPlayer.getTracks()).toStrictEqual([ 'track1.mp3', 'track2.mp3' ]);
  });

  it('regression: maintains correct index when removing the currently playing track', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
    });

    // Verify initial state
    expect(testPlayer.getIndex()).toBe(0);
    expect(testPlayer.getTracks()).toStrictEqual(testTracks);

    // Move to track 1
    testPlayer.gotoTrack(1);
    expect(testPlayer.getIndex()).toBe(1);
    testPlayer.play();

    // Remove the currently playing track
    testPlayer.removeTrack(1);

    // Check index is still 1 and track list is updated, therefore we move to the next available track
    expect(testPlayer.getIndex()).toBe(1);
    expect(testPlayer.getTracks()).toStrictEqual([ 'track1.mp3', 'track3.mp3' ]);

    testPlayer.play();

    // Remove the currently playing track
    testPlayer.removeTrack(1);

    // Check index is still 0 and track list is updated, therefore we move to the next available track
    expect(testPlayer.getIndex()).toBe(0);
    expect(testPlayer.getTracks()).toStrictEqual([ 'track1.mp3' ]);

    testPlayer.play();

    // Remove the only remaining track — list is empty, index resets to -1
    testPlayer.removeTrack(0);
    expect(testPlayer.getIndex()).toBe(-1);
    expect(testPlayer.getTracks()).toStrictEqual([]);
  });

  it('regression: removing a track does not wipe shuffledIndices', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3', 'track4.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
    });

    testPlayer.shuffle();
    testPlayer.next(); // commit the shuffle
    expect(testPlayer.isShuffled()).toBe(true);
    expect(testPlayer.playlist.shuffledIndices.length).toBe(testTracks.length);

    testPlayer.removeTrack(0);

    // Shuffle order should still be intact (one fewer entry, still shuffled)
    expect(testPlayer.isShuffled()).toBe(true);
    expect(testPlayer.playlist.shuffledIndices.length).toBe(testTracks.length - 1);
    expect(testPlayer.getTracks().length).toBe(testTracks.length - 1);
  });

  it('regression: removing currently-playing track repeatedly until empty does not crash', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
    });

    // Walk the list down to zero by always removing the current track
    // This reproduces a crash in the pre-PR code where updateLoading()
    // would dereference an undefined source after the list went empty.
    while (testPlayer.getTracks().length > 0) {
      testPlayer.removeTrack(testPlayer.getIndex());
    }
    expect(testPlayer.getTracks()).toStrictEqual([]);
    expect(testPlayer.getIndex()).toBe(-1);
  });

  it('regression: removing current-at-tail with loop=true wraps to start and resumes', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
      loop: true,
    });

    testPlayer.gotoTrack(2);
    expect(testPlayer.getIndex()).toBe(2);

    // Force the tail source to report as playing so removeTrack takes the
    // wasPlaying branch (the mock audio env never transitions real state).
    testPlayer.playlist.sources[2].inPlayState = () => true;

    testPlayer.onnext = jest.fn();
    testPlayer.onplayrequest = jest.fn();

    testPlayer.removeTrack(2);

    expect(testPlayer.getIndex()).toBe(0);
    expect(testPlayer.getTracks()).toStrictEqual([ 'track1.mp3', 'track2.mp3' ]);
    expect(testPlayer.onnext).toHaveBeenCalledWith('track3.mp3', 'track1.mp3');
    expect(testPlayer.onplayrequest).toHaveBeenCalledTimes(1);
    expect(testPlayer.onplayrequest).toHaveBeenCalledWith('track1.mp3');
  });

  it('regression: removing current-at-tail with loop=false clamps and always pauses', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
      loop: false,
    });

    testPlayer.gotoTrack(2);
    expect(testPlayer.getIndex()).toBe(2);

    // Force the tail source to report as playing so removeTrack takes the
    // wasPlaying branch — this is the scenario where the old code would
    // have auto-resumed on the clamped-to-last track.
    testPlayer.playlist.sources[2].inPlayState = () => true;

    testPlayer.onnext = jest.fn();
    testPlayer.onplayrequest = jest.fn();

    testPlayer.removeTrack(2);

    expect(testPlayer.getIndex()).toBe(1);
    expect(testPlayer.getTracks()).toStrictEqual([ 'track1.mp3', 'track2.mp3' ]);
    expect(testPlayer.onnext).toHaveBeenCalledWith('track3.mp3', 'track2.mp3');
    expect(testPlayer.onplayrequest).not.toHaveBeenCalled();
  });

  it('regression: removing a track does not spuriously disable shuffle when never shuffled', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
    });

    expect(testPlayer.isShuffled()).toBe(false);
    const setShuffleSpy = jest.spyOn(testPlayer.playlist, 'setShuffle');

    // Drop to 2 tracks — previously tripped the shuffle-disable path
    // because `this.isShuffled` (a function reference) was always truthy.
    testPlayer.removeTrack(0);

    expect(testPlayer.isShuffled()).toBe(false);
    expect(setShuffleSpy).not.toHaveBeenCalled();
    setShuffleSpy.mockRestore();
  });
});

describe('Gapless-5 object with load limit', () => {
  it('obeys load limit', () => {
    const player = new Gapless5({
      ...INIT_OPTIONS,
      loadLimit: 2,
    });
    const loadedTracks = new Set([]);
    player.onloadstart = (audioPath) => {
      loadedTracks.add(audioPath);
    };
    player.onunload = (audioPath) => {
      loadedTracks.delete(audioPath);
    };

    TRACKS.forEach((track) => player.addTrack(track));
    expect(player.totalTracks()).toBe(TRACKS.length);
    expect(loadedTracks.size).toBe(2);
    player.next();
    expect(loadedTracks.size).toBe(2);
    player.next();
    expect(loadedTracks.size).toBe(2);
    player.removeAllTracks();
    expect(loadedTracks.size).toBe(0);
  });

  it('excludes deleted tracks and reloads around the new current track', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3', 'track4.mp3', 'track5.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
      loadLimit: 3,
    });
    const loaded = new Set();
    testPlayer.onloadstart = (audioPath) => loaded.add(audioPath);
    testPlayer.onunload = (audioPath) => loaded.delete(audioPath);
    testPlayer.playlist.sources.forEach((source) => {
      source.load();
    });
    loaded.clear();
    testPlayer.playlist.updateLoading();
    expect(loaded.size).toBeLessThanOrEqual(3);

    testPlayer.gotoTrack(2);
    testPlayer.removeTrack(2);

    // the loadable set must never reference a removed track
    const loadable = [ ...testPlayer.playlist.loadableTracks() ];
    expect(loadable.length).toBeLessThanOrEqual(3);
    loadable.forEach((index) => {
      expect(testPlayer.playlist.sources[index]).toBeDefined();
      expect(index).toBeLessThan(testPlayer.totalTracks());
    });
    expect(loaded.size).toBeLessThanOrEqual(3);
    // the new current track is prioritised for loading
    expect(testPlayer.getTrack()).toBe('track4.mp3');
    expect(loaded.has('track4.mp3')).toBe(true);
  });
});

describe('Gapless-5 crossfade lifecycle', () => {
  const makePlayer = (options = {}) => {
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: [ 'track1.mp3', 'track2.mp3', 'track3.mp3' ],
      crossfade: 100,
      ...options,
    });
    return testPlayer;
  };

  // The mock window records timeouts instead of scheduling them, so tests
  // can drive the crossfade completion deterministically.
  const flushTimers = () => {
    const pending = window.setTimeout.mock.calls.splice(0);
    pending.forEach(([ callback ]) => callback());
  };

  beforeEach(() => {
    window.setTimeout.mockClear();
    window.clearTimeout.mockClear();
  });

  it('fades out the outgoing track and releases it after the crossfade', () => {
    const testPlayer = makePlayer();
    const [ first, second ] = testPlayer.playlist.sources;
    first.inPlayState = () => true;

    testPlayer.gotoTrack(1);

    expect(testPlayer.getIndex()).toBe(1);
    expect(testPlayer.fadingTrack).toBe(0);
    expect(testPlayer.getFadingSource()).toBe(first);
    expect(second.getState()).not.toBe(Gapless5State.None);

    flushTimers();

    // after the crossfade the old track is stopped and fully released
    expect(testPlayer.fadingTrack).toBeNull();
    expect(testPlayer.getFadingSource()).toBeNull();
    expect(first.getState()).toBe(Gapless5State.Stop);
    expect(first.getPosition()).toBe(0);
    // and the new track is still the only playable one
    expect(testPlayer.getTrack()).toBe('track2.mp3');
  });

  it('does not create a fading track when crossfade is disabled', () => {
    const testPlayer = makePlayer({ crossfade: 0 });
    const [ first ] = testPlayer.playlist.sources;
    first.inPlayState = () => true;

    testPlayer.gotoTrack(1);
    expect(testPlayer.fadingTrack).toBeNull();
    expect(testPlayer.getFadingSource()).toBeNull();
  });

  it('ending a fade immediately when another track change happens', () => {
    const testPlayer = makePlayer();
    const [ first, second, third ] = testPlayer.playlist.sources;
    first.inPlayState = () => true;
    testPlayer.gotoTrack(1);
    expect(testPlayer.getFadingSource()).toBe(first);

    // seed a playing state on the second track so the next jump also fades
    second.inPlayState = () => true;
    testPlayer.gotoTrack(2);

    // only one fade may be active, and the previous source was released
    expect(testPlayer.getFadingSource()).toBe(second);
    expect(testPlayer.fadingTrack).toBe(1);
    expect(first.getState()).toBe(Gapless5State.Stop);
    flushTimers();
    expect(second.getState()).toBe(Gapless5State.Stop);
    expect(third).toBeTruthy();
  });

  it('stops the fade when playback is stopped mid-crossfade', () => {
    const testPlayer = makePlayer();
    const [ first ] = testPlayer.playlist.sources;
    first.inPlayState = () => true;

    testPlayer.gotoTrack(1);
    expect(testPlayer.getFadingSource()).toBe(first);

    testPlayer.stop();

    expect(testPlayer.fadingTrack).toBeNull();
    expect(testPlayer.getFadingSource()).toBeNull();
    expect(first.getState()).toBe(Gapless5State.Stop);
    expect(window.clearTimeout).toHaveBeenCalled();
  });

  it('clears a queued target that gets removed instead of jumping to the wrong track', () => {
    const testPlayer = makePlayer();
    testPlayer.queueTrack('track2.mp3');
    expect(testPlayer.queuedTrack).toBe('track2.mp3');

    testPlayer.removeTrack('track2.mp3');

    expect(testPlayer.queuedTrack).toBeNull();
    expect(testPlayer.queuedPath).toBeNull();
    expect(testPlayer.getTracks()).toStrictEqual([ 'track1.mp3', 'track3.mp3' ]);
  });

  it('clears the queue after it has been played', () => {
    const testPlayer = makePlayer();
    testPlayer.queueTrack(2);
    expect(testPlayer.queuedTrack).toBe(2);

    testPlayer.onEndedCallback();

    expect(testPlayer.getIndex()).toBe(2);
    expect(testPlayer.getTrack()).toBe('track3.mp3');
    expect(testPlayer.queuedTrack).toBeNull();
    expect(testPlayer.queuedPath).toBeNull();
  });

  it('drops the queue when the whole playlist is cleared', () => {
    const testPlayer = makePlayer();
    testPlayer.queueTrack('track3.mp3');
    expect(testPlayer.queuedTrack).toBe('track3.mp3');

    testPlayer.removeAllTracks();

    expect(testPlayer.queuedTrack).toBeNull();
    expect(testPlayer.fadingTrack).toBeNull();
    expect(testPlayer.getTracks()).toStrictEqual([]);
  });

  it('removing the fading track does not leave a dangling fade reference', () => {
    const testPlayer = makePlayer();
    const [ first ] = testPlayer.playlist.sources;
    first.inPlayState = () => true;

    testPlayer.gotoTrack(1);
    expect(testPlayer.getFadingSource()).toBe(first);

    testPlayer.removeTrack(0);

    // the removed source is no longer tracked as fading
    expect(testPlayer.getFadingSource()).toBeNull();
    expect(testPlayer.fadingTrack).toBeNull();
    expect(testPlayer.getTracks()).toStrictEqual([ 'track2.mp3', 'track3.mp3' ]);
    expect(testPlayer.getIndex()).toBe(0);
  });

  it('re-anchors the fade index when an earlier track is removed', () => {
    const testPlayer = makePlayer({ tracks: [ 'track1.mp3', 'track2.mp3', 'track3.mp3', 'track4.mp3' ] });
    const sources = testPlayer.playlist.sources;
    sources[0].inPlayState = () => true;
    testPlayer.gotoTrack(1);

    // make the new current track start playing, then jump on so that the
    // previous current track (playlist index 1) becomes the fading one
    sources[1].inPlayState = () => true;
    testPlayer.gotoTrack(2);
    const fadingSource = testPlayer.getFadingSource();
    expect(fadingSource).toBe(sources[1]);
    expect(testPlayer.fadingTrack).toBe(1);

    // remove a track before both the current track and the fading track
    testPlayer.removeTrack(0);

    expect(testPlayer.getFadingSource()).toBe(fadingSource);
    expect(testPlayer.fadingTrack).toBe(0);
    expect(testPlayer.getIndex()).toBe(1);
  });

  it('removing the fading track then changing tracks leaves no dangling fade', () => {
    const testPlayer = makePlayer({ tracks: [ 'track1.mp3', 'track2.mp3', 'track3.mp3', 'track4.mp3' ] });
    const [ first ] = testPlayer.playlist.sources;
    first.inPlayState = () => true;
    testPlayer.gotoTrack(1);
    expect(testPlayer.getFadingSource()).toBe(first);

    testPlayer.removeTrack(0);
    expect(testPlayer.getFadingSource()).toBeNull();

    // an immediate track change must not resurrect or stack a fade
    const newCurrent = testPlayer.currentSource();
    newCurrent.inPlayState = () => true;
    testPlayer.gotoTrack(testPlayer.getIndex() + 1);
    const fading = testPlayer.getFadingSource();
    expect(fading).not.toBe(first);
    expect(fading).toBe(newCurrent);
    expect(testPlayer.fadingTrack).not.toBeNull();
    flushTimers();
    expect(testPlayer.getFadingSource()).toBeNull();
    expect(testPlayer.fadingTrack).toBeNull();
  });

  it('counts the fading track against the load limit', () => {
    const testPlayer = makePlayer({
      tracks: [ 'track1.mp3', 'track2.mp3', 'track3.mp3', 'track4.mp3', 'track5.mp3' ],
      loadLimit: 2,
    });
    const sources = testPlayer.playlist.sources;
    sources[0].inPlayState = () => true;

    testPlayer.gotoTrack(1);
    expect(testPlayer.getFadingSource()).toBe(sources[0]);

    const loadable = [ ...testPlayer.playlist.loadableTracks() ];
    expect(loadable.length).toBeLessThanOrEqual(2);
    // both the new current track and the fading track keep a slot
    expect(loadable).toContain(testPlayer.getIndex());
    expect(loadable).toContain(testPlayer.fadingTrack);

    flushTimers();

    // once the fade ends the outgoing track's slot is released
    const afterFade = [ ...testPlayer.playlist.loadableTracks() ];
    expect(afterFade).not.toContain(0);
    expect(afterFade.length).toBeLessThanOrEqual(2);
  });

  it('keeps the fade anchored when a track is inserted before it', () => {
    const testPlayer = makePlayer();
    const firstSource = testPlayer.playlist.sources[0];
    firstSource.inPlayState = () => true;
    testPlayer.gotoTrack(1);
    expect(testPlayer.getFadingSource()).toBe(firstSource);
    expect(testPlayer.fadingTrack).toBe(0);

    testPlayer.insertTrack(0, 'new.mp3');

    expect(testPlayer.getFadingSource()).toBe(firstSource);
    expect(testPlayer.fadingTrack).toBe(1);
    flushTimers();
    expect(testPlayer.getFadingSource()).toBeNull();
  });

  it('keeping the loadable set valid when removing the current track under a load limit', () => {
    const testPlayer = makePlayer({
      tracks: [ 'track1.mp3', 'track2.mp3', 'track3.mp3', 'track4.mp3', 'track5.mp3' ],
      loadLimit: 2,
    });
    testPlayer.gotoTrack(1);

    testPlayer.removeTrack(1);

    const loadable = [ ...testPlayer.playlist.loadableTracks() ];
    expect(loadable.length).toBeLessThanOrEqual(2);
    expect(loadable.length).toBeGreaterThan(0);
    loadable.forEach((index) => {
      expect(testPlayer.playlist.sources[index]).toBeDefined();
    });
    expect(loadable).toContain(testPlayer.getIndex());
    expect(testPlayer.getTrack()).toBe('track3.mp3');
  });
});
