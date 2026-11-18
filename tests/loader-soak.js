/**
 * Soak test: for several seeds, load the same area through the real chunk
 * loader in different orders (walk east, walk west, walk south, teleport) and
 * verify every chunk in the area comes out byte-identical.
 *
 * Run with: node tests/loader-soak.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');

const SOURCES = [
  'src/libraries/noise.js',
  'src/libraries/pseudo-random.js',
  'src/other/math.js',
  'src/game/block-registry.js',
  'src/game/terrain.js',
  'src/game/generate.js',
  'src/game/chunk-edits.js',
  'src/graphics-3d/blocks.js',
  'src/game/chunk.js',
  'src/game/chunk-tasks.js',
  'src/game/chunk-worker-pool.js',
  'src/game/frame-budget.js',
  'src/game/chunk-loader.js'
];

const sandbox = {
  console: { log: () => {}, warn: () => {}, error: console.error },
  LAYER_OPAQUE: 0,
  LAYER_CUTOUT: 1,
  LAYER_TRANSLUCENT: 2,
  TXRW: 24,
  isSolid: () => true,
  getTexture: () => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  getColor: () => null,
  getShadow: () => null,
  performance: { now: () => 0 },
  navigator: {}
};

const context = vm.createContext(sandbox);
for (const file of SOURCES) {
  const code = fs.readFileSync(path.join(REPO, file), 'utf8');
  vm.runInContext(code, context, { filename: file });
}

const failures = vm.runInContext(`(function() {
  LENGTH = 16;
  WIDTH = 16;
  HEIGHT = 256;
  Chunks = {};
  player = { x: 0, y: 300, z: 0 };
  data = {
    edits: new ChunkEdits(),
    chunksGenerated: 0,
    renderedChunks: 0,
    furthestChunk: 0,
    renderDistance: 3,
    mode: 'normal'
  };

  const failures = [];
  const TARGETS = [[6, 0], [6, 1], [7, 0], [7, 1]]; // chunks compared between runs

  const settle = () => { for (let i = 0; i < 40; i++) generateRadius(); };

  const walkTo = (tx, tz) => {
    // Step one chunk at a time so chunks generate in walking order
    while (floor(player.x / LENGTH) !== tx || floor(player.z / WIDTH) !== tz) {
      if (floor(player.x / LENGTH) !== tx) player.x += Math.sign(tx * LENGTH + 8 - player.x) * LENGTH;
      if (floor(player.z / WIDTH) !== tz) player.z += Math.sign(tz * WIDTH + 8 - player.z) * LENGTH;
      settle();
    }
    settle();
  };

  const snapshotArea = () => TARGETS.map(([cx, cz]) => {
    const chunk = getLoadedChunk(cx, cz);
    if (!chunk || !chunk.decorated) return null;
    return Array.from(chunk.blocks);
  });

  const compare = (a, b, label) => {
    for (let i = 0; i < TARGETS.length; i++) {
      if (!a[i] || !b[i]) {
        failures.push(label + ': chunk ' + TARGETS[i] + ' missing or undecorated');
        continue;
      }
      let mismatches = 0;
      for (let k = 0; k < a[i].length; k++) if (a[i][k] !== b[i][k]) mismatches++;
      if (mismatches > 0)
        failures.push(label + ': chunk ' + TARGETS[i] + ' differs in ' + mismatches + ' blocks');
    }
  };

  const freshWorld = (seed) => {
    resetChunkLoader();
    data.edits.clear();
    seedPhrase = seed;
  };

  for (const seed of ['soak-one', 'soak-two', 'soak-three']) {
    const runs = {};

    freshWorld(seed);
    player.x = -48; player.z = 8;
    walkTo(6, 0); // from the west
    runs.west = snapshotArea();

    freshWorld(seed);
    player.x = 15 * 16; player.z = 8;
    walkTo(6, 0); // from the east
    runs.east = snapshotArea();

    freshWorld(seed);
    player.x = 6 * 16 + 8; player.z = -6 * 16;
    walkTo(6, 0); // from the north
    runs.north = snapshotArea();

    freshWorld(seed);
    player.x = 6 * 16 + 8; player.z = 8; // teleport straight in
    settle();
    runs.teleport = snapshotArea();

    compare(runs.west, runs.east, seed + ' west-vs-east');
    compare(runs.west, runs.north, seed + ' west-vs-north');
    compare(runs.west, runs.teleport, seed + ' west-vs-teleport');
  }

  return failures;
})()`, context, { filename: 'loader-soak' });

if (failures.length > 0) {
  for (const failure of failures) console.error('FAIL: ' + failure);
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}

console.log('All soak checks passed (3 seeds x 4 load orders x 4 chunks)');
