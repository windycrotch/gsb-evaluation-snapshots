import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Graph } from '../types/graph';
import type { ScopeDataMessage, WorkletMessage } from '../types/messages';
import { toEngineGraph } from '../model/graph';
import { EngineSync } from './engineSync';

export type StatusType = 'info' | 'success' | 'error';

export type EngineStatus = { message: string; type: StatusType };

/**
 * Drives the AudioWorklet. The engine rebuilds its module graph whenever the
 * audio-relevant part of the patch changes; moving nodes around the canvas
 * never touches it. All protocol bookkeeping (graph versions, parameter
 * diffing, ack/error reconciliation, session reset) lives in EngineSync.
 */
export function useAudioEngine(graph: Graph) {
  const audioContext = useRef<AudioContext | null>(null);
  const modularNode = useRef<AudioWorkletNode | null>(null);
  const syncRef = useRef<EngineSync | null>(null);
  if (syncRef.current === null) {
    syncRef.current = new EngineSync();
  }
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState<EngineStatus>({
    message: 'Ready. Press play to start audio.',
    type: 'info',
  });
  const [scopeData, setScopeData] = useState<Record<string, number[]>>({});

  const engineGraph = useMemo(() => toEngineGraph(graph), [graph]);
  const latestGraph = useRef(engineGraph);
  latestGraph.current = engineGraph;

  // Stream structural rebuilds and parameter deltas into the running engine.
  // EngineSync decides which is which and guarantees ordering/versioning.
  useEffect(() => {
    const sync = syncRef.current;
    if (!sync || !modularNode.current) return;
    sync.sync(engineGraph);
  }, [engineGraph]);

  const start = useCallback(async () => {
    const sync = syncRef.current!;
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

      node.port.onmessage = (e: MessageEvent<WorkletMessage>) => {
        if (e.data.type === 'graphLoaded') {
          // Rebuild the parameter baseline from the graph the engine
          // actually committed, then replay any edits made mid-rebuild.
          sync.handleGraphLoaded(e.data.version);
          setStatus({ message: 'Audio running.', type: 'success' });
        } else if (e.data.type === 'error') {
          // The engine rejected the graph and kept the previous one
          // sounding; roll our baseline back in lockstep and surface it.
          sync.handleGraphError(e.data.version);
          setStatus({ message: `Error: ${e.data.message}`, type: 'error' });
        } else if (e.data.type === 'scopeData') {
          const data = e.data as ScopeDataMessage;
          setScopeData((prev) => {
            const next = { ...prev };
            for (const frame of data.frames) {
              next[frame.id] = frame.samples;
            }
            return next;
          });
        }
      };

      node.connect(ctx.destination);
      modularNode.current = node;
      // Fresh processor instance: no version, cache or pending load from a
      // previous session may carry over.
      sync.reset();
      sync.attach(node.port);

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
    const sync = syncRef.current!;
    if (modularNode.current) {
      modularNode.current.port.onmessage = null;
      modularNode.current.disconnect();
      modularNode.current = null;
    }
    void audioContext.current?.suspend();
    // Drop all synchronization state: the next start() is a clean session.
    sync.reset();
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
    syncRef.current?.reload(latestGraph.current);
  }, []);

  return { isRunning, status, setStatus, scopeData, start, stop, toggle, reload };
}
