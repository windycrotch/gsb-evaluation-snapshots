import type { Graph, ModuleParams } from '../types/graph';
import type { SetParamMessage } from '../types/messages';

/** Anything that can deliver a message to the running AudioWorklet. */
export interface MessageSink {
  postMessage(message: unknown): void;
}

/**
 * Canonical structure signature of a graph: the modules present (id + kind)
 * and every cable. Parameter-only edits never change it, so they do not force
 * a structural rebuild.
 */
export function structureKeyOf(graph: Graph): string {
  return JSON.stringify({
    modules: graph.modules.map(({ id, kind }) => ({ id, kind })),
    connections: graph.connections,
  });
}

/**
 * Owns the contract between the React-side patch model and the AudioWorklet.
 *
 * Invariants it maintains:
 *
 *  - Every structural change is sent as a versioned `loadGraph`. The engine
 *    only commits a graph that builds cleanly, so a rejected graph leaves the
 *    previous one sounding.
 *  - Parameter edits are diffed into `setParam` messages stamped with the
 *    version of the graph they belong to. Edits made while a rebuild is in
 *    flight are replayed onto the new graph once the load is acknowledged, so
 *    they can neither be lost nor land on a same-named module of an older
 *    graph.
 *  - On every `graphLoaded` ack the parameter baseline is rebuilt from the
 *    graph the engine actually committed, which makes a rebuild instant
 *    impossible to roll parameters back to stale cached values.
 *  - `reset()` drops all bookkeeping. A stopped/restarted engine starts from
 *    a clean generation counter and an empty cache instead of inheriting the
 *    previous session's state.
 */
export class EngineSync {
  private sink: MessageSink | null = null;
  private nextVersion = 1;
  /** Version of the graph the engine has acknowledged and is sounding. */
  private ackedVersion: number | null = null;
  /** Snapshot of the graph the engine is sounding. */
  private ackedGraph: Graph | null = null;
  /** Params the engine is known to hold, keyed by module id. */
  private sentParams = new Map<string, ModuleParams | undefined>();
  /** Full graph snapshot for every version still awaiting an ack. */
  private readonly pending = new Map<number, Graph>();
  /** Freshest desired graph passed to sync()/reload(). */
  private latestDesired: Graph | null = null;
  /** Structure signature the last loadGraph was sent with. */
  private lastStructureKey: string | null = null;

  attach(sink: MessageSink): void {
    this.sink = sink;
  }

  detach(): void {
    this.sink = null;
  }

  /**
   * Forgets every session-scoped binding. A freshly started AudioWorklet node
   * (new processor instance, empty module table) must not be handed versions
   * or cached params from the node it replaced.
   */
  reset(): void {
    this.sink = null;
    this.nextVersion = 1;
    this.ackedVersion = null;
    this.ackedGraph = null;
    this.sentParams = new Map();
    this.pending.clear();
    this.latestDesired = null;
    this.lastStructureKey = null;
  }

  /** Version of the graph the engine has acknowledged and is sounding. */
  get acknowledgedVersion(): number | null {
    return this.ackedVersion;
  }

  /** Versions whose load has not yet been acknowledged. */
  get pendingVersions(): number[] {
    return [...this.pending.keys()];
  }

  /**
   * Applies the latest desired graph. Structure changes trigger a versioned
   * rebuild; otherwise only changed parameters are streamed. Returns the
   * messages handed to the sink so callers (and tests) can observe the exact
   * protocol traffic.
   */
  sync(graph: Graph): unknown[] {
    const sink = this.sink;
    if (!sink) return [];
    this.latestDesired = graph;

    const key = structureKeyOf(graph);
    if (this.lastStructureKey === null || key !== this.lastStructureKey) {
      this.lastStructureKey = key;
      return [this.postLoad(graph)];
    }

    // Keep the desired state of any in-flight version fresh so that its
    // acknowledgement can reconcile parameters that changed after the
    // loadGraph was sent but before the engine processed it. The pending
    // snapshot itself stays frozen (it is what the engine instantiated);
    // the freshest values live in latestDesired.
    return this.pushParamDeltas(graph);
  }

