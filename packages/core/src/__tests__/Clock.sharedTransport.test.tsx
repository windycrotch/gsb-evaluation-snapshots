import { act, render, waitFor } from '@testing-library/react';
import { Clock } from '../components/cv/Clock';
import { getSharedTransportRefCount } from '../transportRegistry';

type AnyNode = {
  port: {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage: jest.Mock;
  };
  connect: jest.Mock;
  disconnect: jest.Mock;
};

let currentContext: AudioContext | null = null;

jest.mock('../context/AudioContext', () => ({
  useAudioContext: () => currentContext,
}));

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

const createMockContext = (addModule: jest.Mock = jest.fn(() => Promise.resolve())) =>
  ({
    currentTime: 0,
    destination: {},
    createGain: jest.fn(() => ({
      connect: jest.fn(),
      disconnect: jest.fn(),
      gain: { value: 0 },
    })),
    audioWorklet: { addModule },
  } as unknown as AudioContext);

const createStreamRef = () => ({ current: null as any });

const originalAudioWorkletNode = (global as any).AudioWorkletNode;

describe('Clock with the shared transport registry', () => {
  beforeEach(() => {
    createdNodes.length = 0;
    (global as any).AudioWorkletNode = CountingWorkletNode;
    currentContext = createMockContext();
  });

  afterEach(() => {
    (global as any).AudioWorkletNode = originalAudioWorkletNode;
    currentContext = null;
  });

  it('shares one worklet instance across simultaneously mounted clocks', async () => {
    const first = createStreamRef();
    const second = createStreamRef();

    const { unmount } = render(
      <>
        <Clock output={first} />
        <Clock output={second} />
      </>
    );

    await waitFor(() => {
      expect(first.current?.transport).toBeDefined();
      expect(second.current?.transport).toBeDefined();
    });

    expect(createdNodes).toHaveLength(1);
    expect(first.current.transport).toBe(second.current.transport);
    expect(getSharedTransportRefCount(currentContext!)).toBe(2);

    unmount();

    expect(getSharedTransportRefCount(currentContext!)).toBe(0);
    expect(createdNodes[0].disconnect).toHaveBeenCalled();
    expect(createdNodes[0].port.onmessage).toBeNull();
  });

  it('keeps the shared instance alive while another clock still uses it', async () => {
    const first = createStreamRef();
    const second = createStreamRef();

    const firstRender = render(<Clock output={first} />);
    const secondRender = render(<Clock output={second} />);

    await waitFor(() => {
      expect(first.current?.transport).toBeDefined();
      expect(second.current?.transport).toBeDefined();
    });

    expect(createdNodes).toHaveLength(1);

    firstRender.unmount();

    expect(getSharedTransportRefCount(currentContext!)).toBe(1);
    // The shared worklet node is untouched: only the unmounted clock's edges
    // were removed, and ticks still flow to the surviving clock.
    expect(createdNodes[0].port.onmessage).not.toBeNull();

    // The surviving clock still drives the shared transport.
    const tick = jest.fn();
    second.current.transport.on('tick', tick);
    await act(async () => {
      createdNodes[0].port.onmessage!({
        data: { type: 'tick', time: 1, beat: 2, bpm: 120, running: true },
      });
    });
    expect(tick).toHaveBeenCalledTimes(1);

    secondRender.unmount();
    expect(getSharedTransportRefCount(currentContext!)).toBe(0);
    expect(createdNodes[0].disconnect).toHaveBeenCalled();
  });

  it('releases a mount that unmounts before the worklet finished loading', async () => {
    let resolveModule: () => void = () => {};
    const addModule = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveModule = resolve;
        })
    );
    currentContext = createMockContext(addModule);

    const output = createStreamRef();
    const { unmount } = render(<Clock output={output} />);

    // Unmount while the shared transport is still loading.
    unmount();

    await act(async () => {
      resolveModule();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getSharedTransportRefCount(currentContext)).toBe(0);
    expect(createdNodes).toHaveLength(1);
    expect(createdNodes[0].disconnect).toHaveBeenCalled();
    expect(createdNodes[0].port.onmessage).toBeNull();

    // A later mount gets a freshly built, usable instance.
    const remountedOutput = createStreamRef();
    const remount = render(<Clock output={remountedOutput} />);

    await waitFor(() => {
      expect(remountedOutput.current?.transport).toBeDefined();
    });

    expect(createdNodes).toHaveLength(2);
    expect(getSharedTransportRefCount(currentContext)).toBe(1);

    remount.unmount();
    expect(getSharedTransportRefCount(currentContext)).toBe(0);
  });
});
