import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Html5MediaDriver } from '../../src/media/html5MediaDriver';
import { YouTubeMediaDriver } from '../../src/media/youtubeMediaDriver';
import { ProceduralMediaDriver } from '../../src/media/proceduralMediaDriver';

/**
 * Deterministic fake wall clock for performance.now(), so extrapolation and
 * safety timeouts can be advanced without real timers, network, or decoders.
 */
class FakeClock {
  private currentMs = 10_000;

  readonly now = vi.fn(() => this.currentMs);

  advance(ms: number): void {
    this.currentMs += ms;
  }

  set(ms: number): void {
    this.currentMs = ms;
  }
}

interface FakeVideoElement {
  readyState: number;
  currentTime: number;
  duration: number;
  playbackRate: number;
  paused: boolean;
  ended: boolean;
  muted: boolean;
  seeking: boolean;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

function createFakeVideo(overrides: Partial<FakeVideoElement> = {}): {
  video: FakeVideoElement;
  listeners: Record<string, ((ev?: Event) => void)[]>;
} {
  const listeners: Record<string, ((ev?: Event) => void)[]> = {};
  const video: FakeVideoElement = {
    readyState: 4,
    currentTime: 5.0,
    duration: 60.0,
    playbackRate: 1.0,
    paused: true,
    ended: false,
    muted: false,
    seeking: false,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    addEventListener: vi.fn((event: string, cb: (ev?: Event) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    }),
    removeEventListener: vi.fn((event: string, cb: (ev?: Event) => void) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((fn) => fn !== cb);
      }
    }),
    ...overrides,
  };
  return { video, listeners };
}

