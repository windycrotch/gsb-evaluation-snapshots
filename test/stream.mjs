// HTTP Range support in loadClodStream: the normal 206 prefix path and the whole-file fallback used
// when a server answers Range with 200. No browser needed: fetch is replaced by a local file server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { buildClod } from '../src/build.js';
import { makeSample } from '../examples/make-sample.mjs';
import { loadClodStream, updateStreaming } from '../src/clod.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'three-nanite-stream-'));
const realFetch = globalThis.fetch;
const quiet = () => {};
const headers = (o = {}) => ({ get: (k) => o[String(k).toLowerCase()] ?? null });
const log = [];
let mode = 'range'; // 'range' -> 206, 'ignore' -> 200, 'fail' -> 500

// a stand-in for a static host serving <base>/<name>.json and <base>/<name>.bin
const base = pathToFileURL(tmp).href.replace(/\/$/, '');
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), rel = u.slice(base.length + 1);
  log.push({ url: u, range: init.headers?.Range ?? null });
  const file = path.join(tmp, rel);
  if (!fs.existsSync(file)) return { ok: false, status: 404, headers: headers(), json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  const buf = fs.readFileSync(file);
  if (!u.endsWith('.bin')) return { ok: true, status: 200, headers: headers(), text: async () => buf.toString(), json: async () => JSON.parse(buf.toString()) };
  if (mode === 'fail') return { ok: false, status: 500, headers: headers(), arrayBuffer: async () => new ArrayBuffer(0) };
  if (mode === 'ignore' || !init.headers?.Range) {
    return { ok: true, status: 200, headers: headers(), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
  }
  const m = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range), a = +m[1], b = +m[2];
  return {
    ok: true, status: 206, headers: headers({ 'content-range': `bytes ${a}-${b}/${buf.length}` }),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset + a, buf.byteOffset + b + 1),
  };
};
const reset = (m = 'range') => { log.length = 0; mode = m; };
const binRequests = () => log.filter((r) => r.url.endsWith('.bin'));
const same = (x, y) => assert.deepEqual(Array.from(x), Array.from(y));

try {
  const glb = path.join(tmp, 'rock.glb');
  fs.writeFileSync(glb, makeSample('rock', { texture: 64 }));
  const { meta } = await buildClod({ input: glb, outDir: tmp, name: 'rock', lods: false, log: quiet });
  const name = meta.name;

  // ---- 206: the hierarchy and the root page stream in, geometry stays partial, finer levels are additive
  reset('range');
  const partial = await loadClodStream(base, name, { rootBytes: 0 });
  assert.equal(partial.fallbackFull, false, 'Range-capable host does not fall back');
  assert.ok(partial.loadedLevel > 0 && partial.loadedLevel !== 255, 'a root page is resident');
  assert.ok(partial.residentBytes < partial.fullBytes, 'root page alone is smaller than the file');
  assert.ok(binRequests().every((r) => r.range), 'every .bin fetch used a Range header');
  const seen = binRequests().length;
  partial.wantLevel = 0;
  const pending = updateStreaming([partial]);
  assert.equal(pending.length, 1, 'a finer wanted level starts one fetch');
  await Promise.all(pending);
  assert.equal(partial.loadedLevel, 0);
  assert.equal(partial.residentBytes, partial.fullBytes);
  assert.equal(partial.requests, binRequests().length, 'requests counts every HTTP request');
  assert.ok(binRequests().length > seen, 'finer levels fetched more ranges');
  const lastRange = meta.levelRanges[meta.levelRanges.length - 1];
  assert.equal(partial.pos.length, lastRange.vertexEnd * 3, 'the Range path holds the DAG vertices');
  assert.equal(partial.idx.length, lastRange.indexEnd, 'the Range path holds the cluster indices');
  partial.wantLevel = 0;
  assert.deepEqual(updateStreaming([partial]), [], 'fully loaded assets are not fetched again');

  // ---- 200: one plain GET, every section sliced out of it, asset fully resident from the start
  reset('ignore');
  const full = await loadClodStream(base, name);
  assert.equal(full.fallbackFull, true, 'fallbackFull reports the whole-file path');
  assert.equal(full.loadedLevel, 0);
  assert.equal(full.residentBytes, full.fullBytes);
  assert.equal(full.requests, 1, 'the 200 body is reused: exactly one .bin request');
  assert.equal(binRequests().length, 1);
  // every section must match the bytes in the file at meta.sections[k]
  const raw = fs.readFileSync(path.join(tmp, `${name}.bin`));
  const types = { Float32Array, Int8Array, Uint32Array, Int32Array };
  for (const [k, s] of Object.entries(meta.sections)) {
    const C = types[s.type], want = new C(raw.buffer, raw.byteOffset + s.offset, s.bytes / C.BYTES_PER_ELEMENT);
    same(full[k], want);
  }
  assert.equal(full.geometry.attributes.position.array.length, meta.sections.positions.bytes / 4);
  assert.equal(full.geometry.attributes.position.count, meta.sections.positions.bytes / 12);
  assert.equal(full.geometry.index.array.length, meta.sections.indices.bytes / 4);
  assert.equal(full.minMemberLevel.length, meta.groups, 'hierarchy arrays were sliced from the full download');
  full.wantLevel = 0;
  assert.deepEqual(updateStreaming([full]), [], 'updateStreaming never asks a fallback asset for more');
  const before = log.length;
  await full.loadTo(0);
  assert.equal(log.length, before, 'loadTo is a no-op after the fallback');

  // ---- the whole download fails too: throw with the URL and the status, never a blank scene
  reset('fail');
  await assert.rejects(loadClodStream(base, name), (e) => {
    assert.match(e.message, /\.bin\b/, 'error names the file');
    assert.match(e.message, /HTTP 500/, 'error carries the status code');
    return true;
  });

  console.log(`ok: streaming 206 prefix growth and 200 whole-file fallback (${(meta.binBytes / 1048576).toFixed(1)} MB asset)`);
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
}
