import { assert } from '@esm-bundle/chai'
import { Plot, LayerType, registerLayerType, linkAxes } from '../src/index.js'

// The three paths this suite pins down all key off one "ready" notion:
//
//   * zoom / pan must only write an axis domain once the most recent update() has
//     finished AND that axis's range came from real data — never from d3's placeholder;
//   * a failed update() must leave locks, axis options and colourbar state exactly as
//     they were before the call, and must NOT fire an 'axisoptions' for the config it
//     rolled back;
//   * after a layer rebuild, a selection whose per-column length no longer matches the
//     new data must be cleared and its subscribers told, never served the old arrays.
//
// These exercise the real entry points — Plot.update / setAxisLocked / selectLasso,
// the ZoomController gestures — not a helper in isolation.

const MARGIN = { top: 20, right: 20, bottom: 20, left: 20 }
const LIMITS = { xaxis_bottom: { min: 0, max: 100 }, yaxis_left: { min: 0, max: 100 } }

// A layer whose createLayer waits on `gate`, so a test can hold an update in flight.
let gate = Promise.resolve()

registerLayerType('rc_gated', new LayerType({
  name: 'rc_gated',
  xAxis: 'xaxis_bottom', xAxisQuantityKind: 'rc_x',
  yAxis: 'yaxis_left',   yAxisQuantityKind: 'rc_y',
  vert: `#version 300 es
precision mediump float;
in float x;
in float y;
void main() { gl_Position = plot_pos(vec2(x, y)); }`,
  frag: `#version 300 es
precision mediump float;
void main() { fragColor = gladly_apply_color(vec4(0.0, 0.0, 0.0, 1.0)); }`,
  schema: () => ({ type: 'object', properties: {} }),
  createLayer: async () => {
    await gate
    return [{
      attributes: { x: new Float32Array([0, 100]), y: new Float32Array([0, 100]) },
      uniforms: {},
      domains: { rc_x: [0, 100], rc_y: [0, 100] },
      primitive: 'line strip',
      vertexCount: 2,
    }]
  },
}))

// A layer using a different quantity kind ('rc_alt_x'), so an update() that swaps a
// linked plot onto it fails _validateLinks() and rejects out of update() — the failure
// the rollback path must survive.
registerLayerType('rc_alt', new LayerType({
  name: 'rc_alt',
  xAxis: 'xaxis_bottom', xAxisQuantityKind: 'rc_alt_x',
  yAxis: 'yaxis_left',   yAxisQuantityKind: 'rc_alt_y',
  vert: `#version 300 es
precision mediump float;
in float x;
in float y;
void main() { gl_Position = plot_pos(vec2(x, y)); }`,
  frag: `#version 300 es
precision mediump float;
void main() { fragColor = gladly_apply_color(vec4(0.0, 0.0, 0.0, 1.0)); }`,
  schema: () => ({ type: 'object', properties: {} }),
  createLayer: () => [{
    attributes: { x: new Float32Array([0, 1]), y: new Float32Array([0, 1]) },
    uniforms: {},
    domains: { rc_alt_x: [0, 1], rc_alt_y: [0, 1] },
    primitive: 'line strip',
    vertexCount: 2,
  }],
}))

function makeContainer() {
  const el = document.createElement('div')
  el.style.cssText = 'width:200px;height:200px;position:absolute;left:-9999px'
  document.body.appendChild(el)
  return el
}

const tick = () => new Promise(r => setTimeout(r, 0))

// Assert `promise` rejects, returning the rejection reason. chai's isRejected is not in
// this bundle, so this keeps the failure-path tests provider-independent.
async function expectReject(promise) {
  try {
    await promise
  } catch (e) {
    return e
  }
  assert.fail('expected the promise to reject')
}

function wheel(plot, deltaY = -100) {
  const r = plot._canvas.getBoundingClientRect()
  plot._canvas.dispatchEvent(new WheelEvent('wheel', {
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, deltaY, bubbles: true, cancelable: true,
  }))
}

// Holds a rebuild at its createLayer, returning { open, done }. `open()` releases it.
async function holdUpdate(plot) {
  let open
  gate = new Promise(r => { open = r })
  const done = plot.forceUpdate()
  for (let i = 0; i < 100 && !plot.axisRegistry.getScale('xaxis_bottom'); i++) await tick()
  assert.isOk(plot.axisRegistry.getScale('xaxis_bottom'), 'the update reached layer creation')
  return { open: () => { open(); gate = Promise.resolve() }, done }
}

async function makePlot() {
  const container = makeContainer()
  const plot = new Plot(container, { margin: MARGIN })
  await plot.update({ data: { input: {} }, config: { layers: [{ rc_gated: {} }], axes: LIMITS } })
  await new Promise(r => setTimeout(r, 50))   // let the ResizeObserver's first pass settle
  return { container, plot }
}

