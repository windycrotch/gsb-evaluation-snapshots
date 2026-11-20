import * as THREE from 'three';
import { MeshAnalyzer } from '../topology/MeshAnalyzer';
import { ProceduralIK } from '../ik/ProceduralIK';
import { RiggingOptions, IKTarget, SkeletonRig, JointType } from '../types';

/**
 * Error raised when a rig session is superseded by a newer request or cancelled
 * by the caller. The session's pending worker request is always cleared before
 * this error is delivered.
 */
export class RigSessionCancelledError extends Error {
  constructor(public readonly sessionId: number, message?: string) {
    super(message ?? `[AutoRig] Rig session ${sessionId} was cancelled.`);
    this.name = 'RigSessionCancelledError';
  }
}

/** A single, cancellable rig attempt. */
interface RigSession {
  sessionId: number;
  indices: Uint16Array | null;
  weights: Float32Array | null;
  /** Only populated in SharedArrayBuffer mode so failed sessions can be wiped. */
  positionsBuffer: ArrayBufferLike | null;
}

interface PendingRequest {
  msgId: number;
  /** Present for session-bound messages (RIG); absent for INIT. */
  sessionId?: number;
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
}

interface WorkerReply {
  type?: string;
  payload?: any;
  msgId?: number;
  sessionId?: number;
}

export class AutoRigger {
  private analyzer: MeshAnalyzer;
  private ikSolver: ProceduralIK;
  private worker: Worker | null = null;
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;
  private msgIdCounter = 0;
  private sessionCounter = 0;
  private activeSessionId: number | null = null;
  private pendingRequests = new Map<number, PendingRequest>();
  private activeSkeleton?: THREE.Skeleton;

  constructor(private options: RiggingOptions = {}) {
    this.analyzer = new MeshAnalyzer();
    this.ikSolver = new ProceduralIK(options.ikIterations ?? 15);
  }

  /** True once `init()` has completed successfully. */
  get initialized(): boolean {
    return this.isInitialized;
  }

  /** The skeleton installed by the most recent successful rig. */
  getActiveSkeleton(): THREE.Skeleton | undefined {
    return this.activeSkeleton;
  }

  /** Number of worker requests still awaiting a reply (diagnostics/tests). */
  get pendingRequestCount(): number {
    return this.pendingRequests.size;
  }

  async init(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInit();
    try {
      await this.initPromise;
    } finally {
      // Always release the slot: on failure a later init() must be able to retry,
      // on success isInitialized short-circuits future calls.
      this.initPromise = null;
    }
  }

  private async doInit(): Promise<void> {
    // Drop any worker left over from a previous failed attempt.
    this.disposeWorker();

    let worker: Worker;
    try {
      // Fallback URL resolving for both Vite and plain build output
      const workerUrl = new URL(
        // @ts-ignore
        import.meta.env ? '../worker/rigWorker.ts' : './worker/rigWorker.js',
        import.meta.url
      );
      worker = new Worker(workerUrl, { type: 'module' });
    } catch (err) {
      this.isInitialized = false;
      throw new Error(`[AutoRig] Initialization failed: ${toErrorMessage(err)}`);
    }

    this.worker = worker;
    worker.onmessage = (e: MessageEvent) => this.handleWorkerMessage(e);
    worker.onerror = (e: ErrorEvent) => this.handleWorkerError(e);

    console.log('[AutoRig] Initializing ML Engine in Worker...');

    try {
      await this.postWorkerMessage('INIT', {
        modelPath: this.options.modelPath || '/models/joint_estimator_v1.onnx'
      });

      // A worker error/retry may have replaced the worker while we were waiting.
      if (this.worker !== worker) {
        throw new Error('Worker was replaced during initialization.');
      }

      this.isInitialized = true;
      console.log('[AutoRig] Ready.');
    } catch (err) {
      // Never report a half-initialized engine. Tear the worker down so a
      // subsequent init() builds a fresh one and can succeed.
      this.isInitialized = false;
      this.disposeWorker();
      throw new Error(`[AutoRig] Initialization failed: ${toErrorMessage(err)}`);
    }
  }

