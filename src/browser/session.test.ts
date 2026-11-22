import { afterEach, it, expect, vi } from 'vitest';
import { AudioSession } from './session.js';
import { AudioBuffer } from '../core/buffer.js';

const contexts: FakeContext[] = [];
const flush = async (times = 5) => {
  for (let i = 0; i < times; i++) await Promise.resolve();
};

class FakeNode {
  gain = { value: 0 };
  fftSize = 0;
  buffer: unknown;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  stop = vi.fn();
  start = vi.fn();
  getFloatTimeDomainData = (out: Float32Array) => out.fill(0.25);
  getFloatFrequencyData = (out: Float32Array) => out.fill(-20);
}
class FakeContext {
  sampleRate = 48000;
  destination = {};
  nodes: FakeNode[] = [];
  resume = vi.fn(async () => {});
  suspend = vi.fn(async () => {});
  close = vi.fn(async () => {});
  constructor() {
    contexts.push(this);
  }
  node() {
    const node = new FakeNode();
    this.nodes.push(node);
    return node;
  }
  createAnalyser = () => this.node();
  createGain = () => this.node();
  createBufferSource = () => this.node();
  createMediaStreamSource = () => this.node();
  createBuffer = () => ({ copyToChannel: vi.fn() });
}
function setup() {
  contexts.length = 0;
  vi.stubGlobal('AudioContext', FakeContext);
  return new AudioSession({ fftSize: 64 });
}
const clip = () => new AudioBuffer(8000, 1, 8);
const gainNode = () => contexts[0]!.nodes[1]!;
const makeStream = (tracks: Array<{ stop: ReturnType<typeof vi.fn> }> = []) => ({
  getTracks: () => tracks,
});
const stubMedia = (getUserMedia: unknown) =>
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
afterEach(() => vi.unstubAllGlobals());
it('creates audio resources only when playback begins and cleans them exactly once', async () => {
  const session = setup();
  expect(contexts).toHaveLength(0);
  await session.play(new AudioBuffer(8000, 1, 8));
  expect(session.state).toBe('playing');
  const source = contexts[0]!.nodes[2]!;
  session.stop();
  session.stop();
  expect(source.stop).toHaveBeenCalledTimes(1);
  expect(source.disconnect).toHaveBeenCalledTimes(1);
  await session.close();
  await session.close();
  expect(contexts[0]!.close).toHaveBeenCalledTimes(1);
  expect(session.state).toBe('closed');
  await expect(session.play(new AudioBuffer(8000, 1, 8))).rejects.toThrow('closed');
});
it('pauses and resumes without constructing a second source', async () => {
  const session = setup();
  await session.play(new AudioBuffer(8000, 1, 8));
  await session.pause();
  expect(session.state).toBe('paused');
  await session.resume();
  expect(session.state).toBe('playing');
  expect(contexts[0]!.nodes).toHaveLength(3);
  expect(contexts[0]!.suspend).toHaveBeenCalledTimes(1);
  session.stop();
  await session.resume();
  expect(session.state).toBe('idle');
  await session.close();
});
it('mutes microphone monitoring and releases every track on stop', async () => {
  const session = setup();
  const stop = vi.fn();
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }, { stop }] })) },
  });
  await session.microphone();
  expect(session.state).toBe('microphone');
  expect(contexts[0]!.nodes[1]!.gain.value).toBe(0);
  session.stop();
  expect(stop).toHaveBeenCalledTimes(2);
  expect(session.state).toBe('idle');
  await session.close();
});
it('provides independent live buffers and keeps microphone gain muted after volume changes', async () => {
  const session = setup();
  expect(session.readSpectrum().every((v) => v === -Infinity)).toBe(true);
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
  });
  await session.microphone();
  session.setVolume(0.8);
  expect(contexts[0]!.nodes[1]!.gain.value).toBe(0);
  expect(session.readTimeDomain()).toEqual(new Float32Array(64).fill(0.25));
  expect(session.readSpectrum()).toEqual(new Float32Array(32).fill(-20));
  await session.play(new AudioBuffer(8000, 1, 8));
  expect(contexts[0]!.nodes[1]!.gain.value).toBe(0.8);
  await session.close();
});
it('stops late microphone grants after cancellation without connecting a source', async () => {
  const session = setup();
  let grant!: (stream: unknown) => void;
  const stop = vi.fn();
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    },
  });
  const pending = session.microphone();
  await Promise.resolve();
  session.stop();
  grant({ getTracks: () => [{ stop }] });
  await pending;
  expect(stop).toHaveBeenCalledTimes(1);
  expect(contexts[0]!.nodes).toHaveLength(2);
  expect(session.state).toBe('idle');
  await session.close();
});
it('does not create a source when close interrupts an outstanding context resume', async () => {
  const session = setup();
  await session.play(clip());
  session.stop();
  let finish!: () => void;
  contexts[0]!.resume.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = session.play(clip());
  await session.close();
  finish();
  await pending;
  expect(contexts[0]!.nodes).toHaveLength(3);
  expect(session.state).toBe('closed');
});

