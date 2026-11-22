// Lifecycle / memory-window tests for Gapless5.
//
// These cover the interleavings the plain unit tests can't reach:
//   - load-window shrinking while tracks are in flight
//   - track removal / replacement racing a pending load completion
//   - rapid successive track changes
//   - stop -> play recovery
//
// The mocks here are controllable (unlike the fire-and-forget ones in
// gapless5.test.js): audio elements and XHRs are captured so a test can fire
// callbacks at the exact moment it wants, including long after the player has
// moved on.

const TRACK_BUFFER_DURATION = 30; // seconds

/* ---------- controllable globals ---------- */

let audioElements = [];
let xhrs = [];
let pendingDecodes = [];
let bufferSources = [];

const makeAudioElement = () => {
  const el = {
    listeners: {},
    originPath: '',
    currentTime: 0,
    duration: TRACK_BUFFER_DURATION,
    volume: 1,
    loop: false,
    playbackRate: 1,
    paused: true,
    error: null,
    seekable: { length: 1, end: () => TRACK_BUFFER_DURATION },
    addEventListener: function addEventListener(type, fn) {
      (el.listeners[type] = el.listeners[type] || []).push(fn);
    },
    removeEventListener: function removeEventListener() {},
    removeAttribute: function removeAttribute() {},
    dispatch: function dispatch(type) {
      (el.listeners[type] || []).forEach((fn) => fn({ target: el }));
    },
    load: jest.fn(),
    pause: jest.fn(() => {
      el.paused = true;
    }),
    play: jest.fn(() => {
      el.paused = false;
      return Promise.resolve();
    }),
  };
  // `src` is a property like the real HTMLMediaElement: the first non-empty
  // value records which track this element was created for.
  let srcValue = '';
  Object.defineProperty(el, 'src', {
    configurable: true,
    get: () => srcValue,
    set: (value) => {
      srcValue = value;
      if (value && !el.originPath) {
        el.originPath = value;
      }
    },
  });
  audioElements.push(el);
  return el;
};

// newest element that was ever pointed at `path`
const elementFor = (path) => audioElements.filter((el) => el.originPath === path).pop();

const makeContext = () => ({
  destination: {},
  baseLatency: 0,
  createGain: () => ({
    gain: { value: 1, linearRampToValueAtTime: jest.fn() },
    connect: jest.fn(),
    disconnect: jest.fn(),
  }),
  createBufferSource: () => {
    const bufferSource = {
      buffer: null,
      playbackRate: { value: 1 },
      loop: false,
      connect: jest.fn(),
      disconnect: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
    };
    bufferSources.push(bufferSource);
    return bufferSource;
  },
  createAnalyser: () => ({ fftSize: 0, connect: jest.fn() }),
  decodeAudioData: () => new Promise((resolve) => pendingDecodes.push(resolve)),
  resume: () => Promise.resolve(),
});

const makeAudioElementGlobals = () => {
  audioElements = [];
  xhrs = [];
  pendingDecodes = [];
  bufferSources = [];

  Audio = jest.fn(() => makeAudioElement());

  XMLHttpRequest = jest.fn(() => {
    const xhr = {
      method: null,
      path: null,
      response: { ok: true },
      status: 200,
      aborted: false,
      onload: null,
      onerror: null,
      onloadend: null,
      open: jest.fn((method, path) => {
        xhr.method = method;
        xhr.path = path;
      }),
      send: jest.fn(),
      setRequestHeader: jest.fn(),
      abort: jest.fn(() => {
        xhr.aborted = true;
      }),
    };
    xhrs.push(xhr);
    return xhr;
  });

  let timerId = 0;
  const timers = [];
  window = {
    gapless5Players: {},
    gapless5AudioContext: makeContext(),
    setTimeout: jest.fn((fn, ms) => {
      const id = ++timerId;
      timers.push({ id: id, fn: fn, ms: ms, cleared: false, ran: false });
      return id;
    }),
    clearTimeout: jest.fn((id) => {
      const timer = timers.find((entry) => entry.id === id);
      if (timer) {
        timer.cleared = true;
      }
    }),
  };
  window.timers = timers;
};

