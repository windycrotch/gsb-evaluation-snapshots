// Small but functional Tracker (meteor/tracker) for the harness:
// Dependency / autorun / flush, enough for withTracker to recompute.

let currentComputation = null
const pending = new Set()

class Computation {
  constructor(fn) {
    this._fn = fn
    this.stopped = false
    this._run()
  }
  _run() {
    if (this.stopped) return
    const prev = currentComputation
    currentComputation = this
    try { this._fn(this) } finally { currentComputation = prev }
  }
  invalidate() { pending.add(this) }
  stop() { this.stopped = true }
}

class Dependency {
  constructor() { this._deps = new Set() }
  depend(computation = currentComputation) { if (computation) this._deps.add(computation) }
  changed() {
    for (const c of this._deps) c.invalidate()
    Tracker.flush()
  }
}

export const Tracker = {
  Dependency,
  Computation,
  autorun: fn => new Computation(fn),
  flush: () => {
    const computations = [...pending]
    pending.clear()
    computations.forEach(c => c._run())
  },
  nonreactive: fn => {
    const prev = currentComputation
    currentComputation = null
    try { return fn() } finally { currentComputation = prev }
  },
  get currentComputation() { return currentComputation },
}

export default Tracker