it('a second play during an outstanding resume never connects the stale source', async () => {
  const session = setup();
  // Every resume blocks until released, so both plays sit on the same gate.
  let finishFirst!: () => void;
  let finishSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const secondGate = new Promise<void>((resolve) => {
    finishSecond = resolve;
  });
  vi.stubGlobal(
    'AudioContext',
    class extends FakeContext {
      constructor() {
        super();
        this.resume
          .mockImplementationOnce(() => firstGate)
          .mockImplementationOnce(() => secondGate);
      }
    },
  );
  const first = session.play(clip());
  await flush();
  // The second play invalidates the first before either resume settles.
  const second = session.play(clip());
  await flush();
  finishFirst();
  await first;
  expect(session.state).toBe('idle');
  finishSecond();
  await second;
  expect(session.state).toBe('playing');
  // analyser + gain + only the second play's buffer source.
  expect(contexts[0]!.nodes).toHaveLength(3);
  const source = contexts[0]!.nodes[2]!;
  expect(source.start).toHaveBeenCalledTimes(1);
  expect(source.disconnect).not.toHaveBeenCalled();
  await session.close();
});

it('switching to the microphone stops the playback source and mutes monitoring', async () => {
  const session = setup();
  const trackStop = vi.fn();
  stubMedia(async () => makeStream([{ stop: trackStop }]));
  await session.play(clip());
  const playSource = contexts[0]!.nodes[2]!;
  await session.microphone();
  expect(playSource.stop).toHaveBeenCalledTimes(1);
  expect(playSource.disconnect).toHaveBeenCalledTimes(1);
  expect(session.state).toBe('microphone');
  expect(gainNode().gain.value).toBe(0);
  // Volume changes while capturing cannot raise the monitor gain.
  session.setVolume(0.9);
  expect(gainNode().gain.value).toBe(0);
  // Switching back restores the user's gain for playback.
  await session.play(clip());
  expect(gainNode().gain.value).toBe(0.9);
  expect(trackStop).toHaveBeenCalledTimes(1);
  await session.close();
});

it('a microphone request that loses to a new play releases tracks without connecting', async () => {
  const session = setup();
  let grant!: (stream: unknown) => void;
  const trackStop = vi.fn();
  stubMedia(() => new Promise((resolve) => (grant = resolve)));
  const mic = session.microphone();
  await flush();
  await session.play(clip());
  grant(makeStream([{ stop: trackStop }]));
  await mic;
  expect(trackStop).toHaveBeenCalledTimes(1);
  // analyser + gain + one buffer source; no media stream source was added.
  expect(contexts[0]!.nodes).toHaveLength(3);
  expect(session.state).toBe('playing');
  expect(gainNode().gain.value).not.toBe(0);
  await session.close();
});

it('a microphone request that loses to close releases the late stream and stays closed', async () => {
  const session = setup();
  let grant!: (stream: unknown) => void;
  const trackStop = vi.fn();
  stubMedia(() => new Promise((resolve) => (grant = resolve)));
  const mic = session.microphone();
  await flush();
  await session.close();
  grant(makeStream([{ stop: trackStop }]));
  await mic;
  expect(trackStop).toHaveBeenCalledTimes(1);
  expect(session.state).toBe('closed');
  await expect(session.microphone()).rejects.toThrow('closed');
  await expect(session.play(clip())).rejects.toThrow('closed');
});

it('rejected microphone permission leaves no nodes or tracks and returns to idle', async () => {
  const session = setup();
  const trackStop = vi.fn();
  stubMedia(async () => {
    throw new DOMException('permission denied', 'NotAllowedError');
  });
  await expect(session.microphone()).rejects.toThrow('permission denied');
  expect(session.state).toBe('idle');
  // Only analyser + gain exist; no half-connected source remains.
  expect(contexts[0]!.nodes).toHaveLength(2);
  expect(trackStop).not.toHaveBeenCalled();
  // The session remains usable for another attempt.
  stubMedia(async () => makeStream([{ stop: trackStop }]));
  await session.microphone();
  expect(session.state).toBe('microphone');
  expect(gainNode().gain.value).toBe(0);
  await session.close();
});

