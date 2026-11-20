import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  AutoRigger,
  RiggingEngine,
  RigSessionCancelledError
} from '../src/core/AutoRigger';
import { JointType, SkeletonRig } from '../src/types';

interface WorkerMessage {
  type: string;
  payload: any;
  msgId: number;
  sessionId?: number;
}

type RigMessage = WorkerMessage;

/**
 * Controllable Web Worker stand-in.
 *
 * - INIT replies are driven by `initFailuresRemaining`.
 * - RIG replies are either automatic (echoing populated skin buffers after
 *   `rigDelayMs`) or manual, so tests can force out-of-order completion.
 */
class MockWorker {
  static instances: MockWorker[] = [];
  static initFailuresRemaining = 0;
  static autoRig = true;
  static rigDelayMs = 0;
  static skeletonVersion = 0;

  onmessage: ((e: { data: any }) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  terminated = false;
  messages: WorkerMessage[] = [];
  queuedRigs: RigMessage[] = [];

  constructor(public url: any, public opts?: any) {
    MockWorker.instances.push(this);
  }

  static reset(): void {
    MockWorker.instances = [];
    MockWorker.initFailuresRemaining = 0;
    MockWorker.autoRig = true;
    MockWorker.rigDelayMs = 0;
    MockWorker.skeletonVersion = 0;
  }

  static get last(): MockWorker {
    return MockWorker.instances[MockWorker.instances.length - 1];
  }

  postMessage(data: WorkerMessage): void {
    this.messages.push(data);

    if (data.type === 'INIT') {
      const fail = MockWorker.initFailuresRemaining > 0;
      if (fail) MockWorker.initFailuresRemaining -= 1;
      queueMicrotask(() => {
        if (fail) {
          this.emit({ type: 'ERROR', payload: 'model download failed', msgId: data.msgId });
        } else {
          this.emit({ type: 'INIT_DONE', msgId: data.msgId });
        }
      });
      return;
    }

    if (data.type === 'RIG') {
      if (!MockWorker.autoRig) {
        this.queuedRigs.push(data);
        return;
      }
      const reply = buildRigReply(data, MockWorker.skeletonVersion);
      setTimeout(() => this.emit(reply), MockWorker.rigDelayMs);
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: any): void {
    if (this.onmessage) this.onmessage({ data });
  }

  /** Reply to the Nth queued RIG request (0 = first). */
  flushRig(index = 0, override?: (msg: RigMessage) => any): any {
    const msg = this.queuedRigs[index];
    if (!msg) throw new Error(`No queued RIG at index ${index}`);
    const reply = override ? override(msg) : buildRigReply(msg, index + 1);
    this.emit(reply);
    return reply;
  }
}

function makeRig(version: number): SkeletonRig {
  const y = version;
  return {
    joints: {
      [JointType.Hips]: { type: JointType.Hips, position: { x: 0, y, z: 0 }, confidence: 1 },
      [JointType.Spine]: { type: JointType.Spine, position: { x: 0, y: y + 1, z: 0 }, confidence: 1 },
      [JointType.LeftArm]: {
        type: JointType.LeftArm,
        position: { x: -1, y: y + 1.5, z: 0 },
        confidence: 1
      }
    } as any,
    hierarchy: {
      [JointType.Hips]: [JointType.Spine],
      [JointType.Spine]: [JointType.LeftArm],
      [JointType.LeftArm]: []
    } as any
  };
}

function populateBuffers(msg: RigMessage): void {
  const { indicesBuffer, weightsBuffer } = msg.payload;
  const indices = new Uint16Array(indicesBuffer);
  const weights = new Float32Array(weightsBuffer);
  const vertexCount = weights.length / 4;

  for (let i = 0; i < vertexCount; i++) {
    indices[i * 4 + 0] = 0;
    indices[i * 4 + 1] = 1;
    indices[i * 4 + 2] = 0;
    indices[i * 4 + 3] = 0;
    weights[i * 4 + 0] = 0.75;
    weights[i * 4 + 1] = 0.25;
    weights[i * 4 + 2] = 0;
    weights[i * 4 + 3] = 0;
  }
}

function buildRigReply(msg: RigMessage, version: number): any {
  populateBuffers(msg);
  const sessionId = msg.sessionId;
  const rig = makeRig(version);

  if (msg.payload.mode === 'TRANSFERABLE') {
    return {
      type: 'RIG_DONE',
      msgId: msg.msgId,
      sessionId,
      payload: {
        rig,
        sessionId,
        indicesBuffer: msg.payload.indicesBuffer,
        weightsBuffer: msg.payload.weightsBuffer
      }
    };
  }

  return { type: 'RIG_DONE', msgId: msg.msgId, sessionId, payload: { rig, sessionId } };
}

function makeMesh(vertexCount = 4): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3 + 0] = i;
    positions[i * 3 + 1] = i * 0.5;
    positions[i * 3 + 2] = 0;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
}

