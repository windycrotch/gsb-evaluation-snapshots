/**
 * Stress test: many rounds of world switches, render distance changes, walks
 * and injected task errors in one run, checking the invariants that matter
 * no matter which order things happen in.
 */

const assert = require('assert');
const { createWorld, createMesh } = require('./harness');

const GENERATED = () => ({ blocks: new Uint8Array(16 * 16 * 8), palette: [null], features: new Map() });

/**
 * Small deterministic random number generator, so a failure can be replayed
 */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const w = createWorld({ renderDistance: 2 });
const random = createRandom(Number(process.env.SEED || 12345));

// Errors are injected but limited, so the world can always recover
let generationsUntilHealthy = 0;
let meshesUntilHealthy = 0;

const respond = task => {
  const roll = random();
  if (task.type === 'generate') {
    if (generationsUntilHealthy > 0) { generationsUntilHealthy--; return new Error('injected generation error'); }
    if (roll < 0.03) return new Error('injected generation error');
    return GENERATED();
  }

  if (meshesUntilHealthy > 0) { meshesUntilHealthy--; return new Error('injected mesh error'); }
  if (roll < 0.05) return new Error('injected mesh error');
  return createMesh(roll < 0.3 ? 'both' : 'solid');
};

const liveAfterRounds = [];

for (let round = 0; round < 12; round++) {
  const action = random();

  if (action < 0.2) {
    // Switch worlds
    w.run('resetChunkLoader()');
  } else if (action < 0.4) {
    // Change the render distance
    w.run(`data.renderDistance = ${1 + Math.floor(random() * 3)}`);
  } else if (action < 0.7) {
    // Walk somewhere else
    const x = Math.floor(random() * 40000) - 20000;
    const z = Math.floor(random() * 40000) - 20000;
    w.run(`player.x = ${x}; player.z = ${z}`);
  } else {
    // Sometimes make every task fail for a while, then recover
    generationsUntilHealthy = 40;
    meshesUntilHealthy = 40;
  }

  w.drive(respond, { maxFrames: 5000, quietFrames: 120 });

  const state = w.state();
  liveAfterRounds.push(state.live);

  assert.strictEqual(state.calculating, 0, `round ${round}: no chunk may stay calculating`);
  assert.strictEqual(state.pending, 0, `round ${round}: no generation may stay pending`);

  // Every chunk inside the render distance should have a mesh once the loader
  // has settled, unless the last thing the round did was keep failing
  const unmeshedInside = w.run(`
    (() => {
      const cx = floor(player.x / LENGTH);
      const cz = floor(player.z / WIDTH);
      const r = data.renderDistance;
      let count = 0;
      for (let x = -r; x <= r; x++)
        for (let z = -r; z <= r; z++) {
          const chunk = getLoadedChunk(cx + x, cz + z);
          if (!chunk || !chunk.complete) count++;
        }
      return count;
    })()
  `);
  assert.strictEqual(unmeshedInside, 0, `round ${round}: every visible chunk should be meshed`);

  console.log(`round ${round}: chunks=${state.chunks} complete=${state.complete} live=${state.live}`);
}

// Walk back to the start and settle, then check the buffer count is bounded
// by what one view needs instead of growing with the number of rounds
w.run('resetChunkLoader(); player.x = 8; player.z = 8; data.renderDistance = 2');
w.drive(respond, { maxFrames: 5000, quietFrames: 120 });
const settled = w.state();
console.log(`settled: chunks=${settled.chunks} complete=${settled.complete} live=${settled.live}`);

const maxLive = Math.max(...liveAfterRounds);
assert(maxLive < 200, `live buffers should stay bounded, saw ${maxLive} across rounds`);
assert.strictEqual(settled.calculating, 0);

console.log('\nok   mixed timing stress test');
console.log('1/1 passed');
