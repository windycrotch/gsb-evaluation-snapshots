// Scripted smoke test of the playable game: drives the real page with real key events and checks
// that every player action reaches the simulation. Needs the dev server (npm run dev).
//   node tools/playtest.mjs
import puppeteer from 'puppeteer-core';

const base = process.env.BASE || 'http://127.0.0.1:5183/';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,720'],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
await page.goto(base + '?q=low', { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 60000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tap = async (key, hold = 70) => { await page.keyboard.down(key); await sleep(hold); await page.keyboard.up(key); };
const state = () => page.evaluate(() => {
  const g = window.__game, w = g.stage.world, [me, op] = w.fighters;
  return { flow: g.G.state, char: me.char, level: g.G.level, t: +w.time.toFixed(2), st: me.state, seq: me.moveSeq, move: me.move ? me.move.id : null, x: +me.x.toFixed(2), z: +me.z.toFixed(2), y: +me.y.toFixed(2), hp: +me.hp.toFixed(1), ohp: +op.hp.toFixed(1), stamina: Math.round(me.stamina), cdS1: +me.cdS1.toFixed(2), cdS2: +me.cdS2.toFixed(2), energy: Math.round(me.energy), dist: +Math.hypot(op.x - me.x, op.z - me.z).toFixed(2), audio: g.audio.A ? g.audio.A.ctx.state : 'off' };
});
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

// menu
let s = await state();
check('menu shows on load', s.flow === 'menu');
await tap('KeyD'); await sleep(120);
s = await state();
check('D selects Codex', s.flow === 'menu' && (await page.evaluate(() => window.__game.G.char)) === 'codex');
await tap('KeyA'); await sleep(80);
await tap('KeyS'); await tap('KeyS'); await tap('KeyS'); await sleep(80); // difficulty down to easy
check('S lowers difficulty to easy', (await page.evaluate(() => window.__game.G.level)) === 'easy');
await tap('Enter');
await page.waitForFunction('window.__game.G.state === "fight"', { timeout: 15000 });
s = await state();
check('Enter starts a round as Clawd', s.flow === 'fight' && s.char === 'clawd', `audio ${s.audio}`);
// make the bot stand still so the checks are about the player's inputs only
await page.evaluate(() => { window.__game.G.bot.directive = { do: 'idle', noDefense: true, noTech: true }; });

// movement
const x0 = s.x, d0 = s.dist;
await page.keyboard.down('KeyW'); await sleep(450); await page.keyboard.up('KeyW');
s = await state();
check('W walks toward the opponent', s.dist < d0 - 1, `distance ${d0} → ${s.dist}`);
await page.keyboard.down('KeyD'); await sleep(350); await page.keyboard.up('KeyD');
const s2 = await state();
check('D strafes', Math.hypot(s2.x - s.x, s2.z - s.z) > 0.8);

// close in and run the light string
await page.keyboard.down('KeyW');
for (let i = 0; i < 40 && (await state()).dist > 2.2; i++) await sleep(50);
await page.keyboard.up('KeyW');
let before = await state();
for (let i = 0; i < 4; i++) { await tap('KeyJ', 50); await sleep(150); }
await sleep(250);
s = await state();
check('J x4 chains light attacks', s.seq - before.seq >= 3, `${s.seq - before.seq} moves started`);
check('light string damages the opponent', s.ohp < before.ohp - 3, `opponent hp ${before.ohp} → ${s.ohp}`);
await sleep(900);

// one very short tap must still register (input latch)
before = await state();
await tap('KeyK', 4);
await sleep(200);
s = await state();
check('a 4 ms tap of K still starts a heavy', s.seq > before.seq, `move ${s.move}`);
await sleep(900);

// specials
before = await state();
await tap('KeyQ'); await sleep(350);
s = await state();
check('Q fires special 1 (cooldown starts)', s.cdS1 > 0.5 && s.seq > before.seq, `cd ${s.cdS1}`);
await sleep(700);
await tap('KeyE'); await sleep(350);
s = await state();
check('E fires special 2 (cooldown starts)', s.cdS2 > 0.5, `cd ${s.cdS2}`);
await sleep(900);

// jump, dash, block
await tap('Space'); await sleep(180);
s = await state();
check('Space jumps', s.y > 0.4, `height ${s.y}`);
await sleep(900);
before = await state();
await page.keyboard.down('KeyS'); await sleep(30); await tap('ShiftLeft'); await sleep(260); await page.keyboard.up('KeyS');
s = await state();
check('Shift dashes and spends stamina', s.stamina < before.stamina - 10 || s.dist > before.dist + 2, `stamina ${before.stamina} → ${s.stamina}, distance ${before.dist} → ${s.dist}`);
await sleep(500);
await page.keyboard.down('KeyL'); await sleep(200);
s = await state();
check('L holds a block', s.st === 4, `state ${s.st}`);
await page.keyboard.up('KeyL');

// ultimate with a full meter
await page.evaluate(() => { window.__game.stage.world.fighters[0].energy = 100; });
await sleep(300);
await tap('KeyR'); await sleep(500);
s = await state();
check('R starts the ultimate at full meter', s.move === 'ULT' && s.energy < 50, `move ${s.move}`);
await sleep(3200);

// pause
await tap('Escape'); await sleep(200);
const paused = await page.evaluate(() => window.__game.G.paused);
const tA = (await state()).t; await sleep(400); const tB = (await state()).t;
check('Esc pauses the simulation', paused && tA === tB);
await tap('Escape'); await sleep(200);
check('Esc resumes', !(await page.evaluate(() => window.__game.G.paused)));

// let the round play out: hand the player to a strong bot so it ends quickly, and check the flow
await page.evaluate(() => { window.__game.G.bot.directive = null; });
await page.evaluate(() => { const g = window.__game; g.stage.world.fighters[1].hp = 6; });
await page.keyboard.down('KeyW');
let ended = false;
for (let i = 0; i < 160; i++) {
  await tap('KeyJ', 40); await sleep(90);
  const f = await page.evaluate(() => ({ flow: window.__game.G.state, round: window.__game.G.round, wins: window.__game.G.wins }));
  if (f.flow !== 'fight') { ended = true; console.log('      round ended:', JSON.stringify(f)); break; }
}
await page.keyboard.up('KeyW');
check('a round can be won', ended);
await page.waitForFunction('window.__game.G.round === 2 || window.__game.G.state === "result"', { timeout: 12000 }).catch(() => {});
const f2 = await page.evaluate(() => ({ flow: window.__game.G.state, round: window.__game.G.round, wins: window.__game.G.wins }));
check('next round starts with the win recorded', f2.round === 2 && f2.wins[0] + f2.wins[1] === 1, JSON.stringify(f2));

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
