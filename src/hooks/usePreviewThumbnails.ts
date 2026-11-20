import { useEffect, useRef, useState } from 'react';
import {
  parseThumbnailsVtt,
  PreviewThumbnail,
} from '../utils/parseThumbnailsVtt';

export type PreviewThumbnailsStatus = 'loading' | 'loaded' | 'error';

export interface PreviewThumbnailsResult {
  /** Thumbnails of the current source, or undefined while loading / after a failure / with no source. */
  thumbnails: PreviewThumbnail[] | undefined;
  /**
   * Observable state of the current source.
   * `error` is kept until the source changes, so consumers can react to failures
   * (the slider itself falls back to `getPreviewScreenUrl` or the time label).
   */
  status: PreviewThumbnailsStatus;
  /** Source the current result belongs to. */
  source: string | PreviewThumbnail[] | undefined;
  /** Error of the last failed load, retained for observability. */
  error: Error | undefined;
}

interface StringState extends PreviewThumbnailsResult {
  source: string | undefined;
}

const EMPTY_STATE: StringState = {
  thumbnails: undefined,
  status: 'loading',
  source: undefined,
  error: undefined,
};

/**
 * Turns the `previewThumbnails` prop into a switchable, fail-able session.
 *
 * Every source gets its own session id; an aborted/stale fetch can never write
 * its result into a newer session, and switching to an array or clearing the
 * prop immediately drops in-flight requests and any previous failure state.
 */
export function usePreviewThumbnails(
  source: string | PreviewThumbnail[] | undefined
): PreviewThumbnailsResult {
  const sessionRef = useRef(0);
  const [state, setState] = useState<StringState>(EMPTY_STATE);

  useEffect(() => {
    // Each run, including non-string sources, starts a fresh session: the
    // previous session's late response is rejected by the id check below.
    const sessionId = sessionRef.current + 1;
    sessionRef.current = sessionId;

    if (typeof source !== 'string') {
      // The render branch below serves arrays/empty sources directly; only a
      // stale state from an earlier string session has to be cleared once.
      setState((current) =>
        current.source === undefined ? current : EMPTY_STATE
      );
      return;
    }

    setState({
      thumbnails: undefined,
      status: 'loading',
      source,
      error: undefined,
    });

    const controller = new AbortController();

    let vttUrl: string;
    try {
      vttUrl = new URL(source, document.baseURI).href;
    } catch (error) {
      console.warn(
        `react-video-seek-slider: failed to load preview thumbnails from ${source}`,
        error
      );
      setState({
        thumbnails: undefined,
        status: 'error',
        source,
        error: error as Error,
      });
      return;
    }

    fetch(vttUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        return response.text();
      })
      .then((text) => {
        if (sessionRef.current !== sessionId) {
          return;
        }

        setState({
          thumbnails: parseThumbnailsVtt(text, vttUrl),
          status: 'loaded',
          source,
          error: undefined,
        });
      })
      .catch((error: Error) => {
        if (error.name === 'AbortError') {
          return;
        }

        if (sessionRef.current !== sessionId) {
          return;
        }

        console.warn(
          `react-video-seek-slider: failed to load preview thumbnails from ${source}`,
          error
        );
        setState({
          thumbnails: undefined,
          status: 'error',
          source,
          error,
        });
      });

    return () => controller.abort();
  }, [source]);

  // Arrays and empty sources are used directly, with no async session at all.
  if (typeof source !== 'string') {
    return {
      thumbnails: source,
      status: 'loaded',
      source,
      error: undefined,
    };
  }

  // Only the state belonging to the current string source is exposed, so a
  // late state write from a previous source can never leak into the UI.
  return state.source === source
    ? state
    : {
        thumbnails: undefined,
        status: 'loading',
        source,
        error: undefined,
      };
}
