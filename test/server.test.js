import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

// Footage is read with Range requests, and the browser aborts many of them while seeking. Every file stream the
// server opens must close when its request is aborted, or the viewer runs out of file handles (EMFILE).
test('a file stream closes when its request is aborted', async () => {
  const open = new Set(), real = fs.createReadStream;
  fs.createReadStream = (...args) => { const s = real(...args); open.add(s); s.on('close', () => open.delete(s)); return s; };
  syncBuiltinESMExports();
  const dir = fs.mkdtempSync(join(tmpdir(), 'motlab-server-')), file = join(dir, 'big.bin');
  fs.writeFileSync(file, Buffer.alloc(32 * 1024 * 1024));
  const { startServer } = await import(`../src/server.js?abort=${Date.now()}`);
  const server = await startServer({ root: dir });
  try {
    const abortAfterFirstChunk = range => new Promise(ok => {
      const req = request(`${server.origin}/big.bin`, { headers: range ? { Range: range } : {} }, res => res.once('data', () => { req.destroy(); ok(); }));
      req.on('error', ok); req.end();
    });
    for (let i = 0; i < 20; i++) await abortAfterFirstChunk(i % 2 ? 'bytes=0-' : null);
    for (let i = 0; i < 50 && open.size; i++) await sleep(20);
    assert.equal(open.size, 0, `${open.size} file streams still open after 20 aborted requests`);
  } finally {
    await server.close(); fs.createReadStream = real; syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
