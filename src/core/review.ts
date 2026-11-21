/**
 * Review comments: feedback on an animation that comes from someone who does not have the editor. The reviewer opens the player page (one HTML
 * file), puts a comment at a moment of an animation and sends back a small file; the animator imports it and the comments become markers on the
 * timeline (with the author, and a "resolved" mark). Nothing needs a server or an account.
 *
 * The file comes from outside, so it is read strictly: only the fields below, only text of a sane length, a bounded number of comments.
 * Importing the same file twice changes nothing (a comment keeps its id, so it updates its marker instead of making another).
 */
import type { Id, Marker, SkeletonDoc } from './model';

const REVIEW_VERSION = 1;
export const MAX_COMMENTS = 500;
export const MAX_TEXT = 2000;
const MAX_AUTHOR = 60;
const MAX_NAME = 200;
/** The most characters of a review file that are read (a file is a few kilobytes; more is not one). */
const MAX_FILE = 2_000_000;
/** The marker colour of a comment that came from a review. */
const REVIEW_COLOR = 3;

export interface ReviewComment {
  /** Made by the player page; stays the same when the file is imported again. */
  id: string;
  /** The name of the animation the comment is about. */
  animation: string;
  /** Seconds into the animation. */
  time: number;
  text: string;
  author: string;
  /** The name of the bone the comment points at (optional). */
  bone?: string;
  /** When it was written (milliseconds since 1970), for sorting. */
  at: number;
}

interface ReviewFile {
  bone2dReview: typeof REVIEW_VERSION;
  /** The skeleton the comments are about. */
  title: string;
  comments: ReviewComment[];
}

const ID = /^[\w.:-]{1,64}$/;
const clip = (v: unknown, max: number): string =>
  // eslint-disable-next-line no-control-regex -- strips control characters
  typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max) : '';

/** A new comment, as the player page makes it. `id` is anything unique (the page uses a random one). */
export function makeComment(
  id: string,
  animation: string,
  time: number,
  text: string,
  author: string,
  bone?: string,
  at = Date.now(),
): ReviewComment {
  const c: ReviewComment = {
    id,
    animation: clip(animation, MAX_NAME),
    time: Number.isFinite(time) ? Math.max(0, time) : 0,
    text: clip(text, MAX_TEXT).trim(),
    author: clip(author, MAX_AUTHOR).trim(),
    at,
  };
  const b = clip(bone, MAX_NAME);
  if (b) c.bone = b;
  return c;
}

/** The text of a review file. */
export function serializeReview(title: string, comments: ReviewComment[]): string {
  const file: ReviewFile = { bone2dReview: REVIEW_VERSION, title: clip(title, MAX_NAME), comments: comments.slice(0, MAX_COMMENTS) };
  return JSON.stringify(file, null, 1);
}

export interface ParsedReview {
  title: string;
  comments: ReviewComment[];
  /** Comments that were left out: not valid, or more than the limit. */
  dropped: number;
}

/** Reads a review file; null when the text is not one (not JSON, another kind of file, too big). Bad comments are dropped one by one. */
export function parseReview(text: string): ParsedReview | null {
  if (typeof text !== 'string' || text.length > MAX_FILE) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || (data as { bone2dReview?: unknown }).bone2dReview !== REVIEW_VERSION) return null;
  const raw = (data as { comments?: unknown }).comments;
  if (!Array.isArray(raw)) return null;
  const out: ReviewComment[] = [];
  const seen = new Set<string>();
  let dropped = Math.max(0, raw.length - MAX_COMMENTS);
  for (const r of raw.slice(0, MAX_COMMENTS)) {
    const c = r as Partial<ReviewComment> | null;
    if (
      !c ||
      typeof c !== 'object' ||
      typeof c.id !== 'string' ||
      !ID.test(c.id) ||
      seen.has(c.id) ||
      typeof c.animation !== 'string' ||
      !c.animation ||
      typeof c.time !== 'number' ||
      !Number.isFinite(c.time) ||
      c.time < 0 ||
      typeof c.text !== 'string'
    ) {
      dropped++;
      continue;
    }
    const text = clip(c.text, MAX_TEXT).trim();
    if (!text) {
      dropped++;
      continue;
    }
    seen.add(c.id);
    const comment: ReviewComment = {
      id: c.id,
      animation: clip(c.animation, MAX_NAME),
      time: c.time,
      text,
      author: clip(c.author, MAX_AUTHOR).trim(),
      at: typeof c.at === 'number' && Number.isFinite(c.at) ? c.at : 0,
    };
    const bone = clip(c.bone, MAX_NAME);
    if (bone) comment.bone = bone;
    out.push(comment);
  }
  return { title: clip((data as { title?: unknown }).title, MAX_NAME), comments: out, dropped };
}

/** The id of the marker a comment makes. */
export const markerIdOf = (c: Pick<ReviewComment, 'id'>): Id => `review:${c.id}`;

export interface ReviewResult {
  added: number;
  /** Comments that were in the project already (their text and time are brought up to date, the "resolved" mark stays). */
  updated: number;
  /** Comments about an animation the project does not have. */
  skipped: number;
}

/** Puts the comments on the timelines of their animations as markers. Works on a draft of the skeleton. */
export function applyReview(doc: SkeletonDoc, comments: ReviewComment[]): ReviewResult {
  const result: ReviewResult = { added: 0, updated: 0, skipped: 0 };
  for (const c of comments) {
    const anim = doc.animations.find((a) => a.name === c.animation);
    if (!anim) {
      result.skipped++;
      continue;
    }
    const time = Math.min(Math.max(0, c.time), Math.max(0, anim.duration));
    const list = (anim.markers ??= []);
    const id = markerIdOf(c);
    const there = list.find((m) => m.id === id);
    if (there) {
      there.time = time;
      there.text = c.text;
      there.name = c.author || 'Review';
      there.author = c.author;
      if (c.bone) there.bone = c.bone;
      result.updated++;
    } else {
      const m: Marker = {
        id,
        time,
        name: c.author || 'Review',
        color: REVIEW_COLOR,
        text: c.text,
        review: true,
        author: c.author,
        resolved: false,
      };
      if (c.bone) m.bone = c.bone;
      list.push(m);
      result.added++;
    }
    list.sort((a, b) => a.time - b.time);
  }
  return result;
}

/** How many review comments the project has still open and already resolved. */
export function reviewCounts(doc: Pick<SkeletonDoc, 'animations'>): { open: number; resolved: number } {
  let open = 0;
  let resolved = 0;
  for (const a of doc.animations) for (const m of a.markers ?? []) if (m.review) m.resolved ? resolved++ : open++;
  return { open, resolved };
}

/** One review comment of the project, with the animation it is on: a row of the Comments window. */
export interface ReviewItem {
  animationId: string;
  animation: string;
  marker: Marker;
}

/** Every review comment of the skeleton: by animation in the order of the document, then by time. Comments that are dealt with come last when `openFirst`. */
export function listReview(doc: Pick<SkeletonDoc, 'animations'>, openFirst = false): ReviewItem[] {
  const out: ReviewItem[] = [];
  for (const a of doc.animations)
    for (const m of [...(a.markers ?? [])].sort((x, y) => x.time - y.time))
      if (m.review) out.push({ animationId: a.id, animation: a.name, marker: m });
  return openFirst ? [...out.filter((i) => !i.marker.resolved), ...out.filter((i) => i.marker.resolved)] : out;
}
