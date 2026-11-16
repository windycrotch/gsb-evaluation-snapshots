// Static server for the served folder (the project folder, see locate() in render.js), plus private endpoints the in-page runtime uses to hand encoded bytes to Node.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';

export const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wasm': 'application/wasm', '.txt': 'text/plain',
};

function mediabunnyBundle() {   // the ESM browser bundle that ships inside the pinned npm package
  let dir = dirname(createRequire(import.meta.url).resolve('mediabunny'));
  while (!existsSync(join(dir, 'dist', 'bundles', 'mediabunny.min.mjs'))) { const up = dirname(dir); if (up === dir) throw new Error('mediabunny bundle not found'); dir = up; }
  return join(dir, 'dist', 'bundles', 'mediabunny.min.mjs');
}

// Files for scene pages at fixed paths, so a page loads them the same way from the renderer and from the viewer.
const pageFile = file => () => new URL(`./page/${file}`, import.meta.url);
const PAGE_LIBS = {
  '/__motlab/footage.js': pageFile('footage.js'), '/__motlab/motion.js': pageFile('motion.js'), '/__motlab/transitions.js': pageFile('transitions.js'),
  '/__motlab/cuts.js': pageFile('cuts.js'), '/__motlab/transition.html': pageFile('transition.html'), '/__motlab/mediabunny.mjs': mediabunnyBundle,
};
export const pageLib = pathname => PAGE_LIBS[pathname]?.();

// Sends a file, honouring a single Range request so footage can be read in pieces and MP4s can be seeked.
// pipeline, not pipe: the browser aborts many range requests while it seeks, and pipe would leave the file open.
const stream = (res, path, range) => pipeline(createReadStream(path, range), res, () => {});
export function sendFile(req, res, path) {
  const size = statSync(path).size, type = TYPES[extname(String(path)).toLowerCase()] || 'application/octet-stream';
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  const head = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
  if (m && (m[1] || m[2])) {
    const start = m[1] ? +m[1] : Math.max(0, size - +m[2]), end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
    if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return stream(res, path, { start, end });
  }
  res.writeHead(200, { ...head, 'Content-Length': size });
  stream(res, path);
}

const readBody = req => new Promise((ok, no) => { const parts = []; req.on('data', d => parts.push(d)); req.on('end', () => ok(Buffer.concat(parts))); req.on('error', no); });

export async function startServer({ root }) {
  const ROOT = resolve(root), prefix = `/__motlab/${randomBytes(8).toString('hex')}`;
  const sinks = new Map(); let nextSink = 0;

  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      if (u.pathname.startsWith(prefix + '/')) {
        const route = u.pathname.slice(prefix.length + 1);
        if (req.method === 'GET' && route === 'mediabunny.mjs') return sendFile(req, res, mediabunnyBundle());
        if (req.method === 'GET' && route === 'blank.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><meta charset="utf-8"><title>motlab</title>'); }
        const sink = sinks.get(u.searchParams.get('id'));
        if (req.method === 'POST' && sink && (route === 'write' || route === 'append')) {
          const body = await readBody(req);
          if (route === 'write') await sink.fh.write(body, 0, body.length, Number(u.searchParams.get('pos')));
          else await (sink.tail = sink.tail.then(async () => { await sink.fh.write(body, 0, body.length, sink.size); sink.size += body.length; }));
          res.writeHead(204); return res.end();
        }
        res.writeHead(404); return res.end();
      }
      const lib = pageLib(u.pathname);
      if (lib) return sendFile(req, res, lib);
      const path = join(ROOT, decodeURIComponent(u.pathname));
      if ((path !== ROOT && !path.startsWith(ROOT + sep)) || !existsSync(path) || statSync(path).isDirectory()) { res.writeHead(404); return res.end(); }
      sendFile(req, res, path);
    } catch (e) { res.writeHead(500); res.end(String(e && e.message)); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin, base: origin + prefix,
    // A sink is a file the page may write to: positional writes (MP4 muxer) or appends (raw bitstream, stills).
    async createSink(path) {
      const id = String(++nextSink), sink = { fh: await open(path, 'w'), size: 0, tail: Promise.resolve() };
      sinks.set(id, sink);
      return { id, path, close: async () => { sinks.delete(id); await sink.tail.catch(() => {}); await sink.fh.close(); } };
    },
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }),
  };
}
