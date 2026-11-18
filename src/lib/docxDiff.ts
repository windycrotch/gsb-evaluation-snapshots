/**
 * Helpers for the Word (DOCX) comparison view.
 *
 * These are kept separate from the component so the scrolling, navigation and
 * context-extraction rules are explicit and easy to reason about:
 * - scroll mapping must never divide by a zero-size scroll range (NaN/Infinity)
 * - change navigation always works with positions inside the diff array
 * - "changes only" context is trimmed on word boundaries and never overlaps a
 *   change segment
 */

export interface TextDiff {
  value: string
  added?: boolean
  removed?: boolean
}

/** How many words of unchanged text are kept on each side of a change. */
export const CONTEXT_WORDS = 6

/**
 * A segment is a user-visible change only when it was added/removed *and*
 * contains actual text. Word diffs routinely emit whitespace-only added or
 * removed segments around real edits; counting those would create invisible
 * "changes" that the navigation counter can point at but the user can never
 * see, so they are treated as ordinary text everywhere.
 */
export function isChangeDiff(diff: TextDiff): boolean {
  return (diff.added === true || diff.removed === true) && /\S/.test(diff.value)
}

/** Indices (inside the diff array) of every user-visible change segment. */
export function computeChangePositions(diffs: TextDiff[]): number[] {
  const positions: number[] = []
  diffs.forEach((diff, index) => {
    if (isChangeDiff(diff)) positions.push(index)
  })
  return positions
}

export interface ChangeOffsets {
  /** Character offset of each diff segment inside document A's text. */
  a: number[]
  /** Character offset of each diff segment inside document B's text. */
  b: number[]
}

const WHITESPACE_ONLY = /^\s*$/

/**
 * For every diff segment, whether the closest meaningful neighbour on each
 * side is a change. Whitespace-only segments are "transparent": they never
 * break the adjacency between a change and the surrounding text. Used by the
 * "changes only" view to decide which unchanged text is context worth keeping.
 */
export function computeContextFlags(diffs: TextDiff[]): { before: boolean[]; after: boolean[] } {
  const before = new Array<boolean>(diffs.length).fill(false)
  const after = new Array<boolean>(diffs.length).fill(false)

  // Walk left to right, remembering whether the last meaningful segment was a change.
  let lastMeaningfulWasChange = false
  for (let i = 0; i < diffs.length; i++) {
    const diff = diffs[i]
    if (isChangeDiff(diff)) {
      lastMeaningfulWasChange = true
      continue
    }
    before[i] = lastMeaningfulWasChange
    if (!WHITESPACE_ONLY.test(diff.value)) lastMeaningfulWasChange = false
  }

  // Walk right to left for the other side.
  let nextMeaningfulIsChange = false
  for (let i = diffs.length - 1; i >= 0; i--) {
    const diff = diffs[i]
    if (isChangeDiff(diff)) {
      nextMeaningfulIsChange = true
      continue
    }
    after[i] = nextMeaningfulIsChange
    if (!WHITESPACE_ONLY.test(diff.value)) nextMeaningfulIsChange = false
  }

  return { before, after }
}

/**
 * Character offsets for every diff segment in both documents. Used as a
 * fallback when a view renders formatted HTML and therefore has no DOM node
 * per change to scroll to.
 */
export function computeChangeOffsets(diffs: TextDiff[]): ChangeOffsets {
  const a: number[] = []
  const b: number[] = []
  let offsetA = 0
  let offsetB = 0

  for (const diff of diffs) {
    a.push(offsetA)
    b.push(offsetB)
    // Removed text only exists in A, added text only exists in B.
    if (!diff.added) offsetA += diff.value.length
    if (!diff.removed) offsetB += diff.value.length
  }

  return { a, b }
}

export interface ScrollPaneMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/**
 * Map a scroll position from one pane onto another by relative position.
 *
 * Returns `null` when the mapping is not meaningful (pane smaller than its
 * content, unknown sizes, non-finite values) so callers leave the other pane
 * untouched instead of jumping to the top or writing NaN into `scrollTop`.
 */
export function computeSyncedScrollTop(
  source: ScrollPaneMetrics,
  target: { scrollHeight: number; clientHeight: number }
): number | null {
  const sourceRange = source.scrollHeight - source.clientHeight
  const targetRange = target.scrollHeight - target.clientHeight

  if (!Number.isFinite(sourceRange) || !Number.isFinite(targetRange)) return null
  if (sourceRange <= 0 || targetRange <= 0) return null
  if (!Number.isFinite(source.scrollTop)) return null

  const ratio = Math.min(Math.max(source.scrollTop / sourceRange, 0), 1)
  if (!Number.isFinite(ratio)) return null

  return ratio * targetRange
}

/**
 * Convert a 0..1 position inside the document text into a scroll offset for a
 * pane. Returns `null` when the pane cannot scroll.
 */
export function computeRatioScrollTop(
  ratio: number,
  target: { scrollHeight: number; clientHeight: number }
): number | null {
  const targetRange = target.scrollHeight - target.clientHeight
  if (!Number.isFinite(targetRange) || targetRange <= 0) return null
  if (!Number.isFinite(ratio)) return null
  return Math.min(Math.max(ratio, 0), 1) * targetRange
}

/**
 * Build the context snippet kept around a change in the "changes only" view.
 *
 * Only unchanged text directly next to a change is kept; everything else is
 * folded away. Snippets are cut on word boundaries so no partial word is left
 * behind, and the result is always a substring of the original segment, so a
 * retained snippet can never hide or truncate a change highlight.
 *
 * Returns `null` when the segment should be fully folded.
 */
export function buildContextSnippet(
  value: string,
  hasPreviousChange: boolean,
  hasNextChange: boolean,
  maxWords: number = CONTEXT_WORDS
): string | null {
  if (!hasPreviousChange && !hasNextChange) return null

  const words = [...value.matchAll(/\S+/g)]
  // Whitespace-only segments are already a minimal separator; keeping them
  // verbatim stops neighbouring change highlights from running together.
  if (words.length === 0) return value

  const endOfWord = (index: number) => words[index].index! + words[index][0].length
  const startOfWord = (index: number) => words[index].index!

  const head = () => value.slice(0, endOfWord(Math.min(maxWords, words.length) - 1))
  const tail = () => value.slice(startOfWord(words.length - Math.min(maxWords, words.length)))

  if (hasPreviousChange && hasNextChange) {
    // Short blocks are already "a small piece of context" - keep them whole so
    // both neighbouring changes retain their surrounding text.
    if (words.length <= maxWords * 2) return value
    return `${head()} … ${tail()}`
  }

  if (hasPreviousChange) {
    // Text immediately after a change: keep its beginning.
    if (words.length <= maxWords) return value
    return `${head()} …`
  }

  // Text immediately before a change: keep its end.
  if (words.length <= maxWords) return value
  return `… ${tail()}`
}