  /** Forces a full rebuild of the current graph (manual "reload" action). */
  reload(graph: Graph): unknown | null {
    if (!this.sink) return null;
    this.latestDesired = graph;
    this.lastStructureKey = structureKeyOf(graph);
    return this.postLoad(graph);
  }

  /**
   * Handles a successful load acknowledgement. The committed graph becomes
   * the new parameter baseline; any edits made while the load was in flight
   * (tracked on the pending snapshot and the latest desired state) are
   * reconciled immediately.
   */
  handleGraphLoaded(version: number): unknown[] {
    const graph = this.pending.get(version);
    if (!graph) {
      // Acknowledgement for a version this session no longer tracks (e.g.
      // after reset): nothing safe to reconcile.
      return [];
    }
    this.ackedVersion = version;
    this.ackedGraph = graph;
    this.pending.delete(version);
    // Baseline starts from the params the engine actually instantiated...
    this.sentParams = new Map(graph.modules.map((m) => [m.id, m.params]));

    // ...then reconcile against the freshest desired state. Same structure
    // means only parameter deltas flow; if the structure already moved on,
    // the newer in-flight loadGraph carries everything and we stay quiet.
    const target = this.latestDesired ?? graph;
    if (structureKeyOf(target) !== structureKeyOf(graph)) return [];
    return this.pushParamDeltas(target);
  }

  /**
   * Handles a rejected load. The engine keeps sounding the previously
   * acknowledged graph, so the baseline rolls back to that graph's
   * parameters rather than the ones the failed attempt would have carried.
   * Any parameter edits held while the doomed load was in flight are
   * reconciled against the still-live module table and returned so the
   * caller can observe exactly what was flushed.
   */
  handleGraphError(version: number): unknown[] {
    this.pending.delete(version);
    if (!this.ackedGraph) return [];

    this.sentParams = new Map(this.ackedGraph.modules.map((m) => [m.id, m.params]));
    this.lastStructureKey = structureKeyOf(this.ackedGraph);

    const target = this.latestDesired;
    if (!target || structureKeyOf(target) !== structureKeyOf(this.ackedGraph)) {
      // Desired structure still differs from the sounding graph: edits to
      // shared modules will flow with the next structural attempt instead.
      return [];
    }
    return this.pushParamDeltas(target);
  }

  private postLoad(graph: Graph): unknown {
    const version = this.nextVersion;
    this.nextVersion += 1;
    this.pending.set(version, graph);
    const message = { type: 'loadGraph' as const, graph, version };
    this.sink!.postMessage(message);
    return message;
  }

  private pushParamDeltas(graph: Graph): unknown[] {
    const sink = this.sink;
    if (!sink) return [];
    const version = this.ackedVersion;
    // No committed graph, or a structural rebuild is still in flight: any
    // setParam emitted now would either have nowhere to land (empty module
    // table) or be stamped with an outdated version and bounce off the
    // engine's version guard. Hold the edits; handleGraphLoaded() replays
    // them once the new module table exists.
    if (version === null || this.pending.size > 0) return [];

    const sent: unknown[] = [];
    for (const module of graph.modules) {
      const previous = this.sentParams.get(module.id);
      if (previous === module.params) continue;
      for (const [param, value] of Object.entries(module.params ?? {})) {
        if (value === undefined) continue;
        if ((previous as Record<string, unknown> | undefined)?.[param] === value) continue;
        const message: SetParamMessage = {
          type: 'setParam',
          id: module.id,
          param,
          value,
          version,
        };
        sink.postMessage(message);
        sent.push(message);
      }
      this.sentParams.set(module.id, module.params);
    }
    return sent;
  }
}
