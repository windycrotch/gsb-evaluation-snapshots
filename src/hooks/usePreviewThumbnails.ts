import { useEffect, useRef, useState } from 'react';
import {
  parseThumbnailsVtt,
  PreviewThumbnail,
} from '../utils/parseThumbnailsVtt';

export type PreviewThumbnailsStatus = 'loading' | 'loaded' | 'error';

export interface PreviewThumbnailsState {
  /** Parsed thumbnails. Only present once `status` is `'loaded'`. */
  thumbnails?: PreviewThumbnail[];
  status: PreviewThumbnailsStatus;
  /** Failure reason. Only present when `status` is `'error'`. */
  error?: Error;
}

interface Loaded {
  source: string;
  thumbnails: PreviewThumbnail[];
}

interface Failed {
  source: string;
  error: Error;
}

/**
 * Returns the thumbnails as is, or loads and parses them when given a VTT URL.
 * `onError` fires once per failed request (non-2xx response or parse failure);
 * results arriving after `source` changed are discarded.
 */
export function usePreviewThumbnails(
  source: string | PreviewThumbnail[] | undefined,
  onError?: (error: Error) => void
): PreviewThumbnailsState {
  const [loaded, setLoaded] = useState<Loaded>();
  const [failed, setFailed] = useState<Failed>();
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    if (typeof source !== 'string') {
      return;
    }

    const controller = new AbortController();
    const vttUrl = new URL(source, document.baseURI).href;

    fetch(vttUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        return response.text();
      })
      .then((text) =>
        setLoaded({ source, thumbnails: parseThumbnailsVtt(text, vttUrl) })
      )
      .catch((error: Error) => {
        if (error.name === 'AbortError') {
          return;
        }

        console.warn(
          `react-video-seek-slider: failed to load preview thumbnails from ${source}`,
          error
        );
        setFailed({ source, error });
        onErrorRef.current?.(error);
      });

    return () => controller.abort();
  }, [source]);

  if (typeof source !== 'string') {
    return { thumbnails: source, status: 'loaded' };
  }

  // Results are keyed by their URL so a late response from a previous
  // source can never override the state of the current one.
  if (loaded?.source === source) {
    return { thumbnails: loaded.thumbnails, status: 'loaded' };
  }

  if (failed?.source === source) {
    return { status: 'error', error: failed.error };
  }

  return { status: 'loading' };
}
