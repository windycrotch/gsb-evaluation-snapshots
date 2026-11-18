/**
 * Acceptance test for cross-chunk feature merging (trees growing over chunk
 * borders). Loads the real game sources into a vm context and checks:
 *
 * 1. A tree crown from chunk A reaching into chunk B produces the exact same
 *    blocks in B whether the world is built A-first or B-first.
 * 2. airOnly feature blocks (leaves) never overwrite existing blocks, while
 *    forced feature blocks (trunks) do.
 * 3. A block the player dug out of a tree crown stays air when the chunk is
 *    decorated again (edits are applied after features).
 * 4. Feature blocks placed more than one chunk away still raise an error.
 *
 * Run with: node tests/cross-chunk-features.js
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
  'src/game/chunk.js'
];

// Stubs for the graphics side of block registration, which the test never draws
const sandbox = {
  console: console,
  LAYER_OPAQUE: 0,
  LAYER_CUTOUT: 1,
  LAYER_TRANSLUCENT: 2,
  TXRW: 24,
  isSolid: () => true,
  getTexture: () => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  getColor: () => null,
  getShadow: () => null
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
  data = { edits: new ChunkEdits(), chunksGenerated: 0 };

  const SEED = 'cross-chunk-acceptance';
  const terrain = getTerrain('normal');
  seedWorld(SEED);

  const report = { failures: [], notes: [] };
  const check = (condition, message) => {
    if (condition) report.notes.push('PASS: ' + message);
    else report.failures.push('FAIL: ' + message);
  };

  // Generate a chunk the way the loader's adopt path does
  const generate = (cx, cz) => {
    const generated = generateChunk(cx, cz, terrain, SEED);
    remapGeneratedChunk(generated, Uint8Array.from(generated.palette, getBlockTypeId));
    return generated;
  };

  const adopt = (cx, cz) => {
    const generated = generate(cx, cz);
    if (!Chunks[cx]) Chunks[cx] = {};
    const chunk = new Chunk(cx, cz, generated.blocks, generated.features);
    Chunks[cx][cz] = chunk;
    return chunk;
  };

  // ---- Find adjacent chunks A, B where a tree in A grows leaves into B ----
  let A = -1;
  let leafBlock = null; // {index, id, type} of an airOnly leaf A places in B
  for (let cx = 0; cx < 500 && A < 0; cx++) {
    const generated = generate(cx, 0);
    const features = generated.features.get(getChunkKey(cx + 1, 0));
    if (!features) continue;

    for (const packed of features) {
      const airOnly = packed >>> 24;
      const id = (packed >>> 16) & 0xff;
      const type = getBlockTypeName(id);
      if (airOnly && (type === 'leaves' || type === 'birch_leaves')) {
        A = cx;
        leafBlock = { index: packed & 0xffff, id: id, type: type };
        break;
      }
    }
  }

  if (A < 0) {
    report.failures.push('FAIL: could not find a tree crown crossing a chunk border');
    return report;
  }

  const B = A + 1;
  report.notes.push('Using chunks A=' + A + ', B=' + B + '; crown leaf in B at index ' + leafBlock.index);

  // Chunks whose features can reach A or B
  const NEIGHBORHOOD = [];
  for (let dx = -1; dx <= 2; dx++)
    for (let dz = -1; dz <= 1; dz++) NEIGHBORHOOD.push([A + dx, dz]);

  const resetWorld = () => {
    Chunks = {};
    data.edits = new ChunkEdits();
  };

  // Build the world, generating and decorating in the given chunk order
  const buildWorld = (generateOrder, decorateOrder) => {
    resetWorld();
    for (const [cx, cz] of generateOrder) adopt(cx, cz);
    for (const cx of decorateOrder) getLoadedChunk(cx, 0).decorate();
    return getLoadedChunk(B, 0);
  };

  const byAscendingX = NEIGHBORHOOD.slice().sort((a, b) => a[0] - b[0]);
  const byDescendingX = NEIGHBORHOOD.slice().sort((a, b) => b[0] - a[0]);

  // ---- 1. Load order must not change the result ----
  const bForward = buildWorld(byAscendingX, [A, B]);   // player walks in from A's side
  const forwardBlocks = Array.from(bForward.blocks);

  const bBackward = buildWorld(byDescendingX, [B, A]); // player walks in from B's side
  const backwardBlocks = Array.from(bBackward.blocks);

  let mismatches = 0;
  for (let i = 0; i < forwardBlocks.length; i++)
    if (forwardBlocks[i] !== backwardBlocks[i]) mismatches++;
  check(mismatches === 0, 'B is identical whether built A->B or B->A (' + mismatches + ' mismatched blocks)');

  const countType = (blocks, id) => blocks.filter(b => b === id).length;
  check(countType(forwardBlocks, leafBlock.id) === countType(backwardBlocks, leafBlock.id),
    'leaf count in B matches between orders (' + countType(forwardBlocks, leafBlock.id) + ')');

  check(forwardBlocks[leafBlock.index] === leafBlock.id,
    "A's crown leaf lands in B at the expected spot");

  // ---- 2. airOnly leaves yield to existing blocks, forced blocks do not ----
  resetWorld();
  for (const [cx, cz] of NEIGHBORHOOD) adopt(cx, cz);
  const chunkB = getLoadedChunk(B, 0);
  const stoneId = getBlockTypeId('stone');

  // A non-air block already sitting where the crown leaf wants to go
  chunkB.blocks[leafBlock.index] = stoneId;

  // A forced (trunk-like) feature aimed at another occupied cell of B
  const forcedIndex = (leafBlock.index + HEIGHT) % (LENGTH * WIDTH * HEIGHT);
  chunkB.blocks[forcedIndex] = stoneId;
  const logId = getBlockTypeId('log');
  const keyB = getChunkKey(B, 0);
  const chunkA = getLoadedChunk(A, 0);
  const extended = new Uint32Array(chunkA.features.get(keyB).length + 1);
  extended.set(chunkA.features.get(keyB));
  extended[extended.length - 1] = packFeatureBlock(forcedIndex, logId, false);
  chunkA.features.set(keyB, extended);

  chunkB.decorate();
  check(chunkB.blocks[leafBlock.index] === stoneId,
    'airOnly leaf does not overwrite an existing block');
  check(chunkB.blocks[forcedIndex] === logId,
    'forced feature block (trunk) overwrites an existing block');

  // ---- 3. A dug-out crown block stays dug after redecorating ----
  resetWorld();
  for (const [cx, cz] of NEIGHBORHOOD) adopt(cx, cz);
  let chunk = getLoadedChunk(B, 0);
  chunk.decorate();
  check(chunk.blocks[leafBlock.index] === leafBlock.id, 'crown leaf is there before digging');

  // The player digs the leaf out
  data.edits.setBlock(B, 0, leafBlock.index, BLOCK_AIR, chunk.blocks[leafBlock.index]);
  chunk.blocks[leafBlock.index] = BLOCK_AIR;

  // The chunk is regenerated from the seed and decorated again
  resetChunksOnly = () => { Chunks = {}; };
  resetChunksOnly();
  for (const [cx, cz] of NEIGHBORHOOD) adopt(cx, cz);
  chunk = getLoadedChunk(B, 0);
  chunk.decorate();
  check(chunk.blocks[leafBlock.index] === BLOCK_AIR,
    'dug-out crown block stays air after regenerating and redecorating');

  // ---- 4. Out-of-range feature blocks still raise an error ----
  let threw = false;
  try {
    const place = createFeaturePlacer(0, 0, createPalette(), new Map());
    place('log', 2 * LENGTH + 1, 10, 0);
  } catch (error) {
    threw = true;
  }
  check(threw, 'feature blocks more than one chunk away raise an error');

  return report;
})()`, context, { filename: 'acceptance' });

for (const note of report.notes) console.log(note);
for (const failure of report.failures) console.error(failure);

if (report.failures.length > 0) {
  console.error(`\n${report.failures.length} check(s) failed`);
  process.exit(1);
}

console.log('\nAll checks passed');
