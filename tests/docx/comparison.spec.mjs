import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'

// DOCX comparison behaviour: synced scrolling, change navigation and the
// "changes only" context folding. Runs entirely against local fixtures.

const FIXTURES = new URL('../fixtures/', import.meta.url)

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

async function readFixture(name) {
  return [...await readFile(new URL(name, FIXTURES))]
}

/** Load two DOCX byte arrays into tracks A and B and open the document comparison. */
async function loadDocuments(page, a, b) {
  // The app creates its first project on mount and clears the timeline when it
  // does; wait for that to settle so injected media is not wiped mid-test.
  await page.waitForFunction(async () => {
    const { usePersistenceStore } = await import('/src/stores/persistenceStore.ts')
    return Boolean(usePersistenceStore.getState().currentProjectId)
  })

  return page.evaluate(async ({ a, b, mime }) => {
    const { useMediaStore } = await import('/src/stores/mediaStore.ts')
    const { useTimelineStore } = await import('/src/stores/timelineStore.ts')
    const { usePlaybackStore } = await import('/src/stores/playbackStore.ts')
    const { useProjectStore } = await import('/src/stores/projectStore.ts')
    const toFile = (bytes, name) => new File([new Uint8Array(bytes)], name, { type: mime })

    useMediaStore.getState().clearFiles()
    useTimelineStore.setState({ tracks: [
      { id: 'track-a', name: 'Track A', type: 'a', acceptedTypes: ['docx'], clips: [], muted: false, locked: false },
      { id: 'track-b', name: 'Track B', type: 'b', acceptedTypes: ['docx'], clips: [], muted: false, locked: false },
    ] })
    const mediaA = await useMediaStore.getState().addFile(toFile(a, 'a.docx'))
    const mediaB = await useMediaStore.getState().addFile(toFile(b, 'b.docx'))
    useTimelineStore.getState().addClip('track-a', mediaA.id, 0, 10)
    useTimelineStore.getState().addClip('track-b', mediaB.id, 0, 10)
    usePlaybackStore.getState().seek(1)
    useProjectStore.getState().setComparisonMode('document')
  }, { a, b, mime: DOCX_MIME })
}

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    return url.origin === 'http://127.0.0.1:4179' ? route.continue() : route.abort()
  })
  await page.goto('/tests/fixtures/blank.html')
})

test('synced scroll mapping stays finite and proportional for uneven panes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { computeSyncedScrollTop } = await import('/src/lib/docxDiff.ts')
    const tall = { scrollHeight: 4000, clientHeight: 400 }
    return {
      // Content fits: no scroll range, so the mapping must be refused, not NaN.
      noRange: computeSyncedScrollTop({ scrollTop: 0, scrollHeight: 400, clientHeight: 400 }, tall),
      // Both panes scroll: half-way maps to half-way.
      half: computeSyncedScrollTop({ scrollTop: 100, scrollHeight: 800, clientHeight: 400 }, tall),
      // Scrolled beyond the end is clamped instead of overshooting.
      beyond: computeSyncedScrollTop({ scrollTop: 5000, ...tall }, tall),
      // Unknown/broken sizes never produce a number.
      nan: computeSyncedScrollTop({ scrollTop: NaN, ...tall }, tall),
      zero: computeSyncedScrollTop({ scrollTop: 0, ...tall }, { scrollHeight: 400, clientHeight: 400 }),
    }
  })

  expect(result.noRange).toBeNull()
  expect(result.half).toBe(900)
  expect(result.beyond).toBe(3600)
  expect(result.nan).toBeNull()
  expect(result.zero).toBeNull()
})

test('panes scroll together without NaN or snapping to the ends', async ({ page }) => {
  const [a, b] = await Promise.all([readFixture('docx-comparison-a.docx'), readFixture('docx-comparison-short.docx')])
  await page.goto('/')
  await loadDocuments(page, a, b)

  // The short document does not scroll at all; the tall pane still works.
  const metrics = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="docx-pane-"]')]
    .map(p => ({ range: p.scrollHeight - p.clientHeight })))
  expect(metrics[1].range).toBe(0)

  await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="docx-pane-a"]')
    pane.scrollTop = Math.floor((pane.scrollHeight - pane.clientHeight) / 2)
  })
  await page.waitForTimeout(150)

  const afterHalf = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="docx-pane-"]')]
    .map(p => ({ top: p.scrollTop, range: p.scrollHeight - p.clientHeight })))
  // Pane A moved; pane B has nothing to scroll, so it must stay a valid 0.
  expect(Number.isFinite(afterHalf[0].top)).toBe(true)
  expect(afterHalf[0].top).toBeGreaterThan(0)
  expect(afterHalf[1].top).toBe(0)

  // Both panes tall: the relative position is mirrored, not clamped to an end.
  const [long, mid] = await Promise.all([readFixture('docx-comparison-a.docx'), readFixture('docx-comparison-b.docx')])
  await loadDocuments(page, long, mid)
  await page.waitForTimeout(150)
  await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="docx-pane-a"]')
    pane.scrollTop = pane.scrollHeight - pane.clientHeight
  })
  await page.waitForTimeout(150)
  const afterBottom = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="docx-pane-"]')]
    .map(p => ({ top: p.scrollTop, range: p.scrollHeight - p.clientHeight })))
  expect(afterBottom[0].top).toBe(afterBottom[0].range)
  expect(Math.abs(afterBottom[1].top - afterBottom[1].range)).toBeLessThanOrEqual(1)
})