  private handleWorkerMessage(e: MessageEvent): void {
    const data = (e?.data ?? {}) as WorkerReply;
    const { type, payload, msgId } = data;
    const replySessionId =
      data.sessionId ??
      (payload && typeof payload === 'object' ? (payload as any).sessionId : undefined);

    const req = msgId !== undefined ? this.pendingRequests.get(msgId) : undefined;

    if (!req) {
      // Late/dead replies (including already-cancelled sessions) are dropped
      // here. Nothing is ever written to activeSkeleton from this path.
      if (type === 'ERROR') {
        console.error('[AutoRig] Worker error:', payload);
      }
      return;
    }

    if (req.sessionId !== undefined) {
      // Session-bound replies must carry their session id, and it must be the
      // one this request belongs to. Anything else is rejected before it can
      // be applied.
      if (replySessionId === undefined) {
        this.pendingRequests.delete(req.msgId);
        req.reject(
          new Error(
            `[AutoRig] Worker reply for rig session ${req.sessionId} is missing its session id.`
          )
        );
        return;
      }

      if (replySessionId !== req.sessionId) {
        this.pendingRequests.delete(req.msgId);
        req.reject(
          new Error(
            `[AutoRig] Worker reply session mismatch (expected ${req.sessionId}, received ${replySessionId}).`
          )
        );
        return;
      }

      // Only the currently active session may settle. Everything else is
      // discarded before it can touch activeSkeleton.
      if (this.activeSessionId !== req.sessionId) {
        this.pendingRequests.delete(req.msgId);
        req.reject(
          new RigSessionCancelledError(
            req.sessionId,
            `[AutoRig] Discarded stale rig result for session ${req.sessionId}.`
          )
        );
        return;
      }
    }

    this.pendingRequests.delete(req.msgId);

    if (type === 'ERROR') {
      const detail =
        typeof payload === 'string' ? payload : payload?.message ?? 'Worker rigging failed.';
      req.reject(new Error(detail));
    } else {
      req.resolve(payload);
    }
  }

  private handleWorkerError(e: ErrorEvent): void {
    const message = (e as any)?.message || (e as any)?.error?.message || 'Unknown worker error';
    const error = new Error(`[AutoRig] Worker error: ${message}`);

    this.rejectAllPending(error);

    if (!this.isInitialized) {
      // A worker that fails while booting is unusable; allow a clean retry.
      this.disposeWorker();
    } else {
      // Clear any in-flight rig session; the engine remains initialized so the
      // caller can immediately retry a rig.
      this.activeSessionId = null;
    }
  }

