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
    this._regl          = regl
    this._active        = false
    this._arrays        = null   // Float32Array[] — one per tile; null when inactive
    this._stateListeners = new Set()
    this._onWrite       = null   // called after upload() or clear() increments writeVersion
    this.writeVersion   = 0      // incremented on every write; consumers track their last-read version
    this._tiles         = tileSizes.map(n => makeTile(regl, n))
  }

  get tiles()        { return this._tiles }
  get active()       { return this._active }
  // CPU mirror of the GPU selection texture, one Float32Array per tile.
  // null whenever the column is inactive (never drawn, missed, or cleared).
  get arrays()       { return this._arrays }
  get length()       { return this._tiles.reduce((s, t) => s + t.n, 0) }
  get domain()       { return [0, 1] }
  get quantityKind() { return null }

  // A Selection wrapping this column registers here. A column belongs to one
  // (data, name, plot), so this is normally one listener; it is a Set so a
  // re-bound Selection (e.g. after a data-object change) never strands an
  // old callback and a future shared-column layout would still work.
  onStateChange(callback) {
    this._stateListeners.add(callback)
    return { remove: () => this._stateListeners.delete(callback) }
  }

  _emitState() {
    for (const cb of [...this._stateListeners]) {
      try { cb(this._arrays) }
      catch (e) { console.error('[gladly] Error in selection state listener:', e) }
    }
  }

  // Destroy current tiles and allocate fresh ones with new sizes.
  // Fires the state listeners so every Selection nulls its cached CPU data and notifies.
  // Pass { silent: true } when the caller rebuilds only to immediately write new data,
  // so subscribers see one change instead of an intermediate "cleared" state.
  _rebuild(tileSizes, { silent = false } = {}) {
    for (const tile of this._tiles) tile.fbo.destroy()
    this._tiles  = tileSizes.map(n => makeTile(this._regl, n))
    this._active = false
    this._arrays = null
    if (!silent) this._emitState()
  }

  // Zero all tile textures and mark inactive.
  // `notify` fires the state listeners; the lasso pipeline clears silently because it
  // publishes the fresh result immediately afterwards.
  clear({ notify = false } = {}) {
    for (const tile of this._tiles) {
      this._regl({ framebuffer: tile.fbo })(() => {
        this._regl.clear({ color: [0, 0, 0, 0] })
      })
    }
    this._active = false
    this._arrays = null
    this.writeVersion++
    this._onWrite?.()
    if (notify) this._emitState()
  }

  activate() { this._active = true }

  // Mirror freshly read-back per-tile data (values 0 or 1) and publish it.
  publish(arrays) {
    this._arrays = arrays
    this._active = true
    this.writeVersion++
    this._onWrite?.()
    this._emitState()
  }

  // Upload per-tile selection data (Float32Array[], one per tile, values 0 or 1)
  // into the corresponding GPU textures. The CPU mirror is rebuilt at this column's
  // own tile sizes, so a source with a different tile layout cannot leave stale lengths.
  upload(arrays) {
    const stored = this._tiles.map((tile, t) => {
      const out = new Float32Array(tile.n)
      const src = arrays[t]
      if (src) out.set(src.subarray(0, Math.min(src.length, tile.n)))
      return out
    })
    for (let t = 0; t < this._tiles.length; t++) {
      const tile    = this._tiles[t]
      const texLen  = tile.texW * tile.texH * 4
      const texData = new Float32Array(texLen)
      texData.set(stored[t])
      tile.texture.subimage({ data: texData, width: tile.texW, height: tile.texH })
    }
    this._arrays = stored
    this._active = true
    this.writeVersion++
    this._onWrite?.()
    this._emitState()
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
    this._stateListeners.clear()
  }
}
