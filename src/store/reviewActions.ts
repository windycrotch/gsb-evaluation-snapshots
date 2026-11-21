/** Review comments in the editor: import the file a reviewer sent back (see core/review.ts); the comments become markers on the timelines. */
import { applyReview, parseReview } from '@/core/review';
import type { ReviewResult } from '@/core/review';
import { docStore } from './doc';
import { toast } from './ui';

/** Applies the text of a review file to the open skeleton in one history step. Returns what happened, or null when it is not a review file. */
export function importReviewText(text: string): ReviewResult | null {
  const parsed = parseReview(text);
  if (!parsed) {
    toast('This is not a review file', 'error');
    return null;
  }
  if (!parsed.comments.length) {
    toast('The review file has no comments', 'info');
    return null;
  }
  let result: ReviewResult = { added: 0, updated: 0, skipped: 0 };
  docStore.update('Import review comments', (d) => {
    result = applyReview(d.skeleton, parsed.comments);
  });
  const r = result;
  if (!r.added && !r.updated) toast('No comment fits an animation of this skeleton', 'info');
  else toast(`Review: ${r.added} new, ${r.updated} updated, ${r.skipped + parsed.dropped} left out`, 'ok');
  return r;
}

/** Asks for a review file and imports it. */
export function pickReviewFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.b2dreview,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 2_000_000) {
      toast('This is not a review file', 'error');
      return;
    }
    importReviewText(await file.text());
  };
  input.click();
}
