import { assert } from '@esm-bundle/chai'
import { Plot, linkSelections } from '../src/index.js'

// Container 200×200. The plot's margins are font-metric dependent, so this file
// maps data coordinates through the live axis scales + live margin rather than
// hard-coding plot-area pixels. Axes are 0..100 on both.
const WIDTH = 200, HEIGHT = 200

function makeContainer() {
  const el = document.createElement('div')
  el.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px;position:absolute;left:-9999px`
  document.body.appendChild(el)
  return el
}

// Canvas pixel (top-left origin) for a data point, using the plot's live scales.
function toCanvas(plot, x, y) {
  const sx = plot.axisRegistry.getScale('xaxis_bottom')
  const sy = plot.axisRegistry.getScale('yaxis_left')
  return [
    plot.margin.left + sx(x),
    plot.margin.top + sy(y),
  ]
}

// A rectangle in canvas pixels around the given data-space box.
function boxAround(plot, x0, x1, y0, y1, pad = 8) {
  const [ax, ay0] = toCanvas(plot, x0, y1)   // y up in data → smaller canvas y
  const [bx, by1] = toCanvas(plot, x1, y0)
  return [
    [ax - pad, ay0 - pad],
    [bx + pad, ay0 - pad],
    [bx + pad, by1 + pad],
    [ax - pad, by1 + pad],
  ]
}

async function makePlot({ x = [10, 50, 90], y = [50, 50, 50], selection = 'brush', container } = {}) {
  container = container ?? makeContainer()
  const plot = new Plot(container)
  await plot.update({
    data: { input: { x: new Float32Array(x), y: new Float32Array(y) } },
    config: {
      layers: [{ points: { xData: 'input.x', yData: 'input.y', selection } }],
      axes: { xaxis_bottom: { min: 0, max: 100 }, yaxis_left: { min: 0, max: 100 } },
      interactions: { lasso: true },
    },
  })
  // A ResizeObserver can interrupt the first _initialize; a second pass completes it.
  await plot.forceUpdate()
  // Let any resize-triggered re-initialize that is already queued land before the
  // test starts a lasso, so the geometry it measures belongs to a settled plot.
  await settle()
  return { container, plot }
}

// One frame + a macrotask, so queued ResizeObserver rAF callbacks have run.
function settle() {
  return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
}

async function lasso(plot, vertices) {
  await plot.selectLasso(vertices)
}

function nextChange(selection) {
  return new Promise(resolve => {
    const handle = selection.subscribe(sel => {
      handle.remove()
      resolve(sel)
    })
  })
}

describe('Plot.getSelection()', () => {
  let container, plot

  afterEach(() => {
    plot?.destroy()
    if (container?.parentNode) document.body.removeChild(container)
    plot = null; container = null
  })

  // ─── Accessor ───────────────────────────────────────────────────────────────

  it('returns the same stable Selection instance on every call and across update()', async () => {
    ({ container, plot } = await makePlot())
    const a = plot.getSelection('brush')
    const b = plot.getSelection('brush')
    assert.strictEqual(a, b)
    await plot.forceUpdate()
    assert.strictEqual(plot.getSelection('brush'), a)
  })

  it('keeps the internal _getSelection method working', async () => {
    ({ container, plot } = await makePlot())
    assert.strictEqual(plot.getSelection('brush'), plot._getSelection('brush'))
  })

  it('returns the object for each declared name independently', async () => {
    container = makeContainer()
    plot = new Plot(container)
    await plot.update({
      data: { input: { x: new Float32Array([10, 50, 90]), y: new Float32Array([50, 50, 50]) } },
      config: {
        layers: [{
          points: { xData: 'input.x', yData: 'input.y', selection: 'groupA' },
        }, {
          points: { xData: 'input.x', yData: 'input.y', selection: 'groupB' },
        }],
        axes: { xaxis_bottom: { min: 0, max: 100 }, yaxis_left: { min: 0, max: 100 } },
        interactions: { lasso: true },
      },
    })
    await plot.forceUpdate()
    assert.notStrictEqual(plot.getSelection('groupA'), plot.getSelection('groupB'))
  })

  // ─── Undeclared names ───────────────────────────────────────────────────────

  it('throws for a name no layer declares, naming it', async () => {
    ({ container, plot } = await makePlot())
    assert.throws(() => plot.getSelection('nope'), /nope/)
    assert.throws(() => plot.getSelection('nope'), /selection/i)
  })

  it('throws when reading arrays of an undeclared name obtained via the selections proxy', async () => {
    ({ container, plot } = await makePlot())
    assert.throws(() => plot.selections['never-declared'].arrays, /never-declared/)
  })

  it('throws for an empty or non-string name', async () => {
    ({ container, plot } = await makePlot())
    assert.throws(() => plot.getSelection(''), /selection name/)
    assert.throws(() => plot.getSelection(undefined), /selection name/)
  })

  it('does not throw while a declared name simply has no result yet', async () => {
    ({ container, plot } = await makePlot())
    const sel = plot.getSelection('brush')
    assert.doesNotThrow(() => sel.arrays)
    assert.isNull(sel.arrays)
    assert.isFalse(sel.active)
  })

  // ─── Never-drawn and miss semantics ─────────────────────────────────────────

  it('a freshly created plot reads active === false and arrays === null', async () => {
    ({ container, plot } = await makePlot())
    const sel = plot.getSelection('brush')
    assert.isFalse(sel.active)
    assert.isNull(sel.arrays)
  })

  it('a lasso that hits no points leaves active false and arrays null', async () => {
    ({ container, plot } = await makePlot())
    const sel = plot.getSelection('brush')
    // Far outside the plot area.
    await lasso(plot, [[-500, -500], [-400, -500], [-400, -400], [-500, -400]])
    assert.isFalse(sel.active)
    assert.isNull(sel.arrays)
  })

  // ─── Hit semantics ──────────────────────────────────────────────────────────

  it('a lasso around the middle point activates it with one 0/1 array per tile', async () => {
    ({ container, plot } = await makePlot())
    const sel = plot.getSelection('brush')
    await lasso(plot, boxAround(plot, 40, 60, 40, 60))

    assert.isTrue(sel.active)
    assert.isArray(sel.arrays)
    assert.lengthOf(sel.arrays, 1)
    assert.deepEqual(Array.from(sel.arrays[0]), [0, 1, 0])

    // Each tile array's length equals that tile's point count.
    const layer = plot.layers[0]
    const tiles = layer.selectionColumn._tiles
    assert.lengthOf(sel.arrays, tiles.length)
    sel.arrays.forEach((arr, t) => assert.lengthOf(arr, tiles[t].n))
  })

  it('notifies subscribers when the lasso completes', async () => {
    ({ container, plot } = await makePlot())
    const sel = plot.getSelection('brush')
    const changed = nextChange(sel)
    await lasso(plot, boxAround(plot, 40, 60, 40, 60))
    const got = await changed
    assert.isTrue(got.active)
    assert.deepEqual(Array.from(got.arrays[0]), [0, 1, 0])
  })

  it('an all-encompassing lasso marks every point', async () => {
    ({ container, plot } = await makePlot())
    const sel = plot.getSelection('brush')
    const [x0, y0] = toCanvas(plot, 0, 100)
    const [x1, y1] = toCanvas(plot, 100, 0)
    await lasso(plot, [[x0 - 5, y0 - 5], [x1 + 5, y0 - 5], [x1 + 5, y1 + 5], [x0 - 5, y1 + 5]])
    assert.isTrue(sel.active)
    assert.deepEqual(Array.from(sel.arrays[0]), [1, 1, 1])
  })

  // ─── clear() ────────────────────────────────────────────────────────────────

  it('clear() returns to inactive immediately, nulls arrays and notifies', async () => {
    ({ container, plot } = await makePlot())
    const sel = plot.getSelection('brush')
    await lasso(plot, boxAround(plot, 40, 60, 40, 60))
    assert.isTrue(sel.active)

    const changed = nextChange(sel)
    sel.clear()
    // Synchronously back to the never-selected state.
    assert.isFalse(sel.active)
    assert.isNull(sel.arrays)

    const got = await changed
    assert.isFalse(got.active)
    assert.isNull(got.arrays)
  })

  it('clear() twice still notifies and stays inactive', async () => {
    ({ container, plot } = await makePlot())
    const sel = plot.getSelection('brush')
    await lasso(plot, boxAround(plot, 40, 60, 40, 60))
    sel.clear()
    const changed = nextChange(sel)
    sel.clear()
    const got = await changed
    assert.isFalse(got.active)
    assert.isNull(got.arrays)
  })

  // ─── Re-selecting ───────────────────────────────────────────────────────────

  it('a second lasso replaces the first result', async () => {
    ({ container, plot } = await makePlot())
    const sel = plot.getSelection('brush')
    await lasso(plot, boxAround(plot, 40, 60, 40, 60))
    assert.deepEqual(Array.from(sel.arrays[0]), [0, 1, 0])
    await lasso(plot, boxAround(plot, 80, 100, 40, 60))
    assert.deepEqual(Array.from(sel.arrays[0]), [0, 0, 1])
  })

  it('a later lasso that misses clears a previous hit', async () => {
    ({ container, plot } = await makePlot())
    const sel = plot.getSelection('brush')
    await lasso(plot, boxAround(plot, 40, 60, 40, 60))
    assert.isTrue(sel.active)
    await lasso(plot, [[-500, -500], [-400, -500], [-400, -400], [-500, -400]])
    assert.isFalse(sel.active)
    assert.isNull(sel.arrays)
  })
})

describe('Selection cross-plot application', () => {
  let containers, plots

  afterEach(() => {
    for (const p of plots ?? []) p.destroy()
    for (const c of containers ?? []) if (c?.parentNode) document.body.removeChild(c)
    containers = []; plots = []
  })

  // Two plots over the *same* data object and the *same* selection name.
  // Different point counts come from different columns of that one object, which
  // is how two plots legitimately hold different numbers of points for one channel.
  async function makeTwoPlots(nA, nB) {
    const xA = new Float32Array(nA), yA = new Float32Array(nA)
    const xB = new Float32Array(nB), yB = new Float32Array(nB)
    for (let i = 0; i < nA; i++) { xA[i] = (i + 1) * 100 / (nA + 1); yA[i] = 50 }
    for (let i = 0; i < nB; i++) { xB[i] = (i + 1) * 100 / (nB + 1); yB[i] = 50 }
    // One shared data object holding both point sets.
    const data = {
      input: { x: xA, y: yA },
      sparse: { x: xB, y: yB },
    }

    containers = [makeContainer(), makeContainer()]
    const [pA, pB] = [new Plot(containers[0]), new Plot(containers[1])]
    plots = [pA, pB]
    const mk = (p, prefix) => p.update({
      data,
      config: {
        layers: [{ points: { xData: `${prefix}.x`, yData: `${prefix}.y`, selection: 'brush' } }],
        axes: { xaxis_bottom: { min: 0, max: 100 }, yaxis_left: { min: 0, max: 100 } },
        interactions: { lasso: true },
      },
    })
    await mk(pA, 'input')
    await pA.forceUpdate()
    await mk(pB, 'sparse')
    await pB.forceUpdate()
    await settle()
    return { pA, pB, data }
  }

  it('applyFrom copies A\'s hit into B, active true and arrays identical', async () => {
    const { pA, pB } = await makeTwoPlots(3, 3)
    pA.getSelection('brush')
    await lasso(pA, boxAround(pA, 40, 60, 40, 60))

    const selA = pA.getSelection('brush')
    const selB = pB.getSelection('brush')
    selB.applyFrom(selA)

    assert.isTrue(selB.active)
    assert.lengthOf(selB.arrays, selA.arrays.length)
    selA.arrays.forEach((arr, t) => assert.deepEqual(Array.from(selB.arrays[t]), Array.from(arr)))
  })

  it('applyFrom notifies B\'s subscribers', async () => {
    const { pA, pB } = await makeTwoPlots(3, 3)
    await lasso(pA, boxAround(pA, 40, 60, 40, 60))
    const changed = nextChange(pB.getSelection('brush'))
    pB.getSelection('brush').applyFrom(pA.getSelection('brush'))
    const got = await changed
    assert.isTrue(got.active)
  })

  it('applyFrom of an empty A returns B to inactive (arrays null, active false)', async () => {
    const { pA, pB } = await makeTwoPlots(3, 3)
    // B first holds a hit of its own.
    await lasso(pB, boxAround(pB, 40, 60, 40, 60))
    assert.isTrue(pB.getSelection('brush').active)

    // A was never selected → applying it clears B.
    pB.getSelection('brush').applyFrom(pA.getSelection('brush'))
    assert.isFalse(pB.getSelection('brush').active)
    assert.isNull(pB.getSelection('brush').arrays)
  })

  it('applyFrom rebuilds at the target\'s own tile sizes when point counts differ', async () => {
    // A has 7 points, B has 3: the tile sizes differ (7 vs 3).
    const { pA, pB } = await makeTwoPlots(7, 3)

    // Select the first and last point in A by lassoing narrow bands around them.
    const xA = (i, n) => (i + 1) * 100 / (n + 1)
    await lasso(pA, boxAround(pA, xA(0, 7) - 2, xA(0, 7) + 2, 40, 60))
    const selA = pA.getSelection('brush')
    assert.isTrue(selA.active)
    assert.lengthOf(selA.arrays[0], 7)

    const selB = pB.getSelection('brush')
    selB.applyFrom(selA)

    assert.isTrue(selB.active)
    // B rebuilds to its own point count — never A's 7.
    assert.equal(selB.arrays[0].length, 3)
    assert.equal(pB.layers[0].selectionColumn._tiles[0].n, 3)
    // Content mirrors A's prefix: A selected point 0, so B's point 0 is selected.
    assert.deepEqual(Array.from(selB.arrays[0]), [1, 0, 0])
  })

  it('applyFrom leaves no stale data when the target had a larger result before', async () => {
    const { pA, pB } = await makeTwoPlots(3, 3)
    // Give B an all-points hit first.
    const [x0, y0] = toCanvas(pB, 0, 100)
    const [x1, y1] = toCanvas(pB, 100, 0)
    await lasso(pB, [[x0 - 5, y0 - 5], [x1 + 5, y0 - 5], [x1 + 5, y1 + 5], [x0 - 5, y1 + 5]])
    assert.deepEqual(Array.from(pB.getSelection('brush').arrays[0]), [1, 1, 1])

    // A selects only the middle point; apply → B must hold exactly that.
    await lasso(pA, boxAround(pA, 40, 60, 40, 60))
    pB.getSelection('brush').applyFrom(pA.getSelection('brush'))
    assert.deepEqual(Array.from(pB.getSelection('brush').arrays[0]), [0, 1, 0])
  })

  it('linkSelections keeps two plots in sync and does not echo forever', async () => {
    const { pA, pB } = await makeTwoPlots(3, 3)
    const selA = pA.getSelection('brush')
    const selB = pB.getSelection('brush')
    const handle = linkSelections(selA, selB)

    const changed = nextChange(selB)
    await lasso(pA, boxAround(pA, 40, 60, 40, 60))
    const got = await changed
    assert.isTrue(got.active)
    assert.deepEqual(Array.from(selB.arrays[0]), [0, 1, 0])
    assert.deepEqual(Array.from(selA.arrays[0]), [0, 1, 0])

    // Clearing on B propagates back to A.
    const back = nextChange(selA)
    selB.clear()
    const backGot = await back
    assert.isFalse(backGot.active)
    assert.isNull(selA.arrays)

    handle.unlink()
  })
})