const latestXhr = (path) => xhrs.filter((xhr) => xhr.path === path).pop();

const fireXhrLoad = (path) => {
  const xhr = latestXhr(path);
  if (xhr && xhr.onload) {
    xhr.onload();
  }
  return xhr;
};

const flush = async(rounds = 12) => {
  for (let i = 0; i < rounds; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

const resolvePendingDecodes = async() => {
  const decodes = pendingDecodes;
  pendingDecodes = [];
  decodes.forEach((resolve) => resolve({ duration: TRACK_BUFFER_DURATION }));
  await flush();
};

makeAudioElementGlobals();

const { Gapless5, LogLevel } = require('./gapless5.js');

const BASE_OPTIONS = {
  logLevel: LogLevel.None,
  useWebAudio: false,
  useHTML5Audio: false,
};

/** fixture helpers **/

const makePlayer = (options) => {
  // The constructor overwrites callbacks, so create the player first and add
  // tracks afterwards: that way every load (including the first) is observed
  // through the same bookkeeping.
  const { tracks = [], ...rest } = options;
  const player = new Gapless5({ ...BASE_OPTIONS, ...rest });
  player.loadedPaths = new Set();
  player.loadEvents = [];
  player.unloadEvents = [];
  player.playEvents = [];
  player.onloadstart = (path) => player.loadedPaths.add(path);
  player.onload = (path) => player.loadEvents.push(path);
  player.onunload = (path) => {
    player.loadedPaths.delete(path);
    player.unloadEvents.push(path);
  };
  player.onplay = (path) => player.playEvents.push(path);
  tracks.forEach((path) => player.addTrack(path));
  return player;
};

beforeEach(() => {
  makeAudioElementGlobals();
});

/** tests **/

describe('Gapless-5 load window lifecycle', () => {
  it('unloads tracks leaving the window and reloads tracks re-entering it', () => {
    const TRACKS = [ '0.mp3', '1.mp3', '2.mp3', '3.mp3', '4.mp3' ];
    const player = makePlayer({ tracks: TRACKS, loadLimit: 2 });

    // Starting track 0 keeps [0, 1] loaded.
    expect(player.getIndex()).toBe(0);
    expect(player.loadedPaths).toEqual(new Set([ TRACKS[0], TRACKS[1] ]));

    // Jump near the end: window becomes [3, 4]; 0 and 1 must truly unload.
    player.gotoTrack(3);
    expect(player.getIndex()).toBe(3);
    expect(player.loadedPaths).toEqual(new Set([ TRACKS[3], TRACKS[4] ]));
    expect(player.unloadEvents).toEqual(expect.arrayContaining([ TRACKS[0], TRACKS[1] ]));

    // Jump back: 0 and 1 are loaded again (fresh onloadstart).
    player.gotoTrack(0);
    expect(player.loadedPaths).toEqual(new Set([ TRACKS[0], TRACKS[1] ]));
    expect(player.unloadEvents).toEqual(expect.arrayContaining([ TRACKS[3], TRACKS[4] ]));
  });

  it('keeps exactly loadLimit tracks loaded while stepping through a shuffled list', () => {
    const TRACKS = [ '0.mp3', '1.mp3', '2.mp3', '3.mp3', '4.mp3', '5.mp3' ];
    const player = makePlayer({ tracks: TRACKS, loadLimit: 3, shuffle: true });

    player.shuffle();
    player.next(); // commit shuffle ordering
    expect(player.isShuffled()).toBe(true);

    const steps = 12;
    for (let i = 0; i < steps; i++) {
      expect(player.loadedPaths.size).toBe(3);
      // The current track is always inside the loaded window.
      expect(player.loadedPaths.has(player.getTrack())).toBe(true);

      // The window follows play order, so the track that will play NEXT is
      // always preloaded (this is what keeps gapless playback under shuffle).
      const playOrder = player.getTracks();
      if (player.getIndex() < playOrder.length - 1) {
        expect(player.loadedPaths.has(playOrder[player.getIndex() + 1])).toBe(true);
      }

      // Every loaded path maps to an actual index inside loadableTracks().
      const loadable = player.playlist.loadableTracks();
      expect(loadable.size).toBe(3);
      for (const path of player.loadedPaths) {
        const actualIndex = player.playlist.sources.findIndex((source) => source.audioPath === path);
        expect(loadable.has(actualIndex)).toBe(true);
      }
      player.next();
    }
    expect(player.totalTracks()).toBe(TRACKS.length);
  });

  it('keeps the load window a valid permutation source while adding/removing under shuffle', () => {
    const TRACKS = [ '0.mp3', '1.mp3', '2.mp3', '3.mp3', '4.mp3' ];
    const player = makePlayer({ tracks: TRACKS, loadLimit: 3, shuffle: true });

    player.shuffle();
    player.next(); // commit shuffle
    const assertPermutation = () => {
      const { sources, shuffledIndices } = player.playlist;
      expect(shuffledIndices.length).toBe(sources.length);
      expect([ ...shuffledIndices ].sort((a, b) => a - b))
        .toStrictEqual(Array.from(Array(sources.length).keys()));
      // getTracks() reads through shuffledIndices, so it must name every
      // remaining track exactly once.
      expect(new Set(player.getTracks()).size).toBe(sources.length);
    };
    assertPermutation();

    player.addTrack('new-a.mp3');
    assertPermutation();
    expect(player.getTracks()).toContain('new-a.mp3');

    player.insertTrack(1, 'new-b.mp3');
    assertPermutation();
    expect(player.getTracks()[1]).toBe('new-b.mp3');

    player.removeTrack(0);
    assertPermutation();

    // Deleting the current track keeps index/track/list in agreement.
    const current = player.getTrack();
    player.removeTrack(player.getIndex());
    assertPermutation();
    expect(player.getTracks()[player.getIndex()]).toBe(player.getTrack());
    expect(player.getTrack()).not.toBe(current);
  });

  it('emits onunload only for sources that actually held audio', () => {
    const TRACKS = [ '0.mp3', '1.mp3', '2.mp3', '3.mp3' ];
    const player = makePlayer({ tracks: TRACKS, loadLimit: 1 });

    expect(player.loadedPaths).toEqual(new Set([ TRACKS[0] ]));
    // Skip two ahead, then clear the whole list; unloads never double-fire.
    player.gotoTrack(2);
    player.removeAllTracks();

    expect(player.loadedPaths.size).toBe(0);
    const counts = {};
    player.unloadEvents.forEach((path) => {
      counts[path] = (counts[path] || 0) + 1;
    });
    Object.values(counts).forEach((count) => expect(count).toBe(1));
  });
});

describe('Gapless-5 late WebAudio completions', () => {
  it('ignores a decode that lands after the track was unloaded by the window', async() => {
    const TRACKS = [ '0.mp3', '1.mp3', '2.mp3' ];
    const player = makePlayer({
      tracks: TRACKS,
      loadLimit: 1,
      useWebAudio: true,
      useHTML5Audio: false,
    });

    expect(player.getIndex()).toBe(0);
    // The initial request for track 0 is in flight; complete the fetch but
    // leave the decode unresolved.
    fireXhrLoad(TRACKS[0]);
    expect(pendingDecodes.length).toBe(1);

    // Move the window off track 0 before the decode lands.
    player.gotoTrack(1);
    expect(player.getIndex()).toBe(1);
    expect(latestXhr(TRACKS[0]).aborted).toBe(true);

    // The stale decode completes now.
    await resolvePendingDecodes();

    // Track 0 must stay unloaded: no onload, no revival, no duration leak.
    expect(player.loadEvents).not.toContain(TRACKS[0]);
    const staleSource = player.playlist.sources.find((source) => source.audioPath === TRACKS[0]);
    expect(staleSource.getState()).toBe(0); // Gapless5State.None
    expect(player.getIndex()).toBe(1);
    expect(player.getTrack()).toBe(TRACKS[1]);
    expect(player.currentLength()).toBe(0); // track 1 not loaded yet
  });

  it('ignores a late completion for a track removed while loading', async() => {
    const TRACKS = [ '0.mp3', '1.mp3', '2.mp3' ];
    const player = makePlayer({
      tracks: TRACKS,
      useWebAudio: true,
      useHTML5Audio: false,
    });

    const inFlight = latestXhr(TRACKS[0]);
    expect(inFlight).toBeTruthy();

    player.removeTrack(0);

    // Aborted and unloaded, with the index/track moved to the survivor.
    expect(inFlight.aborted).toBe(true);
    expect(player.getIndex()).toBe(0);
    expect(player.getTrack()).toBe(TRACKS[1]);
    expect(player.getTracks()).toStrictEqual([ TRACKS[1], TRACKS[2] ]);
    expect(player.loadEvents).not.toContain(TRACKS[0]);

    // Simulate the network callback arriving anyway.
    inFlight.onload();
    await resolvePendingDecodes();

    expect(player.loadEvents).not.toContain(TRACKS[0]);
    expect(player.getIndex()).toBe(0);
    expect(player.getTrack()).toBe(TRACKS[1]);
  });

  it('aborts a pending request when the track is replaced, without emitting onload for it', async() => {
    const TRACKS = [ '0.mp3', '1.mp3', '2.mp3' ];
    const player = makePlayer({
      tracks: TRACKS,
      useWebAudio: true,
      useHTML5Audio: false,
    });

    const inFlight = latestXhr(TRACKS[0]);
    player.replaceTrack(0, 'replacement.mp3');

    expect(inFlight.aborted).toBe(true);
    expect(player.getIndex()).toBe(0);
    expect(player.getTrack()).toBe('replacement.mp3');
    expect(player.getTracks()).toStrictEqual([ 'replacement.mp3', TRACKS[1], TRACKS[2] ]);
    expect(player.loadEvents).not.toContain(TRACKS[0]);

    // The superseded request resolving late must not touch the new track.
    inFlight.onload();
    await resolvePendingDecodes();
    expect(player.loadEvents).not.toContain(TRACKS[0]);
    expect(player.getTrack()).toBe('replacement.mp3');
  });

  it('keeps playback on a replaced current track and drops the old audio', async() => {
    const TRACKS = [ '0.mp3', '1.mp3', '2.mp3' ];
    const player = makePlayer({
      tracks: TRACKS,
      useWebAudio: true,
      useHTML5Audio: false,
    });

    fireXhrLoad(TRACKS[0]);
    await resolvePendingDecodes();
    player.play();
    await flush();
    expect(player.isPlaying()).toBe(true);
    const firstSource = bufferSources[bufferSources.length - 1];

    player.replaceTrack(0, 'replacement.mp3');

    // Still current, still on the same slot, and playback continues on a new
    // source rather than the released one.
    expect(player.getIndex()).toBe(0);
    expect(player.getTrack()).toBe('replacement.mp3');
    expect(firstSource.stop).toHaveBeenCalled();

    fireXhrLoad('replacement.mp3');
    await resolvePendingDecodes();
    expect(player.getTrack()).toBe('replacement.mp3');
    expect(player.isPlaying()).toBe(true);
    expect(bufferSources[bufferSources.length - 1]).not.toBe(firstSource);
  });
});

describe('Gapless-5 late HTML5 Audio completions', () => {
  it('does not revive or fire onload for a removed track whose canplaythrough lands late', () => {
    const TRACKS = [ '0.mp3', '1.mp3', '2.mp3' ];
    const player = makePlayer({
      tracks: TRACKS,
      useWebAudio: false,
      useHTML5Audio: true,
    });

    const staleElement = elementFor(TRACKS[0]);
    expect(staleElement).toBeTruthy();
    const staleSource = player.playlist.sources.find((source) => source.audioPath === TRACKS[0]);

    player.removeTrack(0);
    expect(staleElement.paused).toBe(true);
    expect(player.getIndex()).toBe(0);
    expect(player.getTrack()).toBe(TRACKS[1]);

    // Element reports it finished buffering after removal.
    staleElement.dispatch('canplaythrough');

    expect(staleSource.getState()).toBe(0); // None
    expect(player.loadEvents).not.toContain(TRACKS[0]);
    expect(player.getIndex()).toBe(0);
    expect(player.getTrack()).toBe(TRACKS[1]);
    expect(player.currentLength()).toBe(0);
  });

  it('ignores stale metadata so it cannot overwrite the current track duration', () => {
    const TRACKS = [ '0.mp3', '1.mp3', '2.mp3' ];
    const player = makePlayer({
      tracks: TRACKS,
      loadLimit: 1,
      useWebAudio: false,
      useHTML5Audio: true,
    });

    const staleSource = player.playlist.sources[0];
    const staleElement = elementFor(TRACKS[0]);
    player.gotoTrack(2); // loadLimit 1 drops track 0 from the window

    // Track 0 must really be released, not merely quiet.
    expect(staleSource.getState()).toBe(0); // None
    expect(staleElement.paused).toBe(true);
    expect(staleElement.src).toBe('');

    // The current track's own element is what feeds currentLength().
    const currentElement = elementFor(TRACKS[2]);
    currentElement.duration = 42;
    currentElement.dispatch('loadedmetadata');
    expect(player.currentLength()).toBe(42000);
    expect(player.getTrack()).toBe(TRACKS[2]);

    staleElement.duration = 999;
    staleElement.dispatch('loadedmetadata');
    expect(player.currentLength()).toBe(42000); // unchanged by the stale element
    expect(player.getTrack()).toBe(TRACKS[2]);
  });
});

describe('Gapless-5 rapid track changes', () => {
  it('leaves only the finally-selected track playing when loads resolve out of order', async() => {
    const TRACKS = [ '0.mp3', '1.mp3', '2.mp3', '3.mp3', '4.mp3' ];
    const player = makePlayer({
      tracks: TRACKS,
      loadLimit: 2,
      useWebAudio: true,
      useHTML5Audio: false,
    });

    // Finish loading the starting track, then start playback.
    fireXhrLoad(TRACKS[0]);
    await resolvePendingDecodes();
    player.play();
    await flush();
    expect(player.isPlaying()).toBe(true);
    expect(player.playEvents).toEqual([ TRACKS[0] ]);

    // Rapidly click "next" three times without waiting for any load.
    player.next();
    player.next();
    player.next();
    expect(player.getIndex()).toBe(3);

    // Tracks 1 and 2 were superseded; their requests must be aborted.
    expect(latestXhr(TRACKS[1]).aborted).toBe(true);
    expect(latestXhr(TRACKS[2]).aborted).toBe(true);

    // Late completions for the abandoned tracks arrive...
    fireXhrLoad(TRACKS[1]);
    fireXhrLoad(TRACKS[2]);
    await resolvePendingDecodes();
    expect(player.playEvents).not.toContain(TRACKS[1]);
    expect(player.playEvents).not.toContain(TRACKS[2]);
    expect(player.getTrack()).toBe(TRACKS[3]);

    // ...and the finally-selected track starts on its own.
    fireXhrLoad(TRACKS[3]);
    await resolvePendingDecodes();
    expect(player.getTrack()).toBe(TRACKS[3]);
    expect(player.isPlaying()).toBe(true);
    expect(player.playEvents).toEqual([ TRACKS[0], TRACKS[3] ]);

    // Only the selected track is playing/starting. The neighbour may be
    // preloaded (Stop) but must never be Play/Starting.
    const states = player.playlist.sources.map((source) => source.getState());
    const PLAY = 3;
    const STARTING = 2;
    expect(states.filter((state) => state === PLAY || state === STARTING)).toEqual([ PLAY ]);
    expect(player.playlist.sources.findIndex((source) => source.getState() === PLAY)).toBe(3);

    // A neighbouring preload finishing later must not steal playback.
    fireXhrLoad(TRACKS[4]);
    await resolvePendingDecodes();
    expect(player.getTrack()).toBe(TRACKS[3]);
    expect(player.playEvents).toEqual([ TRACKS[0], TRACKS[3] ]);
    expect(player.playlist.sources[4].getState()).toBe(4); // Gapless5State.Stop
  });
});

describe('Gapless-5 removal keeps one source of truth for the index', () => {
  it('keeps getIndex/getTrack/getTracks aligned after deleting the current track', () => {
    const TRACKS = [ '0.mp3', '1.mp3', '2.mp3', '3.mp3' ];
    const player = makePlayer({ tracks: TRACKS, loadLimit: 2 });

    player.gotoTrack(1);
    expect(player.getIndex()).toBe(1);
    expect(player.getTrack()).toBe(TRACKS[1]);

    const removedSource = player.playlist.sources[1];

    player.removeTrack(1);

    const index = player.getIndex();
    expect(index).toBe(1);
    expect(player.getTracks()[index]).toBe(player.getTrack());
    expect(player.getTrack()).toBe(TRACKS[2]);
    expect(player.getTracks()).toStrictEqual([ TRACKS[0], TRACKS[2], TRACKS[3] ]);
    // The window is rebuilt around the new current track.
    expect(player.loadedPaths.has(TRACKS[2])).toBe(true);
    // The deleted source is released, not left loaded behind the scenes.
    expect(removedSource.getState()).toBe(0); // None
    expect(removedSource.isLoaded()).toBe(false);
  });

  it('resets to -1 and leaves nothing loading after the list is emptied', () => {
    const TRACKS = [ '0.mp3', '1.mp3', '2.mp3' ];
    const player = makePlayer({
      tracks: TRACKS,
      loadLimit: 2,
      useWebAudio: true,
      useHTML5Audio: false,
    });

    // Put a real load in flight, then queue a neighbour and start a fade so
    // the clear has to clean up references too.
    player.gotoTrack(1);
    player.queueTrack(2);
    player.fadingTrack = 1;
    const inFlight = xhrs.slice();
    expect(inFlight.length).toBeGreaterThan(0);

    player.removeAllTracks();

    expect(player.getIndex()).toBe(-1);
    expect(player.getTrack()).toBe('');
    expect(player.getTracks()).toStrictEqual([]);
    expect(player.totalTracks()).toBe(0);
    expect(player.currentLength()).toBe(0);
    expect(player.loadedPaths.size).toBe(0);
    expect(player.queuedTrack).toBeNull();
    expect(player.fadingTrack).toBeNull();
    // Every request that was issued (including the one for the current
    // track) was aborted.
    xhrs.forEach((xhr) => expect(xhr.aborted).toBe(true));

    // Late completions after the clear do nothing.
    inFlight.forEach((xhr) => {
      if (xhr.onload) {
        xhr.onload();
      }
    });
    expect(player.getIndex()).toBe(-1);
    expect(player.getTrack()).toBe('');
    expect(player.loadEvents).toStrictEqual([]);
  });
});

describe('Gapless-5 stop / play recovery', () => {
  it('restarts from the beginning with a fresh source and no stale fade timer', async() => {
    const TRACKS = [ '0.mp3', '1.mp3' ];
    const player = makePlayer({
      tracks: TRACKS,
      useWebAudio: true,
      useHTML5Audio: false,
    });

    fireXhrLoad(TRACKS[0]);
    await resolvePendingDecodes();
    player.play();
    await flush();

    const firstSource = bufferSources[bufferSources.length - 1];
    expect(player.isPlaying()).toBe(true);
    expect(firstSource.start).toHaveBeenCalled();

    // Simulate a crossfade whose fade-out timer is still pending.
    player.fadingTrack = 0;
    player.fadingCallback = window.setTimeout(() => {
      player.fadingTrack = null;
    }, 500);
    const fadeTimerId = player.fadingCallback;

    // Advance the timeline, then stop.
    player.setPosition(5000);
    expect(player.getPosition()).toBe(5000);
    player.stop();

    // Fade timer cleared and fading track dropped; audio node stopped.
    expect(window.clearTimeout).toHaveBeenCalledWith(fadeTimerId);
    expect(player.fadingCallback).toBeNull();
    expect(player.fadingTrack).toBeNull();
    expect(firstSource.stop).toHaveBeenCalled();
    expect(player.getPosition()).toBe(0);

    // Play again: a brand-new buffer source starts at offset 0.
    player.play();
    await flush();
    const secondSource = bufferSources[bufferSources.length - 1];
    expect(secondSource).not.toBe(firstSource);
    expect(secondSource.start).toHaveBeenCalledWith(0, 0);
    expect(player.isPlaying()).toBe(true);
  });

  it('clears the scheduled end timer on stop and ignores it if it fires anyway', async() => {
    const TRACKS = [ '0.mp3', '1.mp3' ];
    const player = makePlayer({
      tracks: TRACKS,
      useWebAudio: false,
      useHTML5Audio: true,
    });

    const element = elementFor(TRACKS[0]);
    element.dispatch('canplaythrough');
    expect(player.loadEvents).toContain(TRACKS[0]);

    player.onfinishedtrack = jest.fn();
    player.play();
    await flush();
    expect(player.isPlaying()).toBe(true);

    // The end-of-track timer scheduled during play.
    const endTimers = window.timers.filter((timer) => timer.ms > 0 && !timer.cleared);
    expect(endTimers.length).toBeGreaterThan(0);
    const endTimer = endTimers[endTimers.length - 1];

    player.stop();
    expect(window.clearTimeout).toHaveBeenCalledWith(endTimer.id);
    expect(player.getPosition()).toBe(0);

    // Even if the stale callback runs, no finished-track event escapes.
    endTimer.fn();
    expect(player.onfinishedtrack).not.toHaveBeenCalled();

    // And playback restarts from the first sample.
    player.play();
    await flush();
    expect(element.currentTime).toBe(0);
    expect(player.isPlaying()).toBe(true);
  });

  it('a queued play requested during loading is dropped when the user stops', async() => {
    const TRACKS = [ '0.mp3', '1.mp3' ];
    const player = makePlayer({
      tracks: TRACKS,
      useWebAudio: true,
      useHTML5Audio: false,
    });

    // Still loading; a play request is queued.
    player.play();
    const source = player.playlist.sources[0];
    expect(source.isPlayActive(true)).toBe(true); // queuedState === Play

    player.stop();
    expect(source.isPlayActive(true)).toBe(false);

    // The load completing after the stop must not start playback.
    fireXhrLoad(TRACKS[0]);
    await resolvePendingDecodes();
    expect(player.isPlaying()).toBe(false);
    expect(player.playEvents).toStrictEqual([]);
  });

  it('a play() whose resume promise resolves after stop() does not start audio', async() => {
    const TRACKS = [ '0.mp3', '1.mp3' ];
    const player = makePlayer({
      tracks: TRACKS,
      useWebAudio: true,
      useHTML5Audio: false,
    });

    fireXhrLoad(TRACKS[0]);
    await resolvePendingDecodes();
    expect(player.loadEvents).toContain(TRACKS[0]);

    // The context stays suspended until we resume it: grab the deferred
    // resume so we control exactly when the play attempt continues.
    let resumeNow = null;
    player.context.resume = () => new Promise((resolve) => {
      resumeNow = resolve;
    });

    const sourcesBefore = bufferSources.length;
    player.play();
    expect(resumeNow).toBeTruthy();

    // User stops before the audio context resumes.
    player.stop();
    resumeNow();
    await flush();

    // No buffer source was started, no onplay fired, and state is not Play.
    expect(bufferSources.length).toBe(sourcesBefore);
    expect(player.playEvents).toStrictEqual([]);
    expect(player.isPlaying()).toBe(false);

    // A fresh play works normally afterwards.
    player.context.resume = () => Promise.resolve();
    player.play();
    await flush();
    expect(player.isPlaying()).toBe(true);
    expect(player.playEvents).toStrictEqual([ TRACKS[0] ]);
  });
});
