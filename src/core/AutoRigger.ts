import * as THREE from 'three';
import { MeshAnalyzer } from '../topology/MeshAnalyzer';
import { ProceduralIK } from '../ik/ProceduralIK';
import { RiggingOptions, IKTarget, SkeletonRig } from '../types';

type EngineState = 'idle' | 'initializing' | 'ready' | 'failed';

export class AutoRigger {
  private analyzer: MeshAnalyzer;
  private ikSolver: ProceduralIK;
  private worker: Worker | null = null;
  private state: EngineState = 'idle';
  private initPromise: Promise<void> | null = null;
  private initError: Error | null = null;
  private msgIdCounter = 0;
  private pendingRequests = new Map<number, { resolve: Function, reject: Function }>();
  private activeSkeleton?: THREE.Skeleton;
  /**
   * Rig sessions are serialized through this chain: at most one RIG request is
   * in flight at any moment, so bones/weights from two uploads can never mix.
   */
  private rigQueue: Promise<unknown> = Promise.resolve();
  private sessionCounter = 0;

  constructor(private options: RiggingOptions = {}) {
    this.analyzer = new MeshAnalyzer();
    this.ikSolver = new ProceduralIK(options.ikIterations ?? 15);
  }

  /**
   * Idempotent initialization. Concurrent calls share one in-flight attempt;
   * once ready, further calls are no-ops (the worker is NOT rebuilt and no
   * state is lost). After a failure, calling init() again retries cleanly.
   */
  async init(): Promise<void> {
    if (this.state === 'ready') return;
    if (this.initPromise) return this.initPromise;

    this.state = 'initializing';
    this.initPromise = this.createWorkerAndInit()
      .then(() => {
        this.state = 'ready';
        this.initError = null;
        console.log('[AutoRig] Ready.');
      })
      .catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.state = 'failed';
        this.initError = error;
        this.teardownWorker();
        throw error;
      })
      .finally(() => {
        this.initPromise = null;
      });

    return this.initPromise;
  }

  private async createWorkerAndInit(): Promise<void> {
    // Fallback URL resolving for both Vite and plain build output
    const workerUrl = new URL(
      // @ts-ignore
      import.meta.env ? '../worker/rigWorker.ts' : './worker/rigWorker.js',
      import.meta.url
    );

    let worker: Worker;
    try {
      worker = new Worker(workerUrl, { type: 'module' });
    } catch (err: any) {
      throw new Error(`[AutoRig] Failed to create rigging worker: ${err?.message ?? err}`);
    }

    this.worker = worker;
    this.worker.onmessage = (e) => this.handleWorkerMessage(e);
    this.worker.onerror = (e) => this.handleWorkerError(e);

    console.log('[AutoRig] Initializing ML Engine in Worker...');

    await this.postWorkerMessage('INIT', {
      modelPath: this.options.modelPath || '/models/joint_estimator_v1.onnx'
    });
  }

  private handleWorkerMessage(e: MessageEvent) {
    const { type, payload, msgId } = e.data;
    const req = this.pendingRequests.get(msgId);

    if (type === 'ERROR') {
      if (req) {
        req.reject(new Error(payload));
        this.pendingRequests.delete(msgId);
      } else {
        console.error('[AutoRig] Worker error:', payload);
      }
    } else {
      if (req) {
        req.resolve(payload);
        this.pendingRequests.delete(msgId);
      }
    }
  }

  /**
   * A worker 'error' event means the worker script failed to load or crashed:
   * pending requests would otherwise hang forever, so reject them all and
   * move the engine to a failed (but re-initializable) state.
   */
  private handleWorkerError(e: Event) {
    console.error('[AutoRig] Worker error:', e);
    const error = new Error('[AutoRig] Rigging worker terminated unexpectedly.');
    this.rejectAllPending(error);
    if (this.state !== 'initializing') {
      // If we are initializing, the rejected INIT request drives the
      // init() catch handler, which performs this same teardown.
      this.state = 'failed';
      this.initError = error;
      this.teardownWorker();
    }
  }

  private rejectAllPending(error: Error) {
    for (const req of this.pendingRequests.values()) {
      req.reject(error);
    }
    this.pendingRequests.clear();
  }

  private teardownWorker() {
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      try {
        this.worker.terminate?.();
      } catch {
        // Ignore teardown errors — the worker may already be dead.
      }
      this.worker = null;
    }
  }

  private postWorkerMessage(type: string, payload: any, transfers: Transferable[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('[AutoRig] Rigging worker is not available.'));
        return;
      }
      const msgId = ++this.msgIdCounter;
      this.pendingRequests.set(msgId, { resolve, reject });
      this.worker.postMessage({ type, payload, msgId }, transfers);
    });
  }

  /**
   * Dual-Pipe Autonomous Auto-Rigging:
   * 1. If crossOriginIsolated & SharedArrayBuffer are available: zero-copy shared memory.
   * 2. Otherwise: zero-copy Transferable ArrayBuffers (works anywhere without COOP/COEP headers).
   *
   * Sessions are serialized: concurrent calls queue in invocation order and
   * exactly one RIG request is in flight at a time. A failed session rejects
   * its own promise but leaves the engine ready for the next call, and never
   * replaces the skeleton produced by the last successful session.
   */
  async rig(mesh: THREE.Mesh): Promise<THREE.SkinnedMesh> {
    const sessionId = ++this.sessionCounter;
    const run = this.rigQueue.then(() => this.rigSession(mesh, sessionId));
    // Keep the queue alive for subsequent sessions even if this one fails.
    this.rigQueue = run.catch(() => {});
    return run;
  }

  private async rigSession(mesh: THREE.Mesh, sessionId: number): Promise<THREE.SkinnedMesh> {
    if (this.state !== 'ready' || !this.worker) {
      const reason = this.initError ? ` Last initialization error: ${this.initError.message}` : '';
      throw new Error(`[AutoRig] Engine not initialized (state: ${this.state}). Call init() successfully before rigging.${reason}`);
    }

    const geometry = mesh?.geometry;
    const positionAttr = geometry?.attributes?.position;
    if (!positionAttr || !positionAttr.array) {
      throw new Error('[AutoRig] Cannot rig mesh: geometry is missing a "position" attribute.');
    }

    console.log('[AutoRig] Analyzing topology & detecting joints in Worker...');

    // A new session supersedes any previous one: drop IK targets bound to the
    // previous skeleton so a failed attempt cannot leave stale targets behind.
    this.ikSolver.clearTargets();

    const positions = positionAttr.array as Float32Array;
    const vertexCount = positions.length / 3;

    const isSABSupported = typeof SharedArrayBuffer !== 'undefined' &&
      (typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false);

    let skinnedMesh: THREE.SkinnedMesh;

    if (isSABSupported) {
      // Tier 1: SharedArrayBuffer Zero-Copy
      const posBuffer = new SharedArrayBuffer(positions.length * Float32Array.BYTES_PER_ELEMENT);
      new Float32Array(posBuffer).set(positions);

      const indicesBuffer = new SharedArrayBuffer(vertexCount * 4 * Uint16Array.BYTES_PER_ELEMENT);
      const weightsBuffer = new SharedArrayBuffer(vertexCount * 4 * Float32Array.BYTES_PER_ELEMENT);

      const payload = await this.postWorkerMessage('RIG', {
        mode: 'SAB',
        posBuffer,
        indicesBuffer,
        weightsBuffer,
        falloff: this.options.skinningFalloff ?? 2.0
      });

      const rig = payload.rig as SkeletonRig;
      console.log('[AutoRig] Applying procedural skin weights (SAB mode)...');
      skinnedMesh = this.analyzer.bindSkeletonWithWeights(
        mesh,
        rig,
        new Uint16Array(indicesBuffer),
        new Float32Array(weightsBuffer)
      );
    } else {
      // Tier 2: Universal Transferable ArrayBuffer Zero-Copy (No CORS/Spectre headers required)
      const posBuffer = new Float32Array(positions).buffer;
      const indicesBuffer = new ArrayBuffer(vertexCount * 4 * Uint16Array.BYTES_PER_ELEMENT);
      const weightsBuffer = new ArrayBuffer(vertexCount * 4 * Float32Array.BYTES_PER_ELEMENT);

      const payload = await this.postWorkerMessage('RIG', {
        mode: 'TRANSFERABLE',
        posBuffer,
        indicesBuffer,
        weightsBuffer,
        falloff: this.options.skinningFalloff ?? 2.0
      }, [posBuffer, indicesBuffer, weightsBuffer]);

      const rig = payload.rig as SkeletonRig;
      const resultIndices = new Uint16Array(payload.indicesBuffer);
      const resultWeights = new Float32Array(payload.weightsBuffer);

      skinnedMesh = this.analyzer.bindSkeletonWithWeights(mesh, rig, resultIndices, resultWeights);
    }

    // Only the newest session may replace the active skeleton. A stale or
    // failed session never touches it, so animate() keeps driving the last
    // successfully rigged skeleton.
    if (sessionId === this.sessionCounter) {
      this.activeSkeleton = skinnedMesh.skeleton;
    }
    return skinnedMesh;
  }

  /**
   * Alias for rig(mesh) for backward compatibility.
   */
  async autoRig(mesh: THREE.Mesh): Promise<THREE.SkinnedMesh> {
    return this.rig(mesh);
  }

  /**
   * The skeleton produced by the most recent successful rig session, if any.
   */
  getActiveSkeleton(): THREE.Skeleton | undefined {
    return this.activeSkeleton;
  }

  animate(): void {
    if (this.activeSkeleton) {
      this.ikSolver.solve(this.activeSkeleton);
    }
  }

  setIKTarget(target: IKTarget): void {
    this.ikSolver.addTarget(target);
  }
}

export { AutoRigger as RiggingEngine };
