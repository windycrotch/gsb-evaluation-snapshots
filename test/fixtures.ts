import { getLatestState } from '../src/helpers/notifier';
// Import through the package entry point so module side effects (the
// AUDIO_STATE -> AUDIO_X_STATE bridge in states/audioState.ts) are registered.
import { AudioX } from '../src/index';
import type { AudioState, MediaTrack } from '../src/types';

/**
 * Builds a valid, very short WAV file as a data URL so tests can exercise real
 * playback in the browser without any external asset.
 */
export const makeWavDataUrl = (
  durationSeconds = 0.25,
  sampleRate = 8000,
  frequency = 440,
): string => {
  const numSamples = Math.floor(durationSeconds * sampleRate);
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < numSamples; i++) {
    const sample = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.1;
    view.setInt16(44 + i * bytesPerSample, sample * 0x7fff, true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
};

/**
 * Creates MediaTrack fixtures. By default a local (relative) source is used;
 * these never finish loading, which keeps queue-order tests deterministic and
 * avoids triggering queue playback side effects.
 */
export const makeTracks = (ids: string[], sourceFor?: (id: string) => string): MediaTrack[] =>
  ids.map((id) => ({
    id,
    title: `Track ${id}`,
    source: sourceFor ? sourceFor(id) : `audio/track-${id}.wav`,
    artwork: null,
  }));

/** Tracks backed by real, playable (data URL) audio. */
export const makePlayableTracks = (ids: string[], durationSeconds = 0.25): MediaTrack[] =>
  makeTracks(ids, (id) => {
    const index = ids.indexOf(id);
    return makeWavDataUrl(durationSeconds, 8000, 300 + index * 120);
  });

export const getTrackIds = (audio: AudioX): string[] => audio.getQueue().map((track) => track.id);

let latestState: AudioState = {} as AudioState;
let stateSubscription: (() => void) | null = null;

export const getCurrentTrackId = (): string | undefined => latestState.currentTrack?.id;

export const getPlaybackState = (): string | undefined => latestState.playbackState;

export interface StateEvent {
  playbackState: string;
  trackId?: string;
}

/**
 * Captures every AUDIO_STATE notification. Used to assert how many times the
 * player reacted to a single ended/queueended event.
 */
export const recordStateEvents = (audio: AudioX) => {
  const events: StateEvent[] = [];
  const unsubscribe = audio.subscribe('AUDIO_STATE', (state: AudioState) => {
    events.push({ playbackState: state.playbackState, trackId: state.currentTrack?.id });
  });
  return {
    events,
    trackChanges: (id?: string) =>
      events.filter(
        (event) =>
          event.playbackState === 'trackchanged' && (id === undefined || event.trackId === id),
      ),
    count: (playbackState: string) =>
      events.filter((event) => event.playbackState === playbackState).length,
    stop: unsubscribe,
  };
};

/**
 * Registers the default media element listeners once per test file and mirrors
 * what a real consumer does by subscribing to AUDIO_X_STATE. Muted media is
 * used so headless autoplay policies allow playback to start.
 */
export const setupPlayer = async (): Promise<AudioX> => {
  const audio = new AudioX();
  await audio.init({
    mode: 'VANILLA',
    useDefaultEventListeners: true,
    autoPlay: false,
    preloadStrategy: 'auto',
  });

  if (stateSubscription) {
    stateSubscription();
  }
  latestState = { ...(getLatestState('AUDIO_X_STATE') as AudioState) };
  stateSubscription = audio.subscribe('AUDIO_X_STATE', (state: AudioState) => {
    latestState = { ...state };
  });

  AudioX.getAudioInstance().muted = true;
  return audio;
};

/** Puts the singleton back into a neutral state between tests. */
export const resetPlayer = (audio: AudioX): void => {
  audio.loop('OFF');
  audio.clearQueue();
};

export const waitFor = async (
  predicate: () => boolean,
  { timeout = 15000, interval = 25, label = 'condition' } = {},
): Promise<void> => {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Timed out after ${timeout}ms waiting for ${label}`);
};
