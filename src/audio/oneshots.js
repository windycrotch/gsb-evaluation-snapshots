/* The endgame contract for one-shot sources.
 *
 * The continuous voices in this folder run sources that live for the whole
 * race. The gearchange bark, the boost-pad ignition and the rank notes are the
 * opposite: a BufferSource or Oscillator started with a stop time a tenth of a
 * second out. Those used to be fire-and-forget — each carried an `onended`
 * that disconnected it, and nothing else knew it existed. Two failure modes
 * came straight out of that:
 *
 *   - A race restarted inside that tenth of a second left the old source
 *     sounding into the graph the new race was already using, so two cars
 *     appeared to be running at once.
 *   - dispose() stopped the permanent sources and disconnected the permanent
 *     nodes, but a one-shot still inside its envelope was only orphaned, not
 *     silenced: until its stop time came round it kept playing into a
 *     half-torn-down graph.
 *
 * OneShots is the single convention both voices now share. Every transient
 * source registers here with the nodes it owns. They leave the registry in
 * exactly two ways, both of which leave silence behind:
 *
 *   1. Natural end — `onended` fires, the source and its nodes disconnect and
 *      drop out of the registry.
 *   2. An explicit abort — cutTransients() on a restart, dispose() teardown —
 *      which stops every source still in flight, disconnects its nodes and
 *      clears the registry. The late `onended` the stop provokes then finds
 *      nothing to do.
 *
 * Everything here is tolerant of a source that has already ended: stop() is
 * allowed to throw on a finished source in some engines, and disconnect() on
 * an unconnected node is a no-op, so neither path is allowed to throw.
 */
export class OneShots {
  constructor() {
    /** { src, nodes: AudioNode[] } records still inside their envelopes. */
    this.active = new Set();
    /** True once the owning voice has been torn down. */
    this.disposed = false;
  }

  /**
   * Take ownership of a started one-shot source.
   *
   * @param {AudioScheduledSourceNode} src already started, with a stop time
   * @param {AudioNode[]} [nodes] the per-shot nodes that must come out with it
   * @returns {boolean} false when the voice is already disposed and the shot
   *   was refused (and immediately cleaned up) rather than registered
   */
  add(src, nodes = []) {
    if (this.disposed) {
      /* The voice is gone. Never let a late event attach sound to a dead graph:
         kill the source at once and take its nodes with it. */
      try { src.stop(); } catch (_) {}
      try { src.disconnect(); } catch (_) {}
      for (const n of nodes) { try { n.disconnect(); } catch (_) {} }
      return false;
    }
    const rec = { src, nodes };
    this.active.add(rec);
    src.onended = () => this._reap(rec);
    return true;
  }

  _reap(rec) {
    if (!this.active.has(rec)) return;
    this.active.delete(rec);
    try { rec.src.disconnect(); } catch (_) {}
    for (const n of rec.nodes) { try { n.disconnect(); } catch (_) {} }
  }

  /** In-flight transients only: stop and disconnect them, keep the voice. */
  cut() {
    for (const rec of this.active) {
      try { rec.src.stop(); } catch (_) {}
      try { rec.src.disconnect(); } catch (_) {}
      for (const n of rec.nodes) { try { n.disconnect(); } catch (_) {} }
    }
    this.active.clear();
  }

  /** Final teardown. Idempotent; afterwards add() refuses everything. */
  dispose() {
    if (this.disposed) return;
    this.cut();
    this.disposed = true;
  }

  get count() { return this.active.size; }
}
