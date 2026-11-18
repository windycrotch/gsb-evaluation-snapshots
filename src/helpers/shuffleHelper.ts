import type { MediaTrack } from 'types';

/**
 * Shuffles a queue of tracks while maintaining the position of the currently playing track
 * @param queue The current queue of tracks
 * @param currentTrackId The ID of the currently playing track (optional)
 * @returns A new shuffled array of tracks
 */
export const shuffleQueue = (queue: MediaTrack[], currentTrackId?: string): MediaTrack[] => {
  if (!queue.length) return [];

  // If no current track, shuffle the entire queue
  if (!currentTrackId) {
    return shuffleArray([...queue]);
  }

  // Find current track position
  const currentIndex = queue.findIndex((track) => track.id === currentTrackId);

  // If current track not found, shuffle entire queue
  if (currentIndex === -1) {
    return shuffleArray([...queue]);
  }

  // Get tracks before and after current. Other entries sharing the current
  // track id are dropped so the current track appears exactly once in the
  // result (a queue may legitimately contain the same id more than once).
  const beforeCurrent = queue.slice(0, currentIndex).filter((track) => track.id !== currentTrackId);
  const afterCurrent = queue.slice(currentIndex + 1).filter((track) => track.id !== currentTrackId);

  // Shuffle all tracks except current
  const shuffledRest = shuffleArray([...beforeCurrent, ...afterCurrent]);

  // Reinsert current track where it was relative to the retained tracks
  const position = Math.min(beforeCurrent.length, shuffledRest.length);
  return [...shuffledRest.slice(0, position), queue[currentIndex], ...shuffledRest.slice(position)];
};

/**
 * Restores the original order of the queue while maintaining the current track
 * @param originalQueue The original unshuffled queue
 * @param currentTrackId The ID of the currently playing track (optional)
 * @returns The original queue unchanged
 */
export const unshuffleQueue = (originalQueue: MediaTrack[]): MediaTrack[] => {
  // Simply return the original queue as is
  return [...originalQueue];
};

/**
 * Fisher-Yates shuffle algorithm
 * @param array Array to shuffle
 * @returns New shuffled array
 */
const shuffleArray = <T>(array: T[]): T[] => {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};
