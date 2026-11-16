// End-to-end check without a browser: procedural GLB -> build -> crack test -> the runtime module imports.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { buildClod, verifyClod, cutStats } from '../src/build.js';
import { makeSample } from '../examples/make-sample.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'three-nanite-test-'));
try {
  const glb = path.join(tmp, 'rock.glb');
  fs.writeFileSync(glb, makeSample('rock', { texture: 64 }));
  const quiet = () => {};

  const full = await buildClod({ input: glb, outDir: tmp, name: 'rock', log: quiet });
  assert.equal(full.meta.sourceTris, 262144);
  assert.ok(full.meta.levels >= 8, 'expected a deep hierarchy');
  assert.ok(full.meta.coarsestTris <= 256, 'root should be a couple of clusters');
  assert.equal(full.meta.lods.length, 5);
  assert.equal(fs.statSync(full.bin).size, full.meta.binBytes);
  assert.ok(fs.existsSync(path.join(tmp, full.meta.textures.basecolor)));
  const v = await verifyClod(tmp, 'rock', quiet);
  assert.ok(v.ok, `crack test failed: ${JSON.stringify(v)}`);
  const stats = cutStats(tmp, 'rock', 1, quiet);
  assert.ok(stats[0].px1 > stats.at(-1).px1, 'fewer triangles far away');

  const small = await buildClod({ input: glb, outDir: tmp, name: 'small', maxTriangles: 20000, lods: false, edgeLimit: 1, log: quiet });
  assert.ok(small.meta.sourceTris <= 20000);
  assert.equal(small.meta.lods.length, 1);
  assert.ok((await verifyClod(tmp, 'small', quiet)).ok);

  await assert.rejects(buildClod({ input: full.json, outDir: tmp, log: quiet }), /not a binary glTF/);

  const rt = await import('../src/index.js');
  for (const k of ['loadClod', 'loadClodStream', 'updateStreaming', 'loadClodMaterial', 'ClodBatch', 'ClodSelector', 'DiscreteLodSet', 'patchDebug', 'debugUniform', 'sphereOccluded']) assert.ok(rt[k], `missing export ${k}`);
  console.log(`ok: ${full.meta.clusters} clusters, ${full.meta.levels} levels, no cracks; capped build ${small.meta.sourceTris} tris`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
