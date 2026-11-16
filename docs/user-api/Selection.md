# Selection

API for reading selection results, cross-plot selection linking, and (when needed) programmatic lasso control. The preferred way to enable lasso is via the declarative `interactions.lasso` config key — see [Selection — Configuration](../configuration/Selection.md). For the GPU pipeline internals see [Selection — Architecture](../architecture/Selection.md).

---

## `plot.getSelection(name)`

Returns the stable `Selection` instance for a selection channel **declared by a layer's `selection` key**. This is the public read path; the same instance is returned on every call and across `plot.update()` calls, so subscriptions survive updates.

```js
const sel = plot.getSelection('brush1')
```

- `name` must match the `selection` value of at least one layer in the current config. For a name no layer declares, `getSelection()` **throws** an error naming it — an unknown name never silently reads as an empty selection.
- The returned object is identical to `plot.selections[name]`; `plot.selections` remains available and behaves the same, including throwing when reading `.arrays` of an undeclared name.

```js
// Throws: no layer declares 'typo'
plot.getSelection('typo')
```

`Selection` implements the [`ColumnData`](Data.md) interface, so it can be used directly as an attribute value in layer specs or computation inputs:

```js
layers: [{
  points: {
    xData: 'input.x',
    yData: 'input.y',
    vData: plot.getSelection('brush1'),  // drive color from selection state
  }
}]
```

---

## Selection state semantics

Every `Selection` reads from one of three states. `active` and `arrays` always agree:

| State | `active` | `arrays` |
|-------|----------|----------|
| Never selected, a lasso that hit nothing, or after `clear()` | `false` | `null` |
| A lasso (or applied cross-plot selection) hit ≥ 1 point | `true` | `Float32Array[]`, one per tile |

There is no distinct "drawn but empty" state: a miss and a never-drawn selection are both `active === false, arrays === null`.

When `active` is `true`, `arrays[t]` has exactly `tile[t]`'s point count, and `arrays[t][i] === 1` marks a selected point (all other entries are `0`). For single-tile layers `arrays` has length 1. This matches the tile/index pair returned by `plot.pick()`.

---

## Selection properties

### `selection.active`

`true` when a lasso has been drawn and at least one point is selected; `false` otherwise (including before any lasso has been drawn), and after `clear()`.

### `selection.arrays`

