import type { Graph, ModuleParams } from '../types/graph';
import type {
  ErrorMessage,
  GraphLoadedMessage,
  ScopeDataMessage,
  SetParamMessage,
  WorkletMessage,
} from '../types/messages';

/** Minimal port surface the controller needs; AudioWorkletNode.port satisfies it. */
export interface MessagePoster {
  postMessage(message: unknown): void;
}

export type SyncStatusType = 'info' | 'success' | 'error';

export interface SyncStatus {
  message: string;
  type: SyncStatusType;
}

export interface EngineSyncCallbacks {
  onStatus: (status: SyncStatus) => void;
  onScopeData: (frames: ScopeDataMessage['frames']) => void;
}

const paramsEqual = (a: ModuleParams | undefined, b: ModuleParams | undefined): boolean => {
  if (a === b) return true;
  if (!a || !b) return a === b;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
  }
  return true;
};

const structureKeyOf = (graph: Graph): string =>
  JSON.stringify({
    modules: graph.modules.map(({ id, kind }) => ({ id, kind })),
    connections: graph.connections,
  });

/**
 * Owns the protocol between the React graph state and the AudioWorklet.
 *
 * Two kinds of change flow through here:
 *
 * - **Structural** (modules added/removed, cables patched/unpatched) produce a
 *   full `loadGraph` carrying a monotonic revision. The worklet builds the new
 *   graph off-stage and only swaps it in when valid, replying
 *   `graphLoaded`/`error` with the same revision.
 * - **Parameter edits** are diffed into cheap `setParam` messages and never
 *   rebuild anything, so delay lines and integrators keep their state.
 *
 * The tricky part is the two paths interleaving. Every load carries the full
 * parameter snapshot at post time. Parameter edits made while a load is in
 * flight mark the load as "touched" rather than being diffed blindly, and on
 * the load acknowledgment the controller reconciles by re-sending the whole
 * current canvas parameter set. That is bounded by the number of modules and
 * idempotent, so it is correct even when several loads supersede each other
 * before any reply arrives: the final acknowledgment always leaves every
 * engine module at its canvas value, never at an older snapshot. A failed load
 * leaves the previous good graph live in the worklet; the controller keeps its
 * "engine holds" record describing that live graph, so later edits still diff
 * correctly and the next valid load restores full agreement. Stale replies
 * (older revisions) are ignored.
 */
export class EngineSync {
  private readonly port: MessagePoster;
  private readonly callbacks: EngineSyncCallbacks;
  private revision = 0;
  /** Revision of the newest load posted; acks of older revisions are stale. */
  private latestRevision = 0;
  /** Revision whose graphLoaded/error reply has not arrived yet, if any. */
  private outstandingRevision: number | null = null;
  private structureKey: string | null = null;
  /** Params the running worklet graph holds, keyed by module id. */
  private engineParams = new Map<string, ModuleParams | undefined>();
  /** Module ids whose params changed while the outstanding load was in flight. */
  private touchedDuringLoad = new Set<string>();
  private lastError: string | null = null;

  constructor(port: MessagePoster, callbacks: EngineSyncCallbacks) {
    this.port = port;
    this.callbacks = callbacks;
  }

  /** React to every new engine graph; decides load vs. setParam vs. nothing. */
  sync(graph: Graph): void {
    const nextKey = structureKeyOf(graph);
    if (this.structureKey === null || nextKey !== this.structureKey) {
      this.structureKey = nextKey;
      this.load(graph);
      return;
    }
    this.diffParams(graph);
  }

  /** Force a full reload even when the structure is unchanged (manual reload). */
  load(graph: Graph): void {
    this.revision += 1;
    this.latestRevision = this.revision;
    this.outstandingRevision = this.revision;
    // A new load supersedes edits tracked for the previous one; the new load's
    // snapshot already contains the current canvas values.
    this.touchedDuringLoad = new Set();
    this.port.postMessage({ type: 'loadGraph', graph, revision: this.revision });
  }

  /**
   * Sends the parameter edits implied by a new graph. While a load is in
   * flight the load's own snapshot may already contain the value, so edits are
   * recorded and reconciled when the load acknowledges instead of being posted
   * against a graph whose modules might not exist yet.
   */
  private diffParams(graph: Graph): void {
    if (this.outstandingRevision !== null) {
      for (const module of graph.modules) {
        if (!paramsEqual(this.engineParams.get(module.id), module.params)) {
          this.touchedDuringLoad.add(module.id);
        }
      }
      return;
    }

    for (const module of graph.modules) {
      const held = this.engineParams.get(module.id);
      if (paramsEqual(held, module.params)) continue;
      for (const message of this.paramDiffsFor(module.id, module.params)) {
        this.port.postMessage(message);
      }
      this.engineParams.set(module.id, module.params);
    }
  }

  private paramDiffsFor(id: string, params: ModuleParams | undefined): SetParamMessage[] {
    const held = this.engineParams.get(id);
    const messages: SetParamMessage[] = [];
    for (const [param, value] of Object.entries(params ?? {})) {
      if (value === undefined) continue;
      if (held && (held as Record<string, unknown>)[param] === value) continue;
      messages.push({ type: 'setParam', id, param, value });
    }
    return messages;
  }

  /** Route worklet replies; call this from the node's port.onmessage. */
  handleMessage(data: WorkletMessage, currentGraph: Graph): void {
    if (data.type === 'graphLoaded') {
      this.handleLoaded(data, currentGraph);
    } else if (data.type === 'error') {
      this.handleError(data);
    } else if (data.type === 'scopeData') {
      this.callbacks.onScopeData(data.frames);
    }
  }

  private handleLoaded(ack: GraphLoadedMessage, currentGraph: Graph): void {
    // A reply to an earlier load while a newer one is in flight: the newest
    // load's own ack will do the reconciliation.
    if (ack.revision !== this.latestRevision) return;
    if (this.outstandingRevision === ack.revision) this.outstandingRevision = null;
    this.lastError = null;

    // The freshly loaded graph holds exactly the snapshot that was posted,
    // except for parameter edits that arrived afterwards. Reconcile against
    // the canvas so every module ends at its current value. Posting the full
    // current parameter set is idempotent and stays correct when loads were
    // superseded: the final acknowledgment always wins with canvas values.
    const touched = this.touchedDuringLoad;
    this.touchedDuringLoad = new Set();
    this.engineParams = new Map(currentGraph.modules.map((module) => [module.id, module.params]));

    if (touched.size > 0) {
      for (const module of currentGraph.modules) {
        if (!touched.has(module.id)) continue;
        for (const [param, value] of Object.entries(module.params ?? {})) {
          if (value === undefined) continue;
          this.port.postMessage({ type: 'setParam', id: module.id, param, value });
        }
      }
    }

    this.callbacks.onStatus({ message: 'Audio running.', type: 'success' });
  }

  private handleError(ack: ErrorMessage): void {
    if (ack.revision !== this.latestRevision) return;
    if (this.outstandingRevision === ack.revision) this.outstandingRevision = null;
    // The failed graph never replaced the running one, and engineParams still
    // describes that running graph. Drop tracked edits: future graph changes
    // diff against the live state and nothing gets silently lost.
    this.touchedDuringLoad = new Set();
    this.lastError = ack.message;
    this.callbacks.onStatus({
      message: `Graph error (previous patch kept playing): ${ack.message}`,
      type: 'error',
    });
  }

  getLastError(): string | null {
    return this.lastError;
  }
}
