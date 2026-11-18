import { TransportBus } from './transportBus';
import { WorkletTransport, WorkletTransportOptions } from './transportWorklet';

export interface SharedTransportEntry {
  transport: WorkletTransport;
  bus: TransportBus;
  refs: number;
  disposed: boolean;
}

export interface SharedTransportHandle {
  transport: WorkletTransport;
  bus: TransportBus;
  /**
   * True when this acquire is the one that created the shared transport, so
   * the caller may seed the transport with its initial tempo. Later Clocks
   * must adopt the shared tempo instead of overwriting it on mount.
   */
  isPrimary: boolean;
}

export interface SharedTransportState {
  bpm: number;
  isRunning: boolean;
}

interface PendingLoad {
  refs: number;
  promise: Promise<SharedTransportEntry>;
  discarded: boolean;
}

const DEFAULT_OPTIONS: WorkletTransportOptions = {
  bpm: 120,
  startBeat: 0,
  tickIntervalSec: 0.025,
};

const sharedTransports = new WeakMap<AudioContext, SharedTransportEntry>();
const pendingLoads = new WeakMap<AudioContext, PendingLoad>();

const disposeEntry = (entry: SharedTransportEntry): void => {
  if (entry.disposed) {
    return;
  }
  entry.disposed = true;
  entry.refs = 0;
  try {
    entry.bus.dispose();
  } finally {
    entry.transport.dispose();
  }
};

/**
 * Acquire the transport shared by every Clock attached to `context`.
 *
 * The first caller creates the worklet transport; every subsequent caller
 * receives the exact same instance. Each successful acquire increments the
 * reference count, which is mirrored by `releaseSharedTransport`.
 */
export const acquireSharedTransport = (
  context: AudioContext
): Promise<SharedTransportHandle> => {
  const existing = sharedTransports.get(context);
  if (existing && !existing.disposed) {
    existing.refs += 1;
    return Promise.resolve({
      transport: existing.transport,
      bus: existing.bus,
      isPrimary: false,
    });
  }

  let pending = pendingLoads.get(context);
  if (!pending || pending.discarded) {
    const record = { refs: 0, discarded: false } as PendingLoad;
    record.promise = WorkletTransport.create(context, DEFAULT_OPTIONS)
      .then((transport) => {
        if (pendingLoads.get(context) === record) {
          pendingLoads.delete(context);
        }
        const entry: SharedTransportEntry = {
          transport,
          bus: new TransportBus(transport),
          refs: record.refs,
          disposed: false,
        };
        if (record.refs > 0) {
          sharedTransports.set(context, entry);
        } else {
          // Every caller released before the worklet finished loading.
          disposeEntry(entry);
        }
        return entry;
      })
      .catch((err) => {
        if (pendingLoads.get(context) === record) {
          pendingLoads.delete(context);
        }
        throw err;
      });
    pendingLoads.set(context, record);
    pending = record;
  }

  const isPrimary = pending.refs === 0;
  pending.refs += 1;
  return pending.promise.then((entry) => ({
    transport: entry.transport,
    bus: entry.bus,
    isPrimary,
  }));
};

/**
 * Release one Clock's reference to the shared transport. The transport is
 * only disposed (and the registry cleared) when the last reference goes away.
 */
export const releaseSharedTransport = (context: AudioContext): void => {
  const entry = sharedTransports.get(context);
  if (entry && !entry.disposed) {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0) {
      sharedTransports.delete(context);
      disposeEntry(entry);
    }
    return;
  }

  // Released before the worklet finished loading. Keep the counter in sync so
  // the pending entry is discarded instead of registered once it resolves.
  const pending = pendingLoads.get(context);
  if (pending) {
    pending.refs = Math.max(0, pending.refs - 1);
    if (pending.refs === 0) {
      pending.discarded = true;
    }
  }
};

/** Returns the live shared entry for a context, if one exists. */
export const getSharedTransportEntry = (
  context: AudioContext
): SharedTransportEntry | undefined => {
  const entry = sharedTransports.get(context);
  return entry && !entry.disposed ? entry : undefined;
};

/** Number of Clocks currently holding the shared transport. */
export const getSharedTransportRefCount = (context: AudioContext): number =>
  getSharedTransportEntry(context)?.refs ?? 0;

/** Snapshot of the state every Clock on this context shares. */
export const getSharedTransportState = (
  context: AudioContext
): SharedTransportState | undefined => {
  const entry = getSharedTransportEntry(context);
  if (!entry) {
    return undefined;
  }
  return {
    bpm: entry.transport.bpm,
    isRunning: entry.transport.isPlaying,
  };
};
