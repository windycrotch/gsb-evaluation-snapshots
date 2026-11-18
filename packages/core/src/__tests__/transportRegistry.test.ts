import {
  acquireSharedTransport,
  releaseSharedTransport,
  getSharedTransportEntry,
  getSharedTransportRefCount,
  getSharedTransportState,
} from '../transportRegistry';

const createContext = (): AudioContext => new (global as any).AudioContext();

describe('transportRegistry', () => {
  it('creates one shared transport per AudioContext', async () => {
    const context = createContext();

    const first = await acquireSharedTransport(context);
    const second = await acquireSharedTransport(context);

    expect(second.transport).toBe(first.transport);
    expect(second.bus).toBe(first.bus);
    expect(getSharedTransportRefCount(context)).toBe(2);

    releaseSharedTransport(context);
    releaseSharedTransport(context);
  });

  it('keeps separate transports for separate contexts', async () => {
    const contextA = createContext();
    const contextB = createContext();

    const entryA = await acquireSharedTransport(contextA);
    const entryB = await acquireSharedTransport(contextB);

    expect(entryA.transport).not.toBe(entryB.transport);

    releaseSharedTransport(contextA);
    releaseSharedTransport(contextB);
  });

  it('coalesces concurrent acquires into a single transport', async () => {
    const context = createContext();

    const [first, second] = await Promise.all([
      acquireSharedTransport(context),
      acquireSharedTransport(context),
    ]);

    expect(second.transport).toBe(first.transport);
    expect(first.isPrimary).toBe(true);
    expect(second.isPrimary).toBe(false);
    expect(getSharedTransportRefCount(context)).toBe(2);

    releaseSharedTransport(context);
    releaseSharedTransport(context);
  });

  it('does not dispose while references remain', async () => {
    const context = createContext();
    const first = await acquireSharedTransport(context);
    await acquireSharedTransport(context);

    const disposeSpy = jest.spyOn(first.transport, 'dispose');

    releaseSharedTransport(context);

    expect(disposeSpy).not.toHaveBeenCalled();
    expect(getSharedTransportEntry(context)?.transport).toBe(first.transport);
    expect(getSharedTransportRefCount(context)).toBe(1);

    releaseSharedTransport(context);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('disposes and clears the registry after the last release', async () => {
    const context = createContext();
    const entry = await acquireSharedTransport(context);
    const disposeSpy = jest.spyOn(entry.transport, 'dispose');
    const busDisposeSpy = jest.spyOn(entry.bus, 'dispose');

    releaseSharedTransport(context);

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(busDisposeSpy).toHaveBeenCalledTimes(1);
    expect(getSharedTransportEntry(context)).toBeUndefined();
    expect(getSharedTransportRefCount(context)).toBe(0);
    expect(getSharedTransportState(context)).toBeUndefined();
  });

  it('creates a fresh transport after the previous one was disposed', async () => {
    const context = createContext();
    const first = await acquireSharedTransport(context);
    releaseSharedTransport(context);

    const second = await acquireSharedTransport(context);

    expect(second.transport).not.toBe(first.transport);
    expect(getSharedTransportRefCount(context)).toBe(1);

    releaseSharedTransport(context);
  });

  it('ignores releases beyond the reference count', async () => {
    const context = createContext();
    const handle = await acquireSharedTransport(context);
    const entry = getSharedTransportEntry(context);

    releaseSharedTransport(context);
    expect(() => releaseSharedTransport(context)).not.toThrow();
    expect(() => releaseSharedTransport(context)).not.toThrow();
    expect(getSharedTransportEntry(context)).toBeUndefined();
    expect(entry?.disposed).toBe(true);
    // The handle stays usable for introspection but the transport is dead.
    expect(handle.transport.isPlaying).toBe(false);
  });

  it('discards a transport whose callers all released before load finished', async () => {
    const context = createContext();

    const pending = acquireSharedTransport(context);
    // Released while the worklet is still loading.
    releaseSharedTransport(context);

    const entry = await pending;
    expect(entry.transport).toBeDefined();
    expect(getSharedTransportEntry(context)).toBeUndefined();
    expect(getSharedTransportRefCount(context)).toBe(0);
  });

  it('exposes the shared tempo and running state', async () => {
    const context = createContext();
    (context as unknown as { currentTime: number }).currentTime = 0;
    const { transport } = await acquireSharedTransport(context);

    transport.start(0);
    transport.setTempo(150, 0);

    expect(getSharedTransportState(context)).toEqual({
      bpm: 150,
      isRunning: true,
    });

    releaseSharedTransport(context);
  });
});
