import { useEffect, useRef } from 'react';
import { getHoverTimePosition } from '../utils/getHoverTimePosition';
import { timeToTimeString } from '../utils/timeToTimeString';
import { findThumbnail } from '../utils/findThumbnail';
import { PreviewThumbnail } from '../utils/parseThumbnailsVtt';
import { PreviewThumbnailsStatus } from '../hooks/usePreviewThumbnails';
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
  /** Loading state of `previewThumbnails`; omitted means already loaded. */
  previewThumbnailsStatus?: PreviewThumbnailsStatus;
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
  previewThumbnailsStatus = 'loaded',
}) => {
  const hoverTimeElement = useRef<HTMLDivElement>(null);
  const preloadedThumbnails = useRef<PreviewThumbnail[]>(undefined);
  const hoverTimeClassName = isThumbActive ? 'hover-time active' : 'hover-time';

  /** Warm up every sprite sheet on the first hover so scrubbing does not flicker. */
  useEffect(() => {
    if (
      !isThumbActive ||
      !previewThumbnails ||
      preloadedThumbnails.current === previewThumbnails
    ) {
      return;
    }

    preloadedThumbnails.current = previewThumbnails;

    new Set(previewThumbnails.map(({ url }) => url)).forEach((url) => {
      new Image().src = url;
    });
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

  // While loading or after a failure there are no thumbnails to match, so
  // the hover area falls back to `getPreviewScreenUrl` (or shows no image).
  const thumbnail =
    previewThumbnailsStatus === 'loaded' &&
    previewThumbnails &&
    findThumbnail(previewThumbnails, hoverTimeValue);
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
