import type { ThumbnailCue } from '@vue-player/core'
import type { Ref } from 'vue'
import { parseThumbnailVtt } from '@vue-player/core'
import { onScopeDispose, ref } from 'vue'

export interface ThumbnailSession {
  cues: Ref<ThumbnailCue[]>
  /**
   * Loads thumbnail cues for a (possibly new) source. Each call is a new
   * session: stale previews are cleared immediately, any in-flight request
   * from the previous source is aborted, and a late response can never
   * overwrite the newer source's data.
   */
  load: (url: string | undefined) => Promise<void>
}

/**
 * Session-guarded thumbnail VTT loading.
 *
 * - Switching sources clears cues synchronously, so no previous movie's
 *   preview can linger while the new VTT is loading or when it has none.
 * - Each load gets an AbortController; a newer load (or unmount) cancels the
 *   previous fetch and its result is discarded even if it resolves late.
 * - Fetch failures resolve to an empty preview instead of throwing.
 */
export function createThumbnailSession(): ThumbnailSession {
  const cues = ref<ThumbnailCue[]>([])
  let sessionId = 0
  let controller: AbortController | null = null

  async function load(url: string | undefined) {
    sessionId += 1
    const id = sessionId

    // Cancel the previous source's in-flight request.
    controller?.abort()
    controller = null

    // Never show the old source's thumbnails for the new one.
    cues.value = []

    if (!url) return

    const current = new AbortController()
    controller = current
    try {
      const result = await parseThumbnailVtt(url, current.signal)
      // A newer session started (or unmount ran) while awaiting — the session
      // id alone decides ownership; an aborted signal only means a newer load
      // happened, not that this response is invalid for its own session.
      if (id !== sessionId) return
      cues.value = result
    } catch {
      // parseThumbnailVtt already swallows errors, but stay defensive:
      // a failed thumbnail request means an empty preview, never a crash.
      if (id === sessionId) cues.value = []
    } finally {
      if (controller === current) controller = null
    }
  }

  onScopeDispose(() => {
    // Invalidate any pending result so it cannot write state after unmount.
    sessionId += 1
    controller?.abort()
    controller = null
  })

  return { cues, load }
}