it('a stream whose tracks fail after grant is fully unwound back to idle', async () => {
  const session = setup();
  const trackStop = vi.fn();
  // Create the lazily-opened context first, then sabotage source creation.
  await session.play(clip());
  session.stop();
  stubMedia(async () => makeStream([{ stop: trackStop }]));
  contexts[0]!.createMediaStreamSource = vi.fn(() => {
    throw new Error('graph failure');
  });
  const nodeCountAfterFailure = contexts[0]!.nodes.length;
  await expect(session.microphone()).rejects.toThrow('graph failure');
  expect(trackStop).toHaveBeenCalledTimes(1);
  expect(session.state).toBe('idle');
  // The failed build created no source node and left no partial graph.
  expect(contexts[0]!.nodes).toHaveLength(nodeCountAfterFailure);
  contexts[0]!.createMediaStreamSource = () => contexts[0]!.node();
  stubMedia(async () => makeStream([]));
  await session.microphone();
  expect(session.state).toBe('microphone');
  await session.close();
});

it('pause interrupted by play cannot restore the paused state', async () => {
  const session = setup();
  await session.play(clip());
  let finishSuspend!: () => void;
  contexts[0]!.suspend.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishSuspend = resolve;
      }),
  );
  const pausing = session.pause();
  await flush();
  // A new play supersedes the pause while suspend() is still pending.
  const playing = session.play(clip());
  await flush();
  finishSuspend();
  await pausing;
  await playing;
  expect(session.state).toBe('playing');
  await session.close();
});

it('pause interrupted by close cannot restore the paused state', async () => {
  const session = setup();
  await session.play(clip());
  let finishSuspend!: () => void;
  contexts[0]!.suspend.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishSuspend = resolve;
      }),
  );
  const pausing = session.pause();
  await flush();
  const closing = session.close();
  finishSuspend();
  await pausing;
  await closing;
  expect(session.state).toBe('closed');
});

it('resume interrupted by close cannot restore the playing state', async () => {
  const session = setup();
  await session.play(clip());
  await session.pause();
  expect(session.state).toBe('paused');
  let finishResume!: () => void;
  contexts[0]!.resume.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishResume = resolve;
      }),
  );
  const resuming = session.resume();
  await flush();
  const closing = session.close();
  finishResume();
  await resuming;
  await closing;
  expect(session.state).toBe('closed');
  expect(contexts[0]!.close).toHaveBeenCalledTimes(1);
});

it('pause and resume are no-ops outside their owning states', async () => {
  const session = setup();
  await session.pause();
  await session.resume();
  expect(session.state).toBe('idle');
  // No context (and therefore no suspend call) was created from idle.
  expect(contexts).toHaveLength(0);
  stubMedia(async () => makeStream([]));
  await session.microphone();
  await session.pause();
  expect(session.state).toBe('microphone');
  expect(contexts[0]!.suspend).not.toHaveBeenCalled();
  session.stop();
  await session.resume();
  expect(session.state).toBe('idle');
  await session.close();
});

it('close disconnects every node, stops tracks and rejects every later request', async () => {
  const session = setup();
  const trackStop = vi.fn();
  stubMedia(async () => makeStream([{ stop: trackStop }, { stop: trackStop }]));
  await session.microphone();
  const analyser = contexts[0]!.nodes[0]!;
  const gain = contexts[0]!.nodes[1]!;
  const source = contexts[0]!.nodes[2]!;
  await session.close();
  expect(trackStop).toHaveBeenCalledTimes(2);
  expect(source.disconnect).toHaveBeenCalledTimes(1);
  expect(analyser.disconnect).toHaveBeenCalled();
  expect(gain.disconnect).toHaveBeenCalled();
  expect(contexts[0]!.close).toHaveBeenCalledTimes(1);
  await expect(session.play(clip())).rejects.toThrow('closed');
  await expect(session.microphone()).rejects.toThrow('closed');
  await expect(session.pause()).rejects.toThrow('closed');
  await expect(session.resume()).rejects.toThrow('closed');
  expect(session.stop()).toBeUndefined();
  expect(session.state).toBe('closed');
});

it('close racing an outstanding play resolves the stale play without sound', async () => {
  const session = setup();
  // Open the context, then make the next resume block.
  await session.play(clip());
  session.stop();
  let finishResume!: () => void;
  contexts[0]!.resume.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishResume = resolve;
      }),
  );
  const playing = session.play(clip());
  await flush();
  const nodeCountWhilePending = contexts[0]!.nodes.length;
  const closing = session.close();
  finishResume();
  await expect(playing).resolves.toBeUndefined();
  await closing;
  // The stale play never built a new source after close began.
  expect(contexts[0]!.nodes).toHaveLength(nodeCountWhilePending);
  expect(session.state).toBe('closed');
});
