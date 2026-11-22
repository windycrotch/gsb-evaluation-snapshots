import { vi } from 'vitest';
import type { AudioInit, MediaTrack } from '../types/audio.types';
import { MockAudioContext } from './mocks';

export const makeTracks = (count: number, prefix = 't'): MediaTrack[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i + 1}`,
    title: `Track ${prefix}${i + 1}`,
    source: `https://example.com/audio/${prefix}${i + 1}.mp3`,
    artwork: null,
  }));

/**
 * Builds a fresh AudioX singleton with fresh module state (notifier,
 * audio state forwarder, equalizer singleton) for every test.
 */
export const createPlayer = async (initProps: Record<string, unknown> = {}) => {
  vi.resetModules();
  // restore a healthy AudioContext baseline for each fresh player
  (globalThis as any).AudioContext = MockAudioContext;
  MockAudioContext.resetCounters();

  const { AudioX } = await import('../audio');
  const notifier = await import('../helpers/notifier');
  const player = new AudioX();
  await player.init({
    mode: 'VANILLA',
    useDefaultEventListeners: true,
    ...initProps,
  } as AudioInit);
  return { player, AudioX, notifier };
};