  private postWorkerMessage(
    type: string,
    payload: any,
    transfers: Transferable[] = [],
    sessionId?: number
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const worker = this.worker;
      if (!worker) {
        reject(new Error('[AutoRig] Engine not initialized. Call init() before rigging.'));
        return;
      }

      const msgId = ++this.msgIdCounter;
      const req: PendingRequest = { msgId, sessionId, resolve, reject };
      this.pendingRequests.set(msgId, req);

      const message: Record<string, any> = { type, payload, msgId };
      if (sessionId !== undefined) message.sessionId = sessionId;

      try {
        worker.postMessage(message, transfers);
      } catch (err) {
        this.pendingRequests.delete(msgId);
        reject(err);
      }
    });
  }

  /**
   * Dual-Pipe Autonomous Auto-Rigging:
   * 1. If crossOriginIsolated & SharedArrayBuffer are available: zero-copy shared memory.
   * 2. Otherwise: zero-copy Transferable ArrayBuffers (works anywhere without COOP/COEP headers).
   *
   * Every call is an independent, cancellable session. Starting a new rig (or
   * calling cancelRig()) rejects the previous session before its result can be
   * applied. Failed sessions leave activeSkeleton untouched and release their
   * skin buffers.
   */
  async rig(mesh: THREE.Mesh): Promise<THREE.SkinnedMesh> {
    if (!this.isInitialized || !this.worker) {
      throw new Error(
        '[AutoRig] Engine not initialized. Call init() successfully before rigging.'
      );
    }

    const geometry = mesh?.geometry;
    const positionAttribute = geometry?.getAttribute
      ? geometry.getAttribute('position')
      : undefined;

    if (!positionAttribute) {
      throw new Error('[AutoRig] Cannot rig a mesh without a position attribute.');
    }

    const positions = positionAttribute.array as Float32Array;
    const vertexCount = Math.floor(positions.length / 3);

    const sessionId = ++this.sessionCounter;
    this.supersedeActiveSession(sessionId);
    this.activeSessionId = sessionId;

    const session: RigSession = {
      sessionId,
      indices: null,
      weights: null,
      positionsBuffer: null
    };

    try {
      console.log('[AutoRig] Analyzing topology & detecting joints in Worker...');

      const isSABSupported =
        typeof SharedArrayBuffer !== 'undefined' &&
        (typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false);

      let payload: any;
      let rig: SkeletonRig;
      let indices: Uint16Array;
      let weights: Float32Array;

      if (isSABSupported) {
        // Tier 1: SharedArrayBuffer Zero-Copy
        const posBuffer = new SharedArrayBuffer(
          positions.length * Float32Array.BYTES_PER_ELEMENT
        );
        new Float32Array(posBuffer).set(positions);

        const indicesBuffer = new SharedArrayBuffer(
          vertexCount * 4 * Uint16Array.BYTES_PER_ELEMENT
        );
        const weightsBuffer = new SharedArrayBuffer(
          vertexCount * 4 * Float32Array.BYTES_PER_ELEMENT
        );

        session.positionsBuffer = posBuffer;
        indices = new Uint16Array(indicesBuffer);
        weights = new Float32Array(weightsBuffer);
        session.indices = indices;
        session.weights = weights;

        payload = await this.postWorkerMessage(
          'RIG',
          {
            mode: 'SAB',
            posBuffer,
            indicesBuffer,
            weightsBuffer,
            falloff: this.options.skinningFalloff ?? 2.0
          },
          [],
          sessionId
        );

        this.assertSessionActive(sessionId);
        rig = this.validateRigResult(payload, vertexCount, sessionId, indices, weights).rig;
      } else {
        // Tier 2: Universal Transferable ArrayBuffer Zero-Copy
        const posBuffer = new Float32Array(positions).buffer;
        const indicesBuffer = new ArrayBuffer(
          vertexCount * 4 * Uint16Array.BYTES_PER_ELEMENT
        );
        const weightsBuffer = new ArrayBuffer(
          vertexCount * 4 * Float32Array.BYTES_PER_ELEMENT
        );

        payload = await this.postWorkerMessage(
          'RIG',
          {
            mode: 'TRANSFERABLE',
            posBuffer,
            indicesBuffer,
            weightsBuffer,
            falloff: this.options.skinningFalloff ?? 2.0
          },
          [posBuffer, indicesBuffer, weightsBuffer],
          sessionId
        );

        this.assertSessionActive(sessionId);

        if (!payload || typeof payload !== 'object') {
          throw new Error(
            `[AutoRig] Rig session ${sessionId} returned an empty worker payload.`
          );
        }

        if (!payload.indicesBuffer || !payload.weightsBuffer) {
          throw new Error(
            `[AutoRig] Rig session ${sessionId} did not return its skin buffers (transfer failed).`
          );
        }

        const decodedIndices = decodeUint16(payload.indicesBuffer);
        const decodedWeights = decodeFloat32(payload.weightsBuffer);
        if (!decodedIndices || !decodedWeights) {
          throw new Error(
            `[AutoRig] Rig session ${sessionId} returned unreadable skin buffers.`
          );
        }

        indices = decodedIndices;
        weights = decodedWeights;
        session.indices = indices;
        session.weights = weights;

        rig = this.validateRigResult(payload, vertexCount, sessionId, indices, weights).rig;
      }

      // Defensive normalisation: the worker normalises too, but a malformed
      // buffer must never reach the SkinnedMesh with weights that do not sum to 1.
      normalizeSkinWeights(weights, vertexCount);

      console.log('[AutoRig] Applying procedural skin weights...');
      const skinnedMesh = this.analyzer.bindSkeletonWithWeights(mesh, rig, indices, weights);

      // Commit only after a fully-built SkinnedMesh exists.
      this.assertSessionActive(sessionId);
      this.activeSkeleton = skinnedMesh.skeleton;

      // Ownership of the buffers has moved into the geometry attributes.
      session.indices = null;
      session.weights = null;
      session.positionsBuffer = null;

      return skinnedMesh;
    } catch (err) {
      // Roll back: activeSkeleton keeps its previous value (or stays unset) and
      // any buffers allocated for this session are wiped and dereferenced.
      this.releaseSessionBuffers(session);
      throw err;
    } finally {
      if (this.activeSessionId === sessionId) {
        this.activeSessionId = null;
      }
      // Belt-and-braces: never leave a request for this session dangling.
      for (const [msgId, req] of this.pendingRequests) {
        if (req.sessionId === sessionId) {
          this.pendingRequests.delete(msgId);
        }
      }
    }
  }

  /**
   * Alias for rig(mesh) for backward compatibility.
   */
  async autoRig(mesh: THREE.Mesh): Promise<THREE.SkinnedMesh> {
    return this.rig(mesh);
  }

  /**
   * Cancel the in-flight rig session (if any). The session's promise rejects
   * with {@link RigSessionCancelledError} and no pending request is retained.
   */
  cancelRig(): void {
    const sessionId = this.activeSessionId;
    if (sessionId === null) return;

    this.activeSessionId = null;
    this.rejectPendingForSession(
      sessionId,
      new RigSessionCancelledError(sessionId, `[AutoRig] Rig session ${sessionId} was cancelled.`)
    );
  }

  /** Convenience alias for {@link cancelRig}. */
  cancel(): void {
    this.cancelRig();
  }

  /** Terminate the worker and release all pending work. */
  dispose(): void {
    this.isInitialized = false;
    this.activeSessionId = null;
    this.disposeWorker();
  }

  animate(): void {
    if (this.activeSkeleton) {
      this.ikSolver.solve(this.activeSkeleton);
    }
  }

  setIKTarget(target: IKTarget): void {
    this.ikSolver.addTarget(target);
  }

  private assertSessionActive(sessionId: number): void {
    if (this.activeSessionId !== sessionId) {
      throw new RigSessionCancelledError(
        sessionId,
        `[AutoRig] Rig session ${sessionId} was cancelled before it completed.`
      );
    }
  }

  private validateRigResult(
    payload: any,
    vertexCount: number,
    sessionId: number,
    indices: Uint16Array,
    weights: Float32Array
  ): { rig: SkeletonRig; indices: Uint16Array; weights: Float32Array } {
    if (!payload || typeof payload !== 'object') {
      throw new Error(`[AutoRig] Rig session ${sessionId} returned no result payload.`);
    }

    const rig = payload.rig as SkeletonRig;

    if (!rig || typeof rig !== 'object' || !rig.joints || typeof rig.joints !== 'object') {
      throw new Error(
        `[AutoRig] Skeleton data missing from worker result for rig session ${sessionId}.`
      );
    }

    const jointTypes = Object.keys(rig.joints);
    if (jointTypes.length === 0) {
      throw new Error(
        `[AutoRig] Skeleton data for rig session ${sessionId} contains no joints.`
      );
    }

    if (!rig.hierarchy || typeof rig.hierarchy !== 'object') {
      throw new Error(
        `[AutoRig] Skeleton hierarchy missing from worker result for rig session ${sessionId}.`
      );
    }

    for (const type of jointTypes) {
      const joint = rig.joints[type as JointType];
      const p = joint?.position;
      if (
        !joint ||
        !p ||
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        !Number.isFinite(p.z)
      ) {
        throw new Error(
          `[AutoRig] Skeleton joint "${type}" is missing a valid position in rig session ${sessionId}.`
        );
      }
    }

    for (const [parent, children] of Object.entries(rig.hierarchy)) {
      if (!rig.joints[parent as JointType]) {
        throw new Error(
          `[AutoRig] Skeleton hierarchy references unknown parent joint "${parent}".`
        );
      }
      if (!Array.isArray(children)) {
        throw new Error(
          `[AutoRig] Skeleton hierarchy for "${parent}" is not a joint list.`
        );
      }
      for (const child of children) {
        if (!rig.joints[child]) {
          throw new Error(
            `[AutoRig] Skeleton hierarchy references unknown child joint "${child}".`
          );
        }
      }
    }

    const required = vertexCount * 4;

    if (!indices || indices.length < required) {
      throw new Error(
        `[AutoRig] Skin index buffer is invalid or truncated for rig session ${sessionId} ` +
          `(expected ${required} entries, got ${indices?.length ?? 0}).`
      );
    }

    if (!weights || weights.length < required) {
      throw new Error(
        `[AutoRig] Skin weight buffer is invalid or truncated for rig session ${sessionId} ` +
          `(expected ${required} entries, got ${weights?.length ?? 0}).`
      );
    }

    return { rig, indices, weights };
  }

  private supersedeActiveSession(newSessionId: number): void {
    const previous = this.activeSessionId;
    this.activeSessionId = null;
    if (previous === null) return;

    this.rejectPendingForSession(
      previous,
      new RigSessionCancelledError(
        previous,
        `[AutoRig] Rig session ${previous} was cancelled (superseded by rig session ${newSessionId}).`
      )
    );
  }

  private rejectPendingForSession(sessionId: number, error: Error): void {
    for (const [msgId, req] of this.pendingRequests) {
      if (req.sessionId === sessionId) {
        this.pendingRequests.delete(msgId);
        req.reject(error);
      }
    }
  }

  private rejectAllPending(error: Error): void {
    const pending = Array.from(this.pendingRequests.values());
    this.pendingRequests.clear();
    for (const req of pending) {
      req.reject(error);
    }
  }

  private releaseSessionBuffers(session: RigSession): void {
    if (session.indices) {
      try {
        session.indices.fill(0);
      } catch {
        /* detached or unwritable buffer */
      }
    }
    if (session.weights) {
      try {
        session.weights.fill(0);
      } catch {
        /* detached or unwritable buffer */
      }
    }
    if (session.positionsBuffer) {
      try {
        new Uint8Array(session.positionsBuffer).fill(0);
      } catch {
        /* detached or unwritable buffer */
      }
    }

    session.indices = null;
    session.weights = null;
    session.positionsBuffer = null;
  }

  private disposeWorker(): void {
    const worker = this.worker;
    this.worker = null;

    if (worker) {
      try {
        worker.onmessage = null;
        worker.onerror = null;
      } catch {
        /* ignore */
      }
      try {
        if (typeof worker.terminate === 'function') worker.terminate();
      } catch {
        /* ignore */
      }
    }

    this.rejectAllPending(new Error('[AutoRig] Worker was disposed.'));
  }
}

function normalizeSkinWeights(weights: Float32Array, vertexCount: number): void {
  for (let i = 0; i < vertexCount; i++) {
    const offset = i * 4;
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += weights[offset + k];

    if (!Number.isFinite(sum) || sum <= 0) {
      // Degenerate vertex: pin it to the first influence so every vertex has a
      // total weight of exactly 1.
      weights[offset] = 1;
      weights[offset + 1] = 0;
      weights[offset + 2] = 0;
      weights[offset + 3] = 0;
      continue;
    }

    if (Math.abs(sum - 1) <= 1e-6) continue;

    for (let k = 0; k < 4; k++) {
      weights[offset + k] = weights[offset + k] / sum;
    }
  }
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

function decodeUint16(value: any): Uint16Array | null {
  if (value instanceof Uint16Array) return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return new Uint16Array(value as any);
  }
  return null;
}

function decodeFloat32(value: any): Float32Array | null {
  if (value instanceof Float32Array) return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return new Float32Array(value as any);
  }
  return null;
}

export { AutoRigger as RiggingEngine };

