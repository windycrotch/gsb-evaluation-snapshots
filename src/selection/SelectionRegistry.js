import { SelectionColumn } from "./SelectionColumn.js"

// One SelectionColumn per (dataRef, selection name, plot). Two plots sharing a data
// object and a selection name each keep a column at their own layer's tile layout;
// they are kept in sync explicitly by linkSelections() / applyFrom() rather than by
// aliasing one GPU texture, which is impossible once the plots hold different
// numbers of points.
export class SelectionRegistry {
  constructor() {
    // dataRef → Map<name, Map<plot, column>>
    this._entries = new WeakMap()
  }

  // Get this plot's column for (data, name), creating it at tileSizes on first use.
  // An existing column is returned as-is, so a re-initialize (resize, config
  // refresh) keeps whatever selection the user already made.
  register(dataRef, name, plot, regl, tileSizes) {
    if (!this._entries.has(dataRef)) this._entries.set(dataRef, new Map())
    const byName = this._entries.get(dataRef)
    if (!byName.has(name)) byName.set(name, new Map())
    const byPlot = byName.get(name)

    let col = byPlot.get(plot)
    if (!col) {
      col = new SelectionColumn(regl, tileSizes)
      col._onWrite = () => plot.scheduleRender()
      byPlot.set(plot, col)
    }
    return col
  }

  get(dataRef, name, plot) {
    return this._entries.get(dataRef)?.get(name)?.get(plot) ?? null
  }

  // Destroy and forget every column this plot owns for `dataRef` whose name is not
  // in keepNames. Called after a layer set has registered, so a name dropped from
  // the config releases its GPU textures while surviving names keep their state.
  retainOnly(dataRef, plot, keepNames) {
    const byName = this._entries.get(dataRef)
    if (!byName) return
    for (const [name, byPlot] of byName) {
      if (keepNames.has(name)) continue
      const col = byPlot.get(plot)
      if (!col) continue
      col.destroy()
      byPlot.delete(plot)
      if (byPlot.size === 0) byName.delete(name)
    }
  }

  // Destroy and forget one plot's column for (data, name) immediately.
  unregister(dataRef, name, plot) {
    const byName = this._entries.get(dataRef)
    const byPlot = byName?.get(name)
    const col = byPlot?.get(plot)
    if (!col) return
    col.destroy()
    byPlot.delete(plot)
    if (byPlot.size === 0) byName.delete(name)
  }
}

export const globalSelectionRegistry = new SelectionRegistry()
