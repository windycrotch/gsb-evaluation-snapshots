import { describe, it, expect } from 'vitest';
import {
  parseChaptersFromVTT,
  timestampToSeconds,
  isValidDuration,
  findChapterAtTime,
  getChapterForHover,
  clampTooltipLeftPct,
} from './chapterUtils';
import type { ChapterMarker } from './chapterUtils';

describe('parseChaptersFromVTT', () => {
  it('takes the label from the text lines after the timing line, ignoring cue identifiers', () => {
    const vtt = `WEBVTT

chapter-intro
00:00:00.000 --> 00:00:10.000
Introduction

42
00:00:10.000 --> 00:00:20.000
Second chapter
`;
    const chapters = parseChaptersFromVTT(vtt);

    expect(chapters).toHaveLength(2);
    // The cue identifier must NOT become the chapter name
    expect(chapters[0].label).toBe('Introduction');
    expect(chapters[1].label).toBe('Second chapter');
    expect(chapters[0].label).not.toContain('chapter-intro');
    expect(chapters[1].label).not.toContain('42');
  });

  it('joins multi-line cue text into the chapter label', () => {
    const vtt = `WEBVTT

chapter-1
00:00:00.000 --> 00:00:10.000
Introduction
to the course
`;
    const chapters = parseChaptersFromVTT(vtt);

    expect(chapters).toHaveLength(1);
    expect(chapters[0].label).toBe('Introduction\nto the course');
  });

  it('parses cues without an identifier line (label directly after timing line)', () => {
    const vtt = `WEBVTT

00:00:05.000 --> 00:00:15.000
Plain chapter
`;
    const chapters = parseChaptersFromVTT(vtt);

    expect(chapters).toHaveLength(1);
    expect(chapters[0]).toEqual({ startTime: 5, endTime: 15, label: 'Plain chapter' });
  });

  it('supports timestamps with omitted hours (mm:ss.mmm)', () => {
    const vtt = `WEBVTT

01:30.000 --> 02:45.500
Short form
`;
    const chapters = parseChaptersFromVTT(vtt);

    expect(chapters).toHaveLength(1);
    expect(chapters[0].startTime).toBe(90);
    expect(chapters[0].endTime).toBe(165.5);
  });

  it('supports comma as the decimal separator', () => {
    const vtt = `WEBVTT

00:00:05,500 --> 00:01:10,250
Comma chapter
`;
    const chapters = parseChaptersFromVTT(vtt);

    expect(chapters).toHaveLength(1);
    expect(chapters[0].startTime).toBe(5.5);
    expect(chapters[0].endTime).toBe(70.25);
  });

  it('supports comma decimals with omitted hours', () => {
    const chapters = parseChaptersFromVTT(`WEBVTT

00:05,000 --> 01:00,000
Mix
`);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].startTime).toBe(5);
    expect(chapters[0].endTime).toBe(60);
  });

  it('ignores cue settings after the end timestamp', () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:10.000 line:0 position:50%
With settings
`;
    const chapters = parseChaptersFromVTT(vtt);

    expect(chapters).toHaveLength(1);
    expect(chapters[0].endTime).toBe(10);
  });

  it('discards cues whose end time is not after the start time', () => {
    const vtt = `WEBVTT

00:00:10.000 --> 00:00:05.000
Backwards

00:00:20.000 --> 00:00:20.000
Zero length

00:00:30.000 --> 00:00:40.000
Valid
`;
    const chapters = parseChaptersFromVTT(vtt);

    expect(chapters).toHaveLength(1);
    expect(chapters[0].label).toBe('Valid');
  });

  it('discards cues with unparseable timestamps', () => {
    const vtt = `WEBVTT

foo --> bar
No times here

00:00:05.000 --> soon
Bad end

00:00:30.000 --> 00:00:40.000
Valid
`;
    const chapters = parseChaptersFromVTT(vtt);

    expect(chapters).toHaveLength(1);
    expect(chapters[0].label).toBe('Valid');
  });

  it('discards cues with an empty label', () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:10.000

00:00:10.000 --> 00:00:20.000

00:00:20.000 --> 00:00:30.000
Valid
`;
    const chapters = parseChaptersFromVTT(vtt);

    expect(chapters).toHaveLength(1);
    expect(chapters[0].label).toBe('Valid');
  });

  it('returns an empty array for an empty or header-only manifest', () => {
    expect(parseChaptersFromVTT('')).toEqual([]);
    expect(parseChaptersFromVTT('WEBVTT\n')).toEqual([]);
    expect(parseChaptersFromVTT('WEBVTT\n\nNOTE nothing here\n')).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const vtt = 'WEBVTT\r\n\r\nch-1\r\n00:00:00.000 --> 00:00:10.000\r\nCRLF chapter\r\n';
    const chapters = parseChaptersFromVTT(vtt);

    expect(chapters).toHaveLength(1);
    expect(chapters[0].label).toBe('CRLF chapter');
  });
});

