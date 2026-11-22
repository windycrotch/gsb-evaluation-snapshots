import {
  acquireSharedTransport,
  getSharedTransportRefCount,
  releaseSharedTransport,
} from '../transportRegistry';
import { TransportBus } from '../transportBus';
import { WorkletTransport } from '../transportWorklet';

type AnyNode = {
  port: {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage: jest.Mock;
  };
  connect: jest.Mock;
  disconnect: jest.Mock;
};

const createdNodes: AnyNode[] = [];

class CountingWorkletNode {
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: jest.fn(),
  };
  connect = jest.fn();
  disconnect = jest.fn();

  constructor(_context: AudioContext, _name: string, _options?: AudioWorkletNodeOptions) {
    createdNodes.push(this as unknown as AnyNode);
  }
}

const createMockContext = (addModule: jest.Mock = jest.fn(() => Promise.resolve())) => {
  const createGain = jest.fn(() => ({
    connect: jest.fn(),
    disconnect: jest.fn(),
    gain: { value: 0 },
  }));
  return {
    currentTime: 0,
    destination: {},
    createGain,
    audioWorklet: { addModule },
  } as unknown as AudioContext;
};

const emitTick = (node: AnyNode, beat = 1) => {
  expect(node.port.onmessage).not.toBeNull();
  node.port.onmessage!({
    data: { type: 'tick', time: 0.5, beat, bpm: 120, running: true },
  });
};

const originalAudioWorkletNode = (global as any).AudioWorkletNode;

