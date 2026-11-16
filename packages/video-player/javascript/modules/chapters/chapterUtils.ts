/**
 * Pure chapter-parsing and hover-positioning logic for the chapter markers
 * progress bar control. Kept free of video.js / DOM dependencies so it can be
 * unit-tested in isolation.
 */

export interface ChapterMarker {
  startTime: number;
  endTime: number;
  label: string;
}

/**
 * Matches WebVTT timestamps with optional hours and either "." or "," as the
 * decimal separator:
 *   "HH:MM:SS.mmm", "HH:MM:SS,mmm", "MM:SS.mmm", "MM:SS,mmm"
 * The milliseconds fraction may have 1-3 digits (".5" === 500ms).
 */
const TIMESTAMP_RE = /^(?:(\d{1,3}):)?([0-5]?\d):([0-5]?\d)(?:[.,](\d{1,3}))?$/;

/** Convert a WebVTT timestamp to seconds. Returns NaN when unparseable. */
export function timestampToSeconds(timestamp: string): number {
  const match = TIMESTAMP_RE.exec((timestamp || '').trim());
  if (!match) return NaN;

  const [, hh, mm, ss, frac] = match;
  const hours = hh ? parseInt(hh, 10) : 0;
  const minutes = parseInt(mm, 10);
  const seconds = parseInt(ss, 10);
  const millis = frac ? parseInt(frac.padEnd(3, '0'), 10) : 0;

  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

/**
 * Parses a WebVTT string into an array of chapter objects,
 * each of which contains startTime, endTime, and label.
 *
 * - The label is the text line(s) AFTER the timing line; an optional cue
 *   identifier line before the timing line is never treated as the label.
 * - Cues with unparseable timestamps, endTime <= startTime, or an empty
 *   label are discarded.
 */
export function parseChaptersFromVTT(vttData: string): ChapterMarker[] {
  const chapters: ChapterMarker[] = [];

  // 1) Normalize newlines and split into cue blocks
  const rawBlocks = vttData.replace(/\r\n|\r|\n/g, '\n').split(/\n{2,}/);

  for (const block of rawBlocks) {
    const lines = block.trim().split('\n');

    // A valid cue block has a line containing "-->". Anything before that
    // line (cue identifier, WEBVTT header, NOTE text) is not chapter text.
    const timeLineIndex = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIndex === -1) continue;

    const timeLine = lines[timeLineIndex];

    // 2) Extract start and end timestamps ("00:05.000 --> 00:12.000"),
    //    ignoring any cue settings after the end timestamp.
    const arrowIndex = timeLine.indexOf('-->');
    const startRaw = timeLine.slice(0, arrowIndex).trim();
    const endRaw = timeLine.slice(arrowIndex + 3).trim().split(/\s+/)[0] || '';
    const startTime = timestampToSeconds(startRaw);
    const endTime = timestampToSeconds(endRaw);

    // 3) The chapter label is the text line(s) after the timing line.
    const label = lines.slice(timeLineIndex + 1).join('\n').trim();

    // Only add if label is non-empty and times are valid
    if (label && !isNaN(startTime) && !isNaN(endTime) && endTime > startTime) {
      chapters.push({ startTime, endTime, label });
    }
  }

  return chapters;
}

/** A duration is usable only when it is a known, positive, finite number. */
export function isValidDuration(duration: unknown): duration is number {
  return typeof duration === 'number' && isFinite(duration) && duration > 0;
}

/**
 * Returns the chapter containing the given time, or null when the time falls
 * outside every chapter interval.
 */
export function findChapterAtTime(
  chapters: ChapterMarker[],
  time: number
): ChapterMarker | null {
  if (!chapters.length || typeof time !== 'number' || isNaN(time)) return null;
  return chapters.find((c) => time >= c.startTime && time < c.endTime) ?? null;
}

/**
 * Resolves which chapter (if any) the hover tooltip should show for a given
 * hover position. Returns null — meaning "keep the tooltip hidden" — when the
 * duration is 0/unknown, the chapter list is empty, or the hovered time falls
 * outside every chapter.
 *
 * @param chapters - Parsed chapter list
 * @param duration - Player duration in seconds
 * @param pct      - Hover position along the progress bar, 0..1
 */
export function getChapterForHover(
  chapters: ChapterMarker[],
  duration: number,
  pct: number
): ChapterMarker | null {
  if (!isValidDuration(duration) || chapters.length === 0) return null;
  const clampedPct = Math.max(0, Math.min(1, pct));
  return findChapterAtTime(chapters, clampedPct * duration);
}

export interface TooltipLayoutInput {
  /** Hover position along the progress bar, 0..1 */
  pct: number;
  /** Progress bar width in px */
  barWidth: number;
  /** Progress bar's left edge relative to the player element, in px */
  barLeftInPlayer: number;
  /** Player element width in px */
  playerWidth: number;
  /** Progress holder's left edge relative to the player element, in px */
  holderLeftInPlayer: number;
  /** Progress holder width in px (the tooltip's positioning context) */
  holderWidth: number;
  /** The tooltip's actual rendered width in px */
  tooltipWidth: number;
}

/**
 * Computes the tooltip's `left` (as a % of the progress holder) so that the
 * tooltip — horizontally centered on that point via `translateX(-50%)` —
 * stays fully inside the player's left/right edges. Clamping is based on the
 * tooltip's actual rendered width.
 */
export function clampTooltipLeftPct(input: TooltipLayoutInput): number {
  const {
    pct,
    barWidth,
    barLeftInPlayer,
    playerWidth,
    holderLeftInPlayer,
    holderWidth,
    tooltipWidth,
  } = input;

  if (holderWidth <= 0) return 0;

  const half = tooltipWidth / 2;
  const hoverInPlayer = barLeftInPlayer + pct * barWidth;

  // Clamp the tooltip center so [center - half, center + half] stays within
  // [0, playerWidth]. If the tooltip is wider than the player, pin it to half
  // (best effort — it cannot fit anyway).
  const clamped = Math.min(Math.max(hoverInPlayer, half), Math.max(half, playerWidth - half));

  const leftInHolder = clamped - holderLeftInPlayer;
  return (leftInHolder / holderWidth) * 100;
}
