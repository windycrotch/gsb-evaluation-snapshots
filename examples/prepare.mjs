// Runs before the demo server (npm run dev):
//   1. if examples/public/data holds no built assets (or --force), generate the procedural samples and build them
//   2. write examples/public/data/assets.json, the list of asset names the demo loads by default
// To show your own model:  npx three-nanite build model.glb examples/public/data   then   npm run dev
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildClod } from '../src/build.js';
import { makeSample, SAMPLE_KINDS } from './make-sample.mjs';

const data = path.join(import.meta.dirname, 'public', 'data');
fs.mkdirSync(data, { recursive: true });
const built = () => fs.readdirSync(data).filter((f) => f.endsWith('.json') && f !== 'assets.json' && fs.existsSync(path.join(data, f.replace(/\.json$/, '.bin')))).map((f) => f.replace(/\.json$/, '')).sort();

if (!built().length || process.argv.includes('--force')) {
  console.log('building the procedural sample models (a few seconds, once)…');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'three-nanite-'));
  for (const kind of SAMPLE_KINDS) {
    const glb = path.join(tmp, `${kind}.glb`);
    fs.writeFileSync(glb, makeSample(kind));
    const r = await buildClod({ input: glb, outDir: data, name: kind, log: () => {} });
    console.log(`  ${kind}: ${r.meta.sourceTris} triangles -> ${r.meta.clusters} clusters, ${r.meta.levels} levels, ${(r.meta.binBytes / 1048576).toFixed(1)} MB`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
const names = built();
fs.writeFileSync(path.join(data, 'assets.json'), JSON.stringify(names));
console.log(`demo assets: ${names.join(', ')}`);