function createReadyYouTubeDriver(
  fallbackDurationSec = 60.0,
  initialTimeSec = 3.5
): {
  driver: YouTubeMediaDriver;
  player: {
    currentTime: number;
    duration: number;
    getCurrentTime: ReturnType<typeof vi.fn>;
    getDuration: ReturnType<typeof vi.fn>;
    seekTo: ReturnType<typeof vi.fn>;
    setPlaybackRate: ReturnType<typeof vi.fn>;
    playVideo: ReturnType<typeof vi.fn>;
    pauseVideo: ReturnType<typeof vi.fn>;
    mute: ReturnType<typeof vi.fn>;
    unMute: ReturnType<typeof vi.fn>;
    isMuted: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
} {
  const container = {
    innerHTML: '',
    appendChild: vi.fn(),
  } as unknown as HTMLElement;
  const driver = new YouTubeMediaDriver(container, 'dQw4w9WgXcQ', fallbackDurationSec);
  const player = {
    currentTime: initialTimeSec,
    duration: fallbackDurationSec,
    getCurrentTime: vi.fn(function (this: { currentTime: number }) {
      return this.currentTime;
    }),
    getDuration: vi.fn(function (this: { duration: number }) {
      return this.duration;
    }),
    seekTo: vi.fn(),
    setPlaybackRate: vi.fn(),
    playVideo: vi.fn(),
    pauseVideo: vi.fn(),
    mute: vi.fn(),
    unMute: vi.fn(),
    isMuted: vi.fn(() => false),
    destroy: vi.fn(),
  };
  (driver as unknown as { player: unknown }).player = player;
  (driver as unknown as { ready: boolean }).ready = true;
  // Prime the extrapolation anchor at the player's current time.
  expect(driver.getCurrentTime()).toBe(initialTimeSec);
  return { driver, player };
}

describe('MediaClockDrivers - Optimistic In-Flight Seek Synchronization', () => {
  describe('Html5MediaDriver', () => {
    let mockVideo: HTMLVideoElement & { seeking: boolean };
    let eventListeners: Record<string, ((ev?: Event) => void)[]> = {};

    beforeEach(() => {
      eventListeners = {};
      mockVideo = {
        readyState: 4,
        currentTime: 5.0,
        duration: 60.0,
        playbackRate: 1.0,
        paused: true,
        ended: false,
        muted: false,
        seeking: false,
        play: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn(),
        addEventListener: vi.fn((event: string, cb: (ev?: Event) => void) => {
          if (!eventListeners[event]) eventListeners[event] = [];
          eventListeners[event].push(cb);
        }),
        removeEventListener: vi.fn((event: string, cb: (ev?: Event) => void) => {
          if (eventListeners[event]) {
            eventListeners[event] = eventListeners[event].filter((fn) => fn !== cb);
          }
        }),
      } as unknown as HTMLVideoElement & { seeking: boolean };
    });

    it('returns optimistic seek target immediately before native video element finishes seeking', () => {
      const driver = new Html5MediaDriver(mockVideo, 60.0);
      expect(driver.getCurrentTime()).toBe(5.0);

      // User seeks to 24.5s
      // Simulate that the browser video element is now seeking and currentTime has not updated yet
      mockVideo.seeking = true;
      driver.seek(24.5);

      // Setting currentTime on video was dispatched
      expect(mockVideo.currentTime).toBe(24.5);

      // Temporarily revert mockVideo.currentTime to simulate async decoder delay
      mockVideo.currentTime = 5.0;

      // getCurrentTime() must optimistically return 24.5 rather than reverting to 5.0
      expect(driver.getCurrentTime()).toBe(24.5);

      // When the native 'seeked' event fires and seeking completes
      mockVideo.seeking = false;
      mockVideo.currentTime = 24.5;
      eventListeners['seeked']?.forEach((cb) => cb());

      expect(driver.getCurrentTime()).toBe(24.5);
      driver.destroy();
    });

    it('releases lock if safety timeout of 500ms elapses without seeked event', () => {
      const driver = new Html5MediaDriver(mockVideo, 60.0);
      mockVideo.seeking = true;
      driver.seek(30.0);
      mockVideo.currentTime = 5.0; // Decoder stalled

      expect(driver.getCurrentTime()).toBe(30.0);

      // Advance performance.now by 501ms
      const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 501);
      expect(driver.getCurrentTime()).toBe(5.0); // Safely timed out and returned video element time

      nowSpy.mockRestore();
      // When metadata duration is unavailable (NaN), fallback duration updates in-place without changing time
      (mockVideo as { duration: number }).duration = Number.NaN;
      driver.seek(12.5);
      driver.setDuration(25.0);
      expect(driver.getDuration()).toBe(25.0);
      expect(driver.getCurrentTime()).toBe(12.5);
      driver.destroy();
    });
  });

  describe('YouTubeMediaDriver', () => {
    it('anchors to seek target and prevents stale pre-seek polling from reverting anchor', () => {
      const container = {
        innerHTML: '',
        appendChild: vi.fn(),
      } as unknown as HTMLElement;
      const driver = new YouTubeMediaDriver(container, 'dQw4w9WgXcQ', 60.0);

      // Mock internal player ready state
      let mockYtCurrentTime = 3.5;
      (driver as unknown as { player: unknown; ready: boolean }).player = {
        getCurrentTime: () => mockYtCurrentTime,
        getDuration: () => 60.0,
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
      };
      (driver as unknown as { ready: boolean }).ready = true;

      // Initially at 3.5s
      expect(driver.getCurrentTime()).toBe(3.5);

      // User seeks to 45.0s
      driver.seek(45.0);

      // YouTube iframe still returns 3.5s for the next few frames because postMessage is in flight
      mockYtCurrentTime = 3.5;

      // getCurrentTime() must NOT revert back to 3.5s
      expect(driver.getCurrentTime()).toBe(45.0);

      // When YouTube arrives within 0.35s of the target (e.g. 45.1s)
      mockYtCurrentTime = 45.1;
      expect(driver.getCurrentTime()).toBe(45.1);

      // Updating fallback duration in-place does not alter playhead anchor
      (driver as unknown as { player: { getDuration: () => number } }).player.getDuration =
        () => 0;
      driver.setDuration(90.0);
      expect(driver.getDuration()).toBe(90.0);
      expect(driver.getCurrentTime()).toBe(45.1);

      driver.destroy();
    });
  });

  describe('ProceduralMediaDriver', () => {
    it('seeks synchronously without delay and updates duration in-place without resetting t', async () => {
      const driver = new ProceduralMediaDriver(60.0);
      expect(driver.getCurrentTime()).toBe(0);

      driver.seek(18.25);
      expect(driver.getCurrentTime()).toBe(18.25);

      await driver.play();
      driver.setDuration(75.0);
      expect(driver.getDuration()).toBe(75.0);
      expect(driver.isPlaying()).toBe(true);
      expect(driver.getCurrentTime()).toBeGreaterThanOrEqual(18.25);

      // Shrinking duration below current position clamps cleanly
      driver.pause();
      driver.setDuration(10.0);
      expect(driver.getDuration()).toBe(10.0);
      expect(driver.getCurrentTime()).toBe(10.0);

      driver.destroy();
    });
  });
});

