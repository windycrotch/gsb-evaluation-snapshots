import type { Mode } from './types';

/**
 * Reply length limit in graphemes, so the video fits into 60 s without speeding up:
 * normal ≈ 30 s and typos ≈ 45 s for 150 chars; grandpa up to ~56 s for 30 chars;
 * breaks ≈ 25 s of typing for 120 chars plus up to three ~5–6 s breaks.
 */
export const MAX_CHARS: Record<Mode, number> = { normal: 150, typos: 150, grandpa: 30, manicure: 150, breaks: 120 };
/** Absolute maximum (the most generous mode) — the most that can be typed into the field at all. */
export const MAX_CHARS_ANY = Math.max(...Object.values(MAX_CHARS));
