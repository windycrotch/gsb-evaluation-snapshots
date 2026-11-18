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

describe('Gapless-5 object in shuffle mode', () => {
  // Asserts that every index-based accessor agrees on which track is current.
  const expectConsistentIndexing = (player) => {
    const tracks = player.getTracks();
    const currentIndex = player.getIndex();
    const currentSourceIndex = player.getIndex(true);
    const currentPath = player.getTrack();

    // getIndex() is an index into getTracks()
    expect(tracks[currentIndex]).toBe(currentPath);
    // getIndex(true) is an index into the unshuffled source array
    expect(player.playlist.sources[currentSourceIndex].audioPath).toBe(currentPath);
    // findTrack(path) is an index into getTracks()
    expect(player.findTrack(currentPath)).toBe(currentIndex);
  };

  const createShuffledPlayer = (testTracks, options = {}) => {
    const player = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
      ...options,
    });
    player.shuffle();
    player.next(); // commit the deferred shuffle
    expect(player.isShuffled()).toBe(true);
    return player;
  };

  it('keeps getTracks, getIndex, getIndex(true) and findTrack consistent', () => {
    const player = createShuffledPlayer(TRACKS);

    expectConsistentIndexing(player);
    expect(player.getTracks()).not.toStrictEqual(TRACKS);
    expect(new Set(player.getTracks())).toStrictEqual(new Set(TRACKS));

    // navigate in play order and re-check consistency at every step
    for (let i = 0; i < TRACKS.length; i++) {
      player.next();
      expectConsistentIndexing(player);
    }
  });

  it('adds and removes tracks in play order while shuffling', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3', 'track4.mp3', 'track5.mp3' ];
    const player = createShuffledPlayer(testTracks);
    const initialOrder = player.getTracks();

    player.gotoTrack(2);
    expectConsistentIndexing(player);
    const currentPath = player.getTrack();

    // insert a new track in the middle of the play order
    player.insertTrack(2, 'inserted.mp3');
    expect(player.getTracks()[2]).toBe('inserted.mp3');
    expectConsistentIndexing(player);
    expect(player.getTrack()).toBe(currentPath);

    // remove a non-current track by path
    const removablePath = player.getTracks().find((track) => track !== player.getTrack());
    const expectedRemaining = player.getTracks().filter((track) => track !== removablePath);
    player.removeTrack(removablePath);
    expect(player.getTracks()).toStrictEqual(expectedRemaining);
    expect(player.getTrack()).toBe(currentPath);
    expectConsistentIndexing(player);

    player.removeAllTracks();
    expect(player.getTracks()).toStrictEqual([]);
    expect(player.getIndex()).toBe(-1);
    expect(initialOrder.length).toBe(testTracks.length);
  });

  it('removes a non-current track by path without changing the playing track', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3', 'track4.mp3', 'track5.mp3' ];
    const player = createShuffledPlayer(testTracks);

    player.gotoTrack(2);
    const playingPath = player.getTrack();
    const pathToRemove = player.getTracks()[0];

    player.onnext = jest.fn();
    player.removeTrack(pathToRemove);

    expect(player.getTrack()).toBe(playingPath);
    expect(player.getTracks()).not.toContain(pathToRemove);
    expect(player.getTracks().length).toBe(testTracks.length - 1);
    // removing a non-current track must not report a track change
    expect(player.onnext).not.toHaveBeenCalled();
    expectConsistentIndexing(player);
  });

  it('removes the current track by path and advances to the track that slid into its slot', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3', 'track4.mp3', 'track5.mp3' ];
    const player = createShuffledPlayer(testTracks);

    player.gotoTrack(1);
    expect(player.getIndex()).toBe(1);
    const orderBefore = player.getTracks();
    const playingPath = player.getTrack();
    const pathToRemove = player.getTrack();
    const expectedNextPath = orderBefore[2]; // the track that slides into slot 1

    player.onnext = jest.fn();
    player.onplayrequest = jest.fn();
    player.removeTrack(pathToRemove);

    expect(player.getIndex()).toBe(1);
    expect(player.getTrack()).toBe(expectedNextPath);
    expect(player.getTracks()[player.getIndex()]).toBe(player.getTrack());
    expect(player.getTracks()).not.toContain(pathToRemove);
    expect(player.onnext).toHaveBeenCalledWith(playingPath, expectedNextPath);
    expectConsistentIndexing(player);
  });

  it('removes the current track by numeric play-order index', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3', 'track4.mp3', 'track5.mp3' ];
    const player = createShuffledPlayer(testTracks);

    player.gotoTrack(2);
    const playingPath = player.getTrack();
    const orderBefore = player.getTracks();
    const expectedNextPath = orderBefore[3];

    player.removeTrack(player.getIndex());

    expect(player.getTrack()).toBe(expectedNextPath);
    expect(player.getTrack()).not.toBe(playingPath);
    expect(player.getTracks().length).toBe(testTracks.length - 1);
    expectConsistentIndexing(player);
  });

  it('removes the current tail track: loop on wraps to first, loop off clamps and stops', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3', 'track4.mp3', 'track5.mp3' ];

    // loop on: wrap around and keep playing
    const loopPlayer = createShuffledPlayer(testTracks, { loop: true });
    loopPlayer.gotoTrack(loopPlayer.totalTracks() - 1);
    const loopOrder = loopPlayer.getTracks();
    const tailPath = loopPlayer.getTrack();
    loopPlayer.playlist.sources[loopPlayer.getIndex(true)].inPlayState = () => true;
    loopPlayer.onnext = jest.fn();
    loopPlayer.onplayrequest = jest.fn();

    loopPlayer.removeTrack(tailPath);

    expect(loopPlayer.getIndex()).toBe(0);
    expect(loopPlayer.getTrack()).toBe(loopOrder[0]);
    expect(loopPlayer.onnext).toHaveBeenCalledWith(tailPath, loopOrder[0]);
    expect(loopPlayer.onplayrequest).toHaveBeenCalledTimes(1);
    expect(loopPlayer.onplayrequest).toHaveBeenCalledWith(loopOrder[0]);
    expectConsistentIndexing(loopPlayer);

    // loop off: clamp to the new last track and do not auto-play
    const stopPlayer = createShuffledPlayer(testTracks, { loop: false });
    stopPlayer.gotoTrack(stopPlayer.totalTracks() - 1);
    const stopOrder = stopPlayer.getTracks();
    const stopTailPath = stopPlayer.getTrack();
    const newLastPath = stopOrder[stopOrder.length - 2];
    stopPlayer.playlist.sources[stopPlayer.getIndex(true)].inPlayState = () => true;
    stopPlayer.onnext = jest.fn();
    stopPlayer.onplayrequest = jest.fn();

    stopPlayer.removeTrack(stopTailPath);

    expect(stopPlayer.getIndex()).toBe(stopPlayer.totalTracks() - 1);
    expect(stopPlayer.getTrack()).toBe(newLastPath);
    expect(stopPlayer.onnext).toHaveBeenCalledWith(stopTailPath, newLastPath);
    expect(stopPlayer.onplayrequest).not.toHaveBeenCalled();
    expectConsistentIndexing(stopPlayer);
  });

  it('removes queued and fading tracks consistently while shuffled', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3', 'track4.mp3', 'track5.mp3' ];
    const player = createShuffledPlayer(testTracks);

    player.gotoTrack(1);
    const queuedPath = player.getTracks()[4];
    player.queueTrack(queuedPath);
    player.fadingTrack = player.getIndex(true); // source-array index

    const playingPath = player.getTrack();
    player.removeTrack(player.getTracks()[3]);

    expect(player.getTrack()).toBe(playingPath);
    expect(player.queuedTrack).toBe(queuedPath);
    expectConsistentIndexing(player);
  });

  it('leaves shuffle mode when too few tracks remain, but only if shuffled', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3' ];
    const player = createShuffledPlayer(testTracks);

    // pick a non-zero slot so removing play index 0 never removes the current track
    player.gotoTrack(1);
    const playingPath = player.getTrack();
    const pathToRemove = player.getTracks()[0];
    player.removeTrack(pathToRemove);

    expect(player.totalTracks()).toBe(2);
    expect(player.isShuffled()).toBe(false);
    // exiting shuffle restores the source order of the tracks that remain
    expect(player.getTracks()).toStrictEqual(testTracks.filter((track) => track !== pathToRemove));
    expect(player.getTrack()).toBe(playingPath);
    expectConsistentIndexing(player);

    // a never-shuffled player dropping to 2 tracks stays unshuffled
    const plainPlayer = new Gapless5({ ...INIT_OPTIONS, tracks: testTracks });
    plainPlayer.removeTrack(0);
    expect(plainPlayer.isShuffled()).toBe(false);
    expectConsistentIndexing(plainPlayer);
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

  // Returns the audio paths whose sources are currently loaded (not None).
  const getLoadedTracks = (player) => player.playlist.sources
    .filter((source) => source.getState() !== 0)
    .map((source) => source.audioPath);

  it('centers the loadable window on the current track in shuffle order', () => {
    const shuffleTracks = [ 'a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3', 'f.mp3', 'g.mp3' ];
    const player = new Gapless5({
      ...INIT_OPTIONS,
      tracks: shuffleTracks,
      loadLimit: 3,
    });

    player.shuffle();
    player.next(); // commit the shuffle

    for (let i = 0; i < shuffleTracks.length; i++) {
      const playOrder = player.getTracks();
      const currentIndex = player.getIndex();
      const currentPath = player.getTrack();

      // expected window: loadLimit tracks centered on the current track, clamped
      const windowSize = Math.min(3, playOrder.length);
      const startIndex = Math.max(0, Math.min(currentIndex - Math.floor((windowSize - 1) / 2),
        playOrder.length - windowSize));
      const expected = new Set(playOrder.slice(startIndex, startIndex + windowSize));
      expect(expected.has(currentPath)).toBe(true);
      // the window must be centered: the current track is at most one slot from the middle
      const currentOffset = currentIndex - startIndex;
      expect(Math.abs(currentOffset - Math.floor((windowSize - 1) / 2))).toBeLessThanOrEqual(1);

      const loadableSourceIndices = player.playlist.loadableTracks();
      const loadablePaths = new Set(
        [ ...loadableSourceIndices ].map((sourceIndex) => player.playlist.sources[sourceIndex].audioPath),
      );
      expect(loadablePaths).toStrictEqual(expected);
      expect(getLoadedTracks(player).length).toBe(expected.size);
      expect(getLoadedTracks(player).sort()).toStrictEqual([ ...expected ].sort());
      expect(getLoadedTracks(player)).toContain(currentPath);

      player.next();
    }
  });

  it('never unloads the queued or fading track in shuffle order', () => {
    const shuffleTracks = [ 'a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3', 'f.mp3', 'g.mp3' ];
    const player = new Gapless5({
      ...INIT_OPTIONS,
      tracks: shuffleTracks,
      loadLimit: 2,
    });

    player.shuffle();
    player.next(); // commit the shuffle
    player.gotoTrack(0);

    // Queue a far-away track and mark another far-away track as fading.
    const playOrder = player.getTracks();
    const queuedPath = playOrder[playOrder.length - 1];
    const fadingPath = playOrder[playOrder.length - 2];
    player.queueTrack(queuedPath);
    player.fadingTrack = player.playlist.getSourceIndexed(
      player.findTrack(fadingPath),
    ).index;
    player.playlist.updateLoading();

    const loaded = getLoadedTracks(player);
    expect(loaded).toContain(queuedPath);
    expect(loaded).toContain(fadingPath);
    expect(loaded).toContain(player.getTrack());

    // Both extra tracks stay resident after moving the current track.
    player.gotoTrack(1);
    player.playlist.updateLoading();
    const loadedAfterMove = getLoadedTracks(player);
    expect(loadedAfterMove).toContain(queuedPath);
    expect(loadedAfterMove).toContain(fadingPath);
    expect(loadedAfterMove).toContain(player.getTrack());
    expect(loadedAfterMove.length).toBeLessThanOrEqual(4); // window of 2 + 2 pinned
  });

  it('keeps track identity stable through removal while load-limited and shuffled', () => {
    const shuffleTracks = [ 'a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3' ];
    const player = new Gapless5({
      ...INIT_OPTIONS,
      tracks: shuffleTracks,
      loadLimit: 2,
    });

    player.shuffle();
    player.next(); // commit the shuffle
    player.gotoTrack(2);
    const playingPath = player.getTrack();

    // Remove a track outside the current load window; the current track and
    // its loadable neighbours must be unaffected.
    const nonCurrentPath = player.getTracks()[0];
    player.removeTrack(nonCurrentPath);

    expect(player.getTrack()).toBe(playingPath);
    expect(player.getTracks()[player.getIndex()]).toBe(playingPath);
    expect(player.playlist.sources[player.getIndex(true)].audioPath).toBe(playingPath);
    expect(getLoadedTracks(player)).toContain(playingPath);
    expect(getLoadedTracks(player)).not.toContain(nonCurrentPath);
  });
});
