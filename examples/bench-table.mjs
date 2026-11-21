// prints a bench JSON (written by the demo with ?auto=<name>, or one from docs/bench) as compact tables: node examples/bench-table.mjs out/bench/<name>.json
import fs from 'node:fs';
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(r.gpu, r.res, "assets", (r.assets||[]).join(","), (r.mat||""), (r.data||""), "contextLost:", r.contextLost, r.error || "");
const k = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : '' + n;
let last = '';
for (const x of r.bench) {
  const head = `${x.label}${x.occ && x.occ !== 'n/a' ? ' occlusion ' + x.occ : ''} ${x.mode} n=${x.count} err=${x.errorPx}px budget=${x.budget ? k(x.budget) : 'off'}`;
  if (head !== last) { console.log('\n' + head + `  (source ${k(x.sourceTris)})`); last = head; }
  console.log(`  d=${String(x.dist).padEnd(4)}${x.occluded != null ? ' hidden ' + String(x.occluded).padEnd(4) : ''} tris ${k(x.tris).padEnd(8)} ranges ${String(x.clusters).padEnd(6)} calls ${String(x.calls).padEnd(3)} effPx ${String(x.effPx).padEnd(7)} select ${String(x.selectMs).padEnd(6)} frame ${String(x.frameMs).padEnd(7)} p90 ${x.p90}`);
}
console.log('\ntraces');
for (const t of r.trace) console.log(JSON.stringify(t));
