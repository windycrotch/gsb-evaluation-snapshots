import { act, waitFor } from '@testing-library/react';
import { render, createMockStreamRef } from './test-utils';
import { Clock, ClockHandle } from '../components/cv/Clock';
import {
  getSharedTransportEntry,
  getSharedTransportRefCount,
  getSharedTransportState,
} from '../transportRegistry';

type StreamRef = ReturnType<typeof createMockStreamRef>;

const getContext = (output: StreamRef): AudioContext =>
  output.current?.context as AudioContext;

const waitForSharedClock = async (outputs: StreamRef[]): Promise<void> => {
  await waitFor(() => {
    outputs.forEach((output) => {
      expect(output.current?.transport).toBeDefined();
    });
  });
};

const makeRef = () => ({ current: null as ClockHandle | null });

/**
 * All Clocks in a test must live under one AudioProvider so they really share
 * an AudioContext. Keys make partial unmounts explicit: without them React
 * would reuse a single Clock instance across a rerender.
 */
describe('Clock shared clock', () => {
  it('shares one transport between Clocks on the same AudioContext', async () => {
    const outputA = createMockStreamRef();
    const outputB = createMockStreamRef();
    const refA = makeRef();
    const refB = makeRef();

    const view = render(
      <>
        <Clock ref={refA} output={outputA} />
        <Clock ref={refB} output={outputB} />
      </>
    );

    await waitForSharedClock([outputA, outputB]);

    const context = getContext(outputA);
    expect(getContext(outputB)).toBe(context);
    expect(outputA.current.transport).toBe(outputB.current.transport);
    expect(getSharedTransportRefCount(context)).toBe(2);

    view.unmount();
    expect(getSharedTransportRefCount(context)).toBe(0);
  });

  it('disposes the shared clock only after the last Clock unmounts', async () => {
    const outputA = createMockStreamRef();
    const outputB = createMockStreamRef();

    const view = render(
      <>
        <Clock key="a" output={outputA} />
        <Clock key="b" output={outputB} />
      </>
    );
    await waitForSharedClock([outputA, outputB]);

    const context = getContext(outputA);
    const entry = getSharedTransportEntry(context);
    expect(entry).toBeDefined();
    const transportDispose = jest.spyOn(entry!.transport, 'dispose');
    const busDispose = jest.spyOn(entry!.bus, 'dispose');

    // Unmount the second Clock only.
    view.rerender(<Clock key="a" output={outputA} />);

    expect(transportDispose).not.toHaveBeenCalled();
    expect(busDispose).not.toHaveBeenCalled();
    expect(getSharedTransportEntry(context)?.transport).toBe(entry!.transport);
    expect(getSharedTransportRefCount(context)).toBe(1);

    view.unmount();

    expect(transportDispose).toHaveBeenCalledTimes(1);
    expect(busDispose).toHaveBeenCalledTimes(1);
    expect(getSharedTransportEntry(context)).toBeUndefined();
    expect(getSharedTransportRefCount(context)).toBe(0);
  });

  it('propagates start from one Clock to every mounted Clock', async () => {
    const outputA = createMockStreamRef();
    const outputB = createMockStreamRef();
    const refA = makeRef();
    const refB = makeRef();

    render(
      <>
        <Clock ref={refA} output={outputA} />
        <Clock ref={refB} output={outputB} />
      </>
    );

    await waitForSharedClock([outputA, outputB]);

    expect(refA.current?.getState().isRunning).toBe(false);
    expect(refB.current?.getState().isRunning).toBe(false);

    act(() => {
      refA.current?.start();
    });

    await waitFor(() => {
      expect(refA.current?.getState().isRunning).toBe(true);
      expect(refB.current?.getState().isRunning).toBe(true);
    });
    expect(getSharedTransportState(getContext(outputA))?.isRunning).toBe(true);
  });

  it('propagates stop from one Clock to every mounted Clock', async () => {
    const outputA = createMockStreamRef();
    const outputB = createMockStreamRef();
    const refA = makeRef();
    const refB = makeRef();

    render(
      <>
        <Clock ref={refA} output={outputA} />
        <Clock ref={refB} output={outputB} />
      </>
    );

    await waitForSharedClock([outputA, outputB]);

    act(() => {
      refA.current?.start();
    });
    await waitFor(() => {
      expect(refB.current?.getState().isRunning).toBe(true);
    });

    act(() => {
      refB.current?.stop();
    });

    await waitFor(() => {
      expect(refA.current?.getState().isRunning).toBe(false);
      expect(refB.current?.getState().isRunning).toBe(false);
    });
    expect(getSharedTransportState(getContext(outputA))?.isRunning).toBe(false);
  });

  it('lets a sibling restart the shared clock after someone stopped it', async () => {
    const outputA = createMockStreamRef();
    const outputB = createMockStreamRef();
    const refA = makeRef();
    const refB = makeRef();

    render(
      <>
        <Clock ref={refA} output={outputA} />
        <Clock ref={refB} output={outputB} />
      </>
    );

    await waitForSharedClock([outputA, outputB]);

    act(() => {
      refA.current?.start();
      refB.current?.start();
    });

    await waitFor(() => {
      expect(refA.current?.getState().isRunning).toBe(true);
      expect(refB.current?.getState().isRunning).toBe(true);
    });

    // Stopping A stops the shared clock; a later start from B must still
    // reach the shared clock even though B previously observed it running.
    act(() => {
      refA.current?.stop();
    });
    await waitFor(() => {
      expect(refB.current?.getState().isRunning).toBe(false);
    });

    act(() => {
      refB.current?.start();
    });
    await waitFor(() => {
      expect(refA.current?.getState().isRunning).toBe(true);
      expect(refB.current?.getState().isRunning).toBe(true);
    });
  });

  it('uses the bpm from the last Clock that set it', async () => {
    const outputA = createMockStreamRef();
    const outputB = createMockStreamRef();
    const refA = makeRef();
    const refB = makeRef();

    const { getByRole, getByText } = render(
      <>
        <Clock ref={refA} output={outputA}>
          {({ bpm, setBpm }) => (
            <div>
              <span>A BPM: {bpm}</span>
              <button onClick={() => setBpm(140)}>Set A</button>
            </div>
          )}
        </Clock>
        <Clock ref={refB} output={outputB}>
          {({ bpm, setBpm }) => (
            <div>
              <span>B BPM: {bpm}</span>
              <button onClick={() => setBpm(90)}>Set B</button>
            </div>
          )}
        </Clock>
      </>
    );

    await waitForSharedClock([outputA, outputB]);

    act(() => {
      getByRole('button', { name: /set a/i }).click();
    });
    await waitFor(() => {
      expect(getSharedTransportState(getContext(outputA))?.bpm).toBe(140);
    });

    act(() => {
      getByRole('button', { name: /set b/i }).click();
    });

    // The last writer wins for the shared clock and every Clock reads it back.
    await waitFor(() => {
      expect(getSharedTransportState(getContext(outputA))?.bpm).toBe(90);
      expect(getByText('A BPM: 90')).toBeInTheDocument();
      expect(getByText('B BPM: 90')).toBeInTheDocument();
    });
    expect(refA.current?.getState().bpm).toBe(90);
    expect(refB.current?.getState().bpm).toBe(90);
  });

  it('a late-mounting Clock joins the running shared clock', async () => {
    const outputA = createMockStreamRef();
    const outputB = createMockStreamRef();
    const refA = makeRef();
    const refB = makeRef();

    const view = render(<Clock key="a" ref={refA} output={outputA} />);
    await waitForSharedClock([outputA]);

    act(() => {
      refA.current?.start();
    });
    await waitFor(() => {
      expect(refA.current?.getState().isRunning).toBe(true);
    });

    view.rerender(
      <>
        <Clock key="a" ref={refA} output={outputA} />
        <Clock key="b" ref={refB} output={outputB} />
      </>
    );
    await waitForSharedClock([outputB]);

    // The newcomer sees the shared clock already running and does not restart it.
    await waitFor(() => {
      expect(refB.current?.getState().isRunning).toBe(true);
    });
    expect(getSharedTransportRefCount(getContext(outputA))).toBe(2);
  });

  it('does not reset the shared bpm when a Clock re-renders', async () => {
    const outputA = createMockStreamRef();
    const outputB = createMockStreamRef();

    const renderTree = () => (
      <>
        <Clock output={outputA}>
          {({ setBpm }) => <button onClick={() => setBpm(180)}>Set 180</button>}
        </Clock>
        <Clock output={outputB} bpm={180} />
      </>
    );

    const view = render(renderTree());
    await waitForSharedClock([outputA, outputB]);

    act(() => {
      view.getByRole('button', { name: /set 180/i }).click();
    });
    await waitFor(() => {
      expect(getSharedTransportState(getContext(outputA))?.bpm).toBe(180);
    });

    // A re-render (without touching bpm) must not restore the default tempo.
    view.rerender(renderTree());

    expect(getSharedTransportState(getContext(outputA))?.bpm).toBe(180);
  });

  it('keeps the beat continuous when the bpm changes while running', async () => {
    const output = createMockStreamRef();
    const ref = makeRef();

    const { getByRole } = render(
      <Clock ref={ref} output={output}>
        {({ setBpm }) => <button onClick={() => setBpm(60)}>Half Time</button>}
      </Clock>
    );

    await waitForSharedClock([output]);

    const context = getContext(output);
    const transport = getSharedTransportEntry(context)!.transport;

    act(() => {
      ref.current?.start();
    });
    await waitFor(() => {
      expect(transport.isPlaying).toBe(true);
    });

    // Advance the audio clock: at 120 BPM two seconds land on beat 4.
    (context as unknown as { currentTime: number }).currentTime = 2;
    const beforeChange = transport.getBeatAtTime(2);
    expect(beforeChange).toBeCloseTo(4, 10);

    act(() => {
      getByRole('button', { name: /half time/i }).click();
    });

    await waitFor(() => {
      expect(transport.bpm).toBe(60);
    });

    // No jump: the beat at the moment of the change is unchanged...
    expect(transport.getBeatAtTime(2)).toBeCloseTo(beforeChange, 10);
    // ...the new tempo applies only after the change point...
    expect(transport.getBeatAtTime(3) - transport.getBeatAtTime(2)).toBeCloseTo(1, 10);
    // ...and the old tempo was still in effect before it (0.5s at 120 BPM).
    expect(transport.getBeatAtTime(1.5) - transport.getBeatAtTime(1)).toBeCloseTo(1, 10);
  });

  it('stops delivering shared clock events to an unmounted Clock', async () => {
    const outputA = createMockStreamRef();
    const outputB = createMockStreamRef();
    const refB = makeRef();
    const onRunningChangeA = jest.fn();

    const view = render(
      <>
        <Clock
          key="a"
          ref={makeRef()}
          output={outputA}
          onRunningChange={onRunningChangeA}
        />
        <Clock key="b" ref={refB} output={outputB} />
      </>
    );
    await waitForSharedClock([outputA, outputB]);

    const context = getContext(outputA);
    const bus = getSharedTransportEntry(context)!.bus;
    const offSpy = jest.spyOn(bus, 'off');

    // Unmount only the observing Clock; the sibling keeps the bus alive.
    view.rerender(
      <>
        <Clock key="b" ref={refB} output={outputB} />
      </>
    );

    expect(offSpy).toHaveBeenCalledWith('state', expect.any(Function));
    expect(getSharedTransportRefCount(context)).toBe(1);
    onRunningChangeA.mockClear();

    act(() => {
      refB.current?.start();
    });
    await waitFor(() => {
      expect(refB.current?.getState().isRunning).toBe(true);
    });

    // The unmounted Clock neither reacts nor reports running changes, and the
    // still-mounted sibling is unaffected by its departure.
    expect(onRunningChangeA).not.toHaveBeenCalled();
    expect(getSharedTransportState(context)?.isRunning).toBe(true);
    expect(getSharedTransportRefCount(context)).toBe(1);
  });

  it('keeps handles from an unmounted Clock safe to call', async () => {
    const outputA = createMockStreamRef();
    const outputB = createMockStreamRef();
    const refA = makeRef();
    const refB = makeRef();

    const view = render(
      <>
        <Clock ref={refA} output={outputA} />
        <Clock ref={refB} output={outputB} />
      </>
    );

    await waitForSharedClock([outputA, outputB]);
    const context = getContext(outputA);
    const staleHandle = refA.current!;

    view.rerender(<Clock ref={refB} output={outputB} />);

    expect(() => {
      act(() => {
        staleHandle.start();
        staleHandle.stop();
      });
    }).not.toThrow();
    expect(getSharedTransportEntry(context)).toBeDefined();

    view.unmount();
    expect(getSharedTransportEntry(context)).toBeUndefined();

    // After the last unmount releases the transport, stale calls still must
    // not throw (released transport/node are simply gone).
    expect(() => {
      act(() => {
        staleHandle.start();
        staleHandle.stop();
        staleHandle.reset();
        staleHandle.getState();
      });
    }).not.toThrow();
  });

  it('treats repeated stop calls as a no-op', async () => {
    const output = createMockStreamRef();
    const ref = makeRef();

    render(<Clock ref={ref} output={output} />);
    await waitForSharedClock([output]);

    const context = getContext(output);
    const bus = getSharedTransportEntry(context)!.bus;
    const transport = getSharedTransportEntry(context)!.transport;
    const stopSpy = jest.spyOn(transport, 'stop');
    const stateListener = jest.fn();
    const unsubscribe = bus.on('state', stateListener);

    act(() => {
      ref.current?.start();
    });
    await waitFor(() => {
      expect(transport.isPlaying).toBe(true);
    });

    stateListener.mockClear();

    act(() => {
      ref.current?.stop();
      ref.current?.stop();
      ref.current?.reset();
    });

    // Only the first stop reaches the shared clock.
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(transport.isPlaying).toBe(false);
    expect(stateListener).toHaveBeenCalledTimes(1);
    expect(ref.current?.getState().isRunning).toBe(false);

    unsubscribe();
  });

  it('releases cleanly when every Clock unmounts while running', async () => {
    const outputA = createMockStreamRef();
    const outputB = createMockStreamRef();
    const refA = makeRef();
    const refB = makeRef();

    const view = render(
      <>
        <Clock ref={refA} output={outputA} />
        <Clock ref={refB} output={outputB} />
      </>
    );

    await waitForSharedClock([outputA, outputB]);

    const context = getContext(outputA);
    act(() => {
      refA.current?.start();
    });
    await waitFor(() => {
      expect(refB.current?.getState().isRunning).toBe(true);
    });

    expect(() => view.unmount()).not.toThrow();
    expect(getSharedTransportEntry(context)).toBeUndefined();
  });
});