A `Float32Array[]` with one array per data tile: each element is `1` if selected, `0` if not. Returns `null` when `selection.active` is `false`. Reading `arrays` on a name no layer declares throws (see [`plot.getSelection`](#plotgetselectionname)).

```js
plot.getSelection('brush1').subscribe(sel => {
  const arrays = sel.arrays   // Float32Array[] | null
  if (arrays) {
    arrays.forEach((tileArr, t) => {
      const indices = [...tileArr.keys()].filter(i => tileArr[i] > 0.5)
      console.log(`tile ${t}: ${indices.length} points selected`)
    })
  }
})
```

### `selection.length`

Total number of data points tracked by this selection channel across all tiles, or `null` if no layer has registered it yet.

---

## Selection methods

### `selection.clear()`

Clears the selection and marks it inactive. Takes effect immediately (`active` becomes `false`, `arrays` becomes `null` synchronously), triggers a re-render and notifies subscribers. When two plots share the same data object and selection name, clearing on one returns both to inactive.

```js
plot.getSelection('brush1').clear()
```

### `selection.applyFrom(otherSelection)`

Copies the selection result from another `Selection` into this one. Triggers a re-render and notifies subscribers.

- If the source is active, the target becomes active with the same per-point result. When the two plots' tile layouts (point counts) differ, the target **rebuilds its tiles at its own sizes** before writing, so it never keeps the source's tile structure or any stale data.
- If the source is inactive (`arrays === null`), the target also returns to inactive.
- Used by `linkSelections` internally; also useful for manual cross-plot or cross-component propagation.

```js
plot2.getSelection('brush1').applyFrom(plot1.getSelection('brush1'))
```

### `selection.subscribe(callback)`

Registers a callback fired whenever the selection changes: after a lasso completes (hit or miss), after `clear()`, and after the selection is overwritten by an applied cross-plot result. Also fires on every plot sharing the same data object and selection name, since they share one selection channel. Returns `{ remove() }` to unregister.

```js
const handle = plot.getSelection('brush1').subscribe(sel => {
  console.log('selection changed, active:', sel.active)
})

handle.remove()  // unsubscribe
```

### `selection.unsubscribe(callback)`

Removes a previously registered callback by reference.

---

## LassoInteraction

Low-level class that attaches mouse event handlers to a plot's canvas and calls `plot.selectLasso()` on `mouseup`. Prefer the declarative `interactions.lasso` config key for typical use — instantiate `LassoInteraction` directly only when you need runtime control (e.g. toggling lasso on/off without re-calling `update()`).

```js
import { LassoInteraction } from 'gladly'

const lasso = new LassoInteraction(plot, options)
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `selectionName` | — | Selection channel name (informational only) |
| `trigger` | `'shift'` | Activation modifier: `'shift'`, `'ctrl'`, or `'always'` |
| `mode` | `'lasso'` | Selection shape, one of `LASSO_MODES`: `'lasso'`, `'rectangle'`, `'triangle'`, `'polygon'`, `'circle'`, `'ellipse'`, `'band'`. The gestures are listed under [Selection shapes](../configuration/Selection.md#selection-shapes). An unknown mode throws. |
| `bandWidth` | `null` | Width of a band click, in the x axis's data units (`xaxis_bottom`, else `xaxis_top`). With none, a band click selects nothing. |

A blue `line loop` is drawn directly on the WebGL canvas while a shape is being drawn, via a regl draw command registered in `plot._renderCallbacks`. It is cleared when the shape selects or is abandoned.

**Properties:**

- `lasso.mode`: the current selection shape
- `lasso.bandWidth`: the current band width, or `null`

**Methods:**

- `lasso.setMode(mode)`: changes the selection shape, abandoning a shape in progress; throws on an unknown mode
- `lasso.setBandWidth(bandWidth)`: sets the band width, in the x axis's data units
- `lasso.destroy()`: removes all event listeners and destroys the WebGL vertex buffer

---

## `plot.setLassoMode(mode, { bandWidth })`

Changes the selection shape of every lasso interaction on the plot at run time, without `update()`, so no layer is rebuilt. A shape in progress is abandoned.

```js
plot.setLassoMode('rectangle')
plot.setLassoMode('band', { bandWidth: 100 })   // a band click selects 100 x-axis units
```

- `mode`: one of `LASSO_MODES`; an unknown mode throws
- `bandWidth`: optional; when given, the band width in the x axis's data units, otherwise the current width is kept

The mode and width are kept on the plot, so interactions built by a later `update()` start in them. An `interactions.lasso` item with its own `mode` or `bandWidth` wins over them at that update.

---

## `plot.selectLasso(vertices)`

Runs the GPU selection algorithm for a polygon defined by screen-space vertices.

```js
// vertices: [[x, y], ...] in HTML canvas coordinates (top-left origin)
await plot.selectLasso([[10, 20], [150, 30], [140, 200], [10, 190]])
```

After the GPU pipeline completes, each affected `Selection` object reads back its result to CPU (`selection.array` is updated), then fires its subscribers.

> **Limit:** The lasso polygon may have at most 256 vertices.

---

## `linkSelections(selA, selB)`

Links two `Selection` objects bidirectionally. When a lasso fires on either plot, the result propagates to the other.

```js
import { linkSelections } from 'gladly'

const handle = linkSelections(plot1.getSelection('brush1'), plot2.getSelection('brush1'))

// Later, tear down:
handle.unlink()
```

Cross-plot cycles are prevented: the `_propagating` flag on each `Selection` stops a change from bouncing back to its source.

---

## Cross-Plot Linked Selection

```js
const plot1 = new Plot(container1)
const plot2 = new Plot(container2)

const config1 = { layers: [{ points: { xData: 'input.x', yData: 'input.y', selection: 'brush1' } }], interactions: { lasso: true } }
const config2 = { layers: [{ points: { xData: 'input.x', yData: 'input.z', selection: 'brush1' } }], interactions: { lasso: true } }

await plot1.update({ data: myData, config: config1 })
await plot2.update({ data: myData, config: config2 })

linkSelections(plot1.getSelection('brush1'), plot2.getSelection('brush1'))
// Lasso on either plot propagates to the other via the link
```

---

## PlotGroup Auto-Linking

When using [`PlotGroup`](PlotGroup.md) with `autoLink: true`, `_updateAutoLinks()` automatically calls `linkSelections()` for any selection name shared across plots — no manual wiring needed.

```js
const group = new PlotGroup({ plot1, plot2 }, { autoLink: true })

await group.update({
  data: { input: myData },
  plots: {
    plot1: { layers: [{ points: { xData: 'input.x', yData: 'input.y', selection: 'brush1' } }], interactions: { lasso: true } },
    plot2: { layers: [{ points: { xData: 'input.x', yData: 'input.z', selection: 'brush1' } }], interactions: { lasso: true } },
  }
})
// A lasso on either plot propagates to the other automatically
```

Unlike axis auto-linking (which matches by quantity kind), selection auto-linking matches by **dataset object and selection name together** — both plots must receive the same data object reference and use the same name string for auto-linking to connect them.