function sumVertexWeights(geometry: THREE.BufferGeometry, vertexCount: number): number[] {
  const attr = geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
  const array = attr.array as Float32Array;
  const sums: number[] = [];
  for (let i = 0; i < vertexCount; i++) {
    sums.push(
      array[i * 4 + 0] + array[i * 4 + 1] + array[i * 4 + 2] + array[i * 4 + 3]
    );
  }
  return sums;
}

describe('RiggingEngine', () => {
  beforeEach(() => {
    MockWorker.reset();
    // @ts-ignore
    global.Worker = MockWorker;
  });

  afterEach(() => {
    // @ts-ignore
    delete global.Worker;
  });

  it('should initialize and run autoRig', async () => {
    const engine = new RiggingEngine();
    await engine.init();

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array([0, 0, 0, 1, 1, 1]);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());

    const skinnedMesh = await engine.autoRig(mesh);
    const expected = MockWorker.instances[0].queuedRigs.length;

    expect(expected).toBe(0); // auto mode replies without queueing
    expect(skinnedMesh).toBeInstanceOf(THREE.SkinnedMesh);
    expect(skinnedMesh.geometry.getAttribute('skinIndex')).toBeDefined();
    expect(skinnedMesh.geometry.getAttribute('skinWeight')).toBeDefined();

    expect(skinnedMesh.skeleton.bones.map((b) => b.name)).toEqual(
      expect.arrayContaining([JointType.Hips, JointType.Spine, JointType.LeftArm])
    );
    expect(skinnedMesh.skeleton.bones[0].name).toBe(JointType.Hips);

    const spine = skinnedMesh.skeleton.bones.find((b) => b.name === JointType.Spine)!;
    expect(spine.parent?.name).toBe(JointType.Hips);

    const arm = skinnedMesh.skeleton.bones.find((b) => b.name === JointType.LeftArm)!;
    expect(arm.parent?.name).toBe(JointType.Spine);
    // Child bone positions are parent-relative (MeshAnalyzer behaviour).
    expect(arm.position.x).toBeCloseTo(-1);
    expect(arm.position.y).toBeCloseTo(0.5);
  });

  it('normalizes skin weights to 1 on the success path', async () => {
    const engine = new AutoRigger();
    await engine.init();

    const mesh = makeMesh(8);
    const skinned = await engine.rig(mesh);

    const sums = sumVertexWeights(skinned.geometry, 8);
    for (const sum of sums) {
      expect(sum).toBeCloseTo(1, 6);
    }

    const indexAttr = skinned.geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
    expect(indexAttr.itemSize).toBe(4);
    expect(indexAttr.count).toBe(8);
    expect(skinned.geometry.getAttribute('skinWeight')).toBeDefined();
  });

  it('leaves isInitialized false when init fails and can retry successfully', async () => {
    MockWorker.initFailuresRemaining = 1;

    const engine = new AutoRigger();
    await expect(engine.init()).rejects.toThrow(/Initialization failed/);
    expect(engine.initialized).toBe(false);

    // Rigging before a successful init must fail with a clear message.
    await expect(engine.rig(makeMesh())).rejects.toThrow(/not initialized/i);

    // Retry succeeds.
    await engine.init();
    expect(engine.initialized).toBe(true);

    const skinned = await engine.rig(makeMesh());
    expect(skinned).toBeInstanceOf(THREE.SkinnedMesh);
    expect(engine.getActiveSkeleton()).toBeDefined();
    expect(engine.pendingRequestCount).toBe(0);

    // The failed worker must have been terminated, a fresh one used.
    expect(MockWorker.instances.length).toBe(2);
    expect(MockWorker.instances[0].terminated).toBe(true);
  });

  it('accepts only the later result when two rigs run concurrently', async () => {
    MockWorker.autoRig = false;

    const engine = new AutoRigger();
    await engine.init();
    const worker = MockWorker.last;

    const first = engine.rig(makeMesh());
    const second = engine.rig(makeMesh());

    // Both requests are in flight.
    expect(worker.queuedRigs.length).toBe(2);

    let firstError: unknown;
    first.catch((err) => {
      firstError = err;
    });

    // Deliver the newer (second) session first.
    worker.flushRig(1);
    const skinned = await second;

    // Now deliver the stale first result.
    worker.flushRig(0);
    await Promise.resolve();
    await Promise.resolve();

    // The stale session was rejected, not resolved.
    await expect(first).rejects.toBeInstanceOf(RigSessionCancelledError);
    expect(firstError).toBeInstanceOf(RigSessionCancelledError);

    // activeSkeleton belongs to the second (accepted) session only.
    expect(engine.getActiveSkeleton()).toBe(skinned.skeleton);
    expect(engine.getActiveSkeleton()!.bones[0].position.y).toBeCloseTo(2);

    // The stale reply must not have installed its own skeleton.
    expect(engine.getActiveSkeleton()!.bones[0].position.y).not.toBeCloseTo(1);

    expect(engine.pendingRequestCount).toBe(0);
  });

  it('drops a late stale reply without touching activeSkeleton', async () => {
    MockWorker.autoRig = false;

    const engine = new AutoRigger();
    await engine.init();
    const worker = MockWorker.last;

    const first = engine.rig(makeMesh());
    const second = engine.rig(makeMesh());
    first.catch(() => undefined);

    worker.flushRig(1);
    const skinned = await second;
    const applied = engine.getActiveSkeleton();

    // Stale reply arrives after the newer session already committed.
    worker.flushRig(0);
    await Promise.resolve();

    expect(engine.getActiveSkeleton()).toBe(applied);
    expect(engine.getActiveSkeleton()).toBe(skinned.skeleton);
    expect(engine.pendingRequestCount).toBe(0);
  });

  it('rolls back and stays usable after a worker ERROR', async () => {
    MockWorker.autoRig = false;

    const engine = new AutoRigger();
    await engine.init();
    const worker = MockWorker.last;

    const failing = engine.rig(makeMesh());
    worker.flushRig(0, (msg) => ({
      type: 'ERROR',
      payload: 'inference exploded',
      msgId: msg.msgId,
      sessionId: msg.sessionId
    }));

    await expect(failing).rejects.toThrow(/inference exploded/);
    expect(engine.getActiveSkeleton()).toBeUndefined();
    expect(engine.pendingRequestCount).toBe(0);

    // Next rig succeeds cleanly.
    const ok = engine.rig(makeMesh());
    worker.flushRig(1);
    const skinned = await ok;

    expect(skinned).toBeInstanceOf(THREE.SkinnedMesh);
    expect(engine.getActiveSkeleton()).toBe(skinned.skeleton);
    expect(engine.pendingRequestCount).toBe(0);
  });

  it('keeps the previous skeleton when a later rig fails', async () => {
    MockWorker.autoRig = false;

    const engine = new AutoRigger();
    await engine.init();
    const worker = MockWorker.last;

    const good = engine.rig(makeMesh());
    worker.flushRig(0);
    const goodSkinned = await good;
    const previous = engine.getActiveSkeleton();
    expect(previous).toBe(goodSkinned.skeleton);

    const bad = engine.rig(makeMesh());
    worker.flushRig(1, (msg) => ({
      type: 'ERROR',
      payload: 'boom',
      msgId: msg.msgId,
      sessionId: msg.sessionId
    }));
    await expect(bad).rejects.toThrow(/boom/);

    // Rollback: no half-built mesh, previous skeleton intact.
    expect(engine.getActiveSkeleton()).toBe(previous);
  });

  it('rejects a result that is missing skeleton data and frees buffers', async () => {
    MockWorker.autoRig = false;

    const engine = new AutoRigger();
    await engine.init();
    const worker = MockWorker.last;

    const pending = engine.rig(makeMesh());
    const msg = worker.queuedRigs[0];
    populateBuffers(msg);

    // Reply without any rig data, but with populated buffers.
    worker.flushRig(0, () => ({
      type: 'RIG_DONE',
      msgId: msg.msgId,
      sessionId: msg.sessionId,
      payload: {
        sessionId: msg.sessionId,
        indicesBuffer: msg.payload.indicesBuffer,
        weightsBuffer: msg.payload.weightsBuffer
      }
    }));

    await expect(pending).rejects.toThrow(/Skeleton data missing/i);
    expect(engine.getActiveSkeleton()).toBeUndefined();
    expect(engine.pendingRequestCount).toBe(0);

    // The rejected session's buffers were wiped.
    const weights = new Float32Array(msg.payload.weightsBuffer);
    expect(Array.from(weights).every((v) => v === 0)).toBe(true);
  });

  it('rejects a result with missing (transfer-failed) skin buffers', async () => {
    MockWorker.autoRig = false;

    const engine = new AutoRigger();
    await engine.init();
    const worker = MockWorker.last;

    const pending = engine.rig(makeMesh());
    const msg = worker.queuedRigs[0];

    worker.flushRig(0, () => ({
      type: 'RIG_DONE',
      msgId: msg.msgId,
      sessionId: msg.sessionId,
      payload: { sessionId: msg.sessionId, rig: makeRig(1) }
    }));

    await expect(pending).rejects.toThrow(/did not return its skin buffers/i);
    expect(engine.getActiveSkeleton()).toBeUndefined();
    expect(engine.pendingRequestCount).toBe(0);
  });

  it('rejects a reply whose session id does not match the request', async () => {
    MockWorker.autoRig = false;

    const engine = new AutoRigger();
    await engine.init();
    const worker = MockWorker.last;

    const pending = engine.rig(makeMesh());
    const msg = worker.queuedRigs[0];

    worker.flushRig(0, () => {
      populateBuffers(msg);
      return {
        type: 'RIG_DONE',
        msgId: msg.msgId,
        sessionId: msg.sessionId + 99,
        payload: { sessionId: msg.sessionId + 99, rig: makeRig(1) }
      };
    });

    await expect(pending).rejects.toThrow(/session mismatch/i);
    expect(engine.getActiveSkeleton()).toBeUndefined();
    expect(engine.pendingRequestCount).toBe(0);
  });

  it('cancelRig rejects the in-flight session and leaves no pending requests', async () => {
    MockWorker.autoRig = false;

    const engine = new AutoRigger();
    await engine.init();
    const worker = MockWorker.last;

    const pending = engine.rig(makeMesh());
    expect(engine.pendingRequestCount).toBe(1);

    engine.cancelRig();

    await expect(pending).rejects.toBeInstanceOf(RigSessionCancelledError);
    expect(engine.pendingRequestCount).toBe(0);
    expect(engine.getActiveSkeleton()).toBeUndefined();

    // A late worker reply for the cancelled session is ignored.
    worker.flushRig(0);
    await Promise.resolve();
    expect(engine.getActiveSkeleton()).toBeUndefined();
    expect(engine.pendingRequestCount).toBe(0);

    // The engine is still usable afterwards.
    MockWorker.autoRig = true;
    const skinned = await engine.rig(makeMesh());
    expect(skinned).toBeInstanceOf(THREE.SkinnedMesh);
    expect(engine.getActiveSkeleton()).toBe(skinned.skeleton);
  });

  it('cancel() is an alias for cancelRig()', async () => {
    MockWorker.autoRig = false;

    const engine = new AutoRigger();
    await engine.init();

    const pending = engine.rig(makeMesh());
    expect(engine.pendingRequestCount).toBe(1);

    engine.cancel();
    await expect(pending).rejects.toBeInstanceOf(RigSessionCancelledError);
    expect(engine.pendingRequestCount).toBe(0);
  });

  it('rejects rigging without a position attribute', async () => {
    const engine = new AutoRigger();
    await engine.init();

    const geometry = new THREE.BufferGeometry();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());

    await expect(engine.rig(mesh)).rejects.toThrow(/position attribute/i);
    expect(engine.pendingRequestCount).toBe(0);
  });

  describe('SharedArrayBuffer mode', () => {
    beforeEach(() => {
      // @ts-ignore
      global.crossOriginIsolated = true;
    });

    afterEach(() => {
      // @ts-ignore
      delete global.crossOriginIsolated;
    });

    it('binds successfully with shared memory and normalizes weights', async () => {
      MockWorker.autoRig = false;

      const engine = new AutoRigger();
      await engine.init();
      const worker = MockWorker.last;

      const pending = engine.rig(makeMesh(4));
      const msg = worker.queuedRigs[0];
      expect(msg.payload.mode).toBe('SAB');
      expect(msg.payload.posBuffer).toBeInstanceOf(SharedArrayBuffer);

      worker.flushRig(0);
      const skinned = await pending;

      expect(skinned).toBeInstanceOf(THREE.SkinnedMesh);
      for (const sum of sumVertexWeights(skinned.geometry, 4)) {
        expect(sum).toBeCloseTo(1, 6);
      }
      expect(engine.getActiveSkeleton()).toBe(skinned.skeleton);
      expect(engine.pendingRequestCount).toBe(0);
    });

    it('wipes shared buffers and keeps activeSkeleton on failure', async () => {
      MockWorker.autoRig = false;

      const engine = new AutoRigger();
      await engine.init();
      const worker = MockWorker.last;

      const pending = engine.rig(makeMesh(4));
      const msg = worker.queuedRigs[0];
      populateBuffers(msg);

      const weights = new Float32Array(msg.payload.weightsBuffer);
      expect(weights.some((v) => v !== 0)).toBe(true);

      worker.flushRig(0, () => ({
        type: 'ERROR',
        payload: 'sab failure',
        msgId: msg.msgId,
        sessionId: msg.sessionId
      }));

      await expect(pending).rejects.toThrow(/sab failure/);
      expect(engine.getActiveSkeleton()).toBeUndefined();

      // Rollback zeroed the shared weight buffer in place.
      expect(Array.from(weights).every((v) => v === 0)).toBe(true);
      expect(Array.from(new Uint16Array(msg.payload.indicesBuffer)).every((v) => v === 0)).toBe(
        true
      );
    });
  });
});
