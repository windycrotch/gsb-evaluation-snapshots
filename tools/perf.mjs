// Real-time performance probe: runs the actual game loop (bot vs bot demo) and reports frame times.
import puppeteer from 'puppeteer-core';
const [q = 'high', W = '1920', H = '1080', secs = '14'] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio', '--disable-gpu-vsync', '--disable-frame-rate-limit', `--window-size=${W},${H}`],
  defaultViewport: { width: +W, height: +H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:5183/?mode=game&q=${q}&autostart=clawd&demo=hard&level=hard`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 60000 });
await new Promise((r) => setTimeout(r, 4000));
const res = await page.evaluate((secs) => new Promise((resolve) => {
  const t = []; let last = performance.now(); const end = last + secs * 1000;
  const tick = (now) => { t.push(now - last); last = now; if (now < end) requestAnimationFrame(tick); else { t.sort((a, b) => a - b); const avg = t.reduce((a, b) => a + b, 0) / t.length; resolve({ frames: t.length, avgMs: +avg.toFixed(2), fps: +(1000 / avg).toFixed(1), p95: +t[Math.floor(t.length * 0.95)].toFixed(1), p99: +t[Math.floor(t.length * 0.99)].toFixed(1), quality: window.__game.stage.R.qualityName, res: [window.__game.stage.R.w, window.__game.stage.R.h] }); } };
  requestAnimationFrame(tick);
}), +secs);
console.log(JSON.stringify(res), errs.length ? errs.slice(0, 3) : '');
await browser.close();
