import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Graph } from '../types/graph';
import type { WorkletMessage } from '../types/messages';
import { toEngineGraph } from '../model/graph';
import { EngineSync } from '../engine/EngineSync';

export type StatusType = 'info' | 'success' | 'error';

export type EngineStatus = { message: string; type: StatusType };

/**
 * Drives the AudioWorklet. The engine rebuilds its module graph whenever the
 * audio-relevant part of the patch changes; moving nodes around the canvas
 * never touches it. All message ordering, revision tracking and parameter
 * reconciliation live in {@link EngineSync}; this hook only owns the WebAudio
 * lifecycle and React state.
 */
export function useAudioEngine(graph: Graph) {
  const audioContext = useRef<AudioContext | null>(null);
  const modularNode = useRef<AudioWorkletNode | null>(null);
  const engineSync = useRef<EngineSync | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState<EngineStatus>({
    message: 'Ready. Press play to start audio.',
    type: 'info',
  });
  const [scopeData, setScopeData] = useState<Record<string, number[]>>({});

  const engineGraph = useMemo(() => toEngineGraph(graph), [graph]);
  const latestGraph = useRef(engineGraph);
  latestGraph.current = engineGraph;

  // Forward every canvas change to the sync controller. Structure changes
  // become revisioned loadGraph messages; parameter edits are diffed into
  // setParam messages (or queued while a load is in flight).
  useEffect(() => {
    engineSync.current?.sync(engineGraph);
  }, [engineGraph]);

  const start = useCallback(async () => {
    try {
      setStatus({ message: 'Initializing audio context...', type: 'info' });

      if (!audioContext.current) {
        audioContext.current = new AudioContext();
      }
      const ctx = audioContext.current;

      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      setStatus({ message: 'Loading AudioWorklet module...', type: 'info' });

      const workletPath = import.meta.env.DEV
        ? '/src/worklet/index.ts'
        : new URL(/* @vite-ignore */ 'modular-processor.js', import.meta.url).href;

      await ctx.audioWorklet.addModule(workletPath);

      const node = new AudioWorkletNode(ctx, 'modular-processor', {
        outputChannelCount: [2],
      });

      // Fresh node → fresh controller. Nothing is assumed about the worklet's
      // initial state, so the first sync() posts a full load of the current
      // graph (never a stale one).
      const sync = new EngineSync(node.port, {
        onStatus: setStatus,
        onScopeData: (frames) => {
          setScopeData((prev) => {
            const next = { ...prev };
            for (const frame of frames) {
              next[frame.id] = frame.samples;
            }
            return next;
          });
        },
      });
      engineSync.current = sync;

      node.port.onmessage = (e: MessageEvent<WorkletMessage>) => {
        sync.handleMessage(e.data, latestGraph.current);
      };

      node.connect(ctx.destination);
      modularNode.current = node;

      setStatus({ message: 'Loading graph...', type: 'info' });
      sync.sync(latestGraph.current);

      if (ctx.state !== 'running') {
        await ctx.resume();
      }
      setIsRunning(true);
    } catch (err) {
      console.error('Audio initialization error:', err);
      const message = err instanceof Error ? err.message : 'Unknown error';
      setStatus({ message: `Error: ${message}`, type: 'error' });
    }
  }, []);

  const stop = useCallback(() => {
    if (modularNode.current) {
      modularNode.current.port.onmessage = null;
      modularNode.current.disconnect();
      modularNode.current = null;
    }
    // Drop the controller too; on restart a new one loads the current graph.
    engineSync.current = null;
    void audioContext.current?.suspend();
    // Scopes must not show samples from the previous run.
    setScopeData({});
    setIsRunning(false);
    setStatus({ message: 'Audio stopped.', type: 'info' });
  }, []);

  const toggle = useCallback(() => {
    if (isRunning) {
      stop();
    } else {
      void start();
    }
  }, [isRunning, start, stop]);

  const reload = useCallback(() => {
    engineSync.current?.load(latestGraph.current);
  }, []);

  return { isRunning, status, setStatus, scopeData, start, stop, toggle, reload };
}
