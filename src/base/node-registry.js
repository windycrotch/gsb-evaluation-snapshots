/**
 * AudioNodeRegistry
 *
 * The shared registry of every audio node/graph in an RAudioContext, keyed by
 * Symbol identifiers. It is a `Map` subclass so existing `nodes.get/has/...`
 * call sites keep working, while lifecycle bookkeeping lives in one place:
 *
 *  - `register`       stores a node under a key and flushes any connections
 *                     that were requested before the target had registered
 *                     (deferred connect), plus re-connects every known inbound
 *                     connection when a source node is re-instantiated after it
 *                     ended.
 *  - `replaceKey`     atomically moves an entry (plus all pending/inbound
 *                     bookkeeping) from an old identifier to a new one.
 *  - `requestConnect` connects two registered nodes immediately, or records a
 *                     pending connection until the target registers. Never
 *                     connects to `undefined`.
 *  - `unregister`     removes the entry and every inbound connection; safe to
 *                     call repeatedly.
 *
 * All mutating operations are idempotent so that interleaved React lifecycle
 * events (re-render, source `ended`, unmount, repeated unmount) can never leave
 * stale keys, connections to stopped nodes, or throw on double cleanup.
 */

// descriptor of one connection attempt that could not be fulfilled yet
const makePending = (source, args, fromKey, toKey) => ({
  source,
  args,
  fromKey,
  toKey
});

// bookkeeping record of a live inbound connection of `targetKey`
const makeInbound = (source, args, fromKey) => ({
  source,
  args,
  fromKey
});

export default class AudioNodeRegistry extends Map {
  constructor() {
    super();
    // connections requested while their destination was not yet registered
    this.pending = [];
    // key -> list of inbound connection records (sources feeding the key)
    this.inbound = new Map();
    // source node -> set of target keys it has connected to
    this.outboundKeys = new Map();
    // reverse index: concrete AudioNode -> the key it is registered under
    this.nodeKeys = new WeakMap();
  }

  safeDisconnect(source, target) {
    try {
      if (target) source.disconnect(target);
      else source.disconnect();
    } catch (e) {
      // the connection may already be gone (node stopped, double unmount);
      // repeated cleanup must never throw
    }
  }

  indexOutbound(source, key) {
    if (!key) return;
    let keys = this.outboundKeys.get(source);
    if (!keys) {
      keys = new Set();
      this.outboundKeys.set(source, keys);
    }
    keys.add(key);
  }

  keyOfNode(node) {
    return this.nodeKeys.get(node);
  }

  /**
   * Stores `value` under `key`.
   *
   * When the key already holds a *different* node instance (the typical case is
   * an Oscillator/BufferSource being re-instantiated after playback ended), all
   * inbound connections are refreshed to point at the new instance and any
   * pending request for the key is fulfilled.
   */
  register(key, value) {
    const previous = this.get(key);
    this.set(key, value);
    if (value && typeof value === 'object') this.nodeKeys.set(value, key);

    // graph containers (RSplit/RCycle) store arrays of pointers and manage
    // their own fan-out; they are never direct connect targets, so skip the
    // node-level connection bookkeeping for them
    const isContainer = Array.isArray(value);

    if (isContainer) return value;

    const pendingForTarget = [];
    const remainingPending = [];

    this.pending.forEach(entry => {
      if (entry.toKey === key) pendingForTarget.push(entry);
      else remainingPending.push(entry);
    });
    this.pending = remainingPending;

    pendingForTarget.forEach(entry => this.executeConnect(entry.source, value, entry.args, entry.fromKey, key));

    // instance replacement: re-plumb every upstream into the fresh node
    if (previous && previous !== value) {
      const inbound = this.inbound.get(key) || [];
      // disconnecting the old (typically stopped) node cannot fail the new graph
      inbound.forEach(record => this.safeDisconnect(record.source, previous));
      this.inbound.set(key, inbound.map(record => {
        this.executeConnect(record.source, value, record.args, record.fromKey, key);
        return makeInbound(record.source, record.args, record.fromKey);
      }));

      // pending outbound requests made by the old instance must be fulfilled
      // by the new one, otherwise a rebuilt source would connect a stopped node
      this.pending = this.pending.map(entry => entry.source === previous
        ? makePending(value, entry.args, entry.fromKey, entry.toKey)
        : entry);

      // the old instance no longer owns any connection bookkeeping
      this.dropSource(previous);
    }

    return value;
  }

