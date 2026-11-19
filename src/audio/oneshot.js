/* One-shot voice bookkeeping.
 *
 * Every event sound in this engine — an impact, a gearchange bark, a start
 * light, the flag, a rank change — allocates a source and an envelope gain
 * per shot, and every one of them used to be fire-and-forget: the graph was
 * cleaned up only when the envelope ran to its end and `ended` fired. That is
 * the right lifetime mid-race and the wrong one at a reset, where a hit or a
 * chord still in flight would play on into the next race, and where "release
 * everything" had no handle to grab.
 *
 * OneShots is that handle. A voice registers each shot as it is scheduled;
 * the shot removes itself when it ends, exactly as before; and release()
 * stops and disconnects whatever is still in flight, so a reset or a dispose
 * leaves nothing sounding and nothing connected. Release is idempotent and
 * safe against the `ended` callback firing afterwards: the entry is gone from
 * the set by then and disconnect() on a disconnected node is a no-op.
 */
export class OneShots {
  constructor() { this.live = new Set(); }

  /**
   * Track one shot: its source first, then every node allocated with it.
   * Takes over the source's `onended`, which is the self-cleanup path the
   * voices have always used — the only change is that the entry also leaves
   * the set, so `size` is always the number of shots actually in flight.
   */
  add(src, ...nodes) {
    const entry = [src, ...nodes];
    this.live.add(entry);
    src.onended = () => {
      this.live.delete(entry);
      for (const n of entry) n.disconnect();
    };
    return entry;
  }

  /**
   * Stop and disconnect everything still in flight.
   * @param {number} [t] when to stop, on the owner's clock. Passed through
   *   to `stop(t)` so an offline render cuts the shot at the reset's own
   *   virtual time rather than wherever the context's wall clock happens
   *   to be; omitted, it stops immediately, which is what dispose wants.
   */
  release(t) {
    for (const entry of this.live) {
      try { t == null ? entry[0].stop() : entry[0].stop(t); } catch (_) {}
      for (const n of entry) n.disconnect();
    }
    this.live.clear();
  }

  get size() { return this.live.size; }
}
