// Robust local static server for the browser checks: no-cache, supports
// range requests, higher connection backlog than Python's simple server.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
const root = fileURLToPath(new URL('../', import.meta.url));
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.webp':'image/webp', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = normalize(join(root, p));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    const s = await stat(file).catch(() => null);
    if (s?.isDirectory()) file = join(file, 'index.html');
    const data = await readFile(file);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
    const range = req.headers.range;
    if (range?.startsWith('bytes=')) {
      const [startS, endS] = range.slice(6).split('-');
      const start = +startS, end = endS ? +endS : data.length - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end-start+1, 'Accept-Ranges': 'bytes' });
      return res.end(data.subarray(start, end+1));
    }
    res.writeHead(200, { 'Content-Length': data.length });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
const port = Number(process.argv[2] || 0);
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  writeFileSync(new URL('./.serve-url', import.meta.url), url);
  console.log(url);
});
