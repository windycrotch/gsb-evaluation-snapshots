const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Splits a string into graphemes so emoji and combined characters are typed with a single press. */
export function splitGraphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}