describe('MediaClockDrivers - Scrub Clamping, Paused No-Extrapolation & Rate Re-Anchoring', () => {
  let clock: FakeClock;
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clock = new FakeClock();
    nowSpy = vi.spyOn(performance, 'now').mockImplementation(clock.now);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  describe('seek target clamping to [0, duration]', () => {
    it('clamps Html5MediaDriver seeks beyond duration and below zero', () => {
      const { video } = createFakeVideo();
      const driver = new Html5MediaDriver(
        video as unknown as HTMLVideoElement,
        60.0
      );

      driver.seek(999);
      expect(video.currentTime).toBe(60.0);
      expect(driver.getCurrentTime()).toBe(60.0);

      driver.seek(-42);
      expect(video.currentTime).toBe(0);
      expect(driver.getCurrentTime()).toBe(0);

      driver.destroy();
    });

    it('clamps YouTubeMediaDriver seeks beyond duration and below zero', () => {
      const { driver, player } = createReadyYouTubeDriver(60.0, 10.0);

      driver.seek(120);
      expect(player.seekTo).toHaveBeenLastCalledWith(60.0, true);
      expect(driver.getCurrentTime()).toBe(60.0);

      driver.seek(-8);
      expect(player.seekTo).toHaveBeenLastCalledWith(0, true);
      expect(driver.getCurrentTime()).toBe(0);

      driver.destroy();
    });

    it('clamps ProceduralMediaDriver seeks beyond duration and below zero', () => {
      const driver = new ProceduralMediaDriver(60.0);

      driver.seek(200);
      expect(driver.getCurrentTime()).toBe(60.0);

      driver.seek(-50);
      expect(driver.getCurrentTime()).toBe(0);

      driver.destroy();
    });
  });

  describe('paused scrubbing never extrapolates past the seek target', () => {
    it('Html5MediaDriver holds the paused seek target on repeated reads while the decoder lags', () => {
      const { video } = createFakeVideo();
      const driver = new Html5MediaDriver(
        video as unknown as HTMLVideoElement,
        60.0
      );
      expect(driver.isPlaying()).toBe(false);

      video.seeking = true;
      driver.seek(24.5);
      // Native element still reports the old, pre-seek timestamp.
      video.currentTime = 5.0;

      // Repeated 60fps reads while wall time advances must all return exactly 24.5.
      for (let i = 0; i < 6; i += 1) {
        clock.advance(16);
        expect(driver.getCurrentTime()).toBe(24.5);
      }
      // Underlying element must never have been nudged forward by the driver.
      expect(video.currentTime).toBe(5.0);

      // Even after the 500ms optimistic latch expires, a paused clock stays pinned.
      clock.advance(501);
      expect(driver.getCurrentTime()).toBe(5.0);
      video.currentTime = 24.5;
      video.seeking = false;
      expect(driver.getCurrentTime()).toBe(24.5);

      driver.destroy();
    });

    it('YouTubeMediaDriver returns the anchor target while paused instead of extrapolating', () => {
      const { driver, player } = createReadyYouTubeDriver(60.0, 3.5);
      expect(driver.isPlaying()).toBe(false);

      driver.seek(45.0);
      // IFrame bridge keeps reporting the stale pre-seek time.
      player.currentTime = 3.5;

      for (let i = 0; i < 6; i += 1) {
        clock.advance(16);
        expect(driver.getCurrentTime()).toBe(45.0);
      }

      // After the 600ms guard the paused anchor still wins over the stale poll,
      // and keeps winning on every subsequent read (no rubberband to 3.5s).
      clock.advance(601);
      for (let i = 0; i < 4; i += 1) {
        clock.advance(100);
        expect(driver.getCurrentTime()).toBe(45.0);
      }
      expect(player.currentTime).toBe(3.5);

      driver.destroy();
    });

    it('ProceduralMediaDriver stays fixed at the seek target while paused', () => {
      const driver = new ProceduralMediaDriver(60.0);
      driver.seek(33.0);

      for (let i = 0; i < 5; i += 1) {
        clock.advance(100);
        expect(driver.getCurrentTime()).toBe(33.0);
      }

      driver.destroy();
    });

    it('YouTubeMediaDriver releases the paused latch once the IFrame catches up near the target', () => {
      const { driver, player } = createReadyYouTubeDriver(60.0, 3.5);

      driver.seek(45.0);
      player.currentTime = 3.5;
      expect(driver.getCurrentTime()).toBe(45.0);

      // IFrame arrives within the 1.5s proximity window well before the 600ms guard.
      clock.advance(120);
      player.currentTime = 45.1;
      expect(driver.getCurrentTime()).toBe(45.1);

      // Latch released: later genuine paused polls are adopted normally again.
      clock.advance(50);
      player.currentTime = 45.4;
      expect(driver.getCurrentTime()).toBe(45.4);

      driver.destroy();
    });
  });

  describe('playback rate re-anchoring and clamping', () => {
    it('Html5MediaDriver re-anchors at displayed time and clamps rates to 0.1x–4.0x', () => {
      const { video } = createFakeVideo();
      const driver = new Html5MediaDriver(
        video as unknown as HTMLVideoElement,
        60.0
      );

      // Rate change while an optimistic seek is pending re-anchors to the
      // displayed target instead of snapping back to the stale element time.
      video.seeking = true;
      driver.seek(24.5);
      video.currentTime = 5.0;

      driver.setPlaybackRate(2);
      expect(video.currentTime).toBe(24.5);
      expect(video.playbackRate).toBe(2);

      driver.setPlaybackRate(10);
      expect(video.playbackRate).toBe(4.0);

      driver.setPlaybackRate(0.01);
      expect(video.playbackRate).toBe(0.1);
      expect(driver.getPlaybackRate()).toBe(0.1);

      driver.destroy();
    });

    it('YouTubeMediaDriver re-anchors without a jump and clamps rates to 0.25x–2.0x', () => {
      const { driver, player } = createReadyYouTubeDriver(60.0, 12.0);

      driver.setPlaybackRate(2);
      expect(player.setPlaybackRate).toHaveBeenLastCalledWith(2);
      expect(driver.getPlaybackRate()).toBe(2);
      // Re-anchoring keeps the displayed time exactly where it was.
      expect(driver.getCurrentTime()).toBe(12.0);

      driver.setPlaybackRate(5);
      expect(player.setPlaybackRate).toHaveBeenLastCalledWith(2.0);
      expect(driver.getPlaybackRate()).toBe(2.0);

      driver.setPlaybackRate(0.05);
      expect(player.setPlaybackRate).toHaveBeenLastCalledWith(0.25);
      expect(driver.getPlaybackRate()).toBe(0.25);
      expect(driver.getCurrentTime()).toBe(12.0);

      driver.destroy();
    });

    it('ProceduralMediaDriver re-anchors at displayed time, clamps rates, and does not move while paused', () => {
      const driver = new ProceduralMediaDriver(60.0);
      driver.seek(20.0);

      driver.setPlaybackRate(2);
      expect(driver.getPlaybackRate()).toBe(2);
      expect(driver.getCurrentTime()).toBe(20.0);

      // Wall clock advances but the paused playhead must stay at the anchor.
      clock.advance(500);
      expect(driver.getCurrentTime()).toBe(20.0);

      driver.setPlaybackRate(8);
      expect(driver.getPlaybackRate()).toBe(2.0);
      driver.setPlaybackRate(0.1);
      expect(driver.getPlaybackRate()).toBe(0.25);
      expect(driver.getCurrentTime()).toBe(20.0);

      driver.destroy();
    });
  });

  describe('ProceduralMediaDriver duration shortening', () => {
    it('clamps the playhead to the new end when duration shrinks below it', () => {
      const driver = new ProceduralMediaDriver(60.0);
      driver.seek(40.0);

      driver.setDuration(25.0);
      expect(driver.getDuration()).toBe(25.0);
      expect(driver.getCurrentTime()).toBe(25.0);
      clock.advance(200);
      // Paused at the new end: no extrapolation past the shortened timeline.
      expect(driver.getCurrentTime()).toBe(25.0);

      driver.destroy();
    });

    it('keeps the playhead untouched when the new duration still contains it', () => {
      const driver = new ProceduralMediaDriver(60.0);
      driver.seek(10.0);

      driver.setDuration(30.0);
      expect(driver.getDuration()).toBe(30.0);
      expect(driver.getCurrentTime()).toBe(10.0);

      driver.destroy();
    });

    it('enforces the 0.5s minimum duration while clamping the playhead', () => {
      const driver = new ProceduralMediaDriver(60.0);
      driver.seek(8.0);

      driver.setDuration(0.1);
      expect(driver.getDuration()).toBe(0.5);
      expect(driver.getCurrentTime()).toBe(0.5);

      driver.destroy();
    });
  });

  describe('source switching destroys the old driver and starts the new one paused', () => {
    it('the old Html5MediaDriver is never read again after being replaced', () => {
      const onPlayStateChange = vi.fn();
      const onSeekSettled = vi.fn();
      const { video, listeners } = createFakeVideo();
      const oldDriver = new Html5MediaDriver(
        video as unknown as HTMLVideoElement,
        60.0,
        { onPlayStateChange, onSeekSettled }
      );
      oldDriver.seek(24.5);
      expect(oldDriver.getCurrentTime()).toBe(24.5);

      // React effect cleanup on source switch:
      oldDriver.destroy();

      expect(video.pause).toHaveBeenCalled();
      expect(video.removeEventListener).toHaveBeenCalledWith('play', expect.any(Function));
      expect(video.removeEventListener).toHaveBeenCalledWith('seeked', expect.any(Function));

      // Detached element mutates underneath; the destroyed driver must not read it.
      video.currentTime = 1.25;
      expect(oldDriver.getCurrentTime()).toBe(24.5);
      expect(oldDriver.getDuration()).toBe(60.0);

      // Transport commands on the retired driver are no-ops.
      oldDriver.seek(50);
      expect(video.currentTime).toBe(1.25);
      oldDriver.setPlaybackRate(2);
      expect(video.playbackRate).toBe(1.0);
      oldDriver.setMuted(true);
      expect(video.muted).toBe(false);

      // Late native events from the detached element must not reach callbacks.
      listeners['seeked']?.forEach((cb) => cb());
      listeners['play']?.forEach((cb) => cb());
      expect(onSeekSettled).not.toHaveBeenCalled();
      expect(onPlayStateChange).not.toHaveBeenCalled();

      // The replacement driver starts life paused at t=0.
      const { video: nextVideo } = createFakeVideo({ currentTime: 0 });
      const newDriver = new Html5MediaDriver(
        nextVideo as unknown as HTMLVideoElement,
        60.0
      );
      expect(newDriver.isPlaying()).toBe(false);
      expect(newDriver.getCurrentTime()).toBe(0);
      newDriver.destroy();
    });

    it('the old YouTubeMediaDriver stops polling its torn-down player after a source switch', () => {
      const { driver: oldDriver, player } = createReadyYouTubeDriver(60.0, 45.0);
      oldDriver.seek(45.0);

      oldDriver.destroy();
      expect(player.destroy).toHaveBeenCalledTimes(1);
      // destroy() freezes the final displayed time; no further polls may happen after it.
      const readsAtDestroy = player.getCurrentTime.mock.calls.length;
      player.seekTo.mockClear();
      player.setPlaybackRate.mockClear();

      // Reads after the switch return the frozen anchor and never touch the iframe.
      player.currentTime = 7.75;
      clock.advance(1_000);
      expect(oldDriver.getCurrentTime()).toBe(45.0);
      expect(player.getCurrentTime.mock.calls.length).toBe(readsAtDestroy);
      expect(oldDriver.isPlaying()).toBe(false);

      // Further transport commands cannot reach the destroyed player.
      oldDriver.seek(10);
      oldDriver.setPlaybackRate(1.5);
      expect(player.seekTo).not.toHaveBeenCalled();
      expect(player.setPlaybackRate).not.toHaveBeenCalled();

      // Replacement procedural driver starts paused at t=0.
      const replacement = new ProceduralMediaDriver(60.0);
      expect(replacement.isPlaying()).toBe(false);
      expect(replacement.getCurrentTime()).toBe(0);
      replacement.destroy();
    });

    it('the old ProceduralMediaDriver freezes and ignores commands after destruction', () => {
      const oldDriver = new ProceduralMediaDriver(60.0);
      oldDriver.seek(30.0);
      oldDriver.destroy();

      clock.advance(5_000);
      expect(oldDriver.getCurrentTime()).toBe(30.0);
      expect(oldDriver.isPlaying()).toBe(false);

      oldDriver.seek(5);
      oldDriver.setPlaybackRate(2);
      oldDriver.setDuration(10);
      expect(oldDriver.getCurrentTime()).toBe(30.0);
      expect(oldDriver.getPlaybackRate()).toBe(1.0);
      expect(oldDriver.getDuration()).toBe(60.0);

      const replacement = new ProceduralMediaDriver(45.0);
      expect(replacement.isPlaying()).toBe(false);
      expect(replacement.getCurrentTime()).toBe(0);
      replacement.destroy();
    });
  });
});
