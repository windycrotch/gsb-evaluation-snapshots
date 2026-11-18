/**
 * Verifikasi berbasis browser (Playwright, channel chrome sistem — tanpa
 * unduhan browser) untuk perlakuan layer air di index.html.
 *
 * Catatan teknis:
 * - viewport internal app tidak diekspos ke window, jadi view di-replikasi
 *   murni dari metadata (rumus viewFor identik dengan yang di index.html).
 * - Di level provinsi kanvas dilapisi dim rgba(7,11,20,.68). Warna batas
 *   (7,11,20) persis sama dengan warna dim sehingga tetap (7,11,20); warna
 *   air #1B4B7A teredam menjadi ~(13,31,53); isi ramp[0] #131C33 -> ~(11,16,30).
 *
 * Cakupan:
 *   A1. fixture mini + waterRle: danau tak terisi/tak terbatas, hover/klik/
 *       keyboard tidak menjadikan air hit administratif, batas darat tetap ada.
 *   A2. fixture mini tanpa waterRle: halaman hidup, masuk provinsi, outline ada.
 *   B1. data produksi, nasional: tanpa error.
 *   B2. Sumatera Utara (Danau Toba): konformasi piksel penuh — sel air berwarna
 *       air (bukan isi/batas kab), tak ada piksel batas menempel ke air,
 *       provinsi tetap tergambar utuh; hover air tak memunculkan tooltip.
 *   B3. data produksi dengan waterRle dihapus / waterRle=[]: tetap normal.
 *   B4. Bali (tanpa danau): batas kab/kota tetap digambar.
 *
 * Jalankan: node tools/test-water/test-water.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, '..', '..');
const TMP = join(DIR, 'tmp');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const DIM_A = 0.32; // sisa warna dasar setelah overlay 0.68
const dim = (r, g, b) => [Math.round(DIM_A * r + 0.68 * 7), Math.round(DIM_A * g + 0.68 * 11), Math.round(DIM_A * b + 0.68 * 20)];
const BORDER = [7, 11, 20];
const WATER_DIM = dim(0x1b, 0x4b, 0x7a);   // ~(13,31,53)
const FILL0_DIM = dim(0x13, 0x1c, 0x33);   // ~(11,16,30), bucket m=0
const near = (c, ref, tol = 4) => Math.abs(c[0] - ref[0]) <= tol && Math.abs(c[1] - ref[1]) <= tol && Math.abs(c[2] - ref[2]) <= tol;
const isBorderPx = c => c[0] === BORDER[0] && c[1] === BORDER[1] && c[2] === BORDER[2] && c[3] === 255;

let passed = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { fails.push(name); console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

function startServer() {
  return new Promise(resolve => {
    const srv = createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      const file = join(ROOT, url === '/' ? 'index.html' : url);
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      try { const body = readFileSync(file); res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' }); res.end(body); }
      catch { res.writeHead(404); res.end(); }
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

// ---- varian data produksi tanpa layer air ----
mkdirSync(TMP, { recursive: true });
const prod = JSON.parse(readFileSync(join(ROOT, 'data/peta-hd-data.json'), 'utf8'));
const makeVariant = (dataFile, pageFile, mutator) => {
  const d = JSON.parse(JSON.stringify(prod)); mutator(d);
  writeFileSync(join(TMP, dataFile), 'window.PETA_HD=' + JSON.stringify(d) + ';\n');
  writeFileSync(join(TMP, pageFile), readFileSync(join(ROOT, 'index.html'), 'utf8').replace('./data/peta-hd-data.js', './' + dataFile));
};
makeVariant('data-nowater.js', 'page-nowater.html', d => { delete d.waterRle; });
makeVariant('data-emptywater.js', 'page-emptywater.html', d => { d.waterRle = []; });

// replika rumus viewFor() di index.html — satu-satunya sumber transform grid->layar.
// Ditulis sebagai const-arrow ber-semicolon supaya aman digabung dengan IIFE (ASI)
// maupun dibungkus Playwright saat evaluate menerima argumen.
const viewForSrc = `
  const viewFor = (bb, pad, W, H, aspect) => {
    const cx = (bb.x0 + bb.x1) / 2 + 0.5, cy = (bb.y0 + bb.y1) / 2 + 0.5;
    let vw = Math.max((bb.x1 - bb.x0 + 1) * pad, (bb.y1 - bb.y0 + 1) * pad / aspect, 46);
    vw = Math.min(vw, W); let vh = vw * aspect;
    if (vh > H) { vh = H; vw = vh / aspect; }
    return { vx: Math.max(0, Math.min(W - vw, cx - vw / 2)), vy: Math.max(0, Math.min(H - vh, cy - vh / 2)), vw: vw, vh: vh };
  };`;

// Chrome/Edge 157 menolak --remote-debugging bila user-data-dir di luar
// LOCALAPPDATA ("DevTools remote debugging requires a non-default data directory").
// Solusi: luncurkan browser sendiri dengan profil di bawah LOCALAPPDATA, lalu
// sambungkan Playwright lewat CDP (tanpa unduhan browser tambahan).
function launchChromeOverCDP() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  const exe = candidates.find(p => { try { readFileSync(p); return true; } catch { return false; } });
  if (!exe) throw new Error('Tidak menemukan Chrome/Edge sistem untuk pengujian browser.');
  const profile = join(process.env.LOCALAPPDATA || TMP, 'PetaPixelWaterTestProfile');
  rmSync(profile, { recursive: true, force: true }); mkdirSync(profile, { recursive: true });
  const port = 9400 + Math.floor(Math.random() * 200);
  const child = spawn(exe, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank',
  ], { stdio: 'ignore', detached: false });
  return { child, profile, endpoint: `http://127.0.0.1:${port}` };
}
async function waitForCDP(endpoint, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`${endpoint}/json/version`); if (r.ok) return; } catch { /* belum siap */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`CDP tidak siap di ${endpoint}`);
}

