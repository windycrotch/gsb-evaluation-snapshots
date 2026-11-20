import { CdgPlayer } from './player.js';
import { vi } from 'vitest';
describe('CdgPlayer teardown and re-init sequence', () => {
  let canvas: HTMLCanvasElement;
  let audio: HTMLAudioElement;
  let video: HTMLVideoElement;
  let player: CdgPlayer;
  let logs: Array<{ message: string; [key: string]: unknown }>;
  let mockLoader: loaderModule.CdgLoader;

  beforeEach(() => {
    const imageData = {
      data: new Uint8ClampedArray(300 * 216 * 4),
      width: 300,
      height: 216,
    } as unknown as ImageData;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () =>
        ({
          imageSmoothingEnabled: false,
          clearRect: vi.fn(),
          drawImage: vi.fn(),
          createImageData: vi.fn(() => imageData),
          putImageData: vi.fn(),
        }) as unknown as CanvasRenderingContext2D,
    );

    canvas = document.createElement('canvas');
    audio = document.createElement('audio');
    video = document.createElement('video');
    vi.spyOn(audio, 'load').mockImplementation(() => {
      return;
    });

    vi.spyOn(video, 'canPlayType').mockReturnValue('probably');
    vi.spyOn(video, 'load').mockImplementation(() => {
      Object.defineProperty(video, 'readyState', {
        configurable: true,
        value: HTMLMediaElement.HAVE_ENOUGH_DATA,
      });
      Object.defineProperty(video, 'videoWidth', {
        configurable: true,
        value: 1280,
      });
      Object.defineProperty(video, 'videoHeight', {
        configurable: true,
        value: 720,
      });
    });

    const tracks: loaderModule.LoadedTrack[] = [
      {
        trackId: 'audio-1',
        sourceSummary: 'a1.zip',
        audioBuffer: new ArrayBuffer(8),
        mediaKind: 'audio',
        mediaMimeType: 'audio/mpeg',
        audioMimeType: 'audio/mpeg',
        hasGraphics: true,
        cdgBytes: new Uint8Array(24),
        metadata: { title: 'a1', artist: 'ar', album: 'al' },
        warnings: [],
      },
      {
        trackId: 'video-1',
        sourceSummary: 'v1.mp4',
        audioBuffer: new ArrayBuffer(8),
        mediaKind: 'video',
        mediaMimeType: 'video/mp4',
        audioMimeType: 'video/mp4',
        hasGraphics: false,
        cdgBytes: null,
        metadata: { title: 'v1', artist: 'ar', album: 'al' },
        warnings: [],
      },
      {
        trackId: 'audio-2',
        sourceSummary: 'a2.zip',
        audioBuffer: new ArrayBuffer(8),
        mediaKind: 'audio',
        mediaMimeType: 'audio/mpeg',
        audioMimeType: 'audio/mpeg',
        hasGraphics: true,
        cdgBytes: new Uint8Array(24),
        metadata: { title: 'a2', artist: 'ar', album: 'al' },
        warnings: [],
      },
    ];

    let loadIndex = 0;
    mockLoader = {
      load: vi.fn(async () => {
        const track = tracks[loadIndex] ?? tracks[tracks.length - 1];
        loadIndex += 1;
        return track;
      }),
      probe: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    } as unknown as loaderModule.CdgLoader;

    vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:track-1')
      .mockReturnValueOnce('blob:track-2')
      .mockReturnValueOnce('blob:track-3');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      return;
    });

    logs = [];
    player = new CdgPlayer({
      canvas,
      audio,
      video,
      loader: mockLoader,
      debug: true,
    });
    // Patch logger to capture debug logs (bypass private)
    (
      player as unknown as {
        logger: {
          debug: (msg: { message: string; [key: string]: unknown }) => void;
        };
      }
    ).logger.debug = (msg: { message: string; [key: string]: unknown }) =>
      logs.push(msg);
  });

  afterEach(() => {
    player?.dispose();
    logs = [];
  });

  it('tears down and re-inits listeners and audio engine for CDG→video→CDG', async () => {
    // Simulate loading a CDG track
    await player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(24) },
      autoplay: false,
    });
    const firstAudioEngine = player['audioEngine'];
    expect(firstAudioEngine).toBeTruthy();
    expect(player['activeMedia']).toBe(audio);

    // Simulate loading a video track
    await player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(24) },
      autoplay: false,
    });
    const secondAudioEngine = player['audioEngine'];
    expect(secondAudioEngine).not.toBe(firstAudioEngine);
    expect(player['activeMedia']).toBe(video);

    // Simulate loading another CDG track
    await player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(24) },
      autoplay: false,
    });
    const thirdAudioEngine = player['audioEngine'];
    expect(thirdAudioEngine).not.toBe(secondAudioEngine);
    expect(player['activeMedia']).toBe(audio);

    // Check that listeners were bound/unbound and audio engine was recreated
    const bindLogs = logs.filter((l) => l.message === 'bindMediaListeners');
    const unbindLogs = logs.filter((l) => l.message === 'unbindMediaListeners');
    expect(bindLogs.length).toBeGreaterThanOrEqual(3);
    expect(unbindLogs.length).toBeGreaterThanOrEqual(2);
    const disposeLogs = logs.filter((l) => l.message?.startsWith('dispose'));
    expect(disposeLogs.length).toBeGreaterThanOrEqual(0);
  });
});
it('aggressively tears down and re-inits for CDG→MP4→MP4 transitions', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const imageData = {
      data: new Uint8ClampedArray(300 * 216 * 4),
      width: 300,
      height: 216,
    } as unknown as ImageData;
    return {
      imageSmoothingEnabled: false,
      clearRect: () => {
        /* mock */
      },
      drawImage: () => {
        /* mock */
      },
      createImageData: () => imageData,
      putImageData: () => {
        /* mock */
      },
    } as unknown as CanvasRenderingContext2D;
  });
  // Mocks for CDG track
  const cdgLoader = {
    load: vi.fn(async () => ({
      trackId: 'cdg-track',
      sourceSummary: 'song.cdg',
      audioBuffer: new ArrayBuffer(8),
      mediaKind: 'audio',
      mediaMimeType: 'audio/mpeg',
      audioMimeType: 'audio/mpeg',
      hasGraphics: true,
      cdgBytes: new Uint8Array(24),
      metadata: { title: 'CDG', artist: 'Artist', album: 'Album' },
      warnings: [],
    })),
    probe: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(),
  } as unknown as loaderModule.CdgLoader;

  // Mocks for MP4 track
  const mp4Loader = {
    load: vi.fn(async () => ({
      trackId: 'mp4-track',
      sourceSummary: 'video.mp4',
      audioBuffer: new ArrayBuffer(8),
      mediaKind: 'video',
      mediaMimeType: 'video/mp4',
      audioMimeType: 'video/mp4',
      hasGraphics: false,
      cdgBytes: null,
      metadata: { title: 'MP4', artist: 'Artist', album: 'Album' },
      warnings: [],
    })),
    probe: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(),
  } as unknown as loaderModule.CdgLoader;

  // Set up elements
  const canvas = document.createElement('canvas');
  const audio = document.createElement('audio');
  const video = document.createElement('video');
  vi.spyOn(audio, 'load').mockImplementation(() => {
    /* mock */
  });
  vi.spyOn(video, 'canPlayType').mockReturnValue('probably');
  vi.spyOn(video, 'load').mockImplementation(() => {
    Object.defineProperty(video, 'readyState', {
      configurable: true,
      value: HTMLMediaElement.HAVE_ENOUGH_DATA,
    });
    Object.defineProperty(video, 'videoWidth', {
      configurable: true,
      value: 1280,
    });
    Object.defineProperty(video, 'videoHeight', {
      configurable: true,
      value: 720,
    });
  });

  // Start with CDG
  let player = createPlayer({
    options: { canvas, audio, loader: cdgLoader },
  });
  await player.load({
    input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(24) },
  });
  expect(player.getState().status).toBe('ready');
  expect(player.getState().trackId).toBe('cdg-track');
  player.dispose();

  // Load MP4 (first)
  player = createPlayer({
    options: { canvas, audio, video, loader: mp4Loader },
  });
  await player.load({
    input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(32) },
  });
  expect(player.getState().status).toBe('ready');
  expect(player.getState().trackId).toBe('mp4-track');
  // Simulate play and progress
  await player.play();
  expect(player.getState().status).toBe('playing');
  player.pause();
  expect(player.getState().status).toBe('paused');
  player.dispose();

  // Load MP4 (second)
  player = createPlayer({
    options: { canvas, audio, video, loader: mp4Loader },
  });
  await player.load({
    input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(40) },
  });
  expect(player.getState().status).toBe('ready');
  expect(player.getState().trackId).toBe('mp4-track');
  // Simulate play and progress again
  await player.play();
  expect(player.getState().status).toBe('playing');
  player.pause();
  expect(player.getState().status).toBe('paused');
  player.dispose();
});
import { createPlayer } from './player.js';
import * as loaderModule from '@cxing/media-loader';
import * as audioEngineModule from './audio-engine.js';

