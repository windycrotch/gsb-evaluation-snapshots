#!/usr/bin/env node
// Local acceptance run for the four behaviours in the brief:
//   1. splash -> 擦干 -> no wet marks -> splash again -> new marks appear
//   2. splashing past the per-leg limit still shows the newest splash
//   3. the copied link restores each leg's wet marks in another tab
//   4. a link with the wetness field removed still renders a dry leg
//
// Uses Playwright only (no test runner). Run:
//   npm i -D playwright && npx playwright install chromium
//   npm run test:e2e

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2', '.json': 'application/json',
};
const VIEWPORT = { width: 1280, height: 800 };
const LEG_CLIP = { x: 390, y: 170, width: 420, height: 460 };
const LIMIT = 24;
// Splash points that land on the stockings at the default camera.
const HIT_POINTS = [[470, 250], [480, 280], [490, 300], [500, 330], [510, 350], [520, 380],
  [530, 410], [540, 440], [500, 470], [510, 500], [520, 530]];

function serve() {
  const server = http.createServer(async (request, response) => {
    try {
      const path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname));
      const safe = path === sep || path === '/' ? 'index.html' : path.replace(/^[\\/]+/, '');
      if (safe.split(/[\\/]/).includes('..')) throw new Error('bad path');
      const body = await readFile(join(root, safe));
      response.writeHead(200, { 'content-type': TYPES[extname(safe)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('需要 Playwright：npm i -D playwright && npx playwright install chromium');
    process.exit(2);
  }
  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const errors = [];

  function watch(page) {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    return page;
  }

  async function open(hash = '') {
    const page = watch(await browser.newPage({ viewport: VIEWPORT }));
    await page.goto(`${origin}/?selftest=1${hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 45000 });
    // Freeze the render loop so every capture below is deterministic; actions
    // still apply effects immediately, they just do not animate.
    await page.evaluate(() => window.__yusi.freeze(true));
    return page;
  }
  // Reopening a link in a new tab occasionally misses the ready class within
  // the first load; retry once instead of failing the whole run.
  async function openWithRetry(hash) {
    try {
      return await open(hash);
    } catch {
      return open(hash);
    }
  }

  const wetness = page => page.evaluate(() => window.__yusi.wetness());
  const countWet = async page => (await wetness(page)).flat().length;

  // Read the leg area straight from the WebGL drawing buffer after snapping
  // the camera, in the same task, so no easing or animation can slip in
  // between. Screenshots would capture whatever the next animation frame drew,
  // which is why frames taken back-to-back could differ.
  async function legPixels(page) {
    await page.evaluate(() => window.__yusi.settle());
    return page.evaluate(clip => {
      const source = document.getElementById('view');
      const gl = source.getContext('webgl2');
      const ratio = source.width / source.clientWidth;
      const width = Math.round(clip.width * ratio);
      const height = Math.round(clip.height * ratio);
      const x = Math.round(clip.x * ratio);
      const y = Math.round(source.height - (clip.y + clip.height) * ratio);
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return Array.from(pixels);
    }, LEG_CLIP);
  }

  const diff = (a, b) => {
    let differing = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) > 8 || Math.abs(a[i + 1] - b[i + 1]) > 8 ||
          Math.abs(a[i + 2] - b[i + 2]) > 8) differing++;
    }
    return differing;
  };
  const total = LEG_CLIP.width * LEG_CLIP.height;

  // Droplets and ripples fly for a second or two after a splash; they are not
  // part of what these checks assert, so clear them before reading pixels. The
  // view also eases and auto-orbits while idle, so pin the camera and freeze
  // the animation loop first; otherwise two captures seconds apart differ.
  async function stablePixels(page) {
    await page.evaluate(() => {
      window.__yusi.clearWater();
      window.__yusi.resetCamera();
      window.__yusi.freeze(true);
    });
    await page.waitForTimeout(80);
    return legPixels(page);
  }

  async function resume(page) {
    await page.evaluate(() => window.__yusi.freeze(false));
  }

  // --- 1. dry clears both legs, and a new splash paints again -------------
  const page = await open();
  const clean = await stablePixels(page);
  for (const [x, y] of HIT_POINTS.slice(0, 4)) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(500);
  const wetFrame = await stablePixels(page);
  const wetBefore = await wetness(page);
  check('泼水后留下湿痕', wetBefore.some(leg => leg.length > 0),
    JSON.stringify(wetBefore.map(leg => leg.length)));
  check('泼水改变了画面', diff(clean, wetFrame) > total * .002,
    `diff=${diff(clean, wetFrame)}/${total}px`);

  await page.click('#dryBtn');
  await page.waitForTimeout(300);
  const dryWet = await wetness(page);
  check('擦干后两条腿湿痕立刻清零', dryWet.every(leg => leg.length === 0), JSON.stringify(dryWet));
  const dried = await stablePixels(page);
  check('擦干后画面回到干的状态', diff(clean, dried) < total * .001,
    `diff=${diff(clean, dried)}/${total}px`);

  // Holding the button down must not keep painting through the towel.
  await page.mouse.move(500, 400);
  await page.mouse.down();
  await page.waitForTimeout(220);
  await page.evaluate(() => document.getElementById('dryBtn').click());
  await page.waitForTimeout(120);
  const heldAfterDry = await countWet(page);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const afterRelease = await countWet(page);
  check('按住时点擦干不会继续留下湿痕', heldAfterDry === 0 && afterRelease === 0,
    `marks=${heldAfterDry}/${afterRelease}`);

  await page.mouse.click(500, 380);
  await page.waitForTimeout(400);
  const rewet = await wetness(page);
  check('擦干后再泼水能留下新湿痕', rewet.some(leg => leg.length > 0),
    JSON.stringify(rewet.map(leg => leg.length)));

  // --- 2. past the limit the newest splash still lands -------------------
  // Fill a leg to exactly the limit with marks spaced farther apart than the
  // merge distance, all low on the leg, then splash high on the thigh. That
  // makes the splash a brand-new mark rather than a growth of a neighbour, so
  // the check isolates "new splash replaces the oldest" from "nearby splash
  // merges into an existing one".
  const seed = [];
  for (let row = 0; row < 5; row++) {
    for (let column = 0; column < 5; column++) {
      seed.push({ x: -.06 + column * .03, y: .12, z: .02 + row * .03, r: .03 });
    }
  }
  await page.evaluate(marks => window.__yusi.setWetness([marks, []]), seed.slice(0, LIMIT));
  const seeded = await wetness(page);
  check('连续泼水能填满上限', seeded[0].length === LIMIT,
    JSON.stringify(seeded.map(leg => leg.length)));

  let overflow = null;
  for (const [x, y] of HIT_POINTS) {
    const before = (await wetness(page))[0];
    const leg = await page.evaluate(([px, py]) => window.__yusi.splashAt(px, py), [x, y]);
    if (leg !== 0) continue;
    const after = (await wetness(page))[0];
    const newest = after.at(-1);
    const brandNew = !before.some(mark => Math.abs(mark.x - newest.x) < 1e-9 &&
      Math.abs(mark.y - newest.y) < 1e-9 && Math.abs(mark.z - newest.z) < 1e-9);
    const oldestGone = !after.some(mark => Math.abs(mark.x - before[0].x) < 1e-9 &&
      Math.abs(mark.y - before[0].y) < 1e-9 && Math.abs(mark.z - before[0].z) < 1e-9);
    if (after.length === LIMIT && brandNew && oldestGone) {
      overflow = { before, after };
      break;
    }
  }
  check('超出上限时新水点覆盖最旧的一条', Boolean(overflow),
    overflow ? `marks=${overflow.after.length}` : '没有水点替换掉旧湿痕');
  if (overflow) {
    check('上限内不丢弃新水点', overflow.after.length === LIMIT,
      `marks=${overflow.after.length}`);
  }
  await page.close();

  // --- 3. the link carries both legs' marks -------------------------------
  const shared = await open();
  for (const [x, y] of HIT_POINTS.slice(0, 6)) {
    await shared.mouse.click(x, y);
    await shared.waitForTimeout(150);
  }
  await shared.waitForTimeout(400);
  const sharedFrame = await stablePixels(shared);
  const sharedWet = await wetness(shared);
  const url = await shared.evaluate(() => window.__yusiUI.link());
  check('链接里带上了湿痕', /#look=[^#]*~[^~]+~[^~]+$/.test(url), url.replace(origin, ''));
  const sharedHash = new URL(url).hash;
  const linkFields = new URLSearchParams(sharedHash.slice(1)).get('look').split('~');
  const linkWetness = linkFields.slice(-2);
  check('两条腿的湿痕都进了链接',
    sharedWet.every((leg, index) => (leg.length === 0
      ? linkWetness[index] === '-'
      : linkWetness[index].split(';').length === leg.length)),
    JSON.stringify(linkWetness.map(field => field.split(';').length)));

  const restored = watch(await browser.newPage({ viewport: VIEWPORT }));
  await restored.goto(url, { waitUntil: 'domcontentloaded' });
  await restored.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 45000 });
  const restoredFrame = await stablePixels(restored);
  const restoredWet = await wetness(restored);
  const closeEnough = sharedWet.length === restoredWet.length &&
    sharedWet.every((leg, index) => leg.length === restoredWet[index].length &&
      leg.every((mark, slot) => Math.abs(mark.x - restoredWet[index][slot].x) <= 1e-5 &&
        Math.abs(mark.y - restoredWet[index][slot].y) <= 1e-5 &&
        Math.abs(mark.z - restoredWet[index][slot].z) <= 1e-5 &&
        Math.abs(mark.r - restoredWet[index][slot].r) <= 1e-5));
  check('打开链接后湿痕位置与半径一致', closeEnough,
    JSON.stringify(restoredWet.map(leg => leg.length)));
  check('打开链接后画面一致', diff(sharedFrame, restoredFrame) < total * .002,
    `diff=${diff(sharedFrame, restoredFrame)}/${total}px`);
  await restored.close();
  await shared.close();

  // --- 4. links with broken or missing wetness still render --------------
  // Reuse one page: each tab allocates another WebGL context, and the browser's
  // budget is small enough that a dozen tabs start failing to boot. Same-document
  // hash navigation keeps the renderer alive between links.
  const review = watch(await browser.newPage({ viewport: VIEWPORT }));
  const visit = async target => {
    await review.goto(target, { waitUntil: 'domcontentloaded' });
    return review.waitForFunction(
      () => document.body.classList.contains('ready'), null, { timeout: 45000 },
    ).then(() => true, () => false);
  };
  const visitHash = async hash => {
    await review.evaluate(next => { location.hash = next; }, hash);
    await review.waitForTimeout(400);
    return review.evaluate(() => document.body.classList.contains('ready'));
  };
  await visit(`${origin}/?selftest=1`);
  const dryFrame = await stablePixels(review);
  const dryMarks = await wetness(review);
  const legacy = `#look=1~step~studio~lilac~thigh.lace.0.sheer.40.none.ink.none.-~thigh.lace.0.sheer.40.none.ink.none.-`;
  const variants = {
    '删掉湿痕字段': legacy,
    '湿痕字段非法': legacy + '~1,2,oops,4~-',
    '湿痕半径越界': legacy + '~1,2,3,999~-',
    '湿痕数字不足': legacy + '~0.1,0.2~-',
    '湿痕只有分隔符': legacy + '~;;~-',
  };
  for (const [label, hash] of Object.entries(variants)) {
    const before = errors.length;
    const ready = await visitHash(hash);
    const marks = ready ? await wetness(review) : [];
    const same = ready ? diff(dryFrame, await stablePixels(review)) : Infinity;
    check(`${label}时页面正常显示无湿痕造型`,
      ready && marks.every(leg => leg.length === 0) && same < total * .001 &&
      errors.length === before,
      `ready=${ready} marks=${JSON.stringify(marks.map(leg => leg.length))} diff=${same}px`);
  }
  await review.close();
  check('干造型本身没有湿痕', dryMarks.every(leg => leg.length === 0));

  check('全程没有页面错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} 项未通过` : '\n全部验收项通过');
  process.exit(failures ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
