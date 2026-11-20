/**
 * Checks the real generation and meshing code that the workers run, so the
 * timing tests' fake results are backed by something that actually works.
 */

const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCES = [
  'src/libraries/noise.js',
  'src/libraries/pseudo-random.js',
  'src/other/math.js',
  'src/graphics-3d/blocks.js',
  'src/graphics-3d/create-cube.js',
  'src/graphics-3d/atlas.js',
  'src/graphics-3d/mesh-builder.js',
  'src/graphics-3d/chunk-mesher.js',
  'src/game/block-registry.js',
  'src/game/terrain.js',
  'src/game/generate.js',
  'src/game/chunk-tasks.js'
];

const context = vm.createContext({
  console,
  Uint8Array, Uint32Array, Int32Array, Float32Array, Float64Array,
  Map, Set, Math, JSON
});
context.LENGTH = 16;
context.WIDTH = 16;
context.HEIGHT = 32;

for (const relative of SOURCES) {
  const file = path.join(ROOT, relative);
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
}

const run = code => vm.runInContext(code, context);
const world = { seed: 'seed-1', mode: 'superflat', length: 16, width: 16, height: 32 };

// Register a block id the mesher can use, and let it load block properties
const STONE = run(`getBlockTypeId('stone')`);
context.STONE = STONE;
run(`useAtlasTileLayers(new Uint8Array(1024))`);

// --- Generation --------------------------------------------------------------

const generated = run(`runChunkTask(${JSON.stringify({ type: 'generate', cx: 0, cz: 0, world })}).result`);
assert(generated.blocks instanceof context.Uint8Array, 'generation gives block bytes');
assert.strictEqual(generated.blocks.length, 16 * 16 * 32);
assert(generated.blocks.some(id => id !== 0), 'the superflat world should have ground');

const again = run(`runChunkTask(${JSON.stringify({ type: 'generate', cx: 0, cz: 0, world })}).result`);
assert.deepStrictEqual(Array.from(again.blocks), Array.from(generated.blocks), 'generation is deterministic');

const elsewhere = run(`runChunkTask(${JSON.stringify({ type: 'generate', cx: 1, cz: 0, world })}).result`);
assert.notDeepStrictEqual(Array.from(elsewhere.blocks), Array.from(generated.blocks), 'chunks differ');

// --- Meshing -----------------------------------------------------------------

// Three stone blocks in a row: 3 * 6 faces, minus the two touching pairs
const meshed = run(`(() => {
  const strideX = (16 + 2) * (32 + 2);
  const strideZ = 32 + 2;
  const offset = ([dx, dy, dz]) => dx * strideX + dz * strideZ + dy;
  const area = {
    blocks: new Uint8Array((16 + 2) * strideX),
    strideX: strideX,
    strideZ: strideZ,
    sideOffsets: Int32Array.from(SIDE_NORMALS, offset),
    shadeOffsets: Int32Array.from(getShadeDirections(), offset)
  };

  for (let x = 1; x <= 3; x++)
    area.blocks[x * area.strideX + 1 * area.strideZ + 1 + 1] = STONE;

  return buildChunkMesh(area, 0, 0);
})()`);

assert(meshed.solid.vertices.length > 0, 'solid faces should be built');
assert.strictEqual(meshed.solid.vertices.length % 48, 0, 'each face adds 4 vertices of 12 floats');
assert.strictEqual(meshed.solid.indices.length, meshed.solid.vertices.length / 48 * 6);
assert.strictEqual(meshed.translucent.indices.length, 0, 'nothing translucent was placed');

// 3 blocks of 6 faces, less the two touching pairs: 5 + 4 + 5
assert.strictEqual(meshed.solid.indices.length / 6, 3 * 6 - 4, 'only exposed faces are built');

// A block with identical neighbours on every side shows nothing, which the
// middle block of a 3x3x3 cube would prove: its 6 faces are all hidden
const hidden = run(`(() => {
  const strideX = (16 + 2) * (32 + 2);
  const strideZ = 32 + 2;
  const offset = ([dx, dy, dz]) => dx * strideX + dz * strideZ + dy;
  const area = {
    blocks: new Uint8Array((16 + 2) * strideX),
    strideX: strideX,
    strideZ: strideZ,
    sideOffsets: Int32Array.from(SIDE_NORMALS, offset),
    shadeOffsets: Int32Array.from(getShadeDirections(), offset)
  };

  for (let x = 1; x <= 3; x++)
    for (let y = 1; y <= 3; y++)
      for (let z = 1; z <= 3; z++)
        area.blocks[x * area.strideX + z * area.strideZ + 1 + y] = STONE;

  return buildChunkMesh(area, 0, 0);
})()`);

// A solid 3x3x3 cube shows only its outside: 6 sides of 9 faces
assert.strictEqual(hidden.solid.indices.length / 6, 6 * 9, 'faces between blocks are hidden');

console.log('ok   generation produces deterministic chunks');
console.log('ok   meshing builds the expected faces');
console.log('\n3/3 passed');