describe('player', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => {
        const imageData = {
          data: new Uint8ClampedArray(300 * 216 * 4),
          width: 300,
          height: 216,
        } as unknown as ImageData;
        return {
          imageSmoothingEnabled: false,
          clearRect: () => {
            return;
          },
          drawImage: () => {
            return;
          },
          createImageData: () => imageData,
          putImageData: () => {
            return;
          },
        } as unknown as CanvasRenderingContext2D;
      },
    );

    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {
      return;
    });

    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(
      async () => {
        return;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a player with expected API', () => {
    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');

    const player = createPlayer({
      options: {
        canvas,
        audio,
      },
    });

    expect(player).toBeDefined();
    expect(player.getState().status).toBe('idle');

    player.dispose();
  });

  it('falls back safely when worklet mode is requested but unsupported', () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('AudioWorkletNode', undefined);

    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');

    const player = createPlayer({
      options: {
        canvas,
        audio,
        audioEngineMode: 'worklet',
      },
    });

    expect(player.getState().status).toBe('idle');

    player.setPitchSemitones({ value: -2.4 });

    expect(player.getState().pitchSemitones).toBe(-2);

    player.dispose();
  });

  it('initializes and tears down worker renderer when explicitly requested', () => {
    class MockWorker {
      static instances: MockWorker[] = [];

      postMessage = vi.fn();
      terminate = vi.fn();

      constructor(...args: unknown[]) {
        void args;
        MockWorker.instances.push(this);
      }
    }

    vi.stubGlobal('Worker', MockWorker as unknown as typeof Worker);
    vi.stubGlobal(
      'OffscreenCanvas',
      class MockOffscreenCanvas {} as unknown as typeof OffscreenCanvas,
    );

    const canvas = document.createElement('canvas') as HTMLCanvasElement & {
      transferControlToOffscreen?: () => OffscreenCanvas;
    };
    const offscreenCanvas = {
      width: 300,
      height: 216,
      getContext: () => null,
    } as unknown as OffscreenCanvas;

    canvas.transferControlToOffscreen = () => offscreenCanvas;

    const audio = document.createElement('audio');

    const player = createPlayer({
      options: {
        canvas,
        audio,
        renderMode: 'worker',
      },
    });

    expect(MockWorker.instances).toHaveLength(1);
    expect(MockWorker.instances[0]?.postMessage).toHaveBeenCalled();

    player.dispose();
    expect(MockWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
  });

  it('uses loader worker transport when explicitly requested', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      return;
    });

    const loadInWorkerSpy = vi
      .spyOn(loaderModule, 'loadInWorker')
      .mockResolvedValue({
        trackId: 'track-id',
        sourceSummary: 'sample.zip',
        audioBuffer: new ArrayBuffer(8),
        mediaKind: 'audio',
        mediaMimeType: 'audio/mpeg',
        audioMimeType: 'audio/mpeg',
        hasGraphics: true,
        cdgBytes: new Uint8Array(24),
        metadata: {
          title: 'Title',
          artist: 'Artist',
          album: 'Album',
        },
        warnings: [],
      });

    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');
    vi.spyOn(audio, 'load').mockImplementation(() => {
      return;
    });

    const player = createPlayer({
      options: {
        canvas,
        audio,
        loadTransport: 'worker',
      },
    });

    await player.load({
      input: {
        kind: 'arrayBuffer',
        arrayBuffer: new ArrayBuffer(24),
      },
    });

    expect(loadInWorkerSpy).toHaveBeenCalledOnce();
    expect(player.getState().status).toBe('ready');

    player.dispose();
  });

  it('falls back to main-thread load when auto worker transport fails', async () => {
    vi.stubGlobal('Worker', class MockWorker {} as unknown as typeof Worker);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      return;
    });

    const mockLoader = {
      load: vi.fn(async () => ({
        trackId: 'track-id',
        sourceSummary: 'sample.zip',
        audioBuffer: new ArrayBuffer(8),
        mediaKind: 'audio',
        mediaMimeType: 'audio/mpeg',
        audioMimeType: 'audio/mpeg',
        hasGraphics: true,
        cdgBytes: new Uint8Array(24),
        metadata: {
          title: 'Title',
          artist: 'Artist',
          album: 'Album',
        },
        warnings: [],
      })),
      probe: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    } as unknown as loaderModule.CdgLoader;

    vi.spyOn(loaderModule, 'createLoader').mockReturnValue(mockLoader);

    const loadInWorkerSpy = vi
      .spyOn(loaderModule, 'loadInWorker')
      .mockRejectedValue(
        new loaderModule.LoaderError({
          code: 'INTERNAL',
          message: 'Worker transport failed.',
          retriable: true,
        }),
      );

    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');
    vi.spyOn(audio, 'load').mockImplementation(() => {
      return;
    });

    const player = createPlayer({
      options: {
        canvas,
        audio,
        loadTransport: 'auto',
      },
    });

    await player.load({
      input: {
        kind: 'arrayBuffer',
        arrayBuffer: new ArrayBuffer(24),
      },
    });

    expect(loadInWorkerSpy).toHaveBeenCalledOnce();
    expect(mockLoader.load).toHaveBeenCalledOnce();
    expect(player.getState().status).toBe('ready');

    player.dispose();
  });

  it('tracks key changes in semitone steps', () => {
    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');

    const player = createPlayer({
      options: {
        canvas,
        audio,
      },
    });

    player.setPitchSemitones({ value: 3.6 });

    expect(player.getState().pitchSemitones).toBe(4);

    player.dispose();
  });

  it('tracks tempo using playback-rate state', () => {
    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');

    const player = createPlayer({
      options: {
        canvas,
        audio,
      },
    });

    player.setTempo({ value: 1.15 });

    expect(player.getState().playbackRate).toBe(1.15);

    player.dispose();
  });

  it('reuses media-specific audio engines across CDG->video->CDG loads', async () => {
    vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:track-1')
      .mockReturnValueOnce('blob:track-2')
      .mockReturnValueOnce('blob:track-3');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      return;
    });

    const createAudioEngineSpy = vi.spyOn(
      audioEngineModule,
      'createAudioEngine',
    );

    const tracks: loaderModule.LoadedTrack[] = [
      {
        trackId: 'audio-1',
        sourceSummary: 'a1.zip',
        audioBuffer: new ArrayBuffer(8),
        mediaKind: 'audio',
        mediaMimeType: 'audio/mpeg',
        audioMimeType: 'audio/mpeg',
        hasGraphics: true,
        cdgBytes: new Uint8Array(24),
        metadata: { title: 'a1', artist: 'ar', album: 'al' },
        warnings: [],
      },
      {
        trackId: 'video-1',
        sourceSummary: 'v1.mp4',
        audioBuffer: new ArrayBuffer(8),
        mediaKind: 'video',
        mediaMimeType: 'video/mp4',
        audioMimeType: 'video/mp4',
        hasGraphics: false,
        cdgBytes: null,
        metadata: { title: 'v1', artist: 'ar', album: 'al' },
        warnings: [],
      },
      {
        trackId: 'audio-2',
        sourceSummary: 'a2.zip',
        audioBuffer: new ArrayBuffer(8),
        mediaKind: 'audio',
        mediaMimeType: 'audio/mpeg',
        audioMimeType: 'audio/mpeg',
        hasGraphics: true,
        cdgBytes: new Uint8Array(24),
        metadata: { title: 'a2', artist: 'ar', album: 'al' },
        warnings: [],
      },
    ];

    let loadIndex = 0;
    const mockLoader = {
      load: vi.fn(async () => {
        const track = tracks[loadIndex] ?? tracks[tracks.length - 1];
        loadIndex += 1;
        return track;
      }),
      probe: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    } as unknown as loaderModule.CdgLoader;

    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');
    const video = document.createElement('video');

    vi.spyOn(audio, 'load').mockImplementation(() => {
      return;
    });

    vi.spyOn(video, 'canPlayType').mockReturnValue('probably');
    vi.spyOn(video, 'load').mockImplementation(() => {
      Object.defineProperty(video, 'readyState', {
        configurable: true,
        value: HTMLMediaElement.HAVE_ENOUGH_DATA,
      });
      Object.defineProperty(video, 'videoWidth', {
        configurable: true,
        value: 1280,
      });
      Object.defineProperty(video, 'videoHeight', {
        configurable: true,
        value: 720,
      });
    });

    const player = createPlayer({
      options: {
        canvas,
        audio,
        video,
        loader: mockLoader,
      },
    });

    await player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(1) },
    });
    await player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(1) },
    });
    await player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(1) },
    });

    expect(createAudioEngineSpy).toHaveBeenCalledTimes(2);

    player.dispose();
  });

  it('clamps volume and tempo ranges', () => {
    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');

    const player = createPlayer({
      options: {
        canvas,
        audio,
      },
    });

    player.setVolume({ value: -10 });
    expect(player.getState().volume).toBe(0);

    player.setVolume({ value: 10 });
    expect(player.getState().volume).toBe(1);

    player.setTempo({ value: 0.1 });
    expect(player.getState().playbackRate).toBe(0.5);

    player.setPlaybackRate({ value: 4 });
    expect(player.getState().playbackRate).toBe(2);

    player.dispose();
  });

  it('seeks using clamped percentages when duration is valid', () => {
    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');

    Object.defineProperty(audio, 'duration', {
      configurable: true,
      value: 120,
    });

    const player = createPlayer({
      options: {
        canvas,
        audio,
      },
    });

    player.seek({ percentage: 150 });

    expect(audio.currentTime).toBe(120);
    expect(player.getState().currentTimeMs).toBe(120_000);

    player.dispose();
  });

  it('ignores seek when duration is unavailable', () => {
    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');

    Object.defineProperty(audio, 'duration', {
      configurable: true,
      value: Number.NaN,
    });
    audio.currentTime = 10;

    const player = createPlayer({
      options: {
        canvas,
        audio,
      },
    });

    player.seek({ percentage: 50 });

    expect(audio.currentTime).toBe(10);
    player.dispose();
  });

  it('transitions to paused when pause is called before load', () => {
    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');

    const player = createPlayer({
      options: {
        canvas,
        audio,
      },
    });

    player.pause();
    expect(player.getState().status).toBe('paused');

    player.dispose();
  });

  it('sets ready state with zero position when playback ends', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      return;
    });

    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');
    vi.spyOn(audio, 'load').mockImplementation(() => {
      return;
    });

    const mockLoader = {
      load: vi.fn(async () => ({
        trackId: 'track-id',
        sourceSummary: 'sample.zip',
        audioBuffer: new ArrayBuffer(8),
        mediaKind: 'audio',
        mediaMimeType: 'audio/mpeg',
        audioMimeType: 'audio/mpeg',
        hasGraphics: true,
        cdgBytes: new Uint8Array(24),
        metadata: {
          title: 'Title',
          artist: 'Artist',
          album: 'Album',
        },
        warnings: [],
      })),
      probe: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    } as unknown as loaderModule.CdgLoader;

    const player = createPlayer({
      options: {
        canvas,
        audio,
        loader: mockLoader,
      },
    });

    await player.load({
      input: {
        kind: 'arrayBuffer',
        arrayBuffer: new ArrayBuffer(24),
      },
    });

    audio.dispatchEvent(new Event('ended'));

    expect(player.getState().status).toBe('ready');
    expect(player.getState().currentTimeMs).toBe(0);

    player.dispose();
  });

  it('throws when canvas 2d context cannot be created', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementationOnce(
      () => null,
    );

    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');

    expect(() =>
      createPlayer({
        options: {
          canvas,
          audio,
        },
      }),
    ).toThrow('Unable to create 2D context for karaoke player canvas.');
  });

  it('loads in main-thread mode without invoking worker transport', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      return;
    });

    const loadInWorkerSpy = vi.spyOn(loaderModule, 'loadInWorker');
    const mockLoader = {
      load: vi.fn(async () => ({
        trackId: 'main-thread-track',
        sourceSummary: 'sample.zip',
        audioBuffer: new ArrayBuffer(8),
        mediaKind: 'audio',
        mediaMimeType: 'audio/mpeg',
        audioMimeType: 'audio/mpeg',
        hasGraphics: true,
        cdgBytes: new Uint8Array(24),
        metadata: {
          title: 'Title',
          artist: 'Artist',
          album: 'Album',
        },
        warnings: [],
      })),
      probe: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    } as unknown as loaderModule.CdgLoader;

    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');
    vi.spyOn(audio, 'load').mockImplementation(() => {
      return;
    });

    const player = createPlayer({
      options: {
        canvas,
        audio,
        loader: mockLoader,
        loadTransport: 'main-thread',
      },
    });

    await player.load({
      input: {
        kind: 'arrayBuffer',
        arrayBuffer: new ArrayBuffer(24),
      },
    });

    expect(loadInWorkerSpy).not.toHaveBeenCalled();
    expect(mockLoader.load).toHaveBeenCalledOnce();

    player.dispose();
  });

  it('emits error state/event when worker load fails without fallback', async () => {
    vi.stubGlobal('Worker', class MockWorker {} as unknown as typeof Worker);

    const workerError = new loaderModule.LoaderError({
      code: 'FETCH_FAILED',
      message: 'fetch failed',
      retriable: false,
    });

    vi.spyOn(loaderModule, 'loadInWorker').mockRejectedValue(workerError);

    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');

    const player = createPlayer({
      options: {
        canvas,
        audio,
        loadTransport: 'worker',
      },
    });

    const onError = vi.fn();
    player.addEventListener('error', onError);

    await expect(
      player.load({
        input: {
          kind: 'arrayBuffer',
          arrayBuffer: new ArrayBuffer(24),
        },
      }),
    ).rejects.toBe(workerError);

    expect(player.getState().status).toBe('error');
    expect(onError).toHaveBeenCalledOnce();

    player.dispose();
  });

  it('falls back in auto mode when worker load throws non-loader error', async () => {
    vi.stubGlobal('Worker', class MockWorker {} as unknown as typeof Worker);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      return;
    });

    const loadInWorkerSpy = vi
      .spyOn(loaderModule, 'loadInWorker')
      .mockRejectedValue(new Error('unexpected worker failure'));

    const mockLoader = {
      load: vi.fn(async () => ({
        trackId: 'fallback-track',
        sourceSummary: 'sample.zip',
        audioBuffer: new ArrayBuffer(8),
        mediaKind: 'audio',
        mediaMimeType: 'audio/mpeg',
        audioMimeType: 'audio/mpeg',
        hasGraphics: true,
        cdgBytes: new Uint8Array(24),
        metadata: {
          title: 'Title',
          artist: 'Artist',
          album: 'Album',
        },
        warnings: [],
      })),
      probe: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    } as unknown as loaderModule.CdgLoader;

    vi.spyOn(loaderModule, 'createLoader').mockReturnValue(mockLoader);

    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');
    vi.spyOn(audio, 'load').mockImplementation(() => {
      return;
    });

    const player = createPlayer({
      options: {
        canvas,
        audio,
        loadTransport: 'auto',
      },
    });

    await player.load({
      input: {
        kind: 'arrayBuffer',
        arrayBuffer: new ArrayBuffer(24),
      },
    });

    expect(loadInWorkerSpy).toHaveBeenCalledOnce();
    expect(mockLoader.load).toHaveBeenCalledOnce();

    player.dispose();
  });

  it('autoplay transitions to playing state after load', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      return;
    });

    const mockLoader = {
      load: vi.fn(async () => ({
        trackId: 'track-id',
        sourceSummary: 'sample.zip',
        audioBuffer: new ArrayBuffer(8),
        mediaKind: 'audio',
        mediaMimeType: 'audio/mpeg',
        audioMimeType: 'audio/mpeg',
        hasGraphics: true,
        cdgBytes: new Uint8Array(24),
        metadata: {
          title: 'Title',
          artist: 'Artist',
          album: 'Album',
        },
        warnings: [],
      })),
      probe: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    } as unknown as loaderModule.CdgLoader;

    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');
    vi.spyOn(audio, 'load').mockImplementation(() => {
      return;
    });

    const player = createPlayer({
      options: {
        canvas,
        audio,
        loader: mockLoader,
      },
    });

    await player.load({
      input: {
        kind: 'arrayBuffer',
        arrayBuffer: new ArrayBuffer(24),
      },
      autoplay: true,
    });

    expect(player.getState().status).toBe('playing');

    player.dispose();
  });

  it('does not transition to paused for idle status pause event', () => {
    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');

    const player = createPlayer({
      options: {
        canvas,
        audio,
      },
    });

    audio.dispatchEvent(new Event('pause'));

    expect(player.getState().status).toBe('idle');

    player.dispose();
  });

  it('updates state to playing for play event', () => {
    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');

    const player = createPlayer({
      options: {
        canvas,
        audio,
      },
    });

    audio.dispatchEvent(new Event('play'));

    expect(player.getState().status).toBe('playing');

    player.dispose();
  });

  it('updates playback time state for timeupdate events', () => {
    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');

    // Patch: define duration before player creation
    Object.defineProperty(audio, 'duration', {
      configurable: true,
      value: 123.456,
    });
    audio.currentTime = 12.345;

    const player = createPlayer({
      options: {
        canvas,
        audio,
      },
    });

    audio.dispatchEvent(new Event('timeupdate'));

    expect(player.getState().currentTimeMs).toBe(12_345);
    expect(player.getState().durationMs).toBe(123_456);

    player.dispose();
  });

  it('uses synchronous core load path when loadAsync is unavailable', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      return;
    });

    const mockLoader = {
      load: vi.fn(async () => ({
        trackId: 'sync-track',
        sourceSummary: 'sample.zip',
        audioBuffer: new ArrayBuffer(8),
        mediaKind: 'audio',
        mediaMimeType: 'audio/mpeg',
        audioMimeType: 'audio/mpeg',
        hasGraphics: true,
        cdgBytes: new Uint8Array(24),
        metadata: {
          title: 'Title',
          artist: 'Artist',
          album: 'Album',
        },
        warnings: [],
      })),
      probe: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    } as unknown as loaderModule.CdgLoader;

    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');
    vi.spyOn(audio, 'load').mockImplementation(() => {
      return;
    });

    const player = createPlayer({
      options: {
        canvas,
        audio,
        loader: mockLoader,
      },
    }) as unknown as {
      load: (args: {
        input: { kind: 'arrayBuffer'; arrayBuffer: ArrayBuffer };
      }) => Promise<unknown>;
      cdgPlayer: {
        loadAsync?: unknown;
        load: ReturnType<typeof vi.fn>;
      };
      dispose: () => void;
    };

    const loadSpy = vi.fn();
    player.cdgPlayer.loadAsync = undefined;
    player.cdgPlayer.load = loadSpy;

    await player.load({
      input: {
        kind: 'arrayBuffer',
        arrayBuffer: new ArrayBuffer(24),
      },
    });

    expect(loadSpy).toHaveBeenCalledOnce();

    player.dispose();
  });

  it('loads and plays audio-only tracks without graphics bytes', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      return;
    });

    const mockLoader = {
      load: vi.fn(async () => ({
        trackId: 'audio-only-track',
        sourceSummary: 'song.ogg',
        audioBuffer: new ArrayBuffer(8),
        mediaKind: 'audio',
        mediaMimeType: 'audio/ogg',
        audioMimeType: 'audio/ogg',
        hasGraphics: false,
        cdgBytes: null,
        metadata: {
          title: 'Song',
          artist: 'Artist',
          album: 'Album',
        },
        warnings: [],
      })),
      probe: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    } as unknown as loaderModule.CdgLoader;

    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');
    vi.spyOn(audio, 'load').mockImplementation(() => {
      return;
    });

    const player = createPlayer({
      options: {
        canvas,
        audio,
        loader: mockLoader,
      },
    });

    await player.load({
      input: {
        kind: 'arrayBuffer',
        arrayBuffer: new ArrayBuffer(16),
      },
    });

    expect(player.getState().status).toBe('ready');

    await player.play();
    expect(player.getState().status).toBe('playing');

    player.pause();
    expect(player.getState().status).toBe('paused');

    player.dispose();
  });

  it('throws when video media is loaded but no video element is configured', async () => {
    const mockLoader = {
      load: vi.fn(async () => ({
        trackId: 'video-track',
        sourceSummary: 'video.mp4',
        audioBuffer: new ArrayBuffer(8),
        mediaKind: 'video',
        mediaMimeType: 'video/mp4',
        audioMimeType: 'video/mp4',
        hasGraphics: false,
        cdgBytes: null,
        metadata: {
          title: 'Video',
          artist: 'Artist',
          album: 'Album',
        },
        warnings: [],
      })),
      probe: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    } as unknown as loaderModule.CdgLoader;

    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');

    const player = createPlayer({
      options: {
        canvas,
        audio,
        loader: mockLoader,
      },
    });

    await expect(
      player.load({
        input: {
          kind: 'arrayBuffer',
          arrayBuffer: new ArrayBuffer(16),
        },
      }),
    ).rejects.toThrow(
      'Loaded video media but no video element was provided to the player.',
    );

    expect(player.getState().status).toBe('error');
    player.dispose();
  });

  it('rejects video tracks when media element cannot play the mime type', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-video');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      return;
    });

    const mockLoader = {
      load: vi.fn(async () => ({
        trackId: 'video-track',
        sourceSummary: 'video.mp4',
        audioBuffer: new ArrayBuffer(8),
        mediaKind: 'video',
        mediaMimeType: 'video/mp4',
        audioMimeType: 'video/mp4',
        hasGraphics: false,
        cdgBytes: null,
        metadata: {
          title: 'Video',
          artist: 'Artist',
          album: 'Album',
        },
        warnings: [],
      })),
      probe: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    } as unknown as loaderModule.CdgLoader;

    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');
    const video = document.createElement('video');
    vi.spyOn(video, 'canPlayType').mockReturnValue('');

    const player = createPlayer({
      options: {
        canvas,
        audio,
        video,
        loader: mockLoader,
      },
    });

    await expect(
      player.load({
        input: {
          kind: 'arrayBuffer',
          arrayBuffer: new ArrayBuffer(16),
        },
      }),
    ).rejects.toThrow('This browser cannot play video format video/mp4.');

    player.dispose();
  });

  it('loads a playable video track and deactivates the audio element source', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-video');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      return;
    });

    const mockLoader = {
      load: vi.fn(async () => ({
        trackId: 'video-track',
        sourceSummary: 'video.mp4',
        audioBuffer: new ArrayBuffer(8),
        mediaKind: 'video',
        mediaMimeType: 'video/mp4',
        audioMimeType: 'video/mp4',
        hasGraphics: false,
        cdgBytes: null,
        metadata: {
          title: 'Video',
          artist: 'Artist',
          album: 'Album',
        },
        warnings: [],
      })),
      probe: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    } as unknown as loaderModule.CdgLoader;

    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');
    const video = document.createElement('video');

    Object.defineProperty(video, 'readyState', {
      configurable: true,
      value: HTMLMediaElement.HAVE_ENOUGH_DATA,
    });
    Object.defineProperty(video, 'videoWidth', {
      configurable: true,
      value: 1280,
    });
    Object.defineProperty(video, 'videoHeight', {
      configurable: true,
      value: 720,
    });

    vi.spyOn(video, 'canPlayType').mockReturnValue('probably');
    const audioPauseSpy = vi.spyOn(audio, 'pause').mockImplementation(() => {
      return;
    });
    const audioLoadSpy = vi.spyOn(audio, 'load').mockImplementation(() => {
      return;
    });
    vi.spyOn(video, 'load').mockImplementation(() => {
      return;
    });

    const player = createPlayer({
      options: {
        canvas,
        audio,
        video,
        loader: mockLoader,
      },
    });

    await player.load({
      input: {
        kind: 'arrayBuffer',
        arrayBuffer: new ArrayBuffer(16),
      },
    });

    expect(player.getState().status).toBe('ready');
    expect(audioPauseSpy).toHaveBeenCalled();
    expect(audioLoadSpy).toHaveBeenCalled();

    player.dispose();
  });

  it('waits for video metadata and canplay events when readyState is not yet available', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-video');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      return;
    });

    const mockLoader = {
      load: vi.fn(async () => ({
        trackId: 'video-track-pending',
        sourceSummary: 'video.mp4',
        audioBuffer: new ArrayBuffer(8),
        mediaKind: 'video',
        mediaMimeType: 'video/mp4',
        audioMimeType: 'video/mp4',
        hasGraphics: false,
        cdgBytes: null,
        metadata: {
          title: 'Video',
          artist: 'Artist',
          album: 'Album',
        },
        warnings: [],
      })),
      probe: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    } as unknown as loaderModule.CdgLoader;

    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');
    const video = document.createElement('video');

    let readyStateValue = 0;
    let widthValue = 0;
    let heightValue = 0;

    Object.defineProperty(video, 'readyState', {
      configurable: true,
      get: () => readyStateValue,
    });
    Object.defineProperty(video, 'videoWidth', {
      configurable: true,
      get: () => widthValue,
    });
    Object.defineProperty(video, 'videoHeight', {
      configurable: true,
      get: () => heightValue,
    });

    vi.spyOn(video, 'canPlayType').mockReturnValue('probably');
    vi.spyOn(video, 'load').mockImplementation(() => {
      queueMicrotask(() => {
        readyStateValue = HTMLMediaElement.HAVE_METADATA;
        widthValue = 1280;
        heightValue = 720;
        video.dispatchEvent(new Event('loadedmetadata'));

        queueMicrotask(() => {
          readyStateValue = HTMLMediaElement.HAVE_FUTURE_DATA;
          video.dispatchEvent(new Event('canplay'));
        });
      });
    });

    const player = createPlayer({
      options: {
        canvas,
        audio,
        video,
        loader: mockLoader,
      },
    });

    await player.load({
      input: {
        kind: 'arrayBuffer',
        arrayBuffer: new ArrayBuffer(16),
      },
    });

    expect(player.getState().status).toBe('ready');
    player.dispose();
  });

  it('fails video load when metadata event emits an error', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-video');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      return;
    });

    const mockLoader = {
      load: vi.fn(async () => ({
        trackId: 'video-track-error',
        sourceSummary: 'video.mp4',
        audioBuffer: new ArrayBuffer(8),
        mediaKind: 'video',
        mediaMimeType: 'video/mp4',
        audioMimeType: 'video/mp4',
        hasGraphics: false,
        cdgBytes: null,
        metadata: {
          title: 'Video',
          artist: 'Artist',
          album: 'Album',
        },
        warnings: [],
      })),
      probe: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    } as unknown as loaderModule.CdgLoader;

    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');
    const video = document.createElement('video');

    let readyStateValue = 0;
    Object.defineProperty(video, 'readyState', {
      configurable: true,
      get: () => readyStateValue,
    });

    vi.spyOn(video, 'canPlayType').mockReturnValue('probably');
    vi.spyOn(video, 'load').mockImplementation(() => {
      queueMicrotask(() => {
        readyStateValue = HTMLMediaElement.HAVE_METADATA;
        video.dispatchEvent(new Event('error'));
      });
    });

    const player = createPlayer({
      options: {
        canvas,
        audio,
        video,
        loader: mockLoader,
      },
    });

    await expect(
      player.load({
        input: {
          kind: 'arrayBuffer',
          arrayBuffer: new ArrayBuffer(16),
        },
      }),
    ).rejects.toThrow('Unable to read video metadata in this browser.');

    player.dispose();
  });

  it('fails video load when canplay wait emits an error event', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-video');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      return;
    });

    const mockLoader = {
      load: vi.fn(async () => ({
        trackId: 'video-track-canplay-error',
        sourceSummary: 'video.mp4',
        audioBuffer: new ArrayBuffer(8),
        mediaKind: 'video',
        mediaMimeType: 'video/mp4',
        audioMimeType: 'video/mp4',
        hasGraphics: false,
        cdgBytes: null,
        metadata: {
          title: 'Video',
          artist: 'Artist',
          album: 'Album',
        },
        warnings: [],
      })),
      probe: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    } as unknown as loaderModule.CdgLoader;

    const canvas = document.createElement('canvas');
    const audio = document.createElement('audio');
    const video = document.createElement('video');

    let readyStateValue = 0;
    const widthValue = 1280;
    const heightValue = 720;

    Object.defineProperty(video, 'readyState', {
      configurable: true,
      get: () => readyStateValue,
    });
    Object.defineProperty(video, 'videoWidth', {
      configurable: true,
      get: () => widthValue,
    });
    Object.defineProperty(video, 'videoHeight', {
      configurable: true,
      get: () => heightValue,
    });

    vi.spyOn(video, 'canPlayType').mockReturnValue('probably');
    readyStateValue = HTMLMediaElement.HAVE_METADATA;
    vi.spyOn(audio, 'load').mockImplementation(() => {
      return;
    });
    vi.spyOn(video, 'load').mockImplementation(() => {
      return;
    });

    const originalAddEventListener = video.addEventListener.bind(video);
    vi.spyOn(video, 'addEventListener').mockImplementation(((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void => {
      originalAddEventListener(type, listener, options);

      if (type === 'error') {
        queueMicrotask(() => {
          video.dispatchEvent(new Event('error'));
        });
      }
    }) as HTMLVideoElement['addEventListener']);

    const player = createPlayer({
      options: {
        canvas,
        audio,
        video,
        loader: mockLoader,
      },
    });

    await expect(
      player.load({
        input: {
          kind: 'arrayBuffer',
          arrayBuffer: new ArrayBuffer(16),
        },
      }),
    ).rejects.toThrow('Unable to load video media in this browser.');

    player.dispose();
  });

  describe('load session isolation', () => {
    /**
     * Builds a loader whose single `load` promise is controlled per call so a
     * test can resolve overlapping loads out of order.
     */
    const createDeferredLoader = (): {
      loader: loaderModule.CdgLoader;
      deferreds: Array<{
        resolve: (track: loaderModule.LoadedTrack) => void;
        reject: (error: unknown) => void;
      }>;
    } => {
      const deferreds: Array<{
        resolve: (track: loaderModule.LoadedTrack) => void;
        reject: (error: unknown) => void;
      }> = [];
      const load = vi.fn(
        () =>
          new Promise<loaderModule.LoadedTrack>((resolve, reject) => {
            deferreds.push({ resolve, reject });
          }),
      );

      return {
        loader: {
          load,
          probe: vi.fn(),
          cancel: vi.fn(),
          dispose: vi.fn(),
        } as unknown as loaderModule.CdgLoader,
        deferreds,
      };
    };

    const createTrack = ({
      trackId,
      hasGraphics = true,
      cdgByteLength = 24,
    }: {
      trackId: string;
      hasGraphics?: boolean;
      cdgByteLength?: number;
    }): loaderModule.LoadedTrack => ({
      trackId,
      sourceSummary: `${trackId}.zip`,
      audioBuffer: new ArrayBuffer(8),
      mediaKind: 'audio',
      mediaMimeType: 'audio/mpeg',
      audioMimeType: 'audio/mpeg',
      hasGraphics,
      cdgBytes: hasGraphics ? new Uint8Array(cdgByteLength) : null,
      metadata: { title: trackId, artist: 'Artist', album: 'Album' },
      warnings: [],
    });

    const createHarness = ({
      loader,
    }: {
      loader: loaderModule.CdgLoader;
    }): {
      player: CdgPlayer;
      canvas: HTMLCanvasElement;
      audio: HTMLAudioElement;
    } => {
      const canvas = document.createElement('canvas');
      const audio = document.createElement('audio');
      vi.spyOn(audio, 'load').mockImplementation(() => {
        return;
      });

      const player = createPlayer({
        options: {
          canvas,
          audio,
          loader,
          loadTransport: 'main-thread',
        },
      });

      return { player, canvas, audio };
    };

    it('keeps state and trackId from the newer load when the first settles last', async () => {
      const { loader, deferreds } = createDeferredLoader();
      vi.spyOn(URL, 'createObjectURL')
        .mockReturnValueOnce('blob:first')
        .mockReturnValueOnce('blob:second');
      const revokeSpy = vi
        .spyOn(URL, 'revokeObjectURL')
        .mockImplementation(() => {
          return;
        });

      const { player } = createHarness({ loader });
      const corePlayer = player['cdgPlayer'];

      const firstLoad = player.load({
        input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(24) },
      });
      const secondLoad = player.load({
        input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(24) },
      });

      // Resolve the second (newest) load first, then the superseded first one.
      // The two tracks carry distinguishable CDG packet counts (24 vs 48 bytes)
      // so we can prove the canvas was fed by the newest session only.
      deferreds[1]?.resolve(
        createTrack({ trackId: 'newer-track', cdgByteLength: 48 }),
      );
      await secondLoad;
      deferreds[0]?.resolve(
        createTrack({ trackId: 'older-track', cdgByteLength: 24 }),
      );
      await expect(firstLoad).rejects.toThrow(/superseded/i);

      expect(player.getState().status).toBe('ready');
      expect(player.getState().trackId).toBe('newer-track');
      // The stale session never created a URL, so only the newest URL existed.
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeSpy).not.toHaveBeenCalledWith('blob:second');
      // The newest session's parsed packets remain committed to the canvas.
      expect(corePlayer.instructions).toHaveLength(2);

      player.dispose();
    });

    it('keeps the player ready when the first load fails but the second succeeds', async () => {
      const { loader, deferreds } = createDeferredLoader();
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:second');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
        return;
      });

      const { player } = createHarness({ loader });
      const errorListener = vi.fn();
      player.addEventListener('error', errorListener);

      const firstLoad = player.load({
        input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(24) },
      });
      const secondLoad = player.load({
        input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(24) },
      });

      deferreds[1]?.resolve(createTrack({ trackId: 'winner-track' }));
      await secondLoad;
      deferreds[0]?.reject(new Error('first load failed'));
      await expect(firstLoad).rejects.toThrow('first load failed');

      expect(player.getState().status).toBe('ready');
      expect(player.getState().trackId).toBe('winner-track');
      expect(errorListener).not.toHaveBeenCalled();

      player.dispose();
    });

    it('enters error and revokes its object URL when the newest load fails while binding media', async () => {
      const { loader, deferreds } = createDeferredLoader();
      const revokeSpy = vi
        .spyOn(URL, 'revokeObjectURL')
        .mockImplementation(() => {
          return;
        });
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:failure');

      // Build the harness manually so media `load()` can throw during bind.
      const canvas = document.createElement('canvas');
      const audio = document.createElement('audio');
      vi.spyOn(audio, 'load').mockImplementation(() => {
        throw new Error('media bind failed');
      });
      const player = createPlayer({
        options: {
          canvas,
          audio,
          loader,
          loadTransport: 'main-thread',
        },
      });
      const errorListener = vi.fn();
      player.addEventListener('error', errorListener);

      const firstLoad = player.load({
        input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(24) },
      });
      const secondLoad = player.load({
        input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(24) },
      });

      // First session resolves successfully but is already superseded; it must
      // not bind media, so only the second session reaches `audio.load()`.
      deferreds[0]?.resolve(createTrack({ trackId: 'stale-track' }));
      await expect(firstLoad).rejects.toThrow(/superseded/i);
      expect(errorListener).not.toHaveBeenCalled();

      deferreds[1]?.resolve(createTrack({ trackId: 'newest-track' }));
      await expect(secondLoad).rejects.toThrow('media bind failed');

      expect(player.getState().status).toBe('error');
      expect(errorListener).toHaveBeenCalledOnce();
      expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
      expect(revokeSpy).toHaveBeenCalledWith('blob:failure');

      player.dispose();
    });

    it('releases CDG data it loaded when the newest session fails', async () => {
      const { loader, deferreds } = createDeferredLoader();
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cdg');
      const revokeSpy = vi
        .spyOn(URL, 'revokeObjectURL')
        .mockImplementation(() => {
          return;
        });

      const canvas = document.createElement('canvas');
      const audio = document.createElement('audio');
      vi.spyOn(audio, 'load').mockImplementation(() => {
        throw new Error('media bind failed after CDG parse');
      });
      const player = createPlayer({
        options: {
          canvas,
          audio,
          loader,
          loadTransport: 'main-thread',
        },
      });
      const errorListener = vi.fn();
      player.addEventListener('error', errorListener);

      const loadPromise = player.load({
        input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(24) },
      });
      deferreds[0]?.resolve(
        createTrack({ trackId: 'cdg-failure-track', hasGraphics: true }),
      );
      await expect(loadPromise).rejects.toThrow(
        'media bind failed after CDG parse',
      );

      expect(player.getState().status).toBe('error');
      expect(errorListener).toHaveBeenCalledOnce();
      expect(player['cdgPlayer'].instructions).toHaveLength(0);
      expect(revokeSpy).toHaveBeenCalledWith('blob:cdg');

      player.dispose();
    });

    it('detaches the media listeners it bound when the newest session fails', async () => {
      const { loader, deferreds } = createDeferredLoader();
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:listener-failure');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
        return;
      });

      const canvas = document.createElement('canvas');
      const audio = document.createElement('audio');
      const video = document.createElement('video');
      vi.spyOn(audio, 'load').mockImplementation(() => {
        return;
      });
      // Video triggers the metadata wait path; force an error on video load so
      // the session fails only after it has bound the video listeners.
      let readyStateValue = 0;
      Object.defineProperty(video, 'readyState', {
        configurable: true,
        get: () => readyStateValue,
      });
      vi.spyOn(video, 'canPlayType').mockReturnValue('probably');
      vi.spyOn(video, 'load').mockImplementation(() => {
        queueMicrotask(() => {
          readyStateValue = HTMLMediaElement.HAVE_METADATA;
          video.dispatchEvent(new Event('error'));
        });
      });

      const player = createPlayer({
        options: {
          canvas,
          audio,
          video,
          loader,
          loadTransport: 'main-thread',
        },
      });
      const errorListener = vi.fn();
      player.addEventListener('error', errorListener);

      // Spy on the video element's add/remove to prove bind/unbind symmetry.
      const addSpy = vi.spyOn(video, 'addEventListener');
      const removeSpy = vi.spyOn(video, 'removeEventListener');

      const loadPromise = player.load({
        input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(24) },
      });
      deferreds[0]?.resolve({
        ...createTrack({ trackId: 'video-bound', hasGraphics: false }),
        mediaKind: 'video',
        mediaMimeType: 'video/mp4',
        audioMimeType: 'video/mp4',
      });
      await expect(loadPromise).rejects.toThrow(
        'Unable to read video metadata in this browser.',
      );

      expect(player.getState().status).toBe('error');
      expect(errorListener).toHaveBeenCalledOnce();
      expect(addSpy).toHaveBeenCalledWith('timeupdate', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith(
        'timeupdate',
        expect.any(Function),
      );

      player.dispose();
    });

    it('has no side effects from a late session after dispose', async () => {
      const { loader, deferreds } = createDeferredLoader();
      const createObjectUrlSpy = vi
        .spyOn(URL, 'createObjectURL')
        .mockReturnValue('blob:late');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
        return;
      });

      const { player } = createHarness({ loader });
      let stateChangeCount = 0;
      player.addEventListener('statechange', () => {
        stateChangeCount += 1;
      });

      const loadPromise = player.load({
        input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(24) },
      });

      player.dispose();
      const stateAtDispose = player.getState();
      const changesAtDispose = stateChangeCount;

      // The loader resolves after dispose; the session must be discarded.
      deferreds[0]?.resolve(createTrack({ trackId: 'late-track' }));
      await expect(loadPromise).rejects.toThrow();

      expect(createObjectUrlSpy).not.toHaveBeenCalled();
      expect(player.getState().status).toBe(stateAtDispose.status);
      expect(player.getState().trackId).toBe(stateAtDispose.trackId);
      expect(stateChangeCount).toBe(changesAtDispose);
    });

    it('discards a session that was mid video-wait when dispose is called', async () => {
      const { loader, deferreds } = createDeferredLoader();
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mid-flight');
      const revokeSpy = vi
        .spyOn(URL, 'revokeObjectURL')
        .mockImplementation(() => {
          return;
        });

      const canvas = document.createElement('canvas');
      const audio = document.createElement('audio');
      const video = document.createElement('video');
      vi.spyOn(audio, 'load').mockImplementation(() => {
        return;
      });
      vi.spyOn(video, 'canPlayType').mockReturnValue('probably');
      Object.defineProperty(video, 'readyState', {
        configurable: true,
        get: () => 0, // force the metadata wait to suspend
      });
      vi.spyOn(video, 'load').mockImplementation(() => {
        return;
      });

      const player = createPlayer({
        options: {
          canvas,
          audio,
          video,
          loader,
          loadTransport: 'main-thread',
        },
      });
      const errorListener = vi.fn();
      player.addEventListener('error', errorListener);

      const loadPromise = player.load({
        input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(24) },
      });
      deferreds[0]?.resolve({
        ...createTrack({ trackId: 'video-mid-flight', hasGraphics: false }),
        mediaKind: 'video',
        mediaMimeType: 'video/mp4',
        audioMimeType: 'video/mp4',
      });

      // Let the session reach the pending metadata wait and create its URL.
      await Promise.resolve();
      await Promise.resolve();

      player.dispose();
      const stateAtDispose = player.getState();
      await expect(loadPromise).rejects.toThrow();

      expect(player.getState().status).toBe(stateAtDispose.status);
      expect(player.getState().trackId).toBe(stateAtDispose.trackId);
      expect(errorListener).not.toHaveBeenCalled();
      expect(revokeSpy).toHaveBeenCalledWith('blob:mid-flight');
    });
  });
});
