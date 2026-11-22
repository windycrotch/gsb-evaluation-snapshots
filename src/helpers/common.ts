import { AudioX } from 'audio';
import { ERROR_MSG_MAP } from 'constants/common';
import type { AudioEvents, AudioState, MediaTrack } from 'types';
import type { LoopMode } from 'types/audio.types';
import { listen, notify } from './notifier';

const isValidArray = (arr: any[]) => arr && Array.isArray(arr) && arr.length;
const isValidFunction = (fn: any) => fn instanceof Function && typeof fn === 'function';

const isValidObject = (obj: any) =>
  typeof obj === 'object' && obj !== null && obj instanceof Object && Object.keys(obj).length;

const isValidWindow = typeof window !== 'undefined' && window instanceof Window;
const loadedScripts: any = {};

const getReadableErrorMessage = (audioInstance: HTMLAudioElement) => {
  let message = '';
  const err = audioInstance.error;

  switch (err?.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      message += ERROR_MSG_MAP.MEDIA_ERR_ABORTED;
      break;
    case MediaError.MEDIA_ERR_NETWORK:
      message += ERROR_MSG_MAP.MEDIA_ERR_NETWORK;
      break;
    case MediaError.MEDIA_ERR_DECODE:
      message += ERROR_MSG_MAP.MEDIA_ERR_DECODE;
      break;
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      message += ERROR_MSG_MAP.MEDIA_ERR_SRC_NOT_SUPPORTED;
      break;
    default:
      message += ERROR_MSG_MAP.DEFAULT;
      break;
  }

  return message;
};

const metaDataCreator = (mediaTrack: MediaTrack) => {
  const { title, album, artist, artwork } = mediaTrack;
  const artworkUrl = artwork ? artwork[0]?.src : '';
  const sizes = ['96x96', '128x128', '192x192', '256x256', '384x384', '512x512'];
  const artworkMap = sizes.map((el) => {
    return { src: artworkUrl, sizes: el, type: 'image/png' };
  });
  const metaData = {
    title,
    album,
    artist,
    artwork: artworkMap,
  };
  return metaData;
};

let previousTrackPlayTime = 0;
export const calculateActualPlayedLength = (
  audioInstance: HTMLAudioElement,
  event?: keyof AudioEvents,
) => {
  const lengthSet = new Set();
  for (let i = 0; i < audioInstance.played.length; i++) {
    const startX = audioInstance.played.start(i);
    const endX = audioInstance.played.end(i);
    const width = endX - startX;
    lengthSet.add(width);
  }
  const lengthArr = [...lengthSet] as number[];
  const currentTrackPlayTime = lengthArr.reduce((acc, val) => acc + val, 0);

  previousTrackPlayTime = ['ENDED', 'TRACK_CHANGE', 'PAUSE'].includes(event as keyof AudioEvents)
    ? currentTrackPlayTime
    : previousTrackPlayTime;
  notify('AUDIO_STATE', {
    currentTrackPlayTime,
    previousTrackPlayTime,
  });
};

const loadScript = (url: string, onLoad: () => void, name: string): Promise<void> => {
  return new Promise<void>((resolve, reject) => {
    if (window instanceof Window && window.document) {
      if (!loadedScripts[name]) {
        loadedScripts[name] = true;
        const script = document.createElement('script');
        script.type = 'text/javascript';
        script.src = url;
        script.async = true;
        script.onload = () => {
          onLoad();
          resolve();
        };
        document.head.appendChild(script);
      } else {
        onLoad();
        resolve();
      }
    } else {
      reject(`Window not ready unable to initialize ${name}`);
    }
  });
};

/**
 * Guard that tells whether a queue session (identified by its id) is still the
 * active one. Listeners captured by older sessions must become no-ops.
 */
export type QueueSessionGuard = (sessionId: number) => boolean;

