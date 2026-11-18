/**
 * Job-supersede guarantees for the main-thread mesh-export client:
 *   - a result arriving after a newer export was started must be dropped
 *   - cancel drops both results and progress of the old job
 *   - a canceled job can be followed by a fresh, fully-delivered export
 *
 * mesh.client.ts keeps its Worker as a module-level singleton, so these tests
 * reuse that one worker instance and drive it through FakeWorker.last.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestMeshExport, cancelMeshExport } from '../src/mesh/mesh.client';
import type { MeshExportResult } from '../src/mesh/mesh.client';

interface ReceivedMsg {
  type: string;
  jobId?: number;
}

class FakeWorker {
  static instance: FakeWorker | null = null;
  onmessage: ((e: { data: any }) => void) | null = null;
  posted: ReceivedMsg[] = [];

  constructor(_url: unknown, _options?: unknown) {
    FakeWorker.instance = this;
  }

  postMessage(msg: ReceivedMsg) {
    this.posted.push(msg);
  }

  emit(data: any) {
    this.onmessage?.({ data });
  }
}

// Install before any requestMeshExport call: the client constructs its worker
// singleton lazily on first use and never reconstructs it, so replacing the
// global per-test would leave the singleton pointing at a discarded class.
(globalThis as any).Worker = FakeWorker;

const CELLS = [{ h3: '89283082837ffff', metric: 42 }];
const OPTS = { footprintMm: 100, maxHeightMm: 20, baseThicknessMm: 2 };
const FORMATS = { stl: true, obj: false };

function makeResult(jobId: number, overrides: Partial<MeshExportResult> = {}): MeshExportResult {
  return {
    type: 'result',
    jobId,
    empty: false,
    triangleCount: 12,
    dims: { x: 10, y: 10, z: 5 },
    report: {
      triangles: 12,
      mergedVertices: 8,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      degenerateTriangles: 0,
      windingConsistent: true,
      volumeMm3: 123,
      watertight: true,
      isSolid: true,
    },
    ...overrides,
  };
}

/** The singleton worker created on the first requestMeshExport call. */
function worker(): FakeWorker {
  const w = FakeWorker.instance;
  assert.ok(w, 'a worker should have been created by requestMeshExport');
  return w;
}

/** Job id of the most recent 'build' message (the worker history is shared). */
function latestBuildJobId(w: FakeWorker): number {
  const builds = w.posted.filter((m) => m.type === 'build');
  const id = builds.at(-1)?.jobId;
  assert.ok(typeof id === 'number');
  return id;
}

test('a stale result from an older export job is dropped, the newer one wins', () => {
  const eventsA: string[] = [];
  requestMeshExport(CELLS, OPTS, FORMATS, {
    onProgress: (f) => eventsA.push(`progress:${f}`),
    onResult: () => eventsA.push('result'),
    onError: (m) => eventsA.push(`error:${m}`),
  });
  const w = worker();
  // requestMeshExport immediately reports progress 0; the test cares about
  // worker-emitted messages only, so reset expectations after setup.
  eventsA.length = 0;
  const jobA = latestBuildJobId(w);

  const eventsB: string[] = [];
  requestMeshExport(CELLS, OPTS, FORMATS, {
    onProgress: (f) => eventsB.push(`progress:${f}`),
    onResult: () => eventsB.push('result'),
  });
  eventsB.length = 0;
  const jobB = w.posted[1].jobId!;
  assert.notEqual(jobA, jobB);

  // Old job resolves late: neither progress nor result may reach any callback.
  w.emit({ type: 'progress', jobId: jobA, fraction: 0.5 });
  w.emit(makeResult(jobA));
  assert.deepEqual(eventsA, [], 'superseded job callbacks must never fire');
  assert.deepEqual(eventsB, []);

  // The new job's messages are delivered normally.
  w.emit({ type: 'progress', jobId: jobB, fraction: 0.75 });
  w.emit(makeResult(jobB));
  assert.deepEqual(eventsB, ['progress:0.75', 'result']);
});

test('cancel drops the old job’s progress and result', () => {
  const events: string[] = [];
  requestMeshExport(CELLS, OPTS, FORMATS, {
    onProgress: (f) => events.push(`progress:${f}`),
    onResult: () => events.push('result'),
    onError: (m) => events.push(`error:${m}`),
  });
  const w = worker();
  events.length = 0;
  const jobId = latestBuildJobId(w);

  cancelMeshExport();
  assert.deepEqual(w.posted.at(-1), { type: 'cancel' }, 'worker must be told to cancel');

  w.emit({ type: 'progress', jobId, fraction: 0.9 });
  w.emit(makeResult(jobId));
  w.emit({ type: 'error', jobId, message: 'boom' });
  assert.deepEqual(events, [], 'no stale progress/result/error after cancel');
});

test('a fresh export after cancel delivers its own result and reports empty builds', () => {
  cancelMeshExport(); // start from a canceled generation

  const progress: number[] = [];
  let received: MeshExportResult | null = null;
  requestMeshExport(CELLS, OPTS, FORMATS, {
    onProgress: (f) => progress.push(f),
    onResult: (r) => { received = r; },
  });
  const w = worker();
  progress.length = 0; // discard the synchronous progress-0 reset
  const jobId = latestBuildJobId(w);

  w.emit({ type: 'progress', jobId, fraction: 0.42 });
  const emptyResult = makeResult(jobId, {
    empty: true,
    triangleCount: 0,
    stl: undefined,
    report: {
      triangles: 0, mergedVertices: 0, boundaryEdges: 0, nonManifoldEdges: 0,
      degenerateTriangles: 0, windingConsistent: true, volumeMm3: 0,
      watertight: true, isSolid: false,
    },
  });
  w.emit(emptyResult);

  assert.deepEqual(progress, [0.42]);
  assert.ok(received);
  assert.equal(received!.empty, true, 'empty-mesh results are still delivered, just without a payload');
  assert.equal(received!.stl, undefined, 'no STL bytes means the panel cannot download a file');
});
