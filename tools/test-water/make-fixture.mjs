/**
 * Fixture grid minimal untuk pengujian layer air di index.html.
 *
 * Grid 24x9 (rasio 24/9 ≈ canvas 1600/594 supaya viewport app menampilkan
 * seluruh grid): satu provinsi (P0) berisi tiga kab/kota (K0..K2), dua sel
 * danau (W) di tengah K1. Danau sengaja DIISI id kab K1 di KG — persis seperti
 * data produksi (237/290 sel air bertumpuk dengan polygon kab) — supaya jalur
 * "air menimpa kab" ikut teruji.
 *
 *   baris y=0 dan y=8: laut
 *   baris y=1..7: K0 (x 0..7) | K1 (x 8..15, danau di (10,4),(11,4)) | K2 (x 16..23)
 *
 * Output:
 *   mini-data.js       -> window.PETA_HD lengkap dengan waterRle
 *   mini-nowater.js    -> payload yang sama tanpa properti waterRle
 *   mini-page.html     -> salinan index.html yang memuat mini-data.js
 *   mini-page-nowater.html -> varian tanpa waterRle
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, '..', '..');
const W = 24, H = 9;
const SEA8 = 255, SEA16 = 65535;

const PG = new Uint8Array(W * H).fill(SEA8);
const KG = new Uint16Array(W * H).fill(SEA16);
const WG = new Uint8Array(W * H).fill(0);

const LAKE = [{ x: 10, y: 4 }, { x: 11, y: 4 }];
const isLake = (x, y) => LAKE.some(c => c.x === x && c.y === y);

for (let y = 1; y <= 7; y++) {
  for (let x = 0; x < W; x++) {
    const o = y * W + x;
    PG[o] = 0;
    KG[o] = x <= 7 ? 0 : x <= 15 ? 1 : 2;
    if (isLake(x, y)) WG[o] = 1; // KG tetap K1: meniru tumpang-tindih data nyata
  }
}

function stats(grid, sea) {
  const st = { x0: 1e9, y0: 1e9, x1: -1, y1: -1, sx: 0, sy: 0, a: 0 };
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === sea) continue;
    const x = i % W, y = (i / W) | 0;
    st.x0 = Math.min(st.x0, x); st.x1 = Math.max(st.x1, x);
    st.y0 = Math.min(st.y0, y); st.y1 = Math.max(st.y1, y);
    st.sx += x; st.sy += y; st.a++;
  }
  return { ...st, cx: Math.round(st.sx / st.a), cy: Math.round(st.sy / st.a) };
}

const rle = a => {
  const r = []; let c = a[0], n = 1;
  for (let i = 1; i < a.length; i++) { if (a[i] === c) n++; else { r.push(c, n); c = a[i]; n = 1; } }
  r.push(c, n); return r;
};

const kabNames = ['Alpha', 'Bravo', 'Charlie'];
const kab = [0, 1, 2].map(i => {
  const own = new Uint16Array(W * H).fill(SEA16);
  for (let k = 0; k < KG.length; k++) if (KG[k] === i) own[k] = i;
  return { c: `MINI.${i}`, n: kabNames[i], t: 'Kabupaten', p: 0, m: 0, ...stats(own, SEA16) };
});
const prov = [{ n: 'Provinsi Mini', m: 0, ...stats(PG, SEA8) }];

const payload = {
  W, H, lonMin: 100, lonMax: 110, latMin: -5, latMax: 5,
  prov, kab, provKab: [[0, 1, 2]],
  provRle: rle(PG), kabRle: rle(KG), waterRle: rle(WG),
};
const noWater = { ...payload };
delete noWater.waterRle;

mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, 'mini-data.js'), 'window.PETA_HD=' + JSON.stringify(payload) + ';\n');
writeFileSync(join(DIR, 'mini-nowater.js'), 'window.PETA_HD=' + JSON.stringify(noWater) + ';\n');
writeFileSync(join(DIR, 'mini-page.html'),
  readFileSync(join(ROOT, 'index.html'), 'utf8').replace('./data/peta-hd-data.js', './mini-data.js'));
writeFileSync(join(DIR, 'mini-page-nowater.html'),
  readFileSync(join(ROOT, 'index.html'), 'utf8').replace('./data/peta-hd-data.js', './mini-nowater.js'));

console.log(`fixture ${W}x${H}: ${LAKE.length} lake cells (KG overlap: K1), waterRle runs=${payload.waterRle.length}`);
console.log('written: mini-data.js, mini-nowater.js, mini-page.html, mini-page-nowater.html');
