import { ColumnData } from "../data/ColumnData.js"

function makeTile(regl, n) {
  const texW = Math.ceil(Math.sqrt(Math.ceil(n / 4)))
  const texH = Math.ceil(Math.ceil(n / 4) / texW)
  const tex = regl.texture({
    width:  texW,
    height: texH,
    format: 'rgba',
    type:   'float',
    data:   new Float32Array(texW * texH * 4),
  })
  const fbo = regl.framebuffer({ color: tex, depth: false, stencil: false })
  return { texture: tex, fbo, texW, texH, n }
}

export class SelectionColumn extends ColumnData {
  constructor(regl, tileSizes) {
    super()
    this._regl         = regl
    this._active       = false
    this._clearListeners = new Set()   // fired when the tile structure is rebuilt under them
    this._onWrite      = null   // called after upload() or clear() increments writeVersion
    this.writeVersion  = 0      // incremented on every write; consumers track their last-read version
    this._tiles        = tileSizes.map(n => makeTile(regl, n))
  }

  get tiles()        { return this._tiles }
  get active()       { return this._active }
  get length()       { return this._tiles.reduce((s, t) => s + t.n, 0) }
  get domain()       { return [0, 1] }
  get quantityKind() { return null }

  // Per-tile point counts. A Selection holds its mirror arrays in the same layout, so a
  // mismatch means the cached selection describes a different data shape.
  get tileSizes() { return this._tiles.map(t => t.n) }

  // Listen for a tile-structure rebuild. Every consumer (each plot's Selection wrapper
  // for this shared column) must hear it, so this is a set, not the single `_onClear`
  // slot the old design had. Returns { remove }.
  addClearListener(fn) {
    this._clearListeners.add(fn)
    return { remove: () => this._clearListeners.delete(fn) }
  }

  _fireClear() {
    for (const fn of this._clearListeners) {
      try { fn() } catch (e) { console.error('[gladly] SelectionColumn clear listener failed:', e) }
    }
  }

  // Destroy current tiles and allocate fresh ones with new sizes.
  // Fires the clear listeners so every Selection holding CPU mirror data can null it and
  // notify subscribers, rather than keep presenting the old selection as current.
  // `silent` skips the notification for a caller that will write fresh data right after
  // (Selection.applyFrom rebuilds, uploads, then notifies once itself).
  _rebuild(tileSizes, { silent = false } = {}) {
    for (const tile of this._tiles) tile.fbo.destroy()
    this._tiles  = tileSizes.map(n => makeTile(this._regl, n))
    this._active = false
    if (!silent) this._fireClear()
  }

  // Zero all tile textures and mark inactive. Caller handles any notification.
  clear() {
    for (const tile of this._tiles) {
      this._regl({ framebuffer: tile.fbo })(() => {
        this._regl.clear({ color: [0, 0, 0, 0] })
      })
    }
    this._active = false
    this.writeVersion++
    this._onWrite?.()
  }

  activate() { this._active = true }

  // Upload per-tile selection data (Float32Array[], one per tile, values 0 or 1)
  // into the corresponding GPU textures.
  upload(arrays) {
    for (let t = 0; t < this._tiles.length; t++) {
      const tile    = this._tiles[t]
      const src     = arrays[t] ?? new Float32Array(tile.n)
      const texLen  = tile.texW * tile.texH * 4
      const texData = new Float32Array(texLen)
      texData.set(src.subarray(0, tile.n))
      tile.texture.subimage({ data: texData, width: tile.texW, height: tile.texH })
    }
    this._active = true
    this.writeVersion++
    this._onWrite?.()
  }

  // ColumnData interface — used when Selection is itself used as a layer attribute.
  resolve(path, _regl) {
    return {
      glslExpr: `sampleColumn(${path}, a_pickId)`,
      textures: { [path]: this._tiles.map(tile => () => tile.texture) },
    }
  }

  toTexture(_regl) { return this._tiles.map(t => t.texture) }
  refresh(_plot)   { return false }

  destroy() {
    for (const tile of this._tiles) tile.fbo.destroy()
  }
}
