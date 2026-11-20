/**
 * Loads the chunk loading sources into a Node vm context with a fake WebGL
 * context, a fake worker pool and a tiny world, so loading can be driven one
 * frame at a time and its GPU buffers can be counted.
 *
 * This is not a browser: it only provides what the chunk loading code touches.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

const SOURCES = [
  'src/libraries/noise.js',
  'src/libraries/pseudo-random.js',
  'src/other/math.js',
  'src/graphics-3d/blocks.js',
  'src/graphics-3d/create-cube.js',
  'src/graphics-3d/atlas.js',
  'src/graphics-3d/gl-code.js',
  'src/graphics-3d/webgl.js',
  'src/graphics-3d/mesh-builder.js',
  'src/graphics-3d/chunk-mesher.js',
  'src/game/block-registry.js',
  'src/game/terrain.js',
  'src/game/generate.js',
  'src/game/chunk-edits.js',
  'src/game/chunk-tasks.js',
  'src/game/frame-budget.js',
  'src/game/chunk.js',
  'src/game/chunk-worker-pool.js',
  'src/game/chunk-loader.js'
];

/**
 * A worker pool stand-in whose results the test delivers by hand. With
 * inline set, tasks run through the real runChunkTask instead, like a page
 * where workers can't be created.
 */
class FakeWorkerPool {
  constructor(capacity = 6, inline = false) {
    this.pending = []; // {task, onDone, delivered}
    this.submitted = []; // every task, in submission order
    this.capacity = capacity; // tasks the pool will take before it starts queueing
    this.inline = inline; // run tasks on the main thread through runInline
    this.inlineQueue = []; // {task, onDone} waiting for the main thread
    this.runTask = null; // runs a task in the context, set by createWorld
  }

  getWorkerCount() {
    return this.inline ? 0 : 1;
  }

  hasCapacity() {
    if (this.inline) return this.inlineQueue.length === 0;

    return this.pending.length < this.capacity;
  }

  hasInlineTask() {
    return this.inlineQueue.length > 0;
  }

  runInline() {
    const { task, onDone } = this.inlineQueue.shift();

    try {
      onDone(null, this.runTask(task));
    } catch (error) {
      onDone(error, null);
    }
  }

  submit(task, onDone) {
    if (this.inline) {
      this.inlineQueue.push({ task: task, onDone: onDone });
      this.submitted.push({ task: task, onDone: onDone, delivered: false });
      return;
    }

    const job = { task: task, onDone: onDone, delivered: false };
    this.pending.push(job);
    this.submitted.push(job);
  }

  /**
   * Deliver the oldest task that matches, or any task when no predicate is given
   * @param {function(Object): boolean} predicate Receives the job
   */
  take(predicate = () => true) {
    const index = this.pending.findIndex(job => !job.delivered && predicate(job));
    if (index < 0) return null;

    const [job] = this.pending.splice(index, 1);
    job.delivered = true;
    return job;
  }

  deliver(job, error, result) {
    job.onDone(error ?? null, result);
  }

  /** Forget the tasks that haven't been delivered yet */
  clear() {
    this.pending = [];
  }
}

/**
 * A WebGL stand-in that counts buffers so leaks are visible
 */
function createFakeGl() {
  const counts = { created: 0, deleted: 0 };
  const gl = {
    counts: counts,
    createBuffer() {
      counts.created++;
      return { id: counts.created };
    },
    deleteBuffer(buffer) {
      if (buffer != null) counts.deleted++;
    },
    bindBuffer() {},
    bufferData() {},
    uniform1i() {},
    uniform1f() {},
    enable() {},
    disable() {},
    depthMask() {},
    drawElements() {}
  };

  return gl;
}

/**
 * Create a fresh context with a tiny world and a fake worker pool
 * @param {Object} options Options
 * @param {number} options.renderDistance Initial render distance
 * @param {string} options.mode Generation mode
 * @param {boolean} options.inline Run real generation and meshing on the main thread, like a page without workers
 * @returns {Object} Context and helpers
 */
