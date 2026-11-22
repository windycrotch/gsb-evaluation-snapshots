import { useEffect, useRef, useState } from 'react';
import {
  parseThumbnailsVtt,
  PreviewThumbnail,
} from '../utils/parseThumbnailsVtt';

export type PreviewThumbnailsStatus = 'ready' | 'loading' | 'error';

export interface PreviewThumbnailsResult {
  status: PreviewThumbnailsStatus;
  thumbnails?: PreviewThumbnail[];
}

interface FetchState {
  source: string;
  status: PreviewThumbnailsStatus;
  thumbnails?: PreviewThumbnail[];
}

/**
 * Returns the thumbnails as is, or loads and parses them when given a VTT URL.
 *
 * A stale response (slow or out-of-order) never overwrites the state of the
 * current URL: superseded requests are aborted and also invalidated by a
 * request id in case the fetch implementation ignores the abort signal.
 * A failed URL is retried automatically on the next hover (`isHovering`).
 */
export function usePreviewThumbnails(
  source: string | PreviewThumbnail[] | undefined,
  isHovering = false
): PreviewThumbnailsResult {
  const [fetchState, setFetchState] = useState<FetchState>();
  const stateRef = useRef<FetchState | undefined>(undefined);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | undefined>(undefined);

  /** Invalidates and aborts whatever request is in flight. */
  const discardPendingRequest = (): void => {
    requestIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = undefined;
  };
  const discardRef = useRef(discardPendingRequest);
  discardRef.current = discardPendingRequest;

  useEffect(() => {
    if (typeof source !== 'string') {
      discardRef.current();
      return;
    }

    const current = stateRef.current;

    if (current && current.source === source) {
      // Already loading or loaded for this URL — keep the request/result.
      if (current.status !== 'error') {
        return;
      }

      // Failed before: retry only when the user hovers again.
      if (!isHovering) {
        return;
      }
    }

    discardRef.current();

    const requestId = requestIdRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    const vttUrl = new URL(source, document.baseURI).href;
    const apply = (next: FetchState): void => {
      stateRef.current = next;
      setFetchState(next);
    };
    const isCurrent = (): boolean =>
      !controller.signal.aborted && requestId === requestIdRef.current;

    apply({ source, status: 'loading' });

    fetch(vttUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        return response.text();
      })
      .then((text) => {
        if (!isCurrent()) {
          return;
        }

        apply({
          source,
          status: 'ready',
          thumbnails: parseThumbnailsVtt(text, vttUrl),
        });
      })
      .catch((error: Error) => {
        if (error.name === 'AbortError' || !isCurrent()) {
          return;
        }

        console.warn(
          `react-video-seek-slider: failed to load preview thumbnails from ${source}`,
          error
        );
        apply({ source, status: 'error' });
      });
  }, [source, isHovering]);

  // Abort the pending request when the component unmounts.
  useEffect(() => () => discardRef.current(), []);

  if (typeof source !== 'string') {
    return { status: 'ready', thumbnails: source };
  }

  if (fetchState?.source !== source) {
    return { status: 'loading' };
  }

  return fetchState;
}
