// Headless runner for the pause/blur/death/respawn regression suite.
//
//   node tools/run-pause-tests.mjs
//
// 1. builds the dev bundle (index.html with __DEV__ helpers + src/devtests.js)
// 2. serves the repo over http on a random free port
// 3. launches Chrome/Edge headless with --dump-dom against
//      http://127.0.0.1:<port>/index.html?manual&pausetest
//    The suite runs synchronously inside the page (frames only advance via __step/__bot, the rAF
//    loop is bypassed by ?manual) and embeds its JSON report in <pre id="pausetest" data-json=...>.
// 4. parses the dumped DOM and exits non-zero on any failed check.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}

function serve(port) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
  const srv = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise(resolve => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

const BROWSERS = [
  process.env.CHROME_BIN,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

function findBrowser() {
  for (const b of BROWSERS) { try { if (fs.existsSync(b)) return b; } catch { /* ignore */ } }
  return null;
}

// Minimal unescaper for the data-json attribute (the page HTML-encodes quotes).
function decodeAttr(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error('No Chrome/Edge binary found. Set CHROME_BIN to a Chromium-based browser path.');
    process.exit(2);
  }
  const port = await freePort();
  const srv = await serve(port);
  const profileDir = 'C:\\Users\\Public\\nova-pausetest-' + Date.now();
  const url = `http://127.0.0.1:${port}/index.html?manual&pausetest`;
  console.log(`[runner] ${path.basename(browser)} → ${url}`);

  const child = spawn(browser, [
    '--headless=new',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--disable-extensions',
    '--disable-gpu',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-frame-rate-limit',
    // The suite runs synchronously via __step frames; this just keeps --dump-dom alive long
    // enough for the page script to finish (virtual time never feeds the game's manual frames).
    '--virtual-time-budget=30000',
    '--dump-dom',
    url,
  ], { cwd: root });

  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });

  const timer = setTimeout(() => {
    console.error('[runner] timed out waiting for the test page');
    child.kill();
    srv.close();
    process.exit(3);
  }, 120000);

  await new Promise(resolve => child.on('exit', resolve));
  clearTimeout(timer);
  srv.close();
  fs.rmSync(profileDir, { recursive: true, force: true });

  const crash = stdout.match(/<pre id="pausetest"[^>]*data-crash="([^"]*)"/);
  if (crash) {
    console.error('[runner] the suite crashed:\n' + decodeAttr(crash[1]));
    process.exit(4);
  }
  const m = stdout.match(/<pre id="pausetest"[^>]*data-json="([^"]*)"/);
  if (!m) {
    console.error('[runner] suite did not produce a report. Browser stderr tail:');
    console.error(stderr.split('\n').filter(Boolean).slice(-12).join('\n'));
    process.exit(5);
  }

  let summary;
  try { summary = JSON.parse(decodeAttr(m[1])); }
  catch (e) { console.error('[runner] could not parse suite JSON:', e.message); process.exit(6); }

  for (const r of summary.results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '\n        ' + r.detail : ''}`);
  }
  console.log(`\n${summary.passed}/${summary.total} checks passed`);
  process.exit(summary.passed === summary.total ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(7); });