test('change navigation is hidden without changes and wraps in both directions', async ({ page }) => {
  const [a, b, short] = await Promise.all([
    readFixture('docx-comparison-a.docx'),
    readFixture('docx-comparison-b.docx'),
    readFixture('docx-comparison-short.docx'),
  ])
  await page.goto('/')

  const nav = page.getByTestId('docx-change-nav')
  const count = page.getByTestId('docx-change-count')

  // Identical documents: no counter, no buttons.
  await loadDocuments(page, short, short)
  await expect(page.getByRole('button', { name: /Changes Only/ })).toBeVisible()
  await expect(nav).toHaveCount(0)

  // Changed documents: the counter and the highlight always point together.
  await loadDocuments(page, a, b)
  await expect(nav).toBeVisible()
  const total = Number((await count.textContent()).split('/')[1])
  expect(total).toBeGreaterThan(0)

  await page.getByRole('button', { name: /^Unified/ }).click()
  const highlighted = () => page.evaluate(() => {
    const host = document.querySelector('.max-w-4xl')
    return host ? [...host.querySelectorAll('[class*="ring-accent"]')].map(el => el.textContent) : []
  })

  const seen = []
  for (let i = 0; i < total; i++) {
    expect(await highlighted()).toHaveLength(1)
    seen.push((await highlighted())[0])
    await expect(count).toHaveText(`${i + 1}/${total}`)
    await page.locator('[title="Next change"]').click()
  }

  // One full cycle returns to the first change.
  await expect(count).toHaveText(`1/${total}`)
  expect((await highlighted())[0]).toBe(seen[0])

  // Reverse wraps to the last change.
  await page.locator('[title="Previous change"]').click()
  await expect(count).toHaveText(`${total}/${total}`)
  expect((await highlighted())[0]).toBe(seen[total - 1])
})

test('changes only keeps word-boundary context and shows an empty state', async ({ page }) => {
  const helpers = await page.evaluate(async () => {
    const { buildContextSnippet, computeContextFlags, computeChangePositions, isChangeDiff } = await import('/src/lib/docxDiff.ts')
    const long = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu'
    return {
      isolated: buildContextSnippet(long, false, false),
      between: buildContextSnippet('and then', true, true),
      after: buildContextSnippet(long, true, false),
      before: buildContextSnippet(long, false, true),
      flags: computeContextFlags([
        { value: 'same ' },
        { value: 'old', removed: true },
        { value: ' ' },
        { value: 'new', added: true },
        { value: ' tail' },
      ]),
      // Whitespace-only segments are not countable changes.
      whitespaceIsChange: isChangeDiff({ value: '\n\n', added: true }),
      positions: computeChangePositions([
        { value: 'same ' },
        { value: 'old', removed: true },
        { value: ' ', added: true },
        { value: 'new', added: true },
      ]),
    }
  })

  expect(helpers.isolated).toBeNull()
  expect(helpers.between).toBe('and then')
  expect(helpers.after.startsWith('alpha beta gamma delta epsilon zeta')).toBe(true)
  expect(helpers.after.trim().endsWith('…')).toBe(true)
  expect(helpers.before.trim().startsWith('…')).toBe(true)
  expect(helpers.before.trim().endsWith('lambda mu')).toBe(true)
  // Every retained token is a whole word from the source.
  const sourceWords = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu'.split(' ')
  for (const snippet of [helpers.after, helpers.before]) {
    expect(snippet.replace('…', '').trim().split(/\s+/).every(w => sourceWords.includes(w))).toBe(true)
  }
  // Whitespace-only segments are transparent when checking adjacency.
  expect(helpers.flags.after[2]).toBe(true)
  expect(helpers.flags.before[4]).toBe(true)
  expect(helpers.whitespaceIsChange).toBe(false)
  expect(helpers.positions).toEqual([1, 3])

  const [a, b] = await Promise.all([readFixture('docx-comparison-a.docx'), readFixture('docx-comparison-b.docx')])
  await page.goto('/')
  await loadDocuments(page, a, b)
  await page.getByRole('button', { name: /Changes Only/ }).click()

  const view = await page.evaluate(() => {
    const host = document.querySelector('.max-w-4xl')
    if (!host) return null
    return {
      text: host.textContent,
      changes: [...host.querySelectorAll('span[class*="bg-green"], span[class*="bg-red"]')].map(el => el.textContent),
    }
  })

  expect(view).not.toBeNull()
  expect(view.changes.length).toBeGreaterThan(0)
  expect(view.changes).toContain('revised')
  expect(view.changes).toContain('was replaced in this revision')
  // Context is folded, and change highlights are rendered in full.
  expect(view.text).toContain('…')
  const fullText = view.text
  for (const change of view.changes) {
    expect(change.trim().length).toBeGreaterThan(0)
    expect(fullText).toContain(change)
  }

  // Identical documents: an explicit empty state instead of a blank pane.
  const short = await readFixture('docx-comparison-short.docx')
  await loadDocuments(page, short, short)
  await page.getByRole('button', { name: /Changes Only/ }).click()
  await expect(page.getByText('No changes', { exact: true })).toBeVisible()
})
