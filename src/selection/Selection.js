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
    this._arrays = null   // Float32Array[] — one per tile, values 0 or 1; null when inactive
    this._listeners   = new Set()
    this._propagating = false
    this._clearHandle = null   // SelectionColumn.addClearListener handle for the live column
  }

  // ─── ColumnData interface ────────────────────────────────────────────────────

  get length()       { return this._column?._tiles.reduce((s, t) => s + t.n, 0) ?? null }
  get domain()       { return [0, 1] }
  get quantityKind() { return null }

  resolve(path, regl) {
    const col = this._column
    if (!col) throw new Error(`[gladly] Selection '${this._name}': no column registered — add a layer with selection: '${this._name}'`)
    return col.resolve(path, regl)
  }

  toTexture(regl) {
    const col = this._column
    if (!col) throw new Error(`[gladly] Selection '${this._name}': no column registered — add a layer with selection: '${this._name}'`)
    return col.toTexture(regl)
  }

  refresh(plot) { return this._column?.refresh(plot) ?? false }

  // ─── Public API ──────────────────────────────────────────────────────────────

  get active() { return this._column?.active ?? false }

  // One Float32Array per tile (values 0 or 1). Mirrors toTexture() for CPU access.
  // Returns null when no lasso has been drawn or no points are selected.
  // arrays[t][i] == 1 means local point i within tile t is selected.
  //
  // Read through _reconcileShape so a stale mirror can never be handed out: if the layer
  // has been rebuilt with a different per-tile shape since the arrays were read, the old
  // selection is dropped (and subscribers told) before this returns.
  get arrays() {
    this._reconcileShape()
    return this._arrays
  }

  // Drop the cached selection when it no longer matches the live column's tile layout.
  // Returns true when a stale selection was cleared.
  _reconcileShape() {
    const col = this._column
    if (!col || !this._arrays) return false
    const sizes = col.tileSizes
    if (arraysEqual(this._arrays.map(a => a.length), sizes)) return false
    this._arrays = null
    this._notify()
    return true
  }

  clear() {
    const col = this._column
    if (col) col.clear()
    this._arrays = null
    this._plot.scheduleRender()
    this._notify()
  }

  applyFrom(otherSel) {
    const arrays   = otherSel._arrays
    const col      = this._column
    const otherCol = otherSel._column
    if (!col || !otherCol) return

    this._watchColumn()

    // Rebuild silently: this call uploads fresh arrays and notifies once itself below,
    // so the clear listener must not fire a redundant "selection cleared" in between.
    const otherSizes = otherCol._tiles.map(t => t.n)
    if (!arraysEqual(col._tiles.map(t => t.n), otherSizes)) {
      col._rebuild(otherSizes, { silent: true })
    }

    if (!arrays || !arrays.some(a => a.some(v => v > 0.5))) {
      col.clear()
      this._arrays = null
    } else {
      col.upload(arrays)
      this._arrays = arrays
    }
    this._plot.scheduleRender()
    this._notify()
  }

  subscribe(callback) {
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

  // Subscribe this Selection to its shared column's rebuild events (idempotent). Any
  // consumer plot of the same (dataRef, name) hears the rebuild, so when the column is
  // reallocated for a changed data shape every mirror drops its stale arrays and notifies.
  _watchColumn() {
    const col = this._column
    if (!col) return
    if (this._clearHandle?.column === col) return
    this._clearHandle?.remove()
    this._clearHandle = { column: col, ...col.addClearListener(() => this._onColumnCleared()) }
  }

  // The column under this selection was rebuilt with a new tile shape (e.g. layers were
  // rebuilt against data of a different length). The cached CPU mirror describes the old
  // shape, so null it and tell subscribers instead of serving the old arrays.
  _onColumnCleared() {
    if (!this._arrays) return
    this._arrays = null
    this._plot.scheduleRender()
    this._notify()
  }

  _readbackAndNotify() {
    const col = this._column
    if (!col) return

    this._watchColumn()

    // Read each tile's FBO into a fresh Float32Array, one per tile.
    const arrays = col._tiles.map(tile => {
      const raw = new Float32Array(tile.texW * tile.texH * 4)
      this._plot.regl({ framebuffer: tile.fbo })(() => {
        this._plot.regl.read({ data: raw })
      })
      return raw.slice(0, tile.n)   // trim padding; .slice gives a fresh copy
    })

    if (arrays.some(a => a.some(v => v > 0.5))) {
      col.activate()
      this._arrays = arrays
    } else {
      col.clear()
      this._arrays = null
    }

    this._plot.scheduleRender()
    this._notify()
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
