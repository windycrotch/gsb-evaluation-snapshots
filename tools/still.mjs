// Render one deterministic still from the running dev server.
//   node tools/still.mjs "<query string>" out/name.png [width height]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const [query = 'mode=lookdev', out = 'out/still.png', W = '1920', H = '1080'] = process.argv.slice(2);
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const base = process.env.BASE || 'http://127.0.0.1:5183/';
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio', `--window-size=${W},${H}`],
  defaultViewport: { width: +W, height: +H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const t0 = Date.now();
await page.goto(base + '?' + query, { waitUntil: 'load' });
try {
  await page.waitForFunction('window.__ready === true || (window.__errors && window.__errors.length > 0)', { timeout: 90000 });
} catch (e) { logs.push('[timeout] page never became ready'); }
if (process.env.WAIT) await new Promise((r) => setTimeout(r, +process.env.WAIT));
const info = await page.evaluate(() => ({ info: window.__info, errors: window.__errors }));
fs.mkdirSync(out.replace(/[\/][^\/]*$/, ''), { recursive: true });
await page.screenshot({ path: out, type: out.endsWith('.jpg') ? 'jpeg' : 'png', ...(out.endsWith('.jpg') ? { quality: 92 } : {}) });
await browser.close();
console.log(JSON.stringify({ out, ms: Date.now() - t0, ...info }, null, 1));
if (logs.length) console.log(logs.slice(0, 30).join('\n'));
