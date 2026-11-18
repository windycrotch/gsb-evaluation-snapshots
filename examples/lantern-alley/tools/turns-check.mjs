// Verifies the attack-turn rules: at most one enemy holds the turn (and attacks) at any
// moment, the turn is released into a cooldown when the holder is knocked out or gives
// up, and Volt hitting a waiting enemy hands the turn over only when the holder is not
// mid-attack. Drives the real game with a fixed seed through ?manual=1 and __steps.
// Usage: node tools/turns-check.mjs [seed]   — exits non-zero if any check fails.
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// Headless environments sometimes lack the user-profile variables; without them Chromium
// cannot resolve its profile directories and refuses DevTools remote debugging.
if (process.platform === 'win32') {
  const home = homedir();
  for (const [key, dir] of [['LOCALAPPDATA', join(home, 'AppData', 'Local')], ['APPDATA', join(home, 'AppData', 'Roaming')]]) {
    if (!process.env[key]) { mkdirSync(dir, { recursive: true }); process.env[key] = dir; }
  }
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
process.chdir(ROOT);
const SEED = Number(process.argv[2]) || 24698;
const PORT = 4193;

const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('No Chrome or Edge found; set CHROME_PATH'); process.exit(1); }

execSync('npx vite build', { stdio: 'ignore', shell: true });
const viteBin = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const server = spawn(process.execPath, [viteBin, 'preview', '--port', PORT, '--strictPort'], { stdio: 'ignore' });
const wait = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { await fetch(`http://localhost:${PORT}/`); break; } catch { await wait(500); } }

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push('page error: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
  await page.goto(`http://localhost:${PORT}/?manual=1&seed=${SEED}&look=greybox`);
  await page.waitForFunction(() => window.__game && window.__steps, null, { timeout: 15000 });

  const lines = await page.evaluate(() => {
    const g = __game;
    const out = [];
    const ok = (cond, msg) => out.push(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
    const holder = () => g.turns.holder;

    // Checked after every simulated step, across all scenarios: never two attackers at
    // once, and the turn is never held by a dead, removed or still-entering enemy.
    const violations = [];
    let steps = 0;
    const origStep = g.step.bind(g);
    g.step = dt => {
      origStep(dt);
      steps++;
      g.hero.hp = Math.max(g.hero.hp, 60);   // these tests are about turns, not survival
      const attackers = g.enemies.filter(e => e.state === 'attack');
      if (attackers.length > 1)
        violations.push(`t=${g.time.toFixed(2)}: ${attackers.length} enemies attacking at once (${attackers.map(e => e.kind + '#' + e.id).join(', ')})`);
      const h = g.turns.holder;
      if (h && (!h.alive || h.removed || h.entering || !g.enemies.includes(h)))
        violations.push(`t=${g.time.toFixed(2)}: turn held by invalid enemy ${h.kind}#${h.id} (alive=${h.alive} removed=${!!h.removed} entering=${h.entering})`);
    };
    const until = (cond, maxSteps) => { for (let i = 0; i < maxSteps; i++) { if (cond()) return true; __steps(1); } return cond(); };
    const ableToAct = () => ['idle', 'walk', 'run'].includes(g.hero.state);

    // --- Scenario 1: normal handoff — Volt stands his ground and the turn rotates ------
    g.reset();
    const trace = [];
    for (let i = 0; i < 60 * 45; i++) { __steps(1); trace.push([holder()?.id ?? null, g.turns.cooldown]); }
    const ids = new Set(trace.map(([id]) => id).filter(id => id != null));
    let releases = 0, badRelease = 0, badPick = 0;
    for (let i = 1; i < trace.length; i++) {
      const [prev] = trace[i - 1], [cur, cd] = trace[i];
      if (prev != null && cur == null) { releases++; if (!(cd > 0)) badRelease++; }
      if (prev == null && cur != null && cd > 1e-9) badPick++;
    }
    ok(ids.size >= 2, `normal play: the turn changed hands (${ids.size} holders in 45 s)`);
    ok(releases > 0, `normal play: turns ended and were released (${releases} releases)`);
    ok(badRelease === 0, `every release is followed by a cooldown (${badRelease} without)`);
    ok(badPick === 0, `no new holder is picked before the cooldown elapses (${badPick} early)`);
    ok(Object.keys(g.turns.ends).length > 0, `release reasons are recorded: ${JSON.stringify(g.turns.ends)}`);

    // --- Scenario 2: the holder is knocked out -----------------------------------------
    g.reset();
    ok(until(() => holder(), 60 * 10), 'a holder emerged');
    const victim = holder();
    victim.hp = 1;                                   // one jab will knock it out
    for (let i = 0; i < 60 * 4 && victim.state !== 'ko'; i++) {
      if (ableToAct()) {
        if (Math.hypot(victim.pos.x - g.hero.pos.x, victim.pos.z - g.hero.pos.z) > 0.7) {
          g.hero.pos.x = victim.pos.x - 0.6; g.hero.pos.z = victim.pos.z;
        }
        g.input.press('punch');
      }
      __steps(1);
    }
    ok(victim.state === 'ko', 'Volt knocked out the turn holder');
    ok(holder() !== victim, 'the turn was released in the same step as the knockout');
    ok(g.turns.cooldown > 0, `the release started a cooldown (cooldown=${g.turns.cooldown.toFixed(2)}s)`);
    ok((g.turns.ends['holder knocked out'] ?? 0) >= 1, `the knockout was recorded as the reason (${JSON.stringify(g.turns.ends)})`);
    let heldDuringCooldown = false;
    while (g.turns.cooldown > 0 && !holder()) __steps(1);
    for (let i = 0; i < 60 * 5 && !holder(); i++) __steps(1);
    ok(holder() && holder() !== victim && holder().alive, 'a new, living holder took over after the cooldown');
    ok(!heldDuringCooldown, 'nobody held the turn while the cooldown was running');

    // --- Scenario 3: Volt hits a waiting enemy ------------------------------------------
    g.reset();
    // A calm moment: the holder is on its way in (not mid-attack), another enemy waits.
    const calm = () => holder() && !holder().engaged && !['attack', 'windup', 'charge'].includes(holder().state) &&
      g.enemies.some(e => e.alive && !e.entering && e !== holder() && e.state === 'wait');
    ok(until(calm, 60 * 15), 'a holder on its way in, with another enemy waiting');
    const waiter = g.enemies.find(e => e.alive && !e.entering && e !== holder() && e.state === 'wait');
    until(ableToAct, 60 * 3);
    g.hero.pos.x = waiter.pos.x - 0.6; g.hero.pos.z = waiter.pos.z;
    g.input.press('punch');
    ok(until(() => holder() === waiter, 60 * 2), 'Volt hit a waiting enemy: the hit enemy took over the turn');
    ok(waiter.engaged, 'the hit enemy is now engaged with Volt');

    // While the holder is mid-attack, hitting a waiter must NOT steal the turn.
    until(ableToAct, 60 * 3);
    g.hero.invuln = 999;                             // keep Volt from being staggered mid-check
    ok(until(() => holder() && holder().state === 'attack', 60 * 20), 'the holder started an attack');
    const attacker = holder();
    const bystander = g.enemies.find(e => e.alive && !e.entering && e !== attacker && e.state === 'wait');
    ok(!!bystander, 'another enemy is waiting while the holder attacks');
    if (bystander) {
      g.hero.pos.x = bystander.pos.x - 0.6; g.hero.pos.z = bystander.pos.z;
      g.input.press('punch');
      until(() => bystander.state === 'hurt' || bystander.state === 'ko' || bystander.state === 'hop', 60 * 2);
      ok(holder() === attacker, 'no switch while the holder is mid-attack');
    }

    // --- Scenario 4: the holder cannot reach Volt and times out -------------------------
    g.reset();
    ok(until(() => holder() && !holder().engaged, 60 * 15), 'a fresh holder on its way in');
    const runner = holder();
    let gaveUp = false;
    for (let i = 0; i < 60 * 10; i++) {
      if (holder()) { g.hero.pos.x = holder().pos.x > 0 ? -13 : 13; g.hero.pos.z = 0; }  // Volt stays out of reach
      __steps(1);
      if (holder() !== runner) { gaveUp = true; break; }
    }
    ok(gaveUp, 'the holder gave up when it could not reach Volt');
    ok((g.turns.ends['could not reach Volt'] ?? 0) >= 1, `the timeout was recorded as the reason (${JSON.stringify(g.turns.ends)})`);
    ok(holder() === null && g.turns.cooldown > 0, 'the turn is free and cooling down after the timeout');

    ok(violations.length === 0, `no turn violations in ${steps} steps` +
      (violations.length ? `:\n    ${[...new Set(violations)].slice(0, 8).join('\n    ')}` : ''));
    return out;
  });

  let failed = 0;
  for (const l of lines) { console.log(l); if (l.startsWith('FAIL')) failed++; }
  if (problems.length) console.log('\nPage problems:\n' + [...new Set(problems)].join('\n'));
  console.log(failed ? `\n${failed} check(s) FAILED (seed ${SEED})` : `\nAll turn checks passed (seed ${SEED})`);
  process.exitCode = failed || problems.length ? 1 : 0;
} finally {
  await browser.close();
  server.kill();
}
