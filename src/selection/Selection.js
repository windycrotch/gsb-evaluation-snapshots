import { ColumnData } from '../data/ColumnData.js'
import { globalSelectionRegistry } from './SelectionRegistry.js'

function arraysEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export class Selection extends ColumnData {
  constructor(plot, name) {
    super()
    this._plot   = plot
    this._name   = name
    this._listeners   = new Set()
    this._propagating = false
    this._boundColumn = null
    this._unbindState = null
  }

  // ─── ColumnData interface ────────────────────────────────────────────────────

  get length()       { return this._column?._tiles.reduce((s, t) => s + t.n, 0) ?? null }
  get domain()       { return [0, 1] }
  get quantityKind() { return null }

  resolve(path, regl) {
    return this._requireColumn().resolve(path, regl)
  }

  toTexture(regl) {
    return this._requireColumn().toTexture(regl)
  }

  refresh(plot) { return this._column?.refresh(plot) ?? false }

  // ─── Public API ──────────────────────────────────────────────────────────────

  // True only when the last selection run (or an applied cross-plot selection)
  // hit at least one point and that result is still current.
  get active() {
    const col = this._column
    return col ? col.active : false
  }

  // One Float32Array per tile (values 0 or 1). Mirrors toTexture() for CPU access.
  // Returns null when this selection has never been drawn, or when a lasso hit
  // nothing, or after clear(). Throws when no layer declares this selection name,
  // so an unknown name can never be mistaken for a legitimately empty selection.
  // arrays[t][i] == 1 means local point i within tile t is selected.
  get arrays() {
    const col = this._column
    if (col) return col.arrays
    if (this._plotDeclaresName()) return null
    throw this._undeclaredError()
  }

  clear() {
    const col = this._syncColumnBinding()
    if (col) {
      // The column broadcasts one state change, so every Selection wrapping the
      // same (data, name) channel — in this plot or another one — goes inactive
      // and notifies its subscribers together.
      col.clear({ notify: true })
    } else {
      this._plot.scheduleRender()
      this._notify()
    }
  }

  applyFrom(otherSel) {
    const col      = this._syncColumnBinding()
    const otherCol = otherSel?._column ?? null
    // Propagation is best-effort: a plot whose update() has not registered its
    // column yet simply has nothing to write into. Reads (getSelection/arrays)
    // still throw for undeclared names — this path is internal.
    if (!col || !otherCol) return

    // Same (data, name) channel: the registry shares one column, so the two
    // selections already read the same state. Nothing to copy.
    if (col === otherCol) return

    const src = otherCol.arrays
    if (!src || !src.some(a => a.some(v => v > 0.5))) {
      // Source is empty (never drawn, missed everything, or cleared): the target
      // returns to fully inactive too, zeroing any result it still held.
      col.clear({ notify: true })
      this._plot.scheduleRender()
      return
    }

    // Rebuild at the *target's own* tile layout, never the source's: the target
    // layer renders at its own point count, so adopting the source's tiles would
    // leave it with the wrong structure. Silent because upload() publishes the
    // finished state immediately after.
    const ownSizes = this._ownTileSizes()
    if (ownSizes.length > 0 && ownSizes.every(n => n > 0) &&
        !arraysEqual(col._tiles.map(t => t.n), ownSizes)) {
      col._rebuild(ownSizes, { silent: true })
    }

    // upload() allocates one fresh, zero-filled buffer per target tile, copies in
    // whatever the source has for that tile, and overwrites every texel — so a
    // source with more, fewer or differently-sized tiles cannot leave stale data.
    col.upload(src)
    this._plot.scheduleRender()
  }

  subscribe(callback) {
    this._syncColumnBinding()
    this._listeners.add(callback)
    return { remove: () => this._listeners.delete(callback) }
  }

  unsubscribe(callback) { this._listeners.delete(callback) }

  // ─── Internal ────────────────────────────────────────────────────────────────

  get _column() {
    const dataRef = this._plot._lastRawDataArg
    if (dataRef == null) return null
    return globalSelectionRegistry.get(dataRef, this._name, this._plot)
  }

  _plotDeclaresName() {
    return this._plot?._declaresSelection?.(this._name) ?? false
  }

  // The tile layout this plot's layers currently render the selection name at:
  // one entry per tile, matching the tiles the lasso pipeline writes into. Empty
  // when no layer of this plot carries the channel (or its size is still unknown).
  _ownTileSizes() {
    for (const layer of this._plot?.layers ?? []) {
      if (layer.selectionName !== this._name) continue
      const sizes = layer._tileSizes
      if (sizes?.length) return sizes
      const n = layer.instanceCount ?? layer.vertexCount ?? 0
      return n > 0 ? [n] : []
    }
    return []
  }

  _undeclaredError() {
    return new Error(
      `[gladly] Selection '${this._name}': no layer declares a selection with this name — ` +
      `add selection: '${this._name}' to a layer spec`
    )
  }

  _requireColumn() {
    const col = this._syncColumnBinding()
    if (!col) throw this._undeclaredError()
    return col
  }

  // Bind this Selection to its column so a write anywhere — a lasso, another
  // plot's applied result, or clear() — fans out to this Selection's subscribers
  // through the column's single state channel.
  _syncColumnBinding() {
    const col = this._column
    if (col === this._boundColumn) return col
    this._unbindState?.()
    this._unbindState = null
    this._boundColumn = col
    if (col) this._unbindState = col.onStateChange(() => this._notify())
    return col
  }

  _readbackAndNotify() {
    const col = this._syncColumnBinding()
    if (!col) return

    const tileSizes = col._tiles.map(t => t.n)
    const ownSizes = this._ownTileSizes()
    // A later render already rebuilt the column at this plot's current layout;
    // re-reading it here is still correct because the rebuild cleared the GPU
    // textures, so a stale result can never be mistaken for a fresh one.
    const matchesOwn = ownSizes.length === 0 || arraysEqual(tileSizes, ownSizes)

    // Read each tile's FBO; keep as separate Float32Array per tile (values 0 or 1).
    const arrays = col._tiles.map(tile => {
      const raw = new Float32Array(tile.texW * tile.texH * 4)
      this._plot.regl({ framebuffer: tile.fbo })(() => {
        this._plot.regl.read({ data: raw })
      })
      return raw.slice(0, tile.n)   // trim padding; .slice gives a fresh copy
    })

    if (matchesOwn && arrays.some(a => a.some(v => v > 0.5))) {
      col.publish(arrays)
    } else {
      // A lasso that missed every point is indistinguishable from "never drawn":
      // inactive with arrays === null. clear({ notify: true }) publishes that.
      col.clear({ notify: true })
    }
    this._plot.scheduleRender()
  }

  _notify() {
    if (this._propagating) return
    this._propagating = true
    try {
      for (const cb of this._listeners) cb(this)
    } finally {
      this._propagating = false
    }
  }
}