  /**
   * Moves an entry and all of its bookkeeping from `oldKey` to `newKey`.
   * The old key is always removed; rapid successive calls therefore leave only
   * the newest key in the registry.
   */
  replaceKey(oldKey, newKey, value) {
    const current = value !== undefined ? value : this.get(oldKey);

    if (oldKey !== newKey) this.delete(oldKey);
    if (current !== undefined) {
      this.set(newKey, current);
      if (current && typeof current === 'object') this.nodeKeys.set(current, newKey);
    }

    this.pending = this.pending.map(entry => {
      if (entry.toKey === oldKey) {
        return makePending(entry.source, entry.args, entry.fromKey, newKey);
      }
      if (entry.fromKey === oldKey) {
        return makePending(entry.source, entry.args, newKey, entry.toKey);
      }
      return entry;
    });

    if (oldKey !== newKey && this.inbound.has(oldKey)) {
      const records = this.inbound.get(oldKey);
      this.inbound.delete(oldKey);
      const existing = this.inbound.get(newKey) || [];
      this.inbound.set(newKey, existing.concat(records));
    }

    this.outboundKeys.forEach(keys => {
      if (keys.has(oldKey)) {
        keys.delete(oldKey);
        keys.add(newKey);
      }
    });

    return current;
  }

  executeConnect(source, target, args, fromKey, toKey) {
    try {
      source.connect(target, ...args);
    } catch (e) {
      // target may be a stopped/non-connectable node; never break rendering
      return false;
    }

    this.indexOutbound(source, toKey);
    const inbound = this.inbound.get(toKey) || [];
    inbound.push(makeInbound(source, args, fromKey));
    this.inbound.set(toKey, inbound);
    return true;
  }

  /**
   * Connects `source` to the node registered under `targetKey`.
   * If the target is missing the request is deferred and fulfilled by the next
   * `register`/`replaceKey` call for that key.
   *
   * @returns {boolean} whether the connection was made immediately
   */
  requestConnect(source, targetKey, args = [], fromKey) {
    const target = this.get(targetKey);

    if (target === undefined || target === null) {
      // de-duplicate identical pending requests (e.g. repeated re-renders)
      const alreadyPending = this.pending.some(entry =>
        entry.source === source &&
        entry.toKey === targetKey &&
        entry.fromKey === fromKey);

      if (!alreadyPending) {
        this.pending.push(makePending(source, args, fromKey, targetKey));
      }
      return false;
    }

    return this.executeConnect(source, target, args, fromKey, targetKey);
  }

  /**
   * Connects `source` to a concrete destination node, using its registry key
   * when known so the connection participates in lifecycle bookkeeping.
   * Targets without a key (e.g. AudioContext.destination) are connected to
   * directly.
   */
  connectToNode(source, target, args = [], fromKey) {
    const key = this.nodeKeys.get(target);
    if (key) return this.requestConnect(source, key, args, fromKey);

    try {
      source.connect(target, ...args);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Disconnects `source` from the given target, which may be a registry key
   * (Symbol) or a concrete node. Bookkeeping is updated to match.
   */
  disconnectFrom(source, target) {
    let targetNode = target;
    let targetKey = null;

    if (typeof target === 'symbol') {
      targetKey = target;
      targetNode = this.get(target);
    } else {
      targetKey = this.nodeKeys.get(target);
    }

    this.safeDisconnect(source, targetNode);

    if (targetKey) {
      const inbound = this.inbound.get(targetKey);
      if (inbound) {
        this.inbound.set(targetKey, inbound.filter(record => record.source !== source));
      }
      const outbound = this.outboundKeys.get(source);
      if (outbound) outbound.delete(targetKey);
      this.pending = this.pending.filter(entry =>
        !(entry.source === source && entry.toKey === targetKey));
    }
  }

  /**
   * Removes everything associated with `key`: the registry entry, pending
   * requests pointing at it, and all inbound connections from parent nodes.
   * Idempotent: a second call for the same key is a no-op.
   */
  unregister(key, expectedValue) {
    // only the current owner of the key may remove it — a stale instance
    // (e.g. an `ended` event delivered after unmount) cannot clobber a new one
    if (this.has(key) && expectedValue !== undefined && this.get(key) !== expectedValue) {
      return;
    }

    if (!this.has(key)) {
      this.pending = this.pending.filter(entry => entry.toKey !== key && entry.fromKey !== key);
      return;
    }

    const value = this.get(key);
    this.delete(key);
    if (value && typeof value === 'object') this.nodeKeys.delete(value);

    this.pending = this.pending.filter(entry => entry.toKey !== key && entry.fromKey !== key);

    const inbound = this.inbound.get(key) || [];
    inbound.forEach(record => this.safeDisconnect(record.source, value));
    this.inbound.delete(key);

    this.outboundKeys.forEach(keys => keys.delete(key));
  }

  /**
   * Drops all bookkeeping of connections made by `source`. Used when a node
   * disconnects itself before reconnecting, so stale records cannot accumulate.
   */
  dropSource(source) {
    this.inbound.forEach((records, key) => {
      this.inbound.set(key, records.filter(record => record.source !== source));
    });
    this.pending = this.pending.filter(entry => entry.source !== source);
    this.outboundKeys.delete(source);
  }
}
