import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { AutoRigger, RiggingEngine } from '../src/core/AutoRigger';
import { JointType } from '../src/types';

/**
 * Configurable mock Worker. Behavior is driven by `workerState` so each test
 * can simulate init failures, rig failures, slow responses, and error events.
 */
const workerState = {
  instances: [] as MockWorker[],
  throwOnConstruct: false,
  failInit: false,
  failRigCount: 0,
  rigDelay: 5,
  /** FIFO of Hips-y markers; lets tests tell rig sessions apart. */
  rigMarkers: [] as number[],
};

function resetWorkerState() {
  workerState.instances = [];
  workerState.throwOnConstruct = false;
  workerState.failInit = false;
  workerState.failRigCount = 0;
  workerState.rigDelay = 5;
  workerState.rigMarkers = [];
}

class MockWorker {
  onmessage: ((e: { data: any }) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  terminated = false;
  inFlight = 0;
  maxInFlight = 0;

  constructor() {
    if (workerState.throwOnConstruct) {
      throw new Error('Worker construction failed');
    }
    workerState.instances.push(this);
  }

  terminate() {
    this.terminated = true;
  }

  postMessage(data: any) {
    if (data.type === 'INIT') {
      setTimeout(() => {
        if (workerState.failInit) {
          this.onmessage?.({ data: { type: 'ERROR', payload: 'init boom', msgId: data.msgId } });
        } else {
          this.onmessage?.({ data: { type: 'INIT_DONE', msgId: data.msgId } });
        }
      }, 5);
    } else if (data.type === 'RIG') {
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      setTimeout(() => {
        this.inFlight--;
        if (workerState.failRigCount > 0) {
          workerState.failRigCount--;
          this.onmessage?.({ data: { type: 'ERROR', payload: 'rig boom', msgId: data.msgId } });
          return;
        }
        const marker = workerState.rigMarkers.length ? workerState.rigMarkers.shift()! : 0;
        this.onmessage?.({
          data: {
            type: 'RIG_DONE',
            msgId: data.msgId,
            payload: {
              rig: {
                joints: {
                  [JointType.Hips]: { type: JointType.Hips, position: { x: 0, y: marker, z: 0 }, confidence: 1 }
                },
                hierarchy: {
                  [JointType.Hips]: []
                }
              },
              indicesBuffer: data.payload.indicesBuffer,
              weightsBuffer: data.payload.weightsBuffer
            }
          }
        });
      }, workerState.rigDelay);
    }
  }
}

function makeMesh(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array([0, 0, 0, 1, 1, 1]);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
}

describe('RiggingEngine', () => {
  beforeEach(() => {
    resetWorkerState();
    // @ts-ignore
    global.Worker = MockWorker;
  });

  it('should initialize and run autoRig', async () => {
    const engine = new RiggingEngine();
    await engine.init();

    const skinnedMesh = await engine.autoRig(makeMesh());

    expect(skinnedMesh).toBeInstanceOf(THREE.SkinnedMesh);
    expect(skinnedMesh.geometry.getAttribute('skinIndex')).toBeDefined();
    expect(skinnedMesh.geometry.getAttribute('skinWeight')).toBeDefined();

    // Check that one bone was added
    expect(skinnedMesh.skeleton.bones.length).toBe(1);
    expect(skinnedMesh.skeleton.bones[0].name).toBe(JointType.Hips);
  });

  it('keeps IK target setting and animate working after a successful rig', async () => {
    const engine = new RiggingEngine();
    await engine.init();
    const skinnedMesh = await engine.rig(makeMesh());

    engine.setIKTarget({ joint: JointType.Hips, position: new THREE.Vector3(1, 1, 1), influence: 1 });
    expect(() => engine.animate()).not.toThrow();
    expect(engine.getActiveSkeleton()).toBe(skinnedMesh.skeleton);
  });

  describe('init lifecycle', () => {
    it('does not rebuild the worker when init is called again after success', async () => {
      const engine = new RiggingEngine();
      await engine.init();
      await engine.init();
      expect(workerState.instances.length).toBe(1);
    });

    it('shares a single in-flight init across concurrent calls', async () => {
      const engine = new RiggingEngine();
      await Promise.all([engine.init(), engine.init(), engine.init()]);
      expect(workerState.instances.length).toBe(1);
    });

    it('rejects rig() with a clear error when never initialized', async () => {
      const engine = new RiggingEngine();
      await expect(engine.rig(makeMesh())).rejects.toThrow(/not initialized/);
    });

    it('fails init clearly when the worker cannot be constructed, then recovers on retry', async () => {
      workerState.throwOnConstruct = true;
      const engine = new RiggingEngine();

      await expect(engine.init()).rejects.toThrow(/Failed to create rigging worker/);

      // rig() must fail fast with a clear error, not hang.
      await expect(engine.rig(makeMesh())).rejects.toThrow(/not initialized/);

      // Recovery: a later init() succeeds and rigging works.
      workerState.throwOnConstruct = false;
      await engine.init();
      const skinnedMesh = await engine.rig(makeMesh());
      expect(skinnedMesh).toBeInstanceOf(THREE.SkinnedMesh);
      // Exactly one live worker: the failed construction registered none.
      expect(workerState.instances.length).toBe(1);
    });

    it('fails init when the worker reports an INIT error, then recovers on retry', async () => {
      workerState.failInit = true;
      const engine = new RiggingEngine();

      await expect(engine.init()).rejects.toThrow(/init boom/);
      await expect(engine.rig(makeMesh())).rejects.toThrow(/not initialized/);

      workerState.failInit = false;
      await engine.init();
      await expect(engine.rig(makeMesh())).resolves.toBeInstanceOf(THREE.SkinnedMesh);
    });
  });

  describe('concurrent rig sessions', () => {
    it('serializes concurrent rig calls and never mixes their results', async () => {
      const engine = new RiggingEngine();
      await engine.init();

      workerState.rigMarkers = [1, 2];
      const [first, second] = await Promise.all([engine.rig(makeMesh()), engine.rig(makeMesh())]);

      // Each session got its own skeleton, in invocation order.
      expect(first.skeleton.bones[0].position.y).toBe(1);
      expect(second.skeleton.bones[0].position.y).toBe(2);
      expect(first.skeleton).not.toBe(second.skeleton);

      // At most one RIG request was in flight at any moment.
      expect(workerState.instances[0].maxInFlight).toBe(1);

      // animate() drives the most recent successful session's skeleton.
      expect(engine.getActiveSkeleton()).toBe(second.skeleton);
    });

    it('keeps the queue alive when one of several queued sessions fails', async () => {
      const engine = new RiggingEngine();
      await engine.init();

      workerState.failRigCount = 1;
      workerState.rigMarkers = [7, 8];

      const results = await Promise.allSettled([
        engine.rig(makeMesh()),
        engine.rig(makeMesh()),
        engine.rig(makeMesh()),
      ]);

      expect(results[0].status).toBe('rejected');
      expect((results[0] as PromiseRejectedResult).reason.message).toMatch(/rig boom/);
      expect(results[1].status).toBe('fulfilled');
      expect(results[2].status).toBe('fulfilled');

      const second = (results[1] as PromiseFulfilledResult<THREE.SkinnedMesh>).value;
      const third = (results[2] as PromiseFulfilledResult<THREE.SkinnedMesh>).value;
      expect(second.skeleton.bones[0].position.y).toBe(7);
      expect(third.skeleton.bones[0].position.y).toBe(8);

      // The failed session did not replace the active skeleton.
      expect(engine.getActiveSkeleton()).toBe(third.skeleton);
    });
  });

  describe('failure recovery', () => {
    it('returns to a riggable state after a worker-reported rig failure', async () => {
      const engine = new RiggingEngine();
      await engine.init();

      workerState.failRigCount = 1;
      await expect(engine.rig(makeMesh())).rejects.toThrow(/rig boom/);

      // Engine accepts a new task right away.
      workerState.rigMarkers = [3];
      const skinnedMesh = await engine.rig(makeMesh());
      expect(skinnedMesh.skeleton.bones[0].position.y).toBe(3);
      expect(engine.getActiveSkeleton()).toBe(skinnedMesh.skeleton);
    });

    it('does not leak bones, weights, or IK targets from a failed session', async () => {
      const engine = new RiggingEngine();
      await engine.init();

      workerState.rigMarkers = [1];
      const good = await engine.rig(makeMesh());
      engine.setIKTarget({ joint: JointType.Hips, position: new THREE.Vector3(0, 1, 0), influence: 1 });

      workerState.failRigCount = 1;
      await expect(engine.rig(makeMesh())).rejects.toThrow(/rig boom/);

      // Last good skeleton is still the one animate() drives.
      expect(engine.getActiveSkeleton()).toBe(good.skeleton);
      // IK targets bound to the superseded session were cleared.
      expect((engine as any).ikSolver.targetCount).toBe(0);
      expect(() => engine.animate()).not.toThrow();
    });

    it('rejects rig() clearly for geometry without a position attribute and stays riggable', async () => {
      const engine = new RiggingEngine();
      await engine.init();

      const emptyMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
      await expect(engine.rig(emptyMesh)).rejects.toThrow(/position/);

      // No worker round-trip happened for the invalid mesh, and the engine still works.
      workerState.rigMarkers = [4];
      const skinnedMesh = await engine.rig(makeMesh());
      expect(skinnedMesh.skeleton.bones[0].position.y).toBe(4);
    });

    it('rejects in-flight and future rig calls when the worker crashes, and recovers after re-init', async () => {
      const engine = new RiggingEngine();
      await engine.init();

      const rigPromise = engine.rig(makeMesh());
      // Simulate a hard worker crash while the RIG request is in flight.
      workerState.instances[0].onerror?.({ message: 'worker crashed' });

      await expect(rigPromise).rejects.toThrow(/terminated unexpectedly/);
      // Subsequent calls fail fast with a clear error instead of hanging.
      await expect(engine.rig(makeMesh())).rejects.toThrow(/not initialized/);

      // Re-initializing brings the engine back.
      await engine.init();
      workerState.rigMarkers = [5];
      const skinnedMesh = await engine.rig(makeMesh());
      expect(skinnedMesh.skeleton.bones[0].position.y).toBe(5);
    });
  });
});
