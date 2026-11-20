/**
 * The shared, recyclable state of one station while anybody listens to it.
 *
 * Every listener keeps its own HTTP connection (and its own upstream fetch), but the
 * station's "now playing" title and its listener count are aggregated here. One
 * connection going away only decrements the count; the single shared title is forgotten
 * only once the last listener is gone. A listener that reconnects gets a fresh
 * connection id, so callbacks the old connection still fires (its upstream may linger
 * after the abort) can never overwrite the title the new connection reports.
 */
/** Ids are unique across every session, not just one: a late callback from a recycled
 * connection must never be mistaken for a connection of the one that replaced it. */
let nextConnectionId = 1;

export class StationSession {
  readonly #listeners = new Set<number>();
  #title: string | null = null;

  /**
   * Registers a listener connection and returns its globally unique id. Attaching to a
   * session that had gone empty starts from no title, so reusing a recycled object can
   * never hand a new listener the song the previous session left behind.
   */
  attach(): number {
    if (this.#listeners.size === 0) this.#title = null;
    const id = nextConnectionId++;
    this.#listeners.add(id);
    return id;
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  get title(): string | null {
    return this.#title;
  }

  /**
   * Records the song a connection's stream reports. A detached connection (the player
   * went away, or an old connection after a reconnect) is ignored, so its stale
   * callbacks can't take the title back from the connection that replaced it.
   */
  setTitle(id: number, title: string | null): void {
    if (!this.#listeners.has(id)) return;
    this.#title = title;
  }

  /**
   * Removes a listener connection. This only decrements the count; the shared title is
   * cleared only when the last listener goes, so the next listener can't read a song a
   * finished session played.
   */
  detach(id: number): void {
    this.#listeners.delete(id);
    if (this.#listeners.size === 0) this.#title = null;
  }
}
