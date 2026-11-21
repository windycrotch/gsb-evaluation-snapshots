// Async image-asset loading with a two-level cache.
//
// Every Editor owns an AssetCache — its exclusive cache, released wholesale
// on destroy. Behind those sits a module-level registry keyed by assetId, so
// several canvas instances sharing one document reuse the SAME decoded image
// and fire only ONE load per asset. The registry entry is freed only when the
// last referring cache goes away.
//
// Entry lifecycle:
//   loading — one Image is in flight; concurrent requests attach to it, they
//             never start a second load
//   ready   — the decoded Image is handed back immediately
//   error   — the failed entry is kept (with its references) until the next
//             request, which retries with a fresh Image; a failure never
//             becomes permanent
//
// A load completion only calls back caches that are still alive, so a late
// callback after destroy() can never trigger a redraw on a dead canvas.
// Dependency-free ESM.

// assetId -> { src, img, status: 'loading'|'ready'|'error', refs: Set<AssetCache> }
export const assetRegistry = new Map()

export class AssetCache {
  constructor() {
    // assetId -> registry entry: this cache's holdings (its "exclusive"
    // view of the shared registry)
    this._entries = new Map()
    // assetId -> latest onReady, present only while that asset is loading;
    // one waiter per asset is enough because every waiter just asks for a
    // repaint, and a repaint re-reads every visible shape
    this._waiters = new Map()
    this._destroyed = false
  }

  get alive() { return !this._destroyed }

  // Returns the decoded HTMLImageElement when ready, otherwise null. While
  // loading, onReady fires once (on this cache) when the image decodes.
  get(store, assetId, onReady) {
    if (this._destroyed || !assetId) return null
    let entry = this._entries.get(assetId)
    if (!entry) {
      const asset = store.asset(assetId)
      if (!asset) return null
      entry = assetRegistry.get(assetId)
      if (!entry) {
        entry = { src: asset.src, img: null, status: 'error', refs: new Set() }
        assetRegistry.set(assetId, entry)
      }
      entry.refs.add(this)
      this._entries.set(assetId, entry)
    }

    if (entry.status === 'ready') return entry.img
    if (onReady) this._waiters.set(assetId, onReady)
    if (entry.status === 'loading') return null

    // status === 'error': a previous attempt failed (or this is the first
    // request) — start one fresh load. Requests piling in while it is in
    // flight share this entry instead of each creating their own Image.
    this._startLoad(assetId, entry)
    return null
  }

  _startLoad(assetId, entry) {
    entry.status = 'loading'
    const img = new Image()
    entry.img = img
    img.onload = () => {
      if (entry.img !== img) return // superseded by a later retry
      entry.status = 'ready'
      this._settle(assetId)
    }
    img.onerror = () => {
      if (entry.img !== img) return
      // drop the failed Image; the entry (and its refs) stays so the next
      // request can retry, and frees for real once every ref is released
      entry.status = 'error'
      entry.img = null
      img.onload = null
      img.onerror = null
      for (const cache of entry.refs) cache._waiters.delete(assetId)
    }
    img.src = entry.src
  }

  // notify every still-alive cache waiting on this asset, then clear waiters
  _settle(assetId) {
    const entry = assetRegistry.get(assetId)
    if (!entry) return
    for (const cache of entry.refs) {
      if (!cache.alive) continue
      const fn = cache._waiters.get(assetId)
      cache._waiters.delete(assetId)
      if (fn) { try { fn() } catch (e) { console.warn('asset load callback failed', e) } }
    }
  }

  // Release this cache's holdings. Shared entries lose one reference and are
  // evicted only when the last referrer leaves. Idempotent.
  release() {
    if (this._destroyed) return
    this._destroyed = true
    for (const [assetId, entry] of this._entries) {
      entry.refs.delete(this)
      if (!entry.refs.size) {
        if (entry.img) { entry.img.onload = null; entry.img.onerror = null }
        assetRegistry.delete(assetId)
      }
    }
    this._entries.clear()
    this._waiters.clear()
  }
}
