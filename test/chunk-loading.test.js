/**
 * Chunk loading timing tests. Each test drives the loader one frame at a time
 * with a fake worker pool and a fake WebGL context that counts buffers, so
 * dropped results, stuck chunks and leaked buffers show up immediately.
 */

const assert = require('assert');
const { createWorld, createMesh } = require('./harness');

const GENERATED = () => ({ blocks: new Uint8Array(16 * 16 * 8), palette: [null], features: new Map() });

/** The result a fake worker returns for a task */
function answer(task) {
  return task.type === 'generate' ? GENERATED() : createMesh('solid');
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// --- World cleared while tasks are in flight --------------------------------

test('results generated for the old world are not written into the new one', () => {
  const w = createWorld({ renderDistance: 1 });

  // A first frame starts generation for the old world, but nothing is delivered
  w.frame();
  const inFlight = w.pool.pending.length;
  assert(inFlight > 0, 'expected generation to be in flight');

  w.run('resetChunkLoader()');
  assert.strictEqual(w.state().chunks, 0);
  assert.strictEqual(w.state().live, 0);

  // The old world's generated chunks arrive late
  let job;
  while ((job = w.pool.take()) != null) {
    assert.strictEqual(job.task.type, 'generate');
    w.pool.deliver(job, null, GENERATED());
  }
  w.frame();

  assert.strictEqual(w.state().chunks, 0, 'stale generation must not create chunks');
  assert.strictEqual(w.state().live, 0, 'stale results must not upload buffers');

  // The new world loads normally
  w.drive(answer);
  assert.strictEqual(w.state().complete, 9, 'the new world should mesh normally');
});

test('mesh results from the old world are not uploaded into the new one', () => {
  const w = createWorld({ renderDistance: 1 });
  w.drive(answer);
  assert.strictEqual(w.state().complete, 9);

  // Force every chunk to want a mesh again, then start those meshes
  w.run('for (const row of Object.values(Chunks)) for (const c of Object.values(row)) c.freeMesh()');
  w.frame();
  assert(w.pool.pending.length > 0, 'expected meshes to be in flight');

  w.run('resetChunkLoader()');
  assert.strictEqual(w.state().live, 0);

  // The old world's meshes arrive late and must not be uploaded
  let job;
  while ((job = w.pool.take()) != null) {
    assert.strictEqual(job.task.type, 'mesh');
    w.pool.deliver(job, null, createMesh('solid'));
  }
  w.frame();

  assert.strictEqual(w.state().chunks, 0);
  assert.strictEqual(w.state().live, 0, 'stale meshes must not upload buffers');
});

test('old and new world tasks can arrive interleaved without mixing', () => {
  const w = createWorld({ renderDistance: 1 });
  w.frame(); // old world generation in flight

  w.run('resetChunkLoader()');
  w.frame(); // new world generation in flight

  // Deliver one old task, then let the rest settle with new world results
  const oldJob = w.pool.take(job => job.task.type === 'generate');
  assert(oldJob != null);
  w.pool.deliver(oldJob, null, GENERATED());

  w.drive(answer);
  const state = w.state();
  assert.strictEqual(state.chunks, 49);
  assert.strictEqual(state.complete, 9);
  assert.strictEqual(state.calculating, 0);
});

// --- Mesh results dropped as stale, or a task erroring -----------------------

test('a mesh that fails is requested again instead of staying in progress', () => {
  const w = createWorld({ renderDistance: 1 });
  let failed = false;

  w.drive(task => {
    if (task.type === 'mesh' && !failed) {
      failed = true;
      return new Error('mesh exploded');
    }
    return answer(task);
  });

  assert(failed, 'the mesh error should have been injected');
  const state = w.state();
  assert.strictEqual(state.calculating, 0, 'no chunk may stay marked as calculating');
  assert.strictEqual(state.complete, 9, 'the failed chunk should have been meshed after retrying');
  assert.strictEqual(state.live, 18, 'a failed mesh must not leak buffers');
});

test('a chunk whose mesh always fails is retried with a backoff and never left calculating', () => {
  const w = createWorld({ renderDistance: 1 });
  const badKey = w.run('getChunkKey(0, 0)');
  let attempts = 0;

  w.runFrames(160, task => {
    if (task.type === 'generate') return GENERATED();

    const key = w.run(`getChunkKey(${task.X / 16}, ${task.Z / 16})`);
    if (key === badKey) {
      attempts++;
      return new Error('always broken');
    }
    return createMesh('solid');
  });

  assert(attempts > 1, `the failing chunk should be retried, got ${attempts} attempts`);
  assert(attempts < 20, `retries should be spaced out, got ${attempts} attempts`);

  const state = w.state();
  assert.strictEqual(state.calculating, 0, 'no chunk may stay marked as calculating');
  assert.strictEqual(state.complete, 8, 'every other chunk should still mesh');
});

test('a generation error is retried, and other chunks keep loading meanwhile', () => {
  const w = createWorld({ renderDistance: 1 });
  let failedOnce = false;

  w.drive(task => {
    if (task.type !== 'generate') return createMesh('solid');
    if (task.cx === 0 && task.cz === 0 && !failedOnce) {
      failedOnce = true;
      return new Error('generation exploded');
    }
    return GENERATED();
  });

  assert(failedOnce, 'the generation error should have been injected');
  const state = w.state();
  assert.strictEqual(state.chunks, 49, 'the failed chunk should have been generated on retry');
  assert.strictEqual(state.complete, 9);
});

test('generation errors on every attempt do not permanently empty the world', () => {
  const w = createWorld({ renderDistance: 1 });
  let attempts = 0;

  // Fail every generation for a while, then let them succeed
  w.drive(task => {
    if (task.type === 'generate' && attempts < 60) {
      attempts++;
      return new Error('generation exploded');
    }
    return answer(task);
  }, { maxFrames: 3000, quietFrames: 90 });

  assert(attempts >= 60, `generation should keep retrying, got ${attempts} attempts`);
  const state = w.state();
  assert.strictEqual(state.chunks, 49, 'the chunks should load once generation works');
  assert.strictEqual(state.complete, 9);
  assert.strictEqual(state.failed, 0, 'successful chunks must not be remembered as failed');
});

test('a stale mesh result is dropped when its chunk leaves the view', () => {
  const w = createWorld({ renderDistance: 2 });
  w.drive(answer);

  // Free every mesh, then ask for them again but hold the results
  w.run('for (const row of Object.values(Chunks)) for (const c of Object.values(row)) c.freeMesh()');
  w.frame();
  assert(w.pool.pending.length > 0, 'expected meshes to be in flight');

  // Shrink while those meshes are in flight; their chunks are freed, but the
  // results have not arrived yet, so the chunks inside the keep margin wait
  w.run('data.renderDistance = 0');
  w.frame();
  const shrunk = w.state();
  assert.strictEqual(shrunk.calculating, 6, 'only the chunks inside the keep margin still wait');

  // The held meshes arrive now: the ones for chunks that left the view must be dropped
  let job;
  while ((job = w.pool.take()) != null) w.pool.deliver(job, null, createMesh('solid'));
  w.frame();
  w.frame();

  const state = w.state();
  assert.strictEqual(state.calculating, 0, 'no chunk may stay calculating from a dropped mesh');
  assert(state.complete <= 9, `only the chunks inside the keep margin may show a mesh, got ${state.complete}`);

  // Nothing left beyond the keep margin may have kept its mesh
  const farMeshed = w.run(`
    Object.values(Chunks).flatMap(row => Object.values(row))
      .filter(c => c.complete && Math.max(Math.abs(c.x), Math.abs(c.z)) > 1).length
  `);
  assert.strictEqual(farMeshed, 0, 'a chunk outside the keep margin must not keep a mesh');
  assert(state.live <= 18, `stale meshes must not upload buffers, got ${state.live} live`);

  // Growing again meshes everything afresh
  w.run('data.renderDistance = 2');
  w.drive(answer);
  assert.strictEqual(w.state().complete, 25);
});

test('one chunk failing does not rebuild the rest of the world', () => {
  const w = createWorld({ renderDistance: 1 });
  const badKey = w.run('getChunkKey(0, 0)');
  let meshesForOthers = 0;
  let firstRound = true;

  w.drive(task => {
    if (task.type === 'generate') return GENERATED();

    const key = w.run(`getChunkKey(${task.X / 16}, ${task.Z / 16})`);
    if (key === badKey && firstRound) {
      firstRound = false;
      return new Error('one bad chunk');
    }

    if (key !== badKey) meshesForOthers++;
    return createMesh('solid');
  });

  // Eight healthy chunks are meshed once; only the failed one is meshed twice
  assert.strictEqual(meshesForOthers, 8, `healthy chunks should mesh once each, got ${meshesForOthers}`);
  assert.strictEqual(w.state().complete, 9);
});

test('a mesh the GPU refuses to take is retried instead of staying in progress', () => {
  const w = createWorld({ renderDistance: 1, mode: 'superflat', inline: true });
  let uploads = 0;
  const upload = w.gl.bufferData;

  // The first mesh upload throws, as it can when the GPU is out of memory
  w.gl.bufferData = function (...args) {
    uploads++;
    if (uploads === 1) throw new Error('out of GPU memory');
    return upload.apply(this, args);
  };

  w.settle({ maxFrames: 4000, quietFrames: 20 });

  const state = w.state();
  assert(uploads > 1, 'the upload should have been tried again');
  assert.strictEqual(state.complete, 9, 'the chunk should be meshed once the GPU accepts it');
  assert.strictEqual(state.calculating, 0, 'no chunk may stay calculating');
});

// --- Render distance changes ------------------------------------------------

test('shrinking the render distance frees meshes that leave the view', () => {
  const w = createWorld({ renderDistance: 2 });
  w.drive(answer);
  const wide = w.state();
  assert.strictEqual(wide.complete, 25);

  w.run('data.renderDistance = 0');
  w.drive(answer);
  const narrow = w.state();

  // Chunks within the mesh keep margin stay meshed; the rest are freed
  assert.strictEqual(narrow.complete, 9, 'far meshes should be freed when the view shrinks');
  assert(narrow.live < wide.live, 'meshes that left the view should be freed');
  assert.strictEqual(narrow.calculating, 0);
});

test('growing the render distance again meshes the chunks that return', () => {
  const w = createWorld({ renderDistance: 2 });
  w.drive(answer);

  for (let round = 0; round < 4; round++) {
    w.run('data.renderDistance = 0');
    w.drive(answer);
    w.run('data.renderDistance = 2');
    w.drive(answer);

    const state = w.state();
    assert.strictEqual(state.complete, 25, `round ${round} should mesh every visible chunk`);
    assert.strictEqual(state.calculating, 0);
  }
});

test('repeated clears do not grow the number of live buffers', () => {
  const w = createWorld({ renderDistance: 1 });
  const livePerRound = [];

  for (let round = 0; round < 6; round++) {
    w.drive(answer);
    livePerRound.push(w.state().live);

    w.run('resetChunkLoader()');
    assert.strictEqual(w.state().live, 0, `round ${round} should free every buffer on clear`);
  }

  for (const live of livePerRound) assert.strictEqual(live, livePerRound[0]);
});

// --- Walking away and coming back -------------------------------------------

test('walking out of range frees buffers, and coming back rebuilds the chunk', () => {
  const w = createWorld({ renderDistance: 1 });
  w.drive(answer);
  const near = w.state();
  assert.strictEqual(near.complete, 9);

  w.run('player.x = 8000; player.z = 8000');
  w.drive(answer);
  const far = w.state();
  assert.strictEqual(far.chunks, 49);
  assert(far.live <= near.live, 'the old chunks should have been unloaded');

  w.run('player.x = 8; player.z = 8');
  w.drive(answer);
  const back = w.state();
  assert.strictEqual(back.complete, 9, 'the chunks should be displayed again on return');
  assert.strictEqual(back.calculating, 0);
});

test('walking back and forth keeps the live buffer count steady', () => {
  const w = createWorld({ renderDistance: 1 });
  w.drive(answer);
  const baseline = w.state().live;

  for (let round = 0; round < 6; round++) {
    w.run('player.x = 8000; player.z = 8000');
    w.drive(answer);
    w.run('player.x = 8; player.z = 8');
    w.drive(answer);

    const state = w.state();
    assert.strictEqual(state.complete, 9, `round ${round} should show the chunk again`);
    assert.strictEqual(state.live, baseline, `round ${round} must not accumulate buffers`);
  }
});

test('a chunk that failed generation loads when the player returns to it', () => {
  const w = createWorld({ renderDistance: 1 });
  let broken = true;

  // Everything generates except the chunk under the player, which always fails
  w.runFrames(200, task => {
    if (task.type === 'generate' && task.cx === 0 && task.cz === 0 && broken) return new Error('broken region');
    return answer(task);
  });
  assert.strictEqual(w.state().complete, 0, 'the broken chunk should block its own mesh');

  // Walk away far enough that the failure is forgotten, then fix generation
  w.run('player.x = 8000; player.z = 8000');
  w.drive(answer);
  broken = false;

  w.run('player.x = 8; player.z = 8');
  w.drive(answer);

  const state = w.state();
  assert.strictEqual(state.complete, 9, 'the chunk should load once it is revisited');
  assert.strictEqual(state.calculating, 0);
  assert.strictEqual(state.failed, 0);
});

// --- Behaviour that must be kept --------------------------------------------

test('chunk offsets are ordered nearest first', () => {
  const w = createWorld({ renderDistance: 3 });
  const distances = w.run('getChunkOffsets(3).map(([dx, dz]) => dx * dx + dz * dz)');

  for (let i = 1; i < distances.length; i++)
    assert(distances[i] >= distances[i - 1], 'offsets should be sorted nearest first');
});

test('generation starts with the chunks nearest the player', () => {
  const w = createWorld({ renderDistance: 8 });
  w.frame();

  const tasks = w.pool.submitted.filter(job => job.task.type === 'generate');
  assert(tasks.length > 0);
  for (const job of tasks)
    assert(job.task.cx ** 2 + job.task.cz ** 2 <= 4, 'the first frame should only touch nearby chunks');
});

test('meshing only starts once the chunk area is ready', () => {
  const w = createWorld({ renderDistance: 1 });
  let meshed = 0;

  w.drive(task => {
    if (task.type === 'mesh') {
      assert(task.area && task.area.blocks, 'a mesh needs a padded block area');
      assert(task.area.blocks.length > 0);
      meshed++;
    }
    return answer(task);
  });

  assert.strictEqual(meshed, 9);
});

test('translucent blocks are drawn after every solid mesh', () => {
  const w = createWorld({ renderDistance: 1 });
  w.drive(task => task.type === 'generate' ? GENERATED() : createMesh('both'));

  // Record the kind of mesh each draw call uses, then draw one frame
  w.run(`
    __drawOrder = [];
    Chunk.prototype.render = function() { __drawOrder.push('solid'); };
    Chunk.prototype.renderTranslucent = function() { __drawOrder.push('translucent'); };
  `);
  w.run('renderChunks()');

  const order = w.run('__drawOrder');
  const firstTranslucent = order.indexOf('translucent');
  const lastSolid = order.lastIndexOf('solid');
  assert(firstTranslucent >= 0 && lastSolid >= 0);
  assert(firstTranslucent > lastSolid, 'translucent chunks must come after all solid ones');
  assert.strictEqual(order.filter(kind => kind === 'solid').length, 9);
});

test('a frame only starts as much work as the worker pool can take', () => {
  const w = createWorld({ renderDistance: 8 });
  w.frame();

  assert(w.pool.submitted.length > 0);
  assert(w.pool.submitted.length <= w.pool.capacity,
    `one frame should not outrun the pool, submitted ${w.pool.submitted.length}`);
});

// --- The same paths with real generation and meshing on the main thread ------

test('without workers, real chunks are generated, meshed and drawn', () => {
  const w = createWorld({ renderDistance: 1, mode: 'superflat', inline: true });
  w.settle({ maxFrames: 4000, quietFrames: 10 });

  const state = w.state();
  assert.strictEqual(state.complete, 9, 'every visible chunk should be meshed');
  assert.strictEqual(state.calculating, 0);
  assert(state.live > 0, 'real meshes should upload buffers');
});

test('without workers, clearing the world with tasks queued drops the old results', () => {
  const w = createWorld({ renderDistance: 1, mode: 'superflat', inline: true });

  // One frame queues inline tasks; they haven't run yet
  w.frame();
  const queued = w.pool.inlineQueue.length;
  assert(queued > 0, 'expected inline tasks to be queued');

  w.run('resetChunkLoader()');
  w.settle({ maxFrames: 4000, quietFrames: 10 });

  const state = w.state();
  // The new world loads from scratch and nothing from the old queue leaks in
  assert.strictEqual(state.complete, 9);
  assert.strictEqual(state.calculating, 0);
});

test('without workers, walking away frees buffers and returning rebuilds them', () => {
  const w = createWorld({ renderDistance: 1, mode: 'superflat', inline: true });
  w.settle({ maxFrames: 4000, quietFrames: 10 });
  const baseline = w.state().live;

  w.run('player.x = 8000; player.z = 8000');
  w.settle({ maxFrames: 4000, quietFrames: 10 });
  w.run('player.x = 8; player.z = 8');
  w.settle({ maxFrames: 4000, quietFrames: 10 });

  const state = w.state();
  assert.strictEqual(state.complete, 9);
  assert(state.live <= baseline + 2, `buffers should not accumulate, was ${baseline} now ${state.live}`);
});

test('without workers, a mesh that fails is retried on the real code path', () => {
  const w = createWorld({ renderDistance: 1, mode: 'superflat', inline: true });
  const realTask = w.pool.runTask;
  let failed = false;

  w.pool.runTask = task => {
    if (task.type === 'mesh' && !failed) {
      failed = true;
      throw new Error('injected mesh failure');
    }
    return realTask(task);
  };

  w.settle({ maxFrames: 4000, quietFrames: 20 });

  assert(failed, 'the mesh error should have been injected');
  const state = w.state();
  assert.strictEqual(state.complete, 9, 'the failed chunk should be meshed after retrying');
  assert.strictEqual(state.calculating, 0, 'no chunk may stay calculating');
  assert.strictEqual(state.live, 18, 'the failed attempt must not leak buffers');
});

// --- Runner ------------------------------------------------------------------

let failures = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}`);
    console.log(error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n') : error);
  }
}

console.log(`\n${tests.length - failures}/${tests.length} passed`);
process.exit(failures === 0 ? 0 : 1);