const chromeProc = launchChromeOverCDP();
await waitForCDP(chromeProc.endpoint);
const browser = await chromium.connectOverCDP(chromeProc.endpoint);
const { srv, base } = await startServer();
const shots = [];
try {
  // ================= A1. fixture mini + waterRle =================
  console.log('A1. mini fixture + waterRle');
  {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 720 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error' && !/favicon/i.test(m.location()?.url || '')) errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`${base}/tools/test-water/mini-page.html`);
    await page.waitForFunction(() => document.getElementById('loadStatus').style.display === 'none');
    check('load tanpa error konsol', errors.length === 0, errors.join(' | '));

    // klik darat K1 (12,4): koordinat layar dihitung dari viewFor replika
    const clickCell = await page.evaluate(viewForSrc + `(() => {
      const D = window.PETA_HD, cv = document.getElementById('cv'), r = cv.getBoundingClientRect();
      const v = viewFor(D.prov[0], 1.65, D.W, D.H, cv.height / cv.width);
      const gx = 12, gy = 4;
      return { x: r.left + (gx + 0.5 - v.vx) / v.vw * r.width, y: r.top + (gy + 0.5 - v.vy) / v.vh * r.height };
    })()`);
    await page.mouse.click(clickCell.x, clickCell.y);
    await page.waitForTimeout(700);
    check('masuk level provinsi', /PROVINSI-MINI/i.test(await page.evaluate(() => document.getElementById('crumb').textContent)));

    // pembacaan piksel lewat transform viewFor yang sama dengan animasi app.
    // evaluate string dieksekusi sebagai ekspresi: dengan argumen, panggil
    // fungsinya inline agar deklarasi viewFor di atasnya ikut ter-closure.
    const readCell = (gx, gy) => page.evaluate(viewForSrc + `
      (cell => {
      const D = window.PETA_HD, cv = document.getElementById('cv'), ctx = cv.getContext('2d');
      const vv = viewFor(D.prov[0], 1.65, D.W, D.H, cv.height / cv.width);
      const px = Math.floor((cell[0] + 0.5 - vv.vx) / vv.vw * cv.width), py = Math.floor((cell[1] + 0.5 - vv.vy) / vv.vh * cv.height);
      return Array.from(ctx.getImageData(px, py, 1, 1).data);
    })(${JSON.stringify([gx, gy])})`);
    const lake1 = await readCell(10, 4), lake2 = await readCell(11, 4), land = await readCell(12, 4);
    check('sel danau (10,4): warna air, bukan batas/isi kab', !isBorderPx(lake1) && near(lake1, WATER_DIM, 2), JSON.stringify(lake1));
    check('sel danau (11,4): warna air, bukan batas/isi kab', !isBorderPx(lake2) && near(lake2, WATER_DIM, 2), JSON.stringify(lake2));
    check('sel darat K1 (12,4) tetap terisi kab (bukan air, bukan batas)', land[3] === 255 && !isBorderPx(land) && !near(land, WATER_DIM, 2), JSON.stringify(land));

    // scan baris grid penuh -> hitung piksel batas pada rentang sel tertentu
    const borderPixelsInCells = async (rowY, x0, x1) => page.evaluate(viewForSrc + `
      (q => {
      const D = window.PETA_HD, cv = document.getElementById('cv'), ctx = cv.getContext('2d');
      const v = viewFor(D.prov[0], 1.65, D.W, D.H, cv.height / cv.width);
      const py = Math.floor((q[0] + 0.5 - v.vy) / v.vh * cv.height);
      const xa = Math.floor((q[1] + 0.5 - v.vx) / v.vw * cv.width), xb = Math.floor((q[2] + 0.5 - v.vx) / v.vw * cv.width);
      const data = ctx.getImageData(xa, py, xb - xa, 1).data;
      let n = 0; for (let i = 0; i < data.length; i += 4) if (data[i] === 7 && data[i + 1] === 11 && data[i + 2] === 20) n++;
      return n;
    })(${JSON.stringify([rowY, x0, x1])})`);
    check('batas antar-kab di darat tetap tergambar (y=2, seluruh baris)', (await borderPixelsInCells(2, 0, 23)) > 0);
    // interior K1: sel 9..13 (danau di 10,11); tak boleh ada piksel batas sama sekali
    check('tidak ada garis batas di tepi/dalam danau (y=4, interior K1 sel 9..13)', (await borderPixelsInCells(4, 9, 13)) === 0);

    // hover & klik pada sel danau
    const lakePoint = await page.evaluate(viewForSrc + `(() => {
      const D = window.PETA_HD, cv = document.getElementById('cv'), r = cv.getBoundingClientRect();
      const v = viewFor(D.prov[0], 1.65, D.W, D.H, cv.height / cv.width);
      return { x: r.left + (10 + 0.5 - v.vx) / v.vw * r.width, y: r.top + (4 + 0.5 - v.vy) / v.vh * r.height };
    })()`);
    await page.mouse.move(lakePoint.x, lakePoint.y);
    await page.waitForTimeout(120);
    check('hover danau tidak memunculkan tooltip', await page.evaluate(() => document.getElementById('tip').style.display === 'none'));
    await page.mouse.click(lakePoint.x, lakePoint.y);
    await page.waitForTimeout(150);
    check('klik danau tidak membuka panel kab/kota', await page.evaluate(() => !/KABUPATEN|KOTA/i.test(document.getElementById('panel').textContent || '')));

    // keyboard: kursor awal di tengah viewport; geser kiri sampai masuk danau
    await page.locator('#cv').focus();
    let kbdText = null;
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(60);
      const live = await page.evaluate(() => document.getElementById('live').textContent || '');
      if (/perairan|laut/i.test(live)) { kbdText = live; break; }
    }
    check('kursor keyboard di danau: live region menyebut perairan, bukan wilayah', !!kbdText, kbdText || 'kursor tidak pernah mengenai danau');
    await page.screenshot({ path: join(DIR, 'shot-mini-water.png') }); shots.push('shot-mini-water.png');
    await ctx.close();
  }

  // ================= A2. fixture mini tanpa waterRle =================
  console.log('A2. mini fixture TANPA waterRle');
  {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 720 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/favicon/i.test(m.location()?.url || '')) errors.push(m.text()); });
    await page.goto(`${base}/tools/test-water/mini-page-nowater.html`);
    await page.waitForFunction(() => document.getElementById('loadStatus').style.display === 'none');
    const clickCell = await page.evaluate(viewForSrc + `(() => {
      const D = window.PETA_HD, cv = document.getElementById('cv'), r = cv.getBoundingClientRect();
      const v = viewFor(D.prov[0], 1.65, D.W, D.H, cv.height / cv.width);
      return { x: r.left + (12 + 0.5 - v.vx) / v.vw * r.width, y: r.top + (4 + 0.5 - v.vy) / v.vh * r.height };
    })()`);
    await page.mouse.click(clickCell.x, clickCell.y);
    await page.waitForTimeout(700);
    check('tanpa waterRle: tidak ada error / white screen', errors.length === 0, errors.join(' | '));
    check('tanpa waterRle: tetap masuk provinsi', /PROVINSI-MINI/i.test(await page.evaluate(() => document.getElementById('crumb').textContent)));
    const exLake = await page.evaluate(viewForSrc + `(() => {
      const D = window.PETA_HD, cv = document.getElementById('cv'), ctx = cv.getContext('2d');
      const v = viewFor(D.prov[0], 1.65, D.W, D.H, cv.height / cv.width);
      const px = Math.floor((10 + 0.5 - v.vx) / v.vw * cv.width), py = Math.floor((4 + 0.5 - v.vy) / v.vh * cv.height);
      return Array.from(ctx.getImageData(px, py, 1, 1).data);
    })()`);
    check('sel eks-danau (10,4) tetap opaque tergambar (fallback tanpa air)', exLake[3] === 255, JSON.stringify(exLake));
    const edges = await page.evaluate(() => {
      const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
      const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let n = 0; for (let i = 0; i < img.length; i += 4) if (img[i] === 7 && img[i + 1] === 11 && img[i + 2] === 20) n++;
      return n;
    });
    check('outline kab/kota tetap digambar', edges > 20, `piksel batas=${edges}`);
    await page.screenshot({ path: join(DIR, 'shot-mini-nowater.png') }); shots.push('shot-mini-nowater.png');
    await ctx.close();
  }

  // ================= B. data produksi =================
  console.log('B1. data produksi — load nasional');
  {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => document.getElementById('loadStatus').style.display === 'none');
    check('nasional: load tanpa error', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  console.log('B2. Sumatera Utara (Danau Toba) — konformasi piksel penuh');
  {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => document.getElementById('loadStatus').style.display === 'none');
    await page.fill('#regionSearch', 'Provinsi Sumatera Utara');
    await page.waitForTimeout(800);
    check('search membuka view provinsi', /SUMATERA-UTARA/i.test(await page.evaluate(() => document.getElementById('crumb').textContent)));

    const report = await page.evaluate(viewForSrc + `(() => {
      const D = window.PETA_HD, W = D.W, H = D.H, SEA16 = 65535;
      const inflate = (rle, Ctor) => { const g = new Ctor(W * H); let o = 0; for (let i = 0; i < rle.length; i += 2) { const v = rle[i], c = rle[i + 1]; for (let j = 0; j < c; j++) g[o++] = v; } return g; };
      const KG = inflate(D.kabRle, Uint16Array), WG = inflate(D.waterRle, Uint8Array), PG = inflate(D.provRle, Uint8Array);
      const pi = D.prov.findIndex(p => p.n === 'Sumatera Utara'), p = D.prov[pi];
      const inProv = {}; (D.provKab[pi] || []).forEach(k => { inProv[k] = 1; });
      const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
      const v = viewFor(p, 1.65, W, H, cv.height / cv.width);
      const toPx = (gx, gy) => [Math.floor((gx + 0.5 - v.vx) / v.vw * cv.width), Math.floor((gy + 0.5 - v.vy) / v.vh * cv.height)];
      const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
      const at = (px, py) => { const k = (py * cv.width + px) * 4; return [img[k], img[k + 1], img[k + 2], img[k + 3]]; };
      const waterDim = [13, 31, 53];
      const near = (c, ref) => Math.abs(c[0] - ref[0]) <= 4 && Math.abs(c[1] - ref[1]) <= 4 && Math.abs(c[2] - ref[2]) <= 4;
      const isBorderPx = c => c[0] === 7 && c[1] === 11 && c[2] === 20 && c[3] === 255;
      // replika PERSIS predikat edge buildProvKab pasca-perbaikan (mask air WG)
      const expectedEdge = (x, y, kv) => {
        const o = y * W + x;
        const sameL = x === 0 || WG[o - 1] || KG[o - 1] === kv, sameR = x === W - 1 || WG[o + 1] || KG[o + 1] === kv;
        const sameU = y === 0 || WG[o - W] || KG[o - W] === kv, sameD = y === H - 1 || WG[o + W] || KG[o + W] === kv;
        return !(sameL && sameR && sameU && sameD);
      };
      let waterSeen = 0, waterBad = 0, edges = 0, fills = 0, falseEdge = 0, missingEdge = 0;
      const badSamples = [], falseSamples = [], missingSamples = [];
      for (let y = p.y0; y <= p.y1; y++) for (let x = p.x0; x <= p.x1; x++) {
        const o = y * W + x; if (PG[o] !== pi) continue;
        const [px, py] = toPx(x, y);
        if (px < 0 || py < 0 || px >= cv.width || py >= cv.height) continue;
        const c = at(px, py), observedBorder = isBorderPx(c);
        if (WG[o]) {
          waterSeen++;
          if (observedBorder || !near(c, waterDim)) { waterBad++; if (badSamples.length < 5) badSamples.push([x, y, c.join(',')]); }
          continue;
        }
        const kv = KG[o];
        if (kv === SEA16 || !inProv[kv]) continue; // tidak dicat oleh buildProvKab
        if (observedBorder) edges++; else if (c[3] === 255) fills++;
        const exp = expectedEdge(x, y, kv);
        if (observedBorder && !exp) { falseEdge++; if (falseSamples.length < 5) falseSamples.push([x, y]); }
        if (exp && !observedBorder) { missingEdge++; if (missingSamples.length < 5) missingSamples.push([x, y]); }
      }
      return { waterSeen, waterBad, badSamples, falseEdge, falseSamples, missingEdge, missingSamples, edges, fills };
    })()`);
    check('error runtime saat konformasi: ' + (errors.join(' | ') || 'tidak ada'), errors.length === 0);
    check(`sel air provinsi ini terlihat di viewport (${report.waterSeen} sel)`, report.waterSeen > 50, `hanya ${report.waterSeen}`);
    check('setiap sel air berwarna air, bukan isi/batas kab', report.waterBad === 0, JSON.stringify(report.badSamples));
    check('batas tergambar sama persis dengan predikat ber-mask air (tanpa batas palsu)', report.falseEdge === 0, JSON.stringify(report.falseSamples));
    check('semua batas asli tetap tergambar (tidak ada yang hilang)', report.missingEdge === 0, JSON.stringify(report.missingSamples));
    check('provinsi tetap utuh: ratusan sel isi & batas kab', report.fills > 1000 && report.edges > 100, `fill=${report.fills} edge=${report.edges}`);

    // hover di sel Danau Toba -> tooltip admin tidak muncul.
    // Pilih sel air DI DALAM viewport yang terdekat ke pusat (sel row-major pertama bisa di luar layar).
    const pnt = await page.evaluate(viewForSrc + `(() => {
      const D = window.PETA_HD, W = D.W, H = D.H;
      const inflate = (rle, Ctor) => { const g = new Ctor(W * H); let o = 0; for (let i = 0; i < rle.length; i += 2) { const v = rle[i], c = rle[i + 1]; for (let j = 0; j < c; j++) g[o++] = v; } return g; };
      const WG = inflate(D.waterRle, Uint8Array), PG = inflate(D.provRle, Uint8Array);
      const pi = D.prov.findIndex(p => p.n === 'Sumatera Utara');
      const cv = document.getElementById('cv'), r = cv.getBoundingClientRect();
      const v = viewFor(D.prov[pi], 1.65, W, H, cv.height / cv.width);
      const gcx = v.vx + v.vw / 2, gcy = v.vy + v.vh / 2;
      let best = null, bestD = Infinity;
      for (let i = 0; i < WG.length; i++) {
        if (!WG[i] || PG[i] !== pi) continue;
        const x = i % W, y = (i / W) | 0;
        if (x < v.vx || x > v.vx + v.vw || y < v.vy || y > v.vy + v.vh) continue;
        const dd = (x - gcx) ** 2 + (y - gcy) ** 2;
        if (dd < bestD) { bestD = dd; best = [x, y]; }
      }
      if (!best) return { none: true };
      return { x: r.left + (best[0] + 0.5 - v.vx) / v.vw * r.width, y: r.top + (best[1] + 0.5 - v.vy) / v.vh * r.height };
    })()`);
    check('ada sel Danau Toba di dalam viewport untuk hover', !pnt.none);
    if (!pnt.none) {
      await page.mouse.move(pnt.x, pnt.y);
      await page.waitForTimeout(150);
      check('hover Danau Toba: tooltip admin tidak muncul', (await page.evaluate(() => document.getElementById('tip').style.display)) === 'none');
    }
    await page.screenshot({ path: join(DIR, 'shot-toba-prov.png') }); shots.push('shot-toba-prov.png');
    await ctx.close();
  }

  console.log('B3. data produksi tanpa waterRle / waterRle kosong');
  for (const [pageFile, tag] of [['page-nowater.html', 'missing'], ['page-emptywater.html', 'empty']]) {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/404|favicon/i.test(m.text())) errors.push(m.text()); });
    await page.goto(`${base}/tools/test-water/tmp/${pageFile}`);
    await page.waitForFunction(() => document.getElementById('loadStatus').style.display === 'none');
    await page.fill('#regionSearch', 'Provinsi Sumatera Utara');
    await page.waitForTimeout(800);
    const r = await page.evaluate(() => {
      const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
      const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let edges = 0; for (let i = 0; i < img.length; i += 4) if (img[i] === 7 && img[i + 1] === 11 && img[i + 2] === 20) edges++;
      return { inProv: /SUMATERA-UTARA/i.test(document.getElementById('crumb').textContent), edges };
    });
    check(`waterRle ${tag}: tanpa error, masuk provinsi, outline ada`, errors.length === 0 && r.inProv && r.edges > 100,
      `err=${errors.join('|')} inProv=${r.inProv} edges=${r.edges}`);
    await page.screenshot({ path: join(DIR, `shot-toba-${tag}.png`) }); shots.push(`shot-toba-${tag}.png`);
    await ctx.close();
  }

  console.log('B4. Bali (tanpa danau): batas kab/kota tetap normal');
  {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => document.getElementById('loadStatus').style.display === 'none');
    await page.fill('#regionSearch', 'Provinsi Bali');
    await page.waitForTimeout(800);
    const r = await page.evaluate(() => {
      const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
      const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let edges = 0; for (let i = 0; i < img.length; i += 4) if (img[i] === 7 && img[i + 1] === 11 && img[i + 2] === 20) edges++;
      return { inProv: /BALI/i.test(document.getElementById('crumb').textContent), edges };
    });
    check('Bali: masuk provinsi dan batas kab/kota tergambar', r.inProv && r.edges > 50, `edges=${r.edges}`);
    await page.screenshot({ path: join(DIR, 'shot-bali.png') }); shots.push('shot-bali.png');
    await ctx.close();
  }
} finally {
  await browser.close();
  srv.close();
  rmSync(TMP, { recursive: true, force: true });
  // profil di bawah LOCALAPPDATA hanya boleh dihapus setelah proses browser mati
  spawnSync(process.platform === 'win32' ? 'taskkill' : 'kill',
    process.platform === 'win32' ? ['/PID', String(chromeProc.child.pid), '/T', '/F'] : ['-9', String(chromeProc.child.pid)],
    { stdio: 'ignore' });
  for (let i = 0; i < 10; i++) {
    try { rmSync(chromeProc.profile, { recursive: true, force: true }); break; }
    catch { /* tunggu proses melepas file */ }
  }
}

console.log(`\n${passed} checks passed, ${fails.length} failed`);
if (fails.length) { console.error('FAILED: ' + fails.join('; ')); process.exit(1); }
console.log('screenshots: ' + shots.map(s => join('tools/test-water', s)).join(', '));
