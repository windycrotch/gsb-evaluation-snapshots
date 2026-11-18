import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useTimelineStore } from '../../stores/timelineStore'
import { useMediaStore } from '../../stores/mediaStore'
import { usePlaybackStore } from '../../stores/playbackStore'
import { cn } from '../../lib/utils'
import { FileText, Columns, AlignJustify, Filter, BarChart3, ChevronUp, ChevronDown } from 'lucide-react'
import { diffWords } from 'diff'
import {
  buildContextSnippet,
  computeChangeOffsets,
  computeChangePositions,
  computeContextFlags,
  computeRatioScrollTop,
  computeSyncedScrollTop,
  isChangeDiff,
  type TextDiff
} from '../../lib/docxDiff'
import { getScrollTopForTextOffset } from '../../lib/docxScroll'

type ViewMode = 'side-by-side' | 'unified' | 'changes-only'

export function DOCXComparison() {
  const { tracks } = useTimelineStore()
  const { currentTime } = usePlaybackStore()
  const { getFile } = useMediaStore()

  const [viewMode, setViewMode] = useState<ViewMode>('side-by-side')
  const [syncScroll, setSyncScroll] = useState(true)
  const [showHtml, setShowHtml] = useState(true)
  // Cursor is stored together with the change list it belongs to. When the
  // documents change the key no longer matches and the cursor resets to the
  // first change without an extra render pass.
  const [changeCursor, setChangeCursor] = useState<{ key: string; index: number }>({ key: '', index: 0 })

  const scrollRefA = useRef<HTMLDivElement>(null)
  const scrollRefB = useRef<HTMLDivElement>(null)
  const changeRefs = useRef<(HTMLSpanElement | null)[]>([])
  // Scroll positions we wrote programmatically, per pane. Used to ignore the
  // scroll event the browser echoes back so the two panes do not fight.
  const expectedScrollRef = useRef<{ a: number | null; b: number | null }>({ a: null, b: null })

  // Get current clips at playhead
  const trackA = tracks.find(t => t.type === 'a')
  const trackB = tracks.find(t => t.type === 'b')

  const clipA = trackA?.clips.find(c => currentTime >= c.startTime && currentTime < c.endTime)
  const clipB = trackB?.clips.find(c => currentTime >= c.startTime && currentTime < c.endTime)

  const mediaA = clipA ? getFile(clipA.mediaId) : null
  const mediaB = clipB ? getFile(clipB.mediaId) : null

  // Get parsed DOCX data
  const contentA = useMemo(() => {
    return mediaA?.documentMeta?.parsedContent || null
  }, [mediaA])

  const contentB = useMemo(() => {
    return mediaB?.documentMeta?.parsedContent || null
  }, [mediaB])

  // Calculate word-level diff
  const textDiffs = useMemo(() => {
    const textA = contentA?.text || ''
    const textB = contentB?.text || ''

    if (!textA && !textB) return []

    // Use diff library for word-level comparison
    const diffs = diffWords(textA, textB)
    return diffs as TextDiff[]
  }, [contentA, contentB])

  // Find change positions for navigation. Whitespace-only added/removed
  // segments are not user-visible changes, so they get no counter entry.
  const changePositions = useMemo(() => computeChangePositions(textDiffs), [textDiffs])

  // Character offsets of every diff segment in A and B, for side-by-side navigation
  const changeOffsets = useMemo(() => computeChangeOffsets(textDiffs), [textDiffs])

  // Which unchanged segments are directly adjacent to a change (for "changes only")
  const contextFlags = useMemo(() => computeContextFlags(textDiffs), [textDiffs])

  // Keep the cursor valid for the current documents. Deriving the safe index
  // (instead of trusting the stored value) guarantees the highlight and the
  // "n/total" counter can never point at different entries.
  const changeKey = `${contentA?.text?.length ?? 0}:${contentB?.text?.length ?? 0}:${changePositions.join(',')}`
  const storedIdx = changeCursor.key === changeKey ? changeCursor.index : 0
  const hasChanges = changePositions.length > 0
  const safeChangeIdx = hasChanges
    ? Math.min(Math.max(storedIdx, 0), changePositions.length - 1)
    : 0

  // Keep the change ref array in sync with the rendered diff segments
  useEffect(() => {
    changeRefs.current.length = textDiffs.length
  }, [textDiffs])

  // Calculate statistics (unchanged measure: word counts / added / removed / similarity)
  const stats = useMemo(() => {
    const textA = contentA?.text || ''
    const textB = contentB?.text || ''

    const wordsA = textA.trim().split(/\s+/).filter(w => w.length > 0).length
    const wordsB = textB.trim().split(/\s+/).filter(w => w.length > 0).length

    let added = 0
    let removed = 0

    textDiffs.forEach(diff => {
      const words = diff.value.trim().split(/\s+/).filter(w => w.length > 0).length
      if (diff.added) added += words
      if (diff.removed) removed += words
    })

    const total = Math.max(wordsA, wordsB)
    const unchanged = total - Math.max(added, removed)
    const matchPercent = total > 0 ? ((unchanged / total) * 100).toFixed(1) : '100'

    return {
      wordsA,
      wordsB,
      paragraphsA: mediaA?.documentMeta?.paragraphCount || 0,
      paragraphsB: mediaB?.documentMeta?.paragraphCount || 0,
      added,
      removed,
      unchanged,
      matchPercent
    }
  }, [contentA, contentB, textDiffs, mediaA, mediaB])

  const applyScrollTop = useCallback((pane: 'a' | 'b', el: HTMLDivElement | null, top: number) => {
    if (!el) return
    const before = el.scrollTop
    el.scrollTop = top
    // Reading back gives the browser-clamped value. Nothing moved => no scroll
    // event will fire, so there is nothing to guard against. Otherwise the guard
    // stays until that pane's own scroll event clears it (see handleScroll),
    // which keeps the two panes from echoing each other back and forth.
    const after = el.scrollTop
    expectedScrollRef.current[pane] = Math.abs(after - before) > 0.5 ? after : null
  }, [])

  // Synced scroll handler
  const handleScroll = (source: 'a' | 'b') => {
    if (!syncScroll) return
    const sourcePane = source === 'a' ? 'a' : 'b'
    const targetPane = source === 'a' ? 'b' : 'a'
    const src = source === 'a' ? scrollRefA.current : scrollRefB.current
    const dst = source === 'a' ? scrollRefB.current : scrollRefA.current

    if (!src || !dst) return

    // Ignore the echo of our own programmatic scroll.
    const expected = expectedScrollRef.current[sourcePane]
    if (expected != null) {
      expectedScrollRef.current[sourcePane] = null
      if (Math.abs(src.scrollTop - expected) <= 1) return
    }

    const targetTop = computeSyncedScrollTop(src, dst)
    // Pane cannot scroll (content fits) or has no measurable scroll range:
    // leave the other pane alone rather than snapping it to the top.
    if (targetTop == null) return

    applyScrollTop(targetPane, dst, targetTop)
  }

  const handleSyncScrollToggle = (enabled: boolean) => {
    setSyncScroll(enabled)
    expectedScrollRef.current = { a: null, b: null }
  }

  // Scroll both panes of the side-by-side view to a change. The rendered pane
  // is authoritative (it knows real paragraph heights); a proportional estimate
  // is used only when the pane cannot be measured.
  const scrollPanesToChange = useCallback((diffIndex: number) => {
    const lengthA = contentA?.text?.length || 0
    const lengthB = contentB?.text?.length || 0

    const offsetA = changeOffsets.a[diffIndex] || 0
    const offsetB = changeOffsets.b[diffIndex] || 0

    const paneA = scrollRefA.current
    const paneB = scrollRefB.current

    if (paneA) {
      const measured = getScrollTopForTextOffset(paneA, offsetA, lengthA)
      const top = measured ?? computeRatioScrollTop(lengthA > 0 ? offsetA / lengthA : 0, paneA)
      if (top != null) applyScrollTop('a', paneA, top)
    }
    if (paneB) {
      const measured = getScrollTopForTextOffset(paneB, offsetB, lengthB)
      const top = measured ?? computeRatioScrollTop(lengthB > 0 ? offsetB / lengthB : 0, paneB)
      if (top != null) applyScrollTop('b', paneB, top)
    }
  }, [contentA, contentB, changeOffsets, applyScrollTop])

  // Navigate to change (wraps around in both directions)
  const navigateToChange = (direction: 'prev' | 'next') => {
    if (!hasChanges) return

    const total = changePositions.length
    const newIdx = direction === 'next'
      ? (safeChangeIdx + 1) % total
      : (safeChangeIdx - 1 + total) % total

    setChangeCursor({ key: changeKey, index: newIdx })

    const diffIndex = changePositions[newIdx]
    if (diffIndex === undefined) return

    if (viewMode === 'side-by-side') {
      // The side-by-side panes render the original document, not per-change
      // spans, so translate the change's character offset into a scroll position.
      scrollPanesToChange(diffIndex)
      return
    }

    const changeRef = changeRefs.current[diffIndex]
    if (changeRef) {
      changeRef.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  if (!contentA && !contentB) {
    return (
      <div className="w-full h-full flex items-center justify-center text-text-muted">
        <div className="text-center">
          <FileText className="w-12 h-12 mx-auto mb-4 opacity-30" />
          <p className="text-lg">No Word documents loaded</p>
          <p className="text-sm mt-2">Upload DOCX files to Track A and Track B</p>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full h-full flex flex-col bg-surface">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-surface-alt border-b border-border">
        <div className="flex items-center gap-2">
          {/* View mode buttons */}
          <div className="flex items-center bg-background rounded overflow-hidden">
            <button
              onClick={() => setViewMode('side-by-side')}
              className={cn(
                'px-3 py-1.5 text-xs flex items-center gap-1',
                viewMode === 'side-by-side'
                  ? 'bg-accent text-white'
                  : 'text-text-muted hover:text-text-primary'
              )}
            >
              <Columns className="w-3 h-3" />
              Side by Side
            </button>
            <button
              onClick={() => setViewMode('unified')}
              className={cn(
                'px-3 py-1.5 text-xs flex items-center gap-1',
                viewMode === 'unified'
                  ? 'bg-accent text-white'
                  : 'text-text-muted hover:text-text-primary'
              )}
            >
              <AlignJustify className="w-3 h-3" />
              Unified
            </button>
            <button
              onClick={() => setViewMode('changes-only')}
              className={cn(
                'px-3 py-1.5 text-xs flex items-center gap-1',
                viewMode === 'changes-only'
                  ? 'bg-accent text-white'
                  : 'text-text-muted hover:text-text-primary'
              )}
            >
              <Filter className="w-3 h-3" />
              Changes Only
            </button>
          </div>

          {/* View options */}
          {viewMode === 'side-by-side' && (
            <>
              <label className="flex items-center gap-2 text-xs text-text-muted">
                <input
                  type="checkbox"
                  checked={syncScroll}
                  onChange={(e) => handleSyncScrollToggle(e.target.checked)}
                  className="rounded"
                />
                Sync Scroll
              </label>
              <label className="flex items-center gap-2 text-xs text-text-muted">
                <input
                  type="checkbox"
                  checked={showHtml}
                  onChange={(e) => setShowHtml(e.target.checked)}
                  className="rounded"
                />
                Show Formatting
              </label>
            </>
          )}

          {/* Change navigation - only when there is at least one real change */}
          {hasChanges && (
            <div className="flex items-center gap-1 ml-2" data-testid="docx-change-nav">
              <button
                onClick={() => navigateToChange('prev')}
                className="p-1 text-text-muted hover:text-text-primary hover:bg-surface rounded"
                title="Previous change"
              >
                <ChevronUp className="w-4 h-4" />
              </button>
              <span className="text-xs text-text-muted" data-testid="docx-change-count">
                {safeChangeIdx + 1}/{changePositions.length}
              </span>
              <button
                onClick={() => navigateToChange('next')}
                className="p-1 text-text-muted hover:text-text-primary hover:bg-surface rounded"
                title="Next change"
              >
                <ChevronDown className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {/* Statistics */}
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-1">
            <BarChart3 className="w-3 h-3 text-text-muted" />
            <span className="text-text-muted">Similarity:</span>
            <span className="text-green-400 font-medium">{stats.matchPercent}%</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 bg-green-500/20 text-green-400 rounded">+{stats.added}</span>
            <span className="px-2 py-0.5 bg-red-500/20 text-red-400 rounded">-{stats.removed}</span>
          </div>
        </div>
      </div>

      {/* Document content */}
      <div className="flex-1 overflow-hidden">
        {viewMode === 'side-by-side' ? (
          <div className="flex h-full">
            {/* Document A */}
            <div className="flex-1 flex flex-col border-r border-border">
              <div className="px-3 py-2 bg-orange-500/10 border-b border-border text-xs font-medium text-orange-400">
                A: {mediaA?.name || 'No file'} ({stats.wordsA} words, {stats.paragraphsA} paragraphs)
              </div>
              <div
                ref={scrollRefA}
                data-testid="docx-pane-a"
                className="flex-1 overflow-auto p-4"
                onScroll={() => handleScroll('a')}
              >
                {showHtml && contentA?.html ? (
                  <div
                    className="prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: contentA.html }}
                  />
                ) : (
                  <div className="whitespace-pre-wrap text-sm leading-relaxed">
                    {contentA?.text || ''}
                  </div>
                )}
              </div>
            </div>

            {/* Document B */}
            <div className="flex-1 flex flex-col">
              <div className="px-3 py-2 bg-lime-400/10 border-b border-border text-xs font-medium text-lime-400">
                B: {mediaB?.name || 'No file'} ({stats.wordsB} words, {stats.paragraphsB} paragraphs)
              </div>
              <div
                ref={scrollRefB}
                data-testid="docx-pane-b"
                className="flex-1 overflow-auto p-4"
                onScroll={() => handleScroll('b')}
              >
                {showHtml && contentB?.html ? (
                  <div
                    className="prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: contentB.html }}
                  />
                ) : (
                  <div className="whitespace-pre-wrap text-sm leading-relaxed">
                    {contentB?.text || ''}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : viewMode === 'changes-only' && !hasChanges ? (
          /* Empty state: changes-only view with no differences to show */
          <div className="h-full flex items-center justify-center text-text-muted">
            <div className="text-center">
              <Filter className="w-12 h-12 mx-auto mb-4 opacity-30" />
              <p className="text-lg">No changes</p>
              <p className="text-sm mt-2">The two documents are identical, so there is nothing to filter.</p>
            </div>
          </div>
        ) : (
          /* Unified/Changes view */
          <div className="h-full overflow-auto p-4">
            <div className="max-w-4xl mx-auto">
              <div className="text-sm leading-relaxed">
                {textDiffs.map((diff, idx) => {
                  const isChange = isChangeDiff(diff)

                  // In changes-only mode, unchanged text is folded unless it is
                  // directly next to a change. The kept snippet is word-based so
                  // it never cuts through a word or a change highlight.
                  if (viewMode === 'changes-only' && !isChange) {
                    const snippet = buildContextSnippet(
                      diff.value,
                      contextFlags.before[idx],
                      contextFlags.after[idx]
                    )
                    if (snippet == null) return null
                    return (
                      <span key={idx} className="text-text-muted">
                        {snippet}
                      </span>
                    )
                  }

                  const isCurrentChange = isChange && changePositions[safeChangeIdx] === idx

                  return (
                    <span
                      key={idx}
                      ref={el => { if (isChange) changeRefs.current[idx] = el }}
                      className={cn(
                        // Highlight only counted changes so every visible mark
                        // has a matching entry in the "n/total" counter.
                        isChange && diff.added && 'bg-green-500/20 text-green-400',
                        isChange && diff.removed && 'bg-red-500/20 text-red-400 line-through',
                        isCurrentChange && 'ring-2 ring-accent ring-offset-2 ring-offset-background rounded'
                      )}
                    >
                      {diff.value}
                    </span>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer stats */}
      <div className="flex items-center justify-between px-4 py-2 bg-surface-alt border-t border-border text-xs text-text-muted">
        <div className="flex items-center gap-4">
          <span>Words: A={stats.wordsA}, B={stats.wordsB}</span>
          <span>Paragraphs: A={stats.paragraphsA}, B={stats.paragraphsB}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 bg-green-500/20 rounded"></span>
          <span>Added</span>
          <span className="w-3 h-3 bg-red-500/20 rounded ml-2"></span>
          <span>Removed</span>
        </div>
      </div>
    </div>
  )
}
