// Grab individual film-quality frames from the capture page (for look-dev and QA).
//   node tools/frame.mjs "<query>" <frame[,frame...]> <out-prefix> [w h] [fps] [s]
// e.g. node tools/frame.mjs "scene=showcase&only=faceoff" 0,48 out/look/poster
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [query = 'scene=showcase', framesArg = '0', prefix = 'out/look/f', W = '1920', H = '1080', FPS = '60', S = '4'] = process.argv.slice(2);
const frames = framesArg.split(',').map(Number).sort((a, b) => a - b);
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const base = process.env.BASE || 'http://127.0.0.1:5183/';
fs.mkdirSync(path.dirname(prefix), { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio', `--window-size=${W},${H}`],
  defaultViewport: { width: +W, height: +H, deviceScaleFactor: 1 }, protocolTimeout: 600000,
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) logs.push(m.text()); });
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
await page.goto(`${base}?mode=capture&fps=${FPS}&s=${S}&q=film&${query}`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true || (window.__errors && window.__errors.length > 0)', { timeout: 120000 });
const errs = await page.evaluate(() => window.__errors);
if (errs.length) { console.error(errs.join('\n')); await browser.close(); process.exit(1); }
let at = 0;
for (const f of frames) {
  // render the two frames before the target too, so exposure adaptation has settled like in the film
  const lead = Math.min(2, f - at);
  if (f - at - lead > 0) await page.evaluate((n) => window.__cap.skip(n), f - at - lead);
  for (let i = 0; i < lead; i++) await page.evaluate(() => window.__cap.frame());
  await page.evaluate(() => window.__cap.frame());
  at = f + 1;
  const out = `${prefix}_${String(f).padStart(4, '0')}.jpg`;
  await page.screenshot({ path: out, type: 'jpeg', quality: 93 });
  console.log(out);
}
await browser.close();
if (logs.length) console.log(logs.slice(0, 10).join('\n'));
