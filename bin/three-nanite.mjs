#!/usr/bin/env node
import path from 'node:path';
import { buildClod } from '../src/build.js';
import { verifyClod, cutStats } from '../src/inspect.js';

const HELP = `three-nanite: cluster LOD (Nanite-style) preprocessor for three.js

  three-nanite build <model.glb> <outDir> [options]   GLB -> <outDir>/<name>.bin + <name>.json + textures
      --name <name>       output file stem (default: the GLB file name)
      --max-tris <n>      simplify the source to at most n triangles first (keeps files small)
      --tex <px>          resize textures to px x px JPEG (needs ffmpeg); default copies them as they are
      --edge-limit <f>    cap group error at f x longest edge (clusterlod.h style), fewer far triangles
      --no-lods           skip the four discrete LODs (only DiscreteLodSet uses them)
      --quiet             no progress output
  three-nanite verify <outDir> <name>                 crack test on built data
  three-nanite stats  <outDir> <name> [radius=1]      triangles in the cut by distance
`;
const argv = process.argv.slice(2), cmd = argv[0];
const flags = {}, pos = [];
const BOOL = new Set(['no-lods', 'quiet', 'help']), VALUE = new Set(['name', 'max-tris', 'tex', 'edge-limit']);
function fail(msg) { console.error(`three-nanite: ${msg}\n\n${HELP}`); process.exit(2); }
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) { pos.push(a); continue; }
  const k = a.slice(2);
  if (BOOL.has(k)) flags[k] = true;
  else if (VALUE.has(k) && i + 1 < argv.length) flags[k] = argv[++i];
  else fail(`unknown or incomplete option ${a}`);
}
const num = (k) => { if (flags[k] == null) return 0; const v = Number(flags[k]); if (!Number.isFinite(v) || v < 0) fail(`--${k} needs a number`); return v; };

try {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || flags.help) console.log(HELP);
  else if (cmd === 'build') {
    if (pos.length !== 2) fail('build needs <model.glb> <outDir>');
    const r = await buildClod({ input: pos[0], outDir: pos[1], name: flags.name, textureSize: num('tex'), maxTriangles: num('max-tris'), edgeLimit: num('edge-limit'), lods: !flags['no-lods'], log: flags.quiet ? () => {} : console.log });
    if (!flags.quiet) console.log(`done: ${path.relative(process.cwd(), r.bin)}`);
  } else if (cmd === 'verify') {
    if (pos.length !== 2) fail('verify needs <outDir> <name>');
    const r = await verifyClod(pos[0], pos[1]);
    process.exitCode = r.ok ? 0 : 1;
  } else if (cmd === 'stats') {
    if (pos.length < 2) fail('stats needs <outDir> <name>');
    cutStats(pos[0], pos[1], Number(pos[2]) || 1);
  } else fail(`unknown command ${cmd}`);
} catch (e) {
  console.error(`three-nanite: ${e.message}`);
  process.exit(1);
}
