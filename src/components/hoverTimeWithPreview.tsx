import { useEffect, useRef } from 'react';
import { getHoverTimePosition } from '../utils/getHoverTimePosition';
import { timeToTimeString } from '../utils/timeToTimeString';
import { findThumbnail } from '../utils/findThumbnail';
import { PreviewThumbnail } from '../utils/parseThumbnailsVtt';
import { PreviewImage } from './previewImage';

interface Props {
  max: number;
  hoverTimeValue: number;
  trackWidth: number;
  seekHoverPosition: number;
  offset: number;
  isThumbActive: boolean;
  limitTimeTooltipBySides: boolean;
  label: string;
  secondsPrefix?: string;
  minutesPrefix?: string;
  getPreviewScreenUrl?: (hoverTimeValue: number) => string;
  previewThumbnails?: PreviewThumbnail[];
}

export const HoverTimeWithPreview: React.FC<Props> = ({
  max,
  hoverTimeValue,
  offset,
  trackWidth,
  seekHoverPosition,
  isThumbActive,
  limitTimeTooltipBySides,
  label,
  minutesPrefix,
  secondsPrefix,
  getPreviewScreenUrl,
  previewThumbnails,
}) => {
  const hoverTimeElement = useRef<HTMLDivElement>(null);
  const preloadedThumbnails = useRef<PreviewThumbnail[]>(undefined);
  const hoverTimeClassName = isThumbActive ? 'hover-time active' : 'hover-time';

  /**
   * Warm up every sprite sheet on the first hover so scrubbing does not
   * flicker. Sheets are decoded one at a time in the background, so pointer
   * events are never blocked by an undecoded image, and the chain stops as
   * soon as the component unmounts or the thumbnails change.
   */
  useEffect(() => {
    if (
      !isThumbActive ||
      !previewThumbnails ||
      preloadedThumbnails.current === previewThumbnails
    ) {
      return;
    }

    preloadedThumbnails.current = previewThumbnails;

    let cancelled = false;
    const pending = [...new Set(previewThumbnails.map(({ url }) => url))];

    const preloadNext = (): void => {
      if (cancelled) {
        return;
      }

      const url = pending.shift();

      if (url === undefined) {
        return;
      }

      const image = new Image();
      image.src = url;

      const decoding =
        typeof image.decode === 'function'
          ? image.decode()
          : Promise.resolve();

      decoding
        .catch(() => undefined)
        .then(() => preloadNext());
    };

    preloadNext();

    return () => {
      cancelled = true;

      // Interrupted before every sheet was preloaded: allow a later hover
      // over the same thumbnails to warm up the rest.
      if (pending.length > 0 && preloadedThumbnails.current === previewThumbnails) {
        preloadedThumbnails.current = undefined;
      }
    };
  }, [isThumbActive, previewThumbnails]);

  const hoverTimePosition = getHoverTimePosition(
    seekHoverPosition,
    hoverTimeElement?.current,
    trackWidth,
    limitTimeTooltipBySides
  );

  const hoverTimeString = timeToTimeString(
    max,
    hoverTimeValue,
    offset,
    minutesPrefix,
    secondsPrefix
  );

  const thumbnail =
    previewThumbnails && findThumbnail(previewThumbnails, hoverTimeValue);
  const previewUrl =
    !thumbnail && getPreviewScreenUrl && isThumbActive
      ? getPreviewScreenUrl(hoverTimeValue)
      : undefined;

  return (
    <div
      className={hoverTimeClassName}
      style={hoverTimePosition}
      ref={hoverTimeElement}
      data-testid="hover-time"
    >
      {isThumbActive && thumbnail && <PreviewImage thumbnail={thumbnail} />}
      {previewUrl !== undefined && (
        <PreviewImage thumbnail={{ fromMs: 0, toMs: 0, url: previewUrl }} />
      )}
      {label && <div>{label}</div>}
      {hoverTimeString}
    </div>
  );
};
