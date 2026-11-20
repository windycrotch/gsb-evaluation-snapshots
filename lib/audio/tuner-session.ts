// Single-owner lifecycle for the tuner's microphone session.
//
// Every start() takes a fresh generation token. Whatever an older start has
// built by the time one of its awaits resolves is released and ignored, so a
// stop or a newer start always wins, even while the permission prompt is open.
// A session owns at most one media stream, one AudioContext and one worklet
// node; stop() and dispose() release all of them, and repeated calls are safe.

import type { NoteReading } from "./note";

export type TunerState = "idle" | "running";

export interface TunerReading extends NoteReading {
  /** Median of the recent detections, smoothed to reduce jitter. */
  smoothedHz: number;
}

export const DEFAULT_TUNER_HISTORY_SIZE = 5;
export const TUNER_WORKLET_URL = "/tuner-audio-processor.js";

// Structural types for the audio graph. The hook passes the browser classes;
// tests pass plain doubles. Keeping the surface small makes the session
// lifecycle testable without a DOM or a real microphone.

export interface TunerTrack {
  stop(): void;
}

export interface TunerMediaStream {
  getTracks(): TunerTrack[];
}

export interface TunerConnectable {
  connect(target: unknown): unknown;
  disconnect(): void;
}

export interface TunerGainNode extends TunerConnectable {
  gain: { value: number };
}

export interface TunerWorkletNode extends TunerConnectable {
  port: {
    onmessage: ((event: { data: { samples: Float32Array } }) => void) | null;
    close(): void;
  };
}

export interface TunerAudioContext {
  readonly sampleRate: number;
  readonly destination: unknown;
  readonly audioWorklet: { addModule(url: string): Promise<unknown> };
  createMediaStreamSource(stream: TunerMediaStream): TunerConnectable;
  createGain(): TunerGainNode;
  close(): Promise<void> | void;
}

export interface TunerSessionDeps {
  getUserMedia(): Promise<TunerMediaStream>;
  createAudioContext(): TunerAudioContext;
  /** Load the worklet processor into the context before creating the node. */
  loadWorkletModule(context: TunerAudioContext): Promise<unknown>;
  createWorkletNode(context: TunerAudioContext): TunerWorkletNode;
  detectPitch(samples: Float32Array, options: { sampleRate: number }): number | null;
  hzToNote(hz: number): NoteReading;
  onStateChange?(state: TunerState): void;
  onReadingChange?(reading: TunerReading | null): void;
  onErrorChange?(error: string | null): void;
  historySize?: number;
}

export interface TunerSession {
  start(): Promise<void>;
  stop(): void;
  dispose(): void;
}

interface SessionResources {
  generation: number;
  stream: TunerMediaStream | null;
  context: TunerAudioContext | null;
  source: TunerConnectable | null;
  node: TunerWorkletNode | null;
  sink: TunerGainNode | null;
  history: number[];
  released: boolean;
}

function stopTracks(stream: TunerMediaStream | null): void {
  if (!stream) return;
  try {
    for (const track of stream.getTracks()) track.stop();
  } catch {
    /* a partially implemented stream must not break teardown */
  }
}

function releaseSession(session: SessionResources | null): void {
  if (!session || session.released) return;
  session.released = true;

  const { node, source, sink, stream, context } = session;

  if (node) {
    // Detach first: a queued worklet message must not reach a dead session.
    node.port.onmessage = null;
    try {
      node.port.close();
    } catch {
      /* already closed */
    }
    try {
      node.disconnect();
    } catch {
      /* already disconnected */
    }
  }
  try {
    source?.disconnect();
  } catch {
    /* already disconnected */
  }
  try {
    sink?.disconnect();
  } catch {
    /* already disconnected */
  }

  stopTracks(stream);

  if (context) {
    try {
      const closing = context.close();
      if (closing && typeof (closing as Promise<void>).catch === "function") {
        (closing as Promise<void>).catch(() => {});
      }
    } catch {
      /* already closed */
    }
  }

  session.stream = null;
  session.context = null;
  session.source = null;
  session.node = null;
  session.sink = null;
  session.history = [];
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Couldn't access the microphone.";
}

export function createTunerSession(deps: TunerSessionDeps): TunerSession {
  const historySize = Math.max(1, deps.historySize ?? DEFAULT_TUNER_HISTORY_SIZE);

  let generation = 0;
  let active: SessionResources | null = null;

  const emitState = (state: TunerState) => deps.onStateChange?.(state);
  const emitReading = (reading: TunerReading | null) => deps.onReadingChange?.(reading);
  const emitError = (error: string | null) => deps.onErrorChange?.(error);

  // A session is stale once the user asked for something newer or left. The
  // generation token is bumped by start, stop and dispose alike, so an older
  // start can never write state after any of them. It stays reusable after
  // dispose: React StrictMode mounts, unmounts and mounts the same hook again.
  function isStale(session: SessionResources): boolean {
    return session.generation !== generation;
  }

  // Live means stale-free and not already torn down.
  function isLive(session: SessionResources): boolean {
    return !session.released && !isStale(session);
  }

  function consumeFrame(
    session: SessionResources,
    sampleRate: number,
    samples: Float32Array,
  ): void {
    const hz = deps.detectPitch(samples, { sampleRate });
    if (hz === null || !Number.isFinite(hz)) return;

    const history = session.history;
    history.push(hz);
    if (history.length > historySize) history.shift();

    const sorted = [...history].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const note = deps.hzToNote(median);
    emitReading({ ...note, smoothedHz: median });
  }

  async function start(): Promise<void> {
    // Claim the newest generation first. Any in-flight or running session is
    // released below and can no longer write state or readings.
    const token = ++generation;
    releaseSession(active);
    active = null;

    const session: SessionResources = {
      generation: token,
      stream: null,
      context: null,
      source: null,
      node: null,
      sink: null,
      history: [],
      released: false,
    };
    active = session;

    emitError(null);
    emitReading(null);
    emitState("idle");

    try {
      const stream = await deps.getUserMedia();
      if (isLive(session) === false) {
        // Nothing claimed this stream yet, so release it here.
        stopTracks(stream);
        return;
      }
      session.stream = stream;

      const context = deps.createAudioContext();
      session.context = context;

      await deps.loadWorkletModule(context);
      if (isLive(session) === false) return;

      const source = context.createMediaStreamSource(stream);
      session.source = source;
      const node = deps.createWorkletNode(context);
      session.node = node;
      const sink = context.createGain();
      session.sink = sink;

      // Silent gain keeps the graph pulled by the destination without echoing
      // the microphone back to the speakers.
      sink.gain.value = 0;
      source.connect(node);
      node.connect(sink);
      sink.connect(context.destination);

      node.port.onmessage = (event) => {
        if (isLive(session) === false) return;
        consumeFrame(session, context.sampleRate, event.data.samples);
      };

      emitState("running");
    } catch (error) {
      if (!isLive(session)) {
        // A failure already handled by stop(), dispose() or a newer start must
        // not overwrite that newer intent.
        return;
      }

      releaseSession(session);
      if (active === session) active = null;

      emitReading(null);
      emitError(describeError(error));
      emitState("idle");
    }
  }

  function stop(): void {
    // Bump the token so a pending start cannot resurrect the session, then
    // release whatever it has built so far. Safe to call repeatedly.
    generation += 1;
    const session = active;
    active = null;
    releaseSession(session);

    emitReading(null);
    emitState("idle");
  }

  function dispose(): void {
    // Same intent as stop, named for the unmount path.
    stop();
  }

  return { start, stop, dispose };
}
