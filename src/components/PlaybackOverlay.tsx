import { useCallback, useReducer, useSyncExternalStore } from 'react';
import { Pause, Play } from 'lucide-react';

import type { VideoSource } from '@sources/VideoSource';
import {
  formatPlaybackSnapshot,
  type PlaybackStateLabels,
  type VideoPlaybackSnapshot,
} from '@sources/videoPlayback';
import { cn } from '@lib/utils';

interface PlaybackOverlayProps {
  /** Active video source, or null when the media is an image/GIF/math shader. */
  source: VideoSource | null;
  className?: string;
}

const POLL_INTERVAL_MS = 250;

// Status wording used in the overlay, e.g. "video 12.3s / 45.0s · 734 帧 · 已暂停".
const OVERLAY_LABELS = {
  playing:  '播放中',
  paused:   '已暂停',
  released: '已释放',
  frames:   (count: number) => `${count} 帧`,
} satisfies PlaybackStateLabels;

// Per-source cache so useSyncExternalStore sees a stable reference between
// polls when nothing changed (React requires referential equality there).
const snapshotCache = new WeakMap<VideoSource, VideoPlaybackSnapshot>();

function readSnapshot(source: VideoSource): VideoPlaybackSnapshot {
  const next = source.playbackSnapshot;
  const prev = snapshotCache.get(source);
  if (prev && sameSnapshot(prev, next)) return prev;
  snapshotCache.set(source, next);
  return next;
}

function subscribeToSnapshot(source: VideoSource, onChange: () => void): () => void {
  const id = window.setInterval(onChange, POLL_INTERVAL_MS);
  return () => window.clearInterval(id);
}

const noopUnsubscribe = (): void => {};

/**
 * Live playback readout for video-backed sources.
 *
 * Polls the source's read-only snapshot on a slow timer and re-renders only
 * this small component, so the 60 fps canvas loop is unaffected.  When the
 * media is not a video the component renders nothing, which is how switching
 * back to an image / GIF / math shader clears the readout.
 */
export function PlaybackOverlay({ source, className }: PlaybackOverlayProps) {
  const subscribe = useCallback(
    (onChange: () => void) =>
      source ? subscribeToSnapshot(source, onChange) : noopUnsubscribe,
    [source],
  );
  const getSnapshot = useCallback(
    () => (source ? readSnapshot(source) : null),
    [source],
  );

  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  if (!source || !snapshot) return null;

  const togglePlayback = () => {
    if (snapshot.paused) {
      void source.start();
    } else {
      source.stop();
    }
    // Drop the memoized snapshot and re-read so the state flips immediately;
    // the poll confirms it shortly after.
    snapshotCache.delete(source);
    bump();
  };

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className="tabular-nums">
        {formatPlaybackSnapshot(snapshot, OVERLAY_LABELS)}
      </span>
      <button
        onClick={togglePlayback}
        title={snapshot.paused ? '继续播放' : '暂停播放'}
        aria-label={snapshot.paused ? '继续播放' : '暂停播放'}
        className="pointer-events-auto flex items-center rounded border border-zinc-800 px-1 py-0.5 text-zinc-600 transition-colors hover:border-zinc-500 hover:text-zinc-300"
      >
        {snapshot.paused
          ? <Play  size={9} strokeWidth={2} />
          : <Pause size={9} strokeWidth={2} />}
      </button>
    </div>
  );
}

function sameSnapshot(
  a: VideoPlaybackSnapshot,
  b: VideoPlaybackSnapshot,
): boolean {
  return (
    a.kind        === b.kind &&
    a.currentTime === b.currentTime &&
    a.duration    === b.duration &&
    a.paused      === b.paused &&
    a.frameCount  === b.frameCount &&
    a.disposed    === b.disposed
  );
}
