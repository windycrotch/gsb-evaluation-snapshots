import { useEffect, useRef } from 'react';
import { getHoverTimePosition } from '../utils/getHoverTimePosition';
import { timeToTimeString } from '../utils/timeToTimeString';
import { findThumbnail } from '../utils/findThumbnail';
import { PreviewThumbnail } from '../utils/parseThumbnailsVtt';
import { PreviewImage } from './previewImage';

/** 1x1 transparent GIF: replacing the src aborts any in-flight sprite download. */
const BLANK_IMAGE =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

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
  const preloadedThumbnails = useRef<PreviewThumbnail[] | undefined>(
    undefined
  );
  const preloadedImages = useRef<HTMLImageElement[]>([]);
  const hoverTimeClassName = isThumbActive ? 'hover-time active' : 'hover-time';

  /**
   * Only the currently effective set is ever warmed: when the set changes
   * (source switch / clear / failure), drop every image created for the old
   * set and abort its in-flight downloads.
   */
  useEffect(() => {
    return () => {
      preloadedImages.current.forEach((image) => {
        image.onload = null;
        image.onerror = null;
        image.src = BLANK_IMAGE;
      });
      preloadedImages.current = [];
      preloadedThumbnails.current = undefined;
    };
  }, [previewThumbnails]);

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

    preloadedImages.current = Array.from(
      new Set(previewThumbnails.map(({ url }) => url)),
      (url) => {
        const image = new Image();
        image.src = url;
        return image;
      }
    );
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
