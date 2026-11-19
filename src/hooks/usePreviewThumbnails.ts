import { useEffect, useState } from 'react';
import {
  parseThumbnailsVtt,
  PreviewThumbnail,
} from '../utils/parseThumbnailsVtt';

interface Loaded {
  source: string;
  thumbnails: PreviewThumbnail[];
}

/** Returns the thumbnails as is, or loads and parses them when given a VTT URL. */
export function usePreviewThumbnails(
  source: string | PreviewThumbnail[] | undefined
): PreviewThumbnail[] | undefined {
  const [loaded, setLoaded] = useState<Loaded>();

  useEffect(() => {
    // Drop the previous thumbnails as soon as the source changes: they must
    // never be shown for another video, even while the next request is in
    // flight. A failed load leaves the state empty, so nothing stale is
    // shown either, and the same URL is fetched again the next time it is
    // passed in (no failure is remembered).
    setLoaded(undefined);

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
      .then((text) => {
        // The request was cancelled (source changed or the component
        // unmounted) after it had already resolved: its late result must
        // not overwrite the state of the current source.
        if (controller.signal.aborted) {
          return;
        }

        setLoaded({ source, thumbnails: parseThumbnailsVtt(text, vttUrl) });
      })
      .catch((error: Error) => {
        if (error.name !== 'AbortError') {
          console.warn(
            `react-video-seek-slider: failed to load preview thumbnails from ${source}`,
            error
          );
        }
      });

    return () => controller.abort();
  }, [source]);

  if (typeof source !== 'string') {
    return source;
  }

  return loaded?.source === source ? loaded.thumbnails : undefined;
}
