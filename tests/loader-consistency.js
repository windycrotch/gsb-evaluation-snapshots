/**
 * Loader-level acceptance test: walks the player up to the same forest from
 * opposite directions through the real chunk loader (generateRadius ->
 * advanceChunk -> adopt -> decorate) and checks the chunks come out identical.
 *
 * Run with: node tests/loader-consistency.js
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

// Stubs for the browser and the graphics side of block registration
const sandbox = {
  console: console,
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

const report = vm.runInContext(`(function() {
  LENGTH = 16;
  WIDTH = 16;
  HEIGHT = 256;
  Chunks = {};
  seedPhrase = 'loader-consistency';
  player = { x: 0, y: 300, z: 8 };
  data = {
    edits: new ChunkEdits(),
    chunksGenerated: 0,
    renderedChunks: 0,
    furthestChunk: 0,
    renderDistance: 3,
    mode: 'normal'
  };

  const report = { failures: [], notes: [] };
  const check = (condition, message) => {
    if (condition) report.notes.push('PASS: ' + message);
    else report.failures.push('FAIL: ' + message);
  };

  const TARGET = 6; // chunk the player walks up to

  // Walk the player chunk by chunk from startChunk to TARGET, loading as we go
  const approach = (startChunk) => {
    resetChunkLoader();
    data.edits.clear();

    const step = startChunk < TARGET ? 1 : -1;
    for (let cx = startChunk; cx !== TARGET + step; cx += step) {
      player.x = cx * LENGTH + 8;
      // Let the loader finish everything it queued
      for (let i = 0; i < 30; i++) generateRadius();
    }
  };

  const snapshot = (cx) => {
    const chunk = getLoadedChunk(cx, 0);
    if (!chunk) return null;
    return { decorated: chunk.decorated, blocks: Array.from(chunk.blocks) };
  };

  approach(TARGET - 6); // come from the west
  const westward = [TARGET - 1, TARGET, TARGET + 1].map(snapshot);

  approach(TARGET + 6); // come from the east
  const eastward = [TARGET - 1, TARGET, TARGET + 1].map(snapshot);

  for (let i = 0; i < 3; i++) {
    const cx = TARGET - 1 + i;
    const west = westward[i];
    const east = eastward[i];

    if (!west || !east) {
      report.failures.push('FAIL: chunk ' + cx + ' missing after approach (west=' + !!west + ', east=' + !!east + ')');
      continue;
    }

    check(west.decorated && east.decorated, 'chunk ' + cx + ' decorated after both approaches');

    let mismatches = 0;
    for (let b = 0; b < west.blocks.length; b++)
      if (west.blocks[b] !== east.blocks[b]) mismatches++;
    check(mismatches === 0, 'chunk ' + cx + ' identical from both directions (' + mismatches + ' mismatched blocks)');
  }

  // The same chunks decorated directly from the seed, with no walking at all
  resetChunkLoader();
  data.edits.clear();
  seedWorld(seedPhrase);
  const terrain = getTerrain(data.mode);
  for (let cx = TARGET - 2; cx <= TARGET + 2; cx++) {
    for (let cz = -1; cz <= 1; cz++) {
      const generated = generateChunk(cx, cz, terrain, seedPhrase);
      remapGeneratedChunk(generated, Uint8Array.from(generated.palette, getBlockTypeId));
      if (!Chunks[cx]) Chunks[cx] = {};
      Chunks[cx][cz] = new Chunk(cx, cz, generated.blocks, generated.features);
    }
  }
  getLoadedChunk(TARGET, 0).decorate();
  const ideal = Array.from(getLoadedChunk(TARGET, 0).blocks);

  let idealMismatches = 0;
  for (let b = 0; b < ideal.length; b++)
    if (ideal[b] !== eastward[1].blocks[b]) idealMismatches++;
  check(idealMismatches === 0, 'walked-up-to chunk ' + TARGET + ' matches direct generation (' + idealMismatches + ' mismatched blocks)');

  // Count trees that cross the borders of the target chunk, to prove the test
  // actually exercised cross-chunk features
  let crossBorder = 0;
  for (let cx = TARGET - 2; cx <= TARGET + 2; cx++) {
    for (let cz = -1; cz <= 1; cz++) {
      for (const key of Chunks[cx][cz].features.keys())
        if (key !== getChunkKey(cx, cz)) crossBorder++;
    }
  }
  report.notes.push('Cross-chunk feature lists in the area: ' + crossBorder);
  check(crossBorder > 0, 'the area has trees crossing chunk borders');

  return report;
})()`, context, { filename: 'loader-consistency' });

for (const note of report.notes) console.log(note);
for (const failure of report.failures) console.error(failure);

if (report.failures.length > 0) {
  console.error(`\n${report.failures.length} check(s) failed`);
  process.exit(1);
}

console.log('\nAll checks passed');