function createWorld({ renderDistance = 1, mode = 'void', inline = false } = {}) {
  const gl = createFakeGl();
  const pool = new FakeWorkerPool(6, inline);
  const context = vm.createContext({
    console: console,
    performance: performance,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Uint8Array: Uint8Array,
    Uint32Array: Uint32Array,
    Int32Array: Int32Array,
    Float32Array: Float32Array,
    Float64Array: Float64Array,
    Map: Map,
    Set: Set,
    Math: Math,
    JSON: JSON,
    navigator: { hardwareConcurrency: 4 },
    Worker: undefined,
    gl: gl,
    glCache: { uAlphaMode: 0, uPos: 0, uDist: 0 },
    sceneTarget: { isMultisampled: () => false },
    player: { x: 8, y: 2, z: 8 },
    seedPhrase: 'test-seed',
    Chunks: {},
    LENGTH: 16,
    WIDTH: 16,
    HEIGHT: 8,
    data: {
      renderDistance: renderDistance,
      renderedChunks: 0,
      chunksGenerated: 0,
      mode: mode,
      edits: null,
      furthestChunk: 0
    }
  });

  context.__pool = pool;
  context.__gl = gl;

  for (const relative of SOURCES) {
    const file = path.join(ROOT, relative);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }

  // A loaded atlas: lets meshing be requested on the main thread
  vm.runInContext('atlasTileLayers = new Uint8Array(1)', context);
  vm.runInContext('data.edits = new ChunkEdits()', context);
  vm.runInContext('chunkWorkers = __pool', context);

  // Inline tasks run the real chunk task code inside the context, like a page
  // where workers can't be created
  pool.runTask = task => {
    context.__task = task;
    return vm.runInContext('runChunkTask(__task).result', context);
  };

  /**
   * Run frames, delivering worker tasks through respond, until the loader is quiet.
   * Use runFrames instead when a task is expected to keep failing forever.
   * @param {function(Object, number): Object|Error} respond Supplies a result or an Error for a task
   * @param {Object} options Options passed to settle
   */
  const drive = (respond, options = {}) => settle({ respond, ...options });

  /**
   * Run one frame of chunk loading
   */
  const frame = () => vm.runInContext('generateRadius()', context);

  /**
   * Run a fixed number of frames, delivering every task through respond
   * @param {number} count Number of frames
   * @param {function(Object, number): Object|Error} respond Supplies a result or an Error for a task
   */
  const runFrames = (count, respond = defaultRespond) => {
    for (let i = 0; i < count; i++) {
      frame();

      let job;
      while ((job = pool.take()) != null) {
        const answer = respond(job.task, i);
        if (answer instanceof Error) pool.deliver(job, answer, null);
        else pool.deliver(job, null, answer);
      }
    }
  };

  /**
   * Read a snapshot of what the loader and the fake GPU hold
   * @returns {Object} Counts used by the tests
   */
  const state = () => ({
    chunks: vm.runInContext('__chunkCount()', context),
    complete: vm.runInContext('__countFlag("complete")', context),
    calculating: vm.runInContext('__countFlag("calculating")', context),
    pending: vm.runInContext('pendingChunks.size', context),
    failed: vm.runInContext('failedChunks.size', context),
    created: gl.counts.created,
    deleted: gl.counts.deleted,
    live: gl.counts.created - gl.counts.deleted
  });

  /**
   * Run frames until the loader has nothing left to submit or adopt, delivering
   * whatever the workers return through respond. Retried chunks are waited for,
   * so quietFrames must be longer than the loader's longest retry wait when a
   * response is expected to eventually succeed.
   * @param {Object} options Options
   * @param {number} options.maxFrames Safety limit
   * @param {number} options.quietFrames Frames with no work before stopping
   * @param {function(Object, number): Object|Error} options.respond Supplies a result or an Error for a task
   * @returns {number} Frames run
   */
  const settle = ({ maxFrames = 2000, quietFrames = 4, respond = defaultRespond } = {}) => {
    let quiet = 0;

    for (let i = 0; i < maxFrames; i++) {
      frame();

      let did = 0;
      let job;
      while ((job = pool.take()) != null) {
        const answer = respond(job.task, i);
        if (answer instanceof Error) pool.deliver(job, answer, null);
        else pool.deliver(job, null, answer);
        did++;
      }

      quiet = (did === 0 && pool.pending.length === 0 && !hasScheduledWork()) ? quiet + 1 : 0;
      if (quiet >= quietFrames) return i + 1;
    }

    throw new Error('World did not settle');
  };

  // Helpers the tests use through the context, so they see the loader's globals
  vm.runInContext(`
    function __chunkCount() {
      let count = 0;
      for (const x in Chunks) count += Object.keys(Chunks[x]).length;
      return count;
    }

    function __countFlag(flag) {
      let count = 0;
      for (const x in Chunks)
        for (const z in Chunks[x]) if (Chunks[x][z][flag]) count++;
      return count;
    }

    // Whether the loader still has chunks it wants to generate or mesh,
    // including ones waiting for a failed attempt to be retried
    function __hasOutstandingWork() {
      const cx = floor(player.x / LENGTH);
      const cz = floor(player.z / WIDTH);
      const r = data.renderDistance;

      for (const [dx, dz] of getChunkOffsets(r)) {
        const x = cx + dx;
        const z = cz + dz;
        const chunk = getLoadedChunk(x, z);
        if (chunk && (chunk.complete || chunk.calculating)) continue;

        for (const [ox, oz] of GENERATE_OFFSETS) {
          const key = getChunkKey(x + ox, z + oz);
          if (!getLoadedChunk(x + ox, z + oz) && (pendingChunks.has(key) || failedChunks.has(key))) return true;
        }

        if (chunk && !chunk.complete && !chunk.calculating) {
          const ready = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]
            .every(([ox, oz]) => getLoadedChunk(x + ox, z + oz)?.decorated);
          if (ready) return true;
        }
      }

      return false;
    }
  `, context);

  const hasScheduledWork = () => vm.runInContext('__hasOutstandingWork()', context);

  return { context, pool, gl, frame, runFrames, settle, drive, state, run: code => vm.runInContext(code, context) };
}

/**
 * Make a plausible result for a fake worker task
 */
function defaultRespond(task) {
  if (task.type === 'generate') {
    return {
      blocks: new Uint8Array(16 * 16 * 8),
      palette: [null],
      features: new Map()
    };
  }

  return createMesh('solid');
}

/**
 * Make a mesh result for a fake worker task
 * @param {string} kind 'solid', 'translucent' or 'both'
 */
function createMesh(kind = 'solid') {
  const solidFaces = kind === 'translucent' ? 0 : 1;
  const translucentFaces = kind === 'solid' ? 0 : 1;

  return {
    solid: {
      vertices: new Float32Array(solidFaces * 4 * 12),
      indices: new Uint32Array(solidFaces * 6)
    },
    translucent: {
      vertices: new Float32Array(translucentFaces * 4 * 12),
      indices: new Uint32Array(translucentFaces * 6)
    }
  };
}

module.exports = { createWorld, createMesh, FakeWorkerPool };
