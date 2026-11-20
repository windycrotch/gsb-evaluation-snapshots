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

const { Gapless5, LogLevel } = require('./gapless5.js');

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
});

// Helpers for the quota/crossfade lifecycle tests below.
// The file-level window.setTimeout mock is a no-op, so we install a
// controllable per-player timer registry for crossfade timing.
const makeTimerMocks = () => {
  const pending = new Map();
  let nextId = 1;
  return {
    setTimeout: (fn) => {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clearTimeout: (id) => {
      pending.delete(id);
    },
    // run every timer currently scheduled (crossfade finalizers)
    flush: () => {
      const callbacks = [ ...pending.values() ];
      pending.clear();
      callbacks.forEach((fn) => fn());
    },
    // The player's constructor starts an internal tick() loop, which is not
    // part of the crossfade lifecycle under test.  Fade timers are always
    // scheduled after construction, so we count everything beyond the first.
    fadeTimerCount: () => Math.max(0, pending.size - 1),
  };
};

// Gapless5 source state constants (mirrors Gapless5State in gapless5.js)
const G5_NONE = 0;
const G5_STOP = 4;

// With both audio backends disabled, load() flips a source to Loading (1) and
// nothing ever completes it, while unload() would mark it Error (5) which is
// not reloadable.  This stub makes loading instant and unloading reversible so
// the quota/lifecycle code behaves like a browser where fetches resolve.
// Source methods are own properties, so each source must be wrapped directly;
// we wrap the playlist's add() (the single source-creation entry point) and
// any sources already created by the constructor.
const stubSource = (source, player) => {
  source.load = () => {
    if (source.getState() === G5_NONE) {
      player.onloadstart(source.audioPath);
      source.getState = () => G5_STOP;
    }
  };
  const origUnload = source.unload;
  source.unload = (isError) => {
    source.getState = () => G5_NONE;
    origUnload.call(source, isError);
  };
};

const createTrackedPlayer = (options) => {
  const timerMocks = makeTimerMocks();
  window.setTimeout = timerMocks.setTimeout;
  window.clearTimeout = timerMocks.clearTimeout;
  const loadedTracks = new Set();
  const { tracks, ...playerOptions } = options || {};

  // Callbacks are own properties initialized in the constructor, so options
  // passed here cannot override them — assign them after construction like
  // the existing load-limit tests do.
  const player = new Gapless5({
    ...INIT_OPTIONS,
    ...playerOptions,
  });
  player.onloadstart = (audioPath) => loadedTracks.add(audioPath);
  player.onunload = (audioPath) => loadedTracks.delete(audioPath);

  // wrap playlist.add: original runs first (creates source + updateLoading,
  // which with disabled backends leaves the freshly-loaded source stuck in
  // Loading).  We then install reversible stubs, reset any source stuck in
  // Loading back to None, and re-run reconciliation under the stubs.
  const originalAdd = player.playlist.add.bind(player.playlist);
  player.playlist.add = (index, audioPath) => {
    originalAdd(index, audioPath);
    const created = player.playlist.sources[index];
    if (created.getState() === 1) {
      created.getState = () => G5_NONE;
    }
    stubSource(created, player);
    player.playlist.updateLoading();
  };
  // constructor-created sources (none when tracks omitted, but be safe)
  player.playlist.sources.forEach((source) => {
    if (source.getState() === 1) {
      source.getState = () => G5_NONE;
    }
    stubSource(source, player);
  });

  if (tracks) {
    tracks.forEach((track) => player.addTrack(track));
  }
  return { player: player, loadedTracks: loadedTracks, timerMocks: timerMocks };
};

// source state check without reaching into Gapless5State constants
const isSourceLoaded = (player, path) => {
  const source = player.playlist.sources.find((s) => s.audioPath === path);
  return Boolean(source && source.getState() !== 0);
};

// drives the natural end-of-track flow (which triggers the crossfade)
const simulateTrackEnd = (player) => {
  player.playlist.sources[player.getIndex()].inPlayState = () => true;
  player.onEndedCallback();
};

describe('Gapless-5 load quota under navigation', () => {
  it('loads the correct set after ordinary next/prev navigation', () => {
    const { player, loadedTracks } = createTrackedPlayer({
      tracks: TRACKS,
      loadLimit: 3,
    });
    expect(player.getIndex()).toBe(0);

    player.next();
    expect(player.getIndex()).toBe(1);
    expect(loadedTracks.size).toBeLessThanOrEqual(3);
    // the quota window must always contain the current track
    expect(loadedTracks.has(TRACKS[1])).toBe(true);
    expect(isSourceLoaded(player, TRACKS[1])).toBe(true);

    player.next();
    expect(player.getIndex()).toBe(2);
    expect(loadedTracks.has(TRACKS[2])).toBe(true);

    player.prev();
    expect(player.getIndex()).toBe(1);
    expect(loadedTracks.has(TRACKS[1])).toBe(true);
    // nothing outside the quota window remains loaded
    loadedTracks.forEach((path) => {
      const index = player.findTrack(path);
      expect(player.playlist.loadableTracks().has(index)).toBe(true);
    });
  });

  it('converges on the final track after rapid consecutive next clicks', () => {
    const { player, loadedTracks } = createTrackedPlayer({
      tracks: TRACKS,
      loadLimit: 2,
    });
    // user mashes "next" far faster than anything can load
    player.next();
    player.next();
    player.next();
    player.next();

    expect(player.getIndex()).toBe(TRACKS.length - 1);
    const finalPath = TRACKS[TRACKS.length - 1];
    // the final resting track is always covered by the quota window
    expect(player.playlist.loadableTracks().has(player.getIndex())).toBe(true);
    expect(loadedTracks.has(finalPath)).toBe(true);
    expect(isSourceLoaded(player, finalPath)).toBe(true);

    // every loaded track lives inside the final window; skipped
    // intermediates do not keep occupying slots
    expect(loadedTracks.size).toBeLessThanOrEqual(2);
    loadedTracks.forEach((path) => {
      expect(player.playlist.loadableTracks().has(player.findTrack(path))).toBe(true);
    });
  });

  it('keeps quota bounded during rapid gotoTrack across the whole list', () => {
    const { player, loadedTracks } = createTrackedPlayer({
      tracks: TRACKS,
      loadLimit: 2,
    });
    player.gotoTrack(4);
    player.gotoTrack(0);
    player.gotoTrack(3);

    expect(player.getIndex()).toBe(3);
    expect(loadedTracks.has(TRACKS[3])).toBe(true);
    expect(loadedTracks.size).toBeLessThanOrEqual(2);
    loadedTracks.forEach((path) => {
      expect(player.playlist.loadableTracks().has(player.findTrack(path))).toBe(true);
    });
  });

  it('queued track gets a quota slot and is released once consumed', () => {
    const { player, loadedTracks } = createTrackedPlayer({
      tracks: TRACKS,
      loadLimit: 2,
    });
    player.queueTrack(4);
    expect(player.queuedTrack).toBe(4);
    expect(loadedTracks.has(TRACKS[4])).toBe(true);
    expect(player.playlist.loadableTracks().has(4)).toBe(true);

    // manual navigation cancels the pending queue and frees its slot
    player.gotoTrack(1);
    expect(player.queuedTrack).toBe(null);
    expect(loadedTracks.has(TRACKS[4])).toBe(false);
  });
});

describe('Gapless-5 removing the current track', () => {
  it('new current track lands inside the loadable set and stays loaded', () => {
    const { player, loadedTracks } = createTrackedPlayer({
      tracks: TRACKS,
      loadLimit: 2,
    });
    player.gotoTrack(2);
    expect(player.getIndex()).toBe(2);

    player.removeTrack(2);
    // next track slid into slot 2
    expect(player.getIndex()).toBe(2);
    expect(player.getTracks()).toStrictEqual([ '0.mp3', '1.mp3', '3.mp3', '4.mp3' ]);
    const newPath = player.getTrack();
    expect(newPath).toBe('3.mp3');
    expect(loadedTracks.has(newPath)).toBe(true);
    expect(isSourceLoaded(player, newPath)).toBe(true);
    expect(player.playlist.loadableTracks().has(player.getIndex())).toBe(true);
    // removed track is fully unloaded
    expect(loadedTracks.has('2.mp3')).toBe(false);
  });

  it('resumes playback per loop semantics and reports paths through onnext', () => {
    const tracks = [ 't1.mp3', 't2.mp3', 't3.mp3' ];

    // loop off, non-tail removal: resumes on the replacement track
    const nonTail = createTrackedPlayer({ tracks: tracks, loadLimit: 2, loop: false });
    nonTail.player.gotoTrack(1);
    nonTail.player.playlist.sources[1].inPlayState = () => true;
    nonTail.player.onnext = jest.fn();
    nonTail.player.onplayrequest = jest.fn();
    nonTail.player.removeTrack(1);
    expect(nonTail.player.onnext).toHaveBeenCalledWith('t2.mp3', 't3.mp3');
    expect(nonTail.player.onplayrequest).toHaveBeenCalledWith('t3.mp3');
    expect(nonTail.player.isFadeReleased(nonTail.player.currentSource())).toBe(false);

    // loop off, tail removal: clamps to new last and stays paused
    const tailNoLoop = createTrackedPlayer({ tracks: tracks, loadLimit: 2, loop: false });
    tailNoLoop.player.gotoTrack(2);
    tailNoLoop.player.playlist.sources[2].inPlayState = () => true;
    tailNoLoop.player.onnext = jest.fn();
    tailNoLoop.player.onplayrequest = jest.fn();
    tailNoLoop.player.removeTrack(2);
    expect(tailNoLoop.player.getIndex()).toBe(1);
    expect(tailNoLoop.player.onnext).toHaveBeenCalledWith('t3.mp3', 't2.mp3');
    expect(tailNoLoop.player.onplayrequest).not.toHaveBeenCalled();
    expect(tailNoLoop.loadedTracks.has('t2.mp3')).toBe(true);

    // loop on, tail removal: wraps to start and resumes
    const tailLoop = createTrackedPlayer({ tracks: tracks, loadLimit: 2, loop: true });
    tailLoop.player.gotoTrack(2);
    tailLoop.player.playlist.sources[2].inPlayState = () => true;
    tailLoop.player.onnext = jest.fn();
    tailLoop.player.onplayrequest = jest.fn();
    tailLoop.player.removeTrack(2);
    expect(tailLoop.player.getIndex()).toBe(0);
    expect(tailLoop.player.onnext).toHaveBeenCalledWith('t3.mp3', 't1.mp3');
    expect(tailLoop.player.onplayrequest).toHaveBeenCalledWith('t1.mp3');
    expect(tailLoop.loadedTracks.has('t1.mp3')).toBe(true);
  });

  it('unloads every removed track even when outside the quota window', () => {
    const { player, loadedTracks } = createTrackedPlayer({
      tracks: TRACKS,
      loadLimit: 2,
    });
    // remove a track that was never loaded
    player.removeTrack(4);
    expect(player.getTracks()).not.toContain('4.mp3');
    expect(loadedTracks.has('4.mp3')).toBe(false);
    expect(player.totalTracks()).toBe(4);

    // remove a loaded, non-playing track
    const loadedBeforeRemove = [ ...loadedTracks ];
    const victim = loadedBeforeRemove.find((p) => p !== player.getTrack());
    player.removeTrack(victim);
    expect(loadedTracks.has(victim)).toBe(false);
  });
});

describe('Gapless-5 crossfade lifecycle', () => {
  it('fading track does not add a quota slot and is unloaded when the fade ends', () => {
    const tracks = [ 'a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3' ];
    const { player, loadedTracks, timerMocks } = createTrackedPlayer({
      tracks: tracks,
      loadLimit: 2,
      crossfade: 250,
    });

    // baseline quota window for the upcoming current track (index 3),
    // captured before any fade exists
    player.gotoTrack(3);
    const baselineWindow = new Set(player.playlist.loadableTracks());
    expect(baselineWindow.size).toBe(2);

    // now play from index 2 and let it end: c fades out, d (index 3) current
    player.gotoTrack(2);
    simulateTrackEnd(player);
    expect(player.getIndex()).toBe(3);
    expect(player.fadingTrack).toBe(2);
    expect(player.getFadingSource()).not.toBe(null);

    // The fade must not enlarge the quota window beyond its normal size, nor
    // inject the fading index as an extra slot.
    const loadable = player.playlist.loadableTracks();
    expect(loadable.size).toBe(2);
    expect(loadable).toStrictEqual(baselineWindow);
    expect(loadedTracks.size).toBeLessThanOrEqual(2);
    // fading source stays alive solely under the fade lifecycle, even if it
    // happens to fall outside the quota window
    expect(isSourceLoaded(player, 'c.mp3')).toBe(true);

    // fade timer fires: old track must stop and be released
    expect(timerMocks.fadeTimerCount()).toBe(1);
    timerMocks.flush();
    expect(player.fadingTrack).toBe(null);
    expect(player.getFadingSource()).toBe(null);
    expect(loadedTracks.has('c.mp3')).toBe(false);
    expect(isSourceLoaded(player, 'c.mp3')).toBe(false);
  });

  it('does not resurrect a released track on later navigation', () => {
    const tracks = [ 'a.mp3', 'b.mp3', 'c.mp3', 'd.mp3' ];
    const { player, loadedTracks, timerMocks } = createTrackedPlayer({
      tracks: tracks,
      loadLimit: 3,
      crossfade: 100,
    });

    simulateTrackEnd(player); // a fades, b current
    timerMocks.flush(); // a released and marked fade-released
    const releasedSource = player.playlist.sources[0];
    expect(player.isFadeReleased(releasedSource)).toBe(true);
    expect(loadedTracks.has('a.mp3')).toBe(false);

    // moving around must not silently reload 'a' even though a window of 3
    // would otherwise cover it again
    player.next(); // c
    player.next(); // d
    expect(loadedTracks.has('a.mp3')).toBe(false);
    expect(isSourceLoaded(player, 'a.mp3')).toBe(false);

    // navigating explicitly back to it revives it legitimately
    player.gotoTrack(0);
    expect(player.isFadeReleased(releasedSource)).toBe(false);
    expect(loadedTracks.has('a.mp3')).toBe(true);
  });

  it('manual navigation during a crossfade finalizes the old track immediately', () => {
    const tracks = [ 'a.mp3', 'b.mp3', 'c.mp3' ];
    const { player, loadedTracks, timerMocks } = createTrackedPlayer({
      tracks: tracks,
      loadLimit: 2,
      crossfade: 100,
    });

    simulateTrackEnd(player); // a fading out
    expect(player.getFadingSource()).not.toBe(null);

    // user jumps straight to c before the fade timer elapses
    player.gotoTrack(2);
    expect(player.fadingTrack).toBe(null);
    expect(player.getFadingSource()).toBe(null);
    expect(loadedTracks.has('a.mp3')).toBe(false);
    expect(timerMocks.fadeTimerCount()).toBe(0);

    // flushing after the fact must not touch the new playlist state
    expect(() => timerMocks.flush()).not.toThrow();
    expect(player.getIndex()).toBe(2);
    expect(loadedTracks.has('c.mp3')).toBe(true);
  });

  it('chained crossfades never leave more than one fading track behind', () => {
    const tracks = [ 'a.mp3', 'b.mp3', 'c.mp3', 'd.mp3' ];
    const { player, loadedTracks, timerMocks } = createTrackedPlayer({
      tracks: tracks,
      loadLimit: 4,
      crossfade: 100,
    });

    simulateTrackEnd(player); // a fading, b current
    const firstFading = player.getFadingSource();
    simulateTrackEnd(player); // b fading, c current; a must be finalized
    expect(player.getFadingSource()).not.toBe(firstFading);
    expect(loadedTracks.has('a.mp3')).toBe(false);
    expect(loadedTracks.has('b.mp3')).toBe(true); // b is the live fading track

    timerMocks.flush();
    expect(player.getFadingSource()).toBe(null);
    expect(loadedTracks.has('b.mp3')).toBe(false);
  });

  it('removing the fading track finalizes it without resurrecting anything', () => {
    const tracks = [ 'a.mp3', 'b.mp3', 'c.mp3' ];
    const { player, loadedTracks, timerMocks } = createTrackedPlayer({
      tracks: tracks,
      loadLimit: 2,
      crossfade: 100,
    });

    simulateTrackEnd(player); // a (index 0) fading out
    expect(player.fadingTrack).toBe(0);
    player.removeTrack(0);
    expect(player.getFadingSource()).toBe(null);
    expect(player.fadingTrack).toBe(null);
    expect(timerMocks.fadeTimerCount()).toBe(0);
    expect(loadedTracks.has('a.mp3')).toBe(false);
    expect(player.getTracks()).toStrictEqual([ 'b.mp3', 'c.mp3' ]);
  });
});

describe('Gapless-5 edge cases', () => {
  it('does not crash on an empty playlist', () => {
    const { player, loadedTracks, timerMocks } = createTrackedPlayer({ loadLimit: 2 });
    expect(() => {
      player.next();
      player.prev();
      player.gotoTrack(0);
      player.play();
      player.pause();
      player.stop();
      player.removeAllTracks();
      timerMocks.flush();
    }).not.toThrow();
    expect(player.totalTracks()).toBe(0);
    expect(player.getIndex()).toBe(-1);
    expect(player.getTrack()).toBe('');
    expect(loadedTracks.size).toBe(0);
  });

  it('does not crash on a single-track playlist with load limit and crossfade', () => {
    const { player, loadedTracks, timerMocks } = createTrackedPlayer({
      tracks: [ 'only.mp3' ],
      loadLimit: 1,
      crossfade: 50,
    });
    expect(() => {
      player.next();
      player.prev();
      player.play();
      player.pause();
      player.gotoTrack(0);
      timerMocks.flush();
      player.removeTrack(0);
      timerMocks.flush();
    }).not.toThrow();
    expect(player.totalTracks()).toBe(0);
    expect(player.getIndex()).toBe(-1);
    expect(loadedTracks.size).toBe(0);
  });

  it('single-track loop keeps the same track loaded across end-of-track', () => {
    const { player, loadedTracks, timerMocks } = createTrackedPlayer({
      tracks: [ 'only.mp3' ],
      loadLimit: 1,
      loop: true,
      crossfade: 50,
    });
    expect(() => {
      simulateTrackEnd(player);
      timerMocks.flush();
    }).not.toThrow();
    expect(player.totalTracks()).toBe(1);
    expect(loadedTracks.has('only.mp3')).toBe(true);
    expect(player.fadingTrack).toBe(null);
  });

  it('releases the previous track after end-of-track even with crossfade disabled', () => {
    const tracks = [ 'a.mp3', 'b.mp3', 'c.mp3' ];
    const { player, loadedTracks, timerMocks } = createTrackedPlayer({
      tracks: tracks,
      loadLimit: 3,
      // crossfade omitted: defaults to 0
    });
    simulateTrackEnd(player); // a -> b, a scheduled for immediate release
    expect(player.getIndex()).toBe(1);
    expect(player.getFadingSource()).not.toBe(null);

    timerMocks.flush(); // 0ms finalizer runs
    expect(player.getFadingSource()).toBe(null);
    expect(player.fadingTrack).toBe(null);
    expect(loadedTracks.has('a.mp3')).toBe(false);
    expect(loadedTracks.has('b.mp3')).toBe(true);
  });
});
