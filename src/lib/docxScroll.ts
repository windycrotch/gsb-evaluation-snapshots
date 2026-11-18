/**
 * DOM helper for scrolling a side-by-side document pane to a text position.
 *
 * The side-by-side view renders each document as a single block (plain text or
 * formatted HTML), not one element per diff segment, so navigating to a change
 * has to be translated from a character offset into a scroll position. Reading
 * the real text node avoids the inaccuracy of mapping the offset onto the
 * pane's scroll range as a fraction -- paragraphs have very different heights,
 * so a fraction-based guess lands on the wrong line in long documents.
 */

function collectTextNodes(root: Node): Text[] {
  const doc = root.ownerDocument ?? document
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let node = walker.nextNode() as Text | null
  while (node) {
    // Empty text nodes have no usable rect; including them would make the
    // offset land on a zero-width position and scroll the pane to the top.
    if (node.data.length > 0) nodes.push(node)
    node = walker.nextNode() as Text | null
  }
  return nodes
}

/**
 * Scroll offset that centers the character at `charOffset` of the pane's
 * rendered text. Returns `null` when the pane has no rendered text or the
 * position cannot be measured, so callers can fall back to a ratio estimate.
 *
 * `referenceLength` is the length of the text the offset was computed from.
 * Formatted rendering (Mammoth HTML) and the extracted plain text do not have
 * identical whitespace, so the offset is scaled onto the rendered text when the
 * two lengths differ.
 */
export function getScrollTopForTextOffset(
  pane: HTMLElement,
  charOffset: number,
  referenceLength?: number
): number | null {
  if (!Number.isFinite(charOffset)) return null

  const contentRoot = pane.firstElementChild ?? pane
  const nodes = collectTextNodes(contentRoot)
  if (nodes.length === 0) return null

  const renderedLength = nodes.reduce((sum, node) => sum + node.data.length, 0)
  if (!Number.isFinite(renderedLength) || renderedLength <= 0) return null

  let offset = Math.max(0, charOffset)
  if (
    referenceLength != null &&
    Number.isFinite(referenceLength) &&
    referenceLength > 0 &&
    Math.abs(referenceLength - renderedLength) > 0
  ) {
    offset = (offset / referenceLength) * renderedLength
  }
  offset = Math.min(offset, renderedLength)

  let consumed = 0
  let targetNode: Text | null = null
  let targetOffset = 0

  for (const node of nodes) {
    const length = node.data.length
    if (offset <= consumed + length) {
      targetNode = node
      targetOffset = Math.max(0, Math.min(length - 1, Math.floor(offset - consumed)))
      break
    }
    consumed += length
  }

  // Offset past the end of the rendered text: aim at the final character so the
  // pane ends up at its end instead of staying put.
  if (!targetNode) {
    targetNode = nodes[nodes.length - 1]
    targetOffset = Math.max(0, targetNode.data.length - 1)
  }

  const doc = pane.ownerDocument
  const range = doc.createRange()
  try {
    range.setStart(targetNode, targetOffset)
    range.setEnd(targetNode, Math.min(targetNode.data.length, targetOffset + 1))
  } catch {
    return null
  }

  const targetRect = range.getBoundingClientRect()
  const paneRect = pane.getBoundingClientRect()
  if (!Number.isFinite(targetRect.top) || !Number.isFinite(paneRect.top)) return null

  const delta = targetRect.top - paneRect.top - pane.clientHeight / 2
  if (!Number.isFinite(delta)) return null

  return pane.scrollTop + delta
}
