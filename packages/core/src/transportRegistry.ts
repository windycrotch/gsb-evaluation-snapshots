import { TransportBus } from './transportBus';
import { WorkletTransport } from './transportWorklet';

/**
 * A shared transport/bus pair for a single AudioContext.
 *
 * The instance fields are stable for the lifetime of one shared transport: every
 * concurrent caller observes the same `transport` and `bus` object.
 */
export interface SharedTransportEntry {
  transport: WorkletTransport;
  bus: TransportBus;
  /**
   * Number of live (resolved) references to the shared instance. Pending
   * acquisitions do not count until they resolve.
   */
  readonly refs: number;
}

/**
 * A per-acquisition handle. Releasing through the handle is exact: it only ever
 * releases the reference that this acquisition took, and it is idempotent.
 */
export interface SharedTransportLease extends SharedTransportEntry {
  release(): void;
}

interface RegistryEntry {
  transport: WorkletTransport;
  bus: TransportBus;
  refs: number;
  disposed: boolean;
}

interface Acquisition {
  status: 'pending' | 'held';
}

interface ContextState {
  entry: RegistryEntry | null;
  loader: Promise<RegistryEntry> | null;
  /** Acquired-but-not-yet-released references, in acquisition order. */
  acquisitions: Map<number, Acquisition>;
  nextId: number;
}

const sharedTransportStates = new WeakMap<AudioContext, ContextState>();

const getState = (context: AudioContext): ContextState => {
  let state = sharedTransportStates.get(context);
  if (!state) {
    state = {
      entry: null,
      loader: null,
      acquisitions: new Map(),
      nextId: 0,
    };
    sharedTransportStates.set(context, state);
  }
  return state;
};

const disposeEntry = (state: ContextState, entry: RegistryEntry): void => {
  if (entry.disposed) {
    return;
  }
  entry.disposed = true;
  // Dispose the bus first so it stops forwarding from the transport, then tear
  // down the worklet node and its audio graph.
  entry.bus.dispose();
  entry.transport.dispose();
  entry.refs = 0;
  if (state.entry === entry) {
    state.entry = null;
  }
};

/**
 * Drop the shared instance once nobody holds it anymore. The check is
 * deliberately conservative: any outstanding acquisition (held or pending)
 * keeps the instance alive.
 */
const sweep = (state: ContextState): void => {
  const entry = state.entry;
  if (!entry) {
    return;
  }
  if (state.loader) {
    return;
  }
  if (entry.refs > 0) {
    return;
  }
  if (state.acquisitions.size > 0) {
    return;
  }
  disposeEntry(state, entry);
};

const loadEntry = (context: AudioContext, state: ContextState): Promise<RegistryEntry> => {
  if (state.entry && !state.entry.disposed) {
    return Promise.resolve(state.entry);
  }

  if (state.loader) {
    return state.loader;
  }

  const loader = WorkletTransport.create(context, {
    bpm: 120,
    startBeat: 0,
    tickIntervalSec: 0.025,
  })
    .then((transport) => {
      const entry: RegistryEntry = {
        transport,
        bus: new TransportBus(transport),
        refs: 0,
        disposed: false,
      };
      state.entry = entry;
      state.loader = null;
      return entry;
    })
    .catch((error) => {
      // Never cache a failed load: the next acquisition must retry from scratch.
      state.loader = null;
      throw error;
    });

  state.loader = loader;
  return loader;
};

const releaseAcquisition = (
  state: ContextState,
  id: number
): void => {
  const record = state.acquisitions.get(id);
  if (!record) {
    return;
  }
  state.acquisitions.delete(id);
  if (record.status === 'held') {
    const entry = state.entry;
    if (entry) {
      entry.refs = Math.max(0, entry.refs - 1);
    }
  }
  sweep(state);
};

const createLease = (entry: RegistryEntry, release: () => void): SharedTransportLease => ({
  transport: entry.transport,
  bus: entry.bus,
  get refs() {
    return entry.refs;
  },
  release,
});

const makeRelease = (
  state: ContextState,
  id: number
): (() => void) => {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    releaseAcquisition(state, id);
  };
};

/**
 * Acquire one reference to the transport shared by `context`.
 *
 * Concurrent calls share a single load: only one worklet node is created, and
 * all callers receive the same `transport`/`bus` instances. A failed load is
 * never cached, so a later call retries.
 */
export const acquireSharedTransport = async (
  context: AudioContext
): Promise<SharedTransportLease> => {
  const state = getState(context);
  const id = state.nextId;
  state.nextId += 1;
  state.acquisitions.set(id, { status: 'pending' });

  let entry: RegistryEntry;
  try {
    entry = await loadEntry(context, state);
  } catch (error) {
    state.acquisitions.delete(id);
    sweep(state);
    throw error;
  }

  const record = state.acquisitions.get(id);
  if (!record) {
    // Released while loading. Drop the freshly created instance if it has no
    // other users instead of leaking a worklet nobody owns.
    sweep(state);
    return createLease(entry, () => {});
  }

  record.status = 'held';
  entry.refs += 1;
  return createLease(entry, makeRelease(state, id));
};

/**
 * Release one reference to the transport shared by `context`.
 *
 * Prefer passing the lease returned by `acquireSharedTransport`; that releases
 * exactly one acquisition and is idempotent. Called without a lease, this
 * releases the oldest still-pending acquisition if there is one, otherwise the
 * oldest held acquisition. The instance is disposed only when the reference
 * count reaches zero.
 */
export const releaseSharedTransport = (
  context: AudioContext,
  lease?: SharedTransportLease | SharedTransportEntry
): void => {
  if (lease && typeof (lease as SharedTransportLease).release === 'function') {
    (lease as SharedTransportLease).release();
    return;
  }

  const state = sharedTransportStates.get(context);
  if (!state) {
    return;
  }

  let targetId: number | undefined;
  let oldestHeldId: number | undefined;
  for (const [id, record] of state.acquisitions) {
    if (record.status === 'pending') {
      targetId = id;
      break;
    }
    if (oldestHeldId === undefined) {
      oldestHeldId = id;
    }
  }
  if (targetId === undefined) {
    targetId = oldestHeldId;
  }
  if (targetId === undefined) {
    return;
  }
  releaseAcquisition(state, targetId);
};

/**
 * Current reference count for the shared transport of `context` (0 when it is
 * not allocated). Primarily useful for diagnostics and tests.
 */
export const getSharedTransportRefCount = (context: AudioContext): number => {
  const state = sharedTransportStates.get(context);
  if (!state || !state.entry) {
    return 0;
  }
  return state.entry.refs;
};
