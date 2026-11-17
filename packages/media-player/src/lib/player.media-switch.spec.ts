import * as loaderModule from '@cxing/media-loader';
import * as audioEngineModule from './audio-engine.js';
import { CdgPlayer, type CdgPlayerOptions } from './player.js';

interface EngineProbe {
  readonly volume?: number;
  readonly playbackRate?: number;
  readonly pitchSemitones?: number;
}

const createTrack = ({
  trackId,
  mediaKind,
}: {
  trackId: string;
  mediaKind: loaderModule.LoadedTrackMediaKind;
}): loaderModule.LoadedTrack => ({
  trackId,
  sourceSummary: `${trackId}.zip`,
  audioBuffer: new ArrayBuffer(8),
  mediaKind,
  mediaMimeType: mediaKind === 'video' ? 'video/mp4' : 'audio/mpeg',
  audioMimeType: mediaKind === 'video' ? 'video/mp4' : 'audio/mpeg',
  hasGraphics: mediaKind === 'audio',
  cdgBytes: mediaKind === 'audio' ? new Uint8Array(24) : null,
  metadata: { title: trackId, artist: 'Artist', album: 'Album' },
  warnings: [],
});

const canvasContextMock = (): CanvasRenderingContext2D => {
  const imageData = {
    data: new Uint8ClampedArray(300 * 216 * 4),
    width: 300,
    height: 216,
  } as unknown as ImageData;

  return {
    imageSmoothingEnabled: false,
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    createImageData: vi.fn(() => imageData),
    putImageData: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
};

describe('CdgPlayer media-switch settings synchronization', () => {
  let canvas: HTMLCanvasElement;
  let audio: HTMLAudioElement;
  let video: HTMLVideoElement;
  let objectUrlIndex: number;
  let tracks: loaderModule.LoadedTrack[];
  let loadIndex: number;
  let mockLoader: loaderModule.CdgLoader;

  const createTestPlayer = (
    options: Partial<CdgPlayerOptions> = {},
  ): CdgPlayer =>
    new CdgPlayer({
      canvas,
      audio,
      video,
      loader: mockLoader,
      audioEngineMode: 'native',
      ...options,
    });

  const engineFor = (player: CdgPlayer, media: HTMLMediaElement): EngineProbe =>
    (
      player as unknown as {
        audioEnginesByMedia: Map<HTMLMediaElement, EngineProbe>;
      }
    ).audioEnginesByMedia.get(media) as EngineProbe;

  const activeEngine = (player: CdgPlayer): EngineProbe =>
    (player as unknown as { audioEngine: EngineProbe }).audioEngine;

  const loadNext = async (player: CdgPlayer): Promise<void> => {
    await player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(24) },
    });
  };

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      canvasContextMock,
    );

    canvas = document.createElement('canvas');
    audio = document.createElement('audio');
    video = document.createElement('video');

    // Real browsers reset `playbackRate` to the default when a new source is
    // loaded; emulate that so the test catches missing re-application.
    vi.spyOn(audio, 'load').mockImplementation(() => {
      audio.playbackRate = 1;
    });
    vi.spyOn(video, 'canPlayType').mockReturnValue('probably');
    vi.spyOn(video, 'load').mockImplementation(() => {
      video.playbackRate = 1;
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

    tracks = [
      createTrack({ trackId: 'audio-1', mediaKind: 'audio' }),
      createTrack({ trackId: 'video-1', mediaKind: 'video' }),
      createTrack({ trackId: 'audio-2', mediaKind: 'audio' }),
      createTrack({ trackId: 'audio-3', mediaKind: 'audio' }),
    ];
    loadIndex = 0;

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

    objectUrlIndex = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(
      () => `blob:track-${(objectUrlIndex += 1)}`,
    );
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies volume, tempo, and pitch to the engine of the active media after audio→video→audio', async () => {
    const player = createTestPlayer();

    await loadNext(player);
    const audioEngine = activeEngine(player);

    player.setVolume({ value: 0.25 });
    player.setTempo({ value: 1.5 });
    player.setPitchSemitones({ value: -3 });

    expect(audioEngine).toMatchObject({
      volume: 0.25,
      playbackRate: 1.5,
      pitchSemitones: -3,
    });
    expect(audio.volume).toBe(0.25);
    expect(audio.playbackRate).toBe(1.5);

    // Switch to video: the same settings must land on the video engine.
    await loadNext(player);
    const videoEngine = activeEngine(player);
    expect(videoEngine).not.toBe(audioEngine);
    expect(player['activeMedia']).toBe(video);
    expect(videoEngine).toMatchObject({
      volume: 0.25,
      playbackRate: 1.5,
      pitchSemitones: -3,
    });
    expect(video.volume).toBe(0.25);
    expect(video.playbackRate).toBe(1.5);

    // Switch back to audio: the previously configured values stay in effect.
    await loadNext(player);
    expect(activeEngine(player)).toBe(audioEngine);
    expect(player['activeMedia']).toBe(audio);
    expect(engineFor(player, audio)).toMatchObject({
      volume: 0.25,
      playbackRate: 1.5,
      pitchSemitones: -3,
    });
    expect(audio.volume).toBe(0.25);
    expect(audio.playbackRate).toBe(1.5);

    expect(player.getState()).toMatchObject({
      volume: 0.25,
      playbackRate: 1.5,
      pitchSemitones: -3,
    });

    player.dispose();
  });

  it('applies settings changed while video is active when switching back to audio', async () => {
    const player = createTestPlayer();

    await loadNext(player);
    player.setVolume({ value: 0.5 });
    player.setTempo({ value: 1.25 });
    player.setPitchSemitones({ value: 2 });

    await loadNext(player);
    player.setVolume({ value: 0.9 });
    player.setTempo({ value: 0.75 });
    player.setPitchSemitones({ value: 6 });

    expect(video.volume).toBe(0.9);
    expect(video.playbackRate).toBe(0.75);
    expect(activeEngine(player)).toMatchObject({
      volume: 0.9,
      playbackRate: 0.75,
      pitchSemitones: 6,
    });

    await loadNext(player);

    expect(audio.volume).toBe(0.9);
    expect(audio.playbackRate).toBe(0.75);
    expect(activeEngine(player)).toMatchObject({
      volume: 0.9,
      playbackRate: 0.75,
      pitchSemitones: 6,
    });

    player.dispose();
  });

  it('does not create duplicate engines when the same media is loaded repeatedly', async () => {
    tracks = [
      createTrack({ trackId: 'audio-1', mediaKind: 'audio' }),
      createTrack({ trackId: 'audio-2', mediaKind: 'audio' }),
      createTrack({ trackId: 'audio-3', mediaKind: 'audio' }),
    ];
    const createAudioEngineSpy = vi.spyOn(
      audioEngineModule,
      'createAudioEngine',
    );
    const player = createTestPlayer();

    await loadNext(player);
    const firstEngine = activeEngine(player);

    await loadNext(player);
    await loadNext(player);

    expect(createAudioEngineSpy).toHaveBeenCalledOnce();
    expect(
      (
        player as unknown as {
          audioEnginesByMedia: Map<HTMLMediaElement, EngineProbe>;
        }
      ).audioEnginesByMedia.size,
    ).toBe(1);
    expect(activeEngine(player)).toBe(firstEngine);

    player.dispose();
  });

  it('keeps the state snapshot aligned with engine values after switching', async () => {
    const player = createTestPlayer();

    await loadNext(player);
    player.setVolume({ value: 0.35 });
    player.setTempo({ value: 1.4 });
    player.setPitchSemitones({ value: -1.6 });

    await loadNext(player);

    const engine = activeEngine(player);
    const state = player.getState();

    expect(state.volume).toBe(engine.volume);
    expect(state.playbackRate).toBe(engine.playbackRate);
    expect(state.pitchSemitones).toBe(engine.pitchSemitones);
    expect(state.volume).toBe(0.35);
    expect(state.playbackRate).toBe(1.4);
    expect(state.pitchSemitones).toBe(-2);

    // Mutating settings on the new media keeps the snapshot in sync.
    player.setVolume({ value: 0.6 });
    player.setPitchSemitones({ value: 9.5 });

    expect(player.getState().volume).toBe(engine.volume);
    expect(player.getState().playbackRate).toBe(engine.playbackRate);
    expect(player.getState().pitchSemitones).toBe(engine.pitchSemitones);
    expect(player.getState().pitchSemitones).toBe(10);

    player.dispose();
  });

  it('still clamps and rounds settings applied to a switched engine', async () => {
    const player = createTestPlayer();

    await loadNext(player);
    await loadNext(player);

    player.setVolume({ value: 4 });
    player.setTempo({ value: 9 });
    player.setPitchSemitones({ value: 99.6 });

    const engine = activeEngine(player);
    expect(engine.volume).toBe(1);
    expect(engine.playbackRate).toBe(2);
    expect(engine.pitchSemitones).toBe(24);
    expect(video.playbackRate).toBe(2);

    player.dispose();
  });
});
