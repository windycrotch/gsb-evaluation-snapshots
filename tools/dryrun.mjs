// Run the showcase without drawing anything and print the director's event log. Used to line the
// staged beats up with the score: the simulation is deterministic, so these times are the film's.
//   node tools/dryrun.mjs ["extra=query"]
import puppeteer from 'puppeteer-core';

const base = process.env.BASE || 'http://127.0.0.1:5183/';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio', '--window-size=640,360'],
  defaultViewport: { width: 640, height: 360, deviceScaleFactor: 1 }, protocolTimeout: 600000,
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.text().startsWith('[director]')) console.log(m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${base}?mode=capture&scene=showcase&fps=60&s=8&q=low${process.argv[2] ? '&' + process.argv[2] : ''}`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true || (window.__errors && window.__errors.length > 0)', { timeout: 120000 });
const total = Math.min(await page.evaluate(() => window.__cap.total), +(process.argv[3] || 1e9));
const t0 = Date.now();
for (let i = 0; i < total; i += 60) await page.evaluate((n) => window.__cap.skip(n), Math.min(60, total - i));
console.log(`simulated ${total} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await browser.close();
