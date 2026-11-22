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
  previewStatus?: PreviewThumbnailsStatus;
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
  previewStatus = 'ready',
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

  const thumbnail =
    previewThumbnails && findThumbnail(previewThumbnails, hoverTimeValue);
  const previewUrl =
    !thumbnail && previewStatus === 'ready' && getPreviewScreenUrl && isThumbActive
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
      {isThumbActive && !thumbnail && previewStatus === 'loading' && (
        <div
          className="preview-screen preview-status"
          data-testid="preview-loading"
        >
          Loading preview…
        </div>
      )}
      {isThumbActive && !thumbnail && previewStatus === 'error' && (
        <div
          className="preview-screen preview-status error"
          data-testid="preview-error"
        >
          Preview failed to load
        </div>
      )}
      {label && <div>{label}</div>}
      {hoverTimeString}
    </div>
  );
};
