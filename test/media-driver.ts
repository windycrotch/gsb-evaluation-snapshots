/**
 * Simulates the parts of the browser media pipeline that happy-dom does not
 * implement (network loading, decoding, buffering). It drives the *real*
 * <video> element owned by the player through standard media events, so the
 * player under test only ever sees public DOM APIs.
 */
export type MediaDriver = {
  video: HTMLVideoElement;
  /** Snapshot of the src attribute currently assigned to the media element. */
  currentSrc: () => string;
  /** Resolve a pending load with metadata + first frame + ready to play. */
  resolveLoad: (options?: { duration?: number; videoWidth?: number; videoHeight?: number }) => Promise<void>;
  /** Fail the pending load with a media error. */
  failLoad: () => void;
  /** Clear a previously simulated media error (e.g. before a retry re-loads). */
  clearError: () => void;
  /** Move the media clock, mirroring a browser timeupdate. */
  advanceTime: (seconds: number) => void;
  /** Simulate a completed seek (seeking -> seeked with data available). */
  completeSeek: (targetTime?: number) => Promise<void>;
  /** Simulate the browser pausing playback due to buffering. */
  simulateWaiting: () => void;
  /** Simulate buffering recovery / resumed playback. */
  simulatePlaying: () => Promise<void>;
  /** Standard buffered-range stub used by the loading heuristics. */
  setBuffered: (ranges: Array<[number, number]>) => void;
  readyState: () => number;
};

type TimeRangesLike = {
  length: number;
  start: (index: number) => number;
  end: (index: number) => number;
};

function createTimeRanges(ranges: Array<[number, number]>): TimeRangesLike {
  return {
    length: ranges.length,
    start: (index: number) => ranges[index][0],
    end: (index: number) => ranges[index][1],
  };
}

export function createMediaDriver(video: HTMLVideoElement): MediaDriver {
  const state = {
    readyState: 0,
    duration: NaN,
    videoWidth: 0,
    videoHeight: 0,
    buffered: createTimeRanges([]),
    error: null as MediaError | null,
  };

  Object.defineProperty(video, 'readyState', {
    configurable: true,
    enumerable: true,
    get: () => state.readyState,
  });
  Object.defineProperty(video, 'duration', {
    configurable: true,
    enumerable: true,
    get: () => state.duration,
  });
  Object.defineProperty(video, 'videoWidth', {
    configurable: true,
    enumerable: true,
    get: () => state.videoWidth,
  });
  Object.defineProperty(video, 'videoHeight', {
    configurable: true,
    enumerable: true,
    get: () => state.videoHeight,
  });
  Object.defineProperty(video, 'buffered', {
    configurable: true,
    enumerable: true,
    get: () => state.buffered,
  });
  Object.defineProperty(video, 'error', {
    configurable: true,
    enumerable: true,
    get: () => state.error,
  });

  const resetNetworkState = () => {
    state.readyState = 0;
    state.duration = NaN;
    state.videoWidth = 0;
    state.videoHeight = 0;
    state.buffered = createTimeRanges([]);
    state.error = null;
    video.currentTime = 0;
  };

  // happy-dom's src setter dispatches canplay/durationchange synchronously.
  // A real browser queues those events asynchronously after network work, and
  // this driver owns the full media-event sequence, so make the setter quiet to
  // avoid phantom "ready" signals during hydration or source switches.
  const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  Object.defineProperty(video, 'src', {
    configurable: true,
    enumerable: true,
    get: srcDescriptor?.get,
    set(value: string) {
      if (value === '' || value === null || value === undefined) {
        video.removeAttribute('src');
        return;
      }
      // Assigning a new resource resets the media element's network state,
      // mirroring HTMLMediaElement.load() in a real browser.
      resetNetworkState();
      video.setAttribute('src', String(value));
    },
  });

  const nextFrame = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  const dispatch = (type: string) => video.dispatchEvent(new Event(type, { bubbles: false }));

  const driver: MediaDriver = {
    video,

    currentSrc: () => video.getAttribute('src') ?? '',

    async resolveLoad(options = {}) {
      const duration = options.duration ?? 100;
      state.duration = duration;
      state.videoWidth = options.videoWidth ?? 1280;
      state.videoHeight = options.videoHeight ?? 720;
      state.buffered = createTimeRanges([[0, duration]]);
      state.error = null;
      state.readyState = HTMLMediaElement.HAVE_METADATA;
      dispatch('loadstart');
      dispatch('loadedmetadata');
      state.readyState = HTMLMediaElement.HAVE_CURRENT_DATA;
      dispatch('loadeddata');
      state.readyState = HTMLMediaElement.HAVE_FUTURE_DATA;
      dispatch('canplay');
      dispatch('canplaythrough');
      // The player confirms the first frame across two animation frames.
      await nextFrame();
      await nextFrame();
      dispatch('playing');
      await nextFrame();
    },

    failLoad() {
      state.error = { code: 4, message: 'Format error', MEDIA_ERR_SRC_NOT_SUPPORTED: 4 } as MediaError;
      state.readyState = HTMLMediaElement.HAVE_NOTHING;
      state.buffered = createTimeRanges([]);
      dispatch('error');
    },

    clearError() {
      state.error = null;
    },

    advanceTime(seconds: number) {
      const duration = Number.isFinite(state.duration) ? state.duration : seconds;
      video.currentTime = Math.min(duration, video.currentTime + seconds);
      dispatch('timeupdate');
    },

    async completeSeek(targetTime) {
      if (typeof targetTime === 'number') video.currentTime = targetTime;
      dispatch('seeking');
      await nextFrame();
      state.readyState = HTMLMediaElement.HAVE_FUTURE_DATA;
      dispatch('seeked');
      await nextFrame();
    },

    simulateWaiting() {
      // A real browser drops readyState while stalled waiting for data.
      state.readyState = HTMLMediaElement.HAVE_CURRENT_DATA;
      dispatch('waiting');
    },

    async simulatePlaying() {
      state.readyState = HTMLMediaElement.HAVE_FUTURE_DATA;
      dispatch('playing');
      await nextFrame();
    },

    setBuffered(ranges) {
      state.buffered = createTimeRanges(ranges);
    },

    readyState: () => state.readyState,
  };

  return driver;
}