describe('timestampToSeconds', () => {
  it('parses full HH:MM:SS.mmm form', () => {
    expect(timestampToSeconds('01:02:03.250')).toBe(3723.25);
  });

  it('parses mm:ss.mmm with omitted hours', () => {
    expect(timestampToSeconds('02:03.500')).toBe(123.5);
  });

  it('parses comma decimal separator', () => {
    expect(timestampToSeconds('00:00:05,750')).toBe(5.75);
    expect(timestampToSeconds('01:30,250')).toBe(90.25);
  });

  it('returns NaN for garbage', () => {
    expect(timestampToSeconds('')).toBeNaN();
    expect(timestampToSeconds('abc')).toBeNaN();
    expect(timestampToSeconds('12')).toBeNaN();
    expect(timestampToSeconds('1:2:3:4.000')).toBeNaN();
  });
});

describe('isValidDuration', () => {
  it('accepts positive finite durations', () => {
    expect(isValidDuration(60)).toBe(true);
    expect(isValidDuration(0.5)).toBe(true);
  });

  it('rejects 0, negative, NaN and Infinity', () => {
    expect(isValidDuration(0)).toBe(false);
    expect(isValidDuration(-10)).toBe(false);
    expect(isValidDuration(NaN)).toBe(false);
    expect(isValidDuration(Infinity)).toBe(false);
  });
});

describe('hover chapter lookup', () => {
  const chapters: ChapterMarker[] = [
    { startTime: 0, endTime: 10, label: 'Intro' },
    { startTime: 20, endTime: 30, label: 'Middle' },
  ];

  it('returns the chapter containing the hovered time', () => {
    // duration 40, hover at 12.5% -> t=5 -> Intro
    expect(getChapterForHover(chapters, 40, 0.125)?.label).toBe('Intro');
    // hover at 62.5% -> t=25 -> Middle
    expect(getChapterForHover(chapters, 40, 0.625)?.label).toBe('Middle');
  });

  it('returns null when the hover falls outside every chapter (gap between chapters)', () => {
    // t=15 is between Intro (0-10) and Middle (20-30)
    expect(getChapterForHover(chapters, 40, 15 / 40)).toBeNull();
    // t=35 is after the last chapter
    expect(getChapterForHover(chapters, 40, 35 / 40)).toBeNull();
  });

  it('returns null when the hover falls outside every chapter (direct time lookup)', () => {
    expect(findChapterAtTime(chapters, 15)).toBeNull();
    expect(findChapterAtTime(chapters, 10)).toBeNull(); // end boundary is exclusive
    expect(findChapterAtTime(chapters, 20)).toEqual(chapters[1]);
  });

  it('returns null when the duration is 0 or unknown', () => {
    expect(getChapterForHover(chapters, 0, 0.5)).toBeNull();
    expect(getChapterForHover(chapters, NaN, 0.5)).toBeNull();
    expect(getChapterForHover(chapters, Infinity, 0.5)).toBeNull();
  });

  it('returns null when the chapter list is empty', () => {
    expect(getChapterForHover([], 40, 0.5)).toBeNull();
  });
});

describe('clampTooltipLeftPct', () => {
  // Player 520px wide; progress bar/holder inset 10px on each side (500px wide).
  const base = {
    barWidth: 500,
    barLeftInPlayer: 10,
    playerWidth: 520,
    holderLeftInPlayer: 10,
    holderWidth: 500,
    tooltipWidth: 120, // half = 60
  };

  const leftInPlayer = (leftPct: number) =>
    base.holderLeftInPlayer + (leftPct / 100) * base.holderWidth;

  it('centers the tooltip on the hover position when there is room', () => {
    const leftPct = clampTooltipLeftPct({ ...base, pct: 0.5 });
    // hover at player-x 260 -> tooltip center at 260
    expect(leftInPlayer(leftPct)).toBeCloseTo(260, 6);
  });

  it('clamps at the left edge so the tooltip stays inside the player', () => {
    const leftPct = clampTooltipLeftPct({ ...base, pct: 0 });
    const center = leftInPlayer(leftPct);

    expect(center).toBeCloseTo(60, 6); // pinned to half the tooltip width
    expect(center - 60).toBeGreaterThanOrEqual(0); // left edge inside player
    expect(center + 60).toBeLessThanOrEqual(base.playerWidth);
  });

  it('clamps at the right edge so the tooltip stays inside the player', () => {
    const leftPct = clampTooltipLeftPct({ ...base, pct: 1 });
    const center = leftInPlayer(leftPct);

    expect(center).toBeCloseTo(520 - 60, 6);
    expect(center - 60).toBeGreaterThanOrEqual(0);
    expect(center + 60).toBeLessThanOrEqual(base.playerWidth);
  });

  it('keeps the tooltip inside the player for every hover position', () => {
    for (let pct = 0; pct <= 1.0001; pct += 0.02) {
      const leftPct = clampTooltipLeftPct({ ...base, pct: Math.min(pct, 1) });
      const center = leftInPlayer(leftPct);
      expect(center - 60).toBeGreaterThanOrEqual(-1e-9);
      expect(center + 60).toBeLessThanOrEqual(base.playerWidth + 1e-9);
    }
  });

  it('adapts to the tooltip’s actual rendered width', () => {
    const wide = { ...base, tooltipWidth: 200 }; // half = 100
    const leftPct = clampTooltipLeftPct({ ...wide, pct: 0 });
    const center = base.holderLeftInPlayer + (leftPct / 100) * base.holderWidth;

    expect(center).toBeCloseTo(100, 6);
  });
});