describe('transportRegistry', () => {
  beforeEach(() => {
    createdNodes.length = 0;
    (global as any).AudioWorkletNode = CountingWorkletNode;
  });

  afterEach(() => {
    (global as any).AudioWorkletNode = originalAudioWorkletNode;
  });

  describe('concurrent acquisition', () => {
    it('creates a single worklet instance and shares it between concurrent callers', async () => {
      const context = createMockContext();

      const [first, second, third] = await Promise.all([
        acquireSharedTransport(context),
        acquireSharedTransport(context),
        acquireSharedTransport(context),
      ]);

      expect(createdNodes).toHaveLength(1);
      expect(context.audioWorklet.addModule).toHaveBeenCalledTimes(1);
      expect(first.transport).toBe(second.transport);
      expect(second.transport).toBe(third.transport);
      expect(first.bus).toBe(second.bus);
      expect(second.bus).toBe(third.bus);
      expect(getSharedTransportRefCount(context)).toBe(3);

      first.release();
      second.release();
      third.release();
      expect(getSharedTransportRefCount(context)).toBe(0);
    });

    it('returns the same instance to callers that acquire after the load resolved', async () => {
      const context = createMockContext();

      const first = await acquireSharedTransport(context);
      const second = await acquireSharedTransport(context);

      expect(second.transport).toBe(first.transport);
      expect(createdNodes).toHaveLength(1);
      expect(getSharedTransportRefCount(context)).toBe(2);

      first.release();
      expect(getSharedTransportRefCount(context)).toBe(1);
      expect(first.transport.isDisposed).toBe(false);

      second.release();
    });

    it('keeps separate instances per AudioContext', async () => {
      const contextA = createMockContext();
      const contextB = createMockContext();

      const a = await acquireSharedTransport(contextA);
      const b = await acquireSharedTransport(contextB);

      expect(a.transport).not.toBe(b.transport);
      expect(createdNodes).toHaveLength(2);

      a.release();
      b.release();
    });
  });

  describe('load failures', () => {
    it('does not cache a failed load and retries successfully', async () => {
      const addModule = jest
        .fn()
        .mockRejectedValueOnce(new Error('worklet load failed'))
        .mockResolvedValue(undefined);
      const context = createMockContext(addModule);

      await expect(acquireSharedTransport(context)).rejects.toThrow('worklet load failed');

      expect(getSharedTransportRefCount(context)).toBe(0);
      expect(createdNodes).toHaveLength(0);

      const lease = await acquireSharedTransport(context);

      expect(lease.transport).toBeDefined();
      expect(lease.bus).toBeInstanceOf(TransportBus);
      expect(createdNodes).toHaveLength(1);
      expect(addModule).toHaveBeenCalledTimes(2);
      expect(getSharedTransportRefCount(context)).toBe(1);

      lease.release();
    });

    it('surfaces the failure to every concurrent caller and allows a later retry', async () => {
      const addModule = jest
        .fn()
        .mockRejectedValueOnce(new Error('worklet load failed'))
        .mockResolvedValue(undefined);
      const context = createMockContext(addModule);

      const results = await Promise.allSettled([
        acquireSharedTransport(context),
        acquireSharedTransport(context),
      ]);

      expect(results.every((result) => result.status === 'rejected')).toBe(true);
      expect(getSharedTransportRefCount(context)).toBe(0);

      const lease = await acquireSharedTransport(context);
      expect(lease.transport).toBeDefined();
      expect(createdNodes).toHaveLength(1);

      lease.release();
    });

    it('retries through the worklet loader instead of caching the rejection', async () => {
      const addModule = jest
        .fn()
        .mockRejectedValueOnce(new Error('worklet load failed'))
        .mockResolvedValue(undefined);
      const context = createMockContext(addModule);

      await expect(WorkletTransport.create(context)).rejects.toThrow('worklet load failed');

      const transport = await WorkletTransport.create(context);
      expect(transport.getNode()).not.toBeNull();
      transport.dispose();
    });
  });

  describe('release to zero and rebuild', () => {
    it('disposes only when the last reference is released', async () => {
      const context = createMockContext();

      const first = await acquireSharedTransport(context);
      const second = await acquireSharedTransport(context);

      first.release();
      expect(getSharedTransportRefCount(context)).toBe(1);
      expect(second.transport.isDisposed).toBe(false);
      expect(second.transport.getNode()).not.toBeNull();

      second.release();
      expect(getSharedTransportRefCount(context)).toBe(0);
      expect(second.transport.isDisposed).toBe(true);
      expect(second.bus.isDisposed).toBe(true);
    });

    it('rebuilds a fresh usable instance after the shared one was disposed', async () => {
      const context = createMockContext();

      const first = await acquireSharedTransport(context);
      const firstTransport = first.transport;
      const firstBus = first.bus;
      const firstNode = createdNodes[0];

      first.release();

      expect(firstTransport.isDisposed).toBe(true);
      expect(firstBus.isDisposed).toBe(true);
      expect(firstNode.disconnect).toHaveBeenCalled();
      expect(firstNode.port.onmessage).toBeNull();

      const second = await acquireSharedTransport(context);

      expect(second.transport).not.toBe(firstTransport);
      expect(second.bus).not.toBe(firstBus);
      expect(second.transport.isDisposed).toBe(false);
      expect(createdNodes).toHaveLength(2);
      expect(second.transport.getNode()).toBe(createdNodes[1] as unknown as AudioWorkletNode);

      second.release();
    });

    it('does not let a disposed instance leak ticks into the rebuilt instance', async () => {
      const context = createMockContext();

      const first = await acquireSharedTransport(context);
      const staleTick = jest.fn();
      first.bus.on('tick', staleTick);
      const firstNode = createdNodes[0];
      first.release();

      // A stale tick arriving late must not reach anyone.
      expect(firstNode.port.onmessage).toBeNull();
      firstBusTickIsSilent(first);

      const second = await acquireSharedTransport(context);
      const freshTick = jest.fn();
      second.bus.on('tick', freshTick);

      emitTick(createdNodes[1], 7);

      expect(freshTick).toHaveBeenCalledTimes(1);
      expect(freshTick).toHaveBeenCalledWith(
        expect.objectContaining({ beat: 7, bpm: 120, running: true })
      );
      expect(staleTick).not.toHaveBeenCalled();

      second.release();
    });

    it('does not let a disposed transport forward start/stop/tempo/seek to old listeners', async () => {
      const context = createMockContext();

      const first = await acquireSharedTransport(context);
      const onStart = jest.fn();
      const onStop = jest.fn();
      const onTempo = jest.fn();
      const onSeek = jest.fn();
      first.bus.on('start', onStart);
      first.bus.on('stop', onStop);
      first.bus.on('tempo', onTempo);
      first.bus.on('seek', onSeek);

      first.release();

      // The (now disposed) transport must not notify the cleared listeners.
      first.transport.start();
      first.transport.stop();
      first.transport.setTempo(150);
      first.transport.seek(4);

      expect(onStart).not.toHaveBeenCalled();
      expect(onStop).not.toHaveBeenCalled();
      expect(onTempo).not.toHaveBeenCalled();
      expect(onSeek).not.toHaveBeenCalled();
    });

    it('allows a rebuilt instance to forward events to new subscribers', async () => {
      const context = createMockContext();

      const first = await acquireSharedTransport(context);
      first.release();

      const second = await acquireSharedTransport(context);
      const onStart = jest.fn();
      const onTick = jest.fn();
      second.bus.on('start', onStart);
      second.bus.on('tick', onTick);

      second.transport.start();
      emitTick(createdNodes[1], 3);

      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onTick).toHaveBeenCalledTimes(1);

      second.release();
    });
  });

  describe('reference bookkeeping', () => {
    it('treats release as idempotent per lease', async () => {
      const context = createMockContext();

      const first = await acquireSharedTransport(context);
      const second = await acquireSharedTransport(context);

      first.release();
      first.release();
      first.release();

      expect(getSharedTransportRefCount(context)).toBe(1);
      expect(second.transport.isDisposed).toBe(false);

      second.release();
      expect(getSharedTransportRefCount(context)).toBe(0);
    });

    it('never drops the reference count below zero on extra releases', async () => {
      const context = createMockContext();

      const lease = await acquireSharedTransport(context);
      lease.release();
      lease.release();

      expect(getSharedTransportRefCount(context)).toBe(0);

      // A stray context-level release must not throw or resurrect the instance.
      expect(() => releaseSharedTransport(context)).not.toThrow();
      expect(getSharedTransportRefCount(context)).toBe(0);
    });

    it('keeps the instance alive for an acquisition that is still loading', async () => {
      const context = createMockContext();

      const first = await acquireSharedTransport(context);

      // A second caller starts acquiring while the first is still held.
      const pendingSecond = acquireSharedTransport(context);
      first.release();

      // Releasing the first reference must not tear down the instance that the
      // pending acquisition is about to receive.
      expect(getSharedTransportRefCount(context)).toBe(0);
      expect(first.transport.isDisposed).toBe(false);

      const second = await pendingSecond;

      expect(second.transport).toBe(first.transport);
      expect(second.transport.isDisposed).toBe(false);
      expect(getSharedTransportRefCount(context)).toBe(1);

      second.release();
      expect(second.transport.isDisposed).toBe(true);
    });

    it('ignores a late release from a previous generation after a rebuild', async () => {
      const context = createMockContext();

      const first = await acquireSharedTransport(context);
      first.release();

      const second = await acquireSharedTransport(context);
      expect(second.transport).not.toBe(first.transport);

      // A stale call cannot take the rebuilt instance down.
      first.release();
      releaseSharedTransport(context, first as any);

      expect(getSharedTransportRefCount(context)).toBe(1);
      expect(second.transport.isDisposed).toBe(false);
      expect(second.bus.isDisposed).toBe(false);

      second.release();
      expect(getSharedTransportRefCount(context)).toBe(0);
      expect(second.transport.isDisposed).toBe(true);
    });

    it('releases an acquisition that was handed back before it resolved', async () => {
      const context = createMockContext();

      const pending = acquireSharedTransport(context);
      // Simulate unmount-before-ready: the caller releases without a lease.
      releaseSharedTransport(context);

      const lease = await pending;

      expect(getSharedTransportRefCount(context)).toBe(0);
      expect(lease.transport.isDisposed).toBe(true);
      expect(createdNodes).toHaveLength(1);
      expect(createdNodes[0].disconnect).toHaveBeenCalled();

      // Releasing the resolved (already dropped) lease is a no-op.
      lease.release();
      expect(getSharedTransportRefCount(context)).toBe(0);
    });
  });
});

const firstBusTickIsSilent = (lease: { bus: TransportBus }) => {
  const listener = jest.fn();
  const unsubscribe = lease.bus.on('tick', listener);
  lease.bus.emitTick();
  unsubscribe();
  expect(listener).not.toHaveBeenCalled();
};