describe('Converging on one ready state', () => {
  let containers, plots

  beforeEach(async () => {
    gate = Promise.resolve()
    containers = []
    plots = []
  })

  afterEach(() => {
    gate = Promise.resolve()
    for (const p of plots) p.destroy()
    for (const c of containers) if (c.parentNode) document.body.removeChild(c)
  })

  async function linkedPair() {
    const [a, b] = [await makePlot(), await makePlot()]
    containers.push(a.container, b.container)
    plots.push(a.plot, b.plot)
    linkAxes(a.plot.axes.xaxis_bottom, b.plot.axes.xaxis_bottom)
    linkAxes(a.plot.axes.yaxis_left, b.plot.axes.yaxis_left)
    return [a.plot, b.plot]
  }

  // ── 1. Normal zoom syncs the linked axis; a gesture mid-rebuild is dropped ──────

  it('a wheel after the rebuild completes zooms the linked axes', async () => {
    const [a, b] = await linkedPair()
    wheel(a)
    const [lo, hi] = b.axes.xaxis_bottom.getDomain()
    assert.isAbove(lo, 0, 'linked x lo moved in')
    assert.isBelow(hi, 100, 'linked x hi moved in')
  })

  it('a wheel while a rebuild is in flight is dropped and does not pollute the link', async () => {
    const [a, b] = await linkedPair()
    const { open, done } = await holdUpdate(a)
    wheel(a)
    assert.deepEqual(b.axes.xaxis_bottom.getDomain(), [0, 100], 'linked x untouched')
    assert.deepEqual(b.axes.yaxis_left.getDomain(), [0, 100], 'linked y untouched')
    open()
    await done
    assert.deepEqual(a.axes.xaxis_bottom.getDomain(), [0, 100], 'source x untouched after')
    assert.deepEqual(a.axes.yaxis_left.getDomain(), [0, 100], 'source y untouched after')
  })

  it('a pan drag that starts mid-rebuild writes nothing to the linked axes', async () => {
    const [a, b] = await linkedPair()
    const { open, done } = await holdUpdate(a)
    const r = a._canvas.getBoundingClientRect()
    // Shift-free left drag across the plot area, as ZoomController's pan handler sees it.
    a._canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: r.left + 100, clientY: r.top + 100, button: 0, bubbles: true, cancelable: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + 140, clientY: r.top + 100, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mouseup',   { clientX: r.left + 140, clientY: r.top + 100, bubbles: true }))
    assert.deepEqual(b.axes.xaxis_bottom.getDomain(), [0, 100], 'linked x untouched by a dropped pan')
    open()
    await done
    assert.deepEqual(a.axes.xaxis_bottom.getDomain(), [0, 100], 'source x untouched after')
  })

  it('_canWriteAxisDomain is false mid-rebuild and true once the rebuild finishes', async () => {
    const [a] = await linkedPair()
    assert.isTrue(a._canWriteAxisDomain('xaxis_bottom'))
    const { open, done } = await holdUpdate(a)
    assert.isFalse(a._canWriteAxisDomain('xaxis_bottom'))
    open()
    await done
    assert.isTrue(a._canWriteAxisDomain('xaxis_bottom'))
  })

  // ── 2. A failed update rolls back locks / options and emits no false event ──────

  it('a failed update() leaves a prior lock intact and fires no axisoptions for it', async () => {
    const [a, b] = await linkedPair()
    a.setAxisLocked('xaxis_bottom', true)
    const events = []
    a.on('axisoptions', (e) => events.push(e))

    // Re-point a onto a different quantity kind while it is linked to b (rc_x): the
    // post-apply link validation rejects, so update() throws and must roll back.
    const err = await expectReject(a.update({
      data: { input: {} },
      config: { layers: [{ rc_alt: {} }], axes: { ...LIMITS, xaxis_bottom: { ...LIMITS.xaxis_bottom, locked: false } } },
    }))
    assert.match(err.message, /incompatible quantity kind/)

    assert.isTrue(a.isAxisLocked('xaxis_bottom'), 'lock restored')
    assert.deepEqual(events, [], 'no axisoptions after a failed update')
    assert.deepEqual(a.axes.xaxis_bottom.getDomain(), [0, 100], 'domain rolled back')
    void b
  })

  it('a failed update() rolls a changed axis option back and does not announce it', async () => {
    const [a] = await linkedPair()
    const events = []
    a.on('axisoptions', (e) => events.push(e))

    const err = await expectReject(a.update({
      data: { input: {} },
      config: { layers: [{ rc_alt: {} }], axes: { ...LIMITS, xaxis_bottom: { ...LIMITS.xaxis_bottom, titleVisible: false } } },
    }))
    assert.match(err.message, /incompatible quantity kind/)

    assert.isNotFalse(a.getConfig().axes.xaxis_bottom.titleVisible, 'titleVisible restored')
    assert.deepEqual(events, [], 'no axisoptions for a config that was rolled back')
  })

  it('a successful update() still emits exactly the changed axisoption', async () => {
    const [a] = await linkedPair()
    const events = []
    a.on('axisoptions', (e) => events.push(e))
    await a.update({ config: { layers: [{ rc_gated: {} }], axes: { ...LIMITS, xaxis_bottom: { ...LIMITS.xaxis_bottom, titleVisible: false } } } })
    assert.deepEqual(events, [{ type: 'axisoptions', axis: 'xaxis_bottom', key: 'titleVisible', value: false }])
  })

  // ── 3. A selection is cleared when the rebuilt layer's column length changes ────

  it('rebuilding with a different data length clears the old selection and notifies', async () => {
    const container = makeContainer()
    containers.push(container)
    const plot = new Plot(container, { margin: MARGIN })
    plots.push(plot)

    const col = (n) => {
      const x = new Float32Array(n), y = new Float32Array(n)
      for (let i = 0; i < n; i++) { x[i] = i / (n - 1); y[i] = i / (n - 1) }
      return { input: { x, y } }
    }

    await plot.update({
      data: col(8),
      config: {
        layers: [{ points: { xData: 'input.x', yData: 'input.y', selection: 'brush' } }],
        axes: LIMITS,
        interactions: { lasso: true },
      },
    })
    await new Promise(r => setTimeout(r, 50))

    plot.axes.xaxis_bottom.setDomain([0, 100])
    // Simulate an existing selection whose per-column length is the OLD 8-point length.
    const sel = plot.selections.brush
    sel._arrays = [new Float32Array(8).fill(1)]
    let notified = null
    sel.subscribe((s) => { notified = s })

    // Rebuild the same selection on shorter data (4 points): the shape changed.
    await plot.update({ data: col(4) })

    assert.isNull(sel.arrays, 'stale selection cleared')
    assert.isNotNull(notified, 'subscribers were notified of the clear')
  })

  it('rebuilding with the same data length keeps a live selection intact', async () => {
    const container = makeContainer()
    containers.push(container)
    const plot = new Plot(container, { margin: MARGIN })
    plots.push(plot)

    const col = (n) => {
      const x = new Float32Array(n), y = new Float32Array(n)
      for (let i = 0; i < n; i++) { x[i] = i / (n - 1); y[i] = i / (n - 1) }
      return { input: { x, y } }
    }

    await plot.update({
      data: col(8),
      config: {
        layers: [{ points: { xData: 'input.x', yData: 'input.y', selection: 'brush' } }],
        axes: LIMITS,
        interactions: { lasso: true },
      },
    })
    await new Promise(r => setTimeout(r, 50))

    const sel = plot.selections.brush
    sel._arrays = [new Float32Array(8).fill(1)]
    await plot.forceUpdate()
    assert.isNotNull(sel.arrays, 'same-length rebuild keeps the selection')
  })

  // ── 4. Two concurrent update()s: only the last takes effect ────────────────────

  it('two concurrent update()s leave the last one effective and the first a no-op', async () => {
    // Disconnect the ResizeObserver: its rAF forceUpdate() would bump the epoch and make
    // the outcome depend on timing rather than on the concurrency we are testing.
    const container = makeContainer()
    containers.push(container)
    const plot = new Plot(container, { margin: MARGIN })
    plot.resizeObserver?.disconnect()
    plots.push(plot)
    await plot.update({ data: { input: {} }, config: { layers: [{ rc_gated: {} }], axes: LIMITS } })

    const events = []
    plot.on('axisoptions', (e) => events.push(e))

    let open
    gate = new Promise(r => { open = r })
    // First asks for titleVisible:false; the second, issued before the first settles,
    // asks for titleVisible:true and therefore supersedes it.
    const first = plot.update({
      config: { layers: [{ rc_gated: {} }], axes: { ...LIMITS, xaxis_bottom: { ...LIMITS.xaxis_bottom, titleVisible: false } } },
    })
    const second = plot.update({
      config: { layers: [{ rc_gated: {} }], axes: { ...LIMITS, xaxis_bottom: { ...LIMITS.xaxis_bottom, titleVisible: true } } },
    })
    // Let both reach their await, then release the shared gate once.
    for (let i = 0; i < 10; i++) await tick()
    open()
    await Promise.all([first, second])

    // The second update's config wins; the superseded first emitted nothing.
    assert.isNotFalse(plot.getConfig().axes.xaxis_bottom.titleVisible, 'the last config wins')
    assert.isFalse(events.some(e => e.value === false), 'no axisoptions for the superseded config')
  })
})