/**
 * Wires the "track ended -> play next in queue" behaviour for a single queue
 * session. Returns an unsubscribe function; the listener also self-invalidates
 * when the session it belongs to is no longer active, so stale listeners from
 * previous sessions can never trigger playNext again.
 */
const handleQueuePlayback = (
  audio: AudioX,
  sessionId: number,
  isSessionActive: QueueSessionGuard,
): (() => void) => {
  let hasEnded = false;

  const audioStateListener = (state: AudioState) => {
    if (!isSessionActive(sessionId)) {
      return;
    }
    if (state.playbackState === 'ended' && !hasEnded) {
      hasEnded = true;
      const queue = audio.getQueue();
      if (queue && isValidArray(queue)) {
        audio.playNext();
      }
    }
    if (state.playbackState !== 'ended') {
      hasEnded = false;
    }
  };

  return listen('AUDIO_STATE', audioStateListener);
};

const getBufferedDuration = (audioInstance: HTMLAudioElement) => {
  const { buffered } = audioInstance;
  let bufferedDuration = 0;

  for (let i = 0; i < buffered.length; i++) {
    bufferedDuration += buffered.end(i) - buffered.start(i);
  }

  return bufferedDuration;
};

const shuffle = <T>(array: T[]): T[] => {
  const shuffledArray = [...array];

  for (let i = shuffledArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * i);

    [shuffledArray[i], shuffledArray[j]] = [shuffledArray[j], shuffledArray[i]];
  }

  return shuffledArray;
};

/**
 * Applies a loop mode for the current queue session.
 * - SINGLE / OFF only toggle the audio element's loop flag and return undefined.
 * - QUEUE registers a session-scoped listener that replays the *current* queue
 *   (read at fire time, not captured at registration) once it ends, and returns
 *   an unsubscribe function. The listener self-invalidates when its session is
 *   over, so switching modes, clearing the queue or destroying the player
 *   guarantees old listeners never replay the first track again.
 */
const handleLoopPlayback = (
  loopMode: LoopMode,
  audio: AudioX,
  sessionId: number,
  isSessionActive: QueueSessionGuard,
): (() => void) | undefined => {
  const audioInstance = AudioX.getAudioInstance();

  if (loopMode === 'SINGLE') {
    audioInstance.loop = true;
    return undefined;
  }

  // OFF and QUEUE both disable single-track looping on the element
  audioInstance.loop = false;

  if (loopMode === 'QUEUE') {
    const queueEndedListener = (audioState: AudioState) => {
      if (!isSessionActive(sessionId)) {
        return;
      }
      if (audioState.playbackState === 'queueended') {
        const queue = audio.getQueue();
        if (queue && isValidArray(queue)) {
          audio.addMediaAndPlay(queue[0]);
        }
      }
    };
    return listen('AUDIO_STATE', queueEndedListener);
  }

  return undefined;
};

const diffChecker = (d1: any, d2: any): boolean => {
  if (d1 === null && d2 === null) {
    return true;
  }

  if (d1 === null || d2 === null) {
    return false;
  }

  if (typeof d1 !== typeof d2) {
    return false;
  }

  if (typeof d1 !== 'object') {
    return d1 === d2;
  }

  if (Array.isArray(d1) && Array.isArray(d2)) {
    if (d1.length !== d2.length) {
      return false;
    }

    return d1.every((item, index) => diffChecker(item, d2[index]));
  }

  const keys1 = Object.keys(d1);
  const keys2 = Object.keys(d2);

  if (keys1.length !== keys2.length) {
    return false;
  }

  return keys1.every((key) => {
    if (!keys2.includes(key)) {
      return false;
    }

    return diffChecker(d1[key], d2[key]);
  });
};

export {
  diffChecker,
  getBufferedDuration,
  getReadableErrorMessage,
  handleLoopPlayback,
  handleQueuePlayback,
  isValidArray,
  isValidFunction,
  isValidObject,
  isValidWindow,
  loadScript,
  metaDataCreator,
  shuffle,
};
