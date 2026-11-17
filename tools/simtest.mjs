// Headless bot-vs-bot soak test: checks the sim runs, rounds finish, and reports basic balance stats.
import { World } from '../src/sim/world.js';
import { Bot } from '../src/sim/ai.js';
import { ST } from '../src/sim/constants.js';

const levels = process.argv[2] ? process.argv[2].split(',') : ['normal', 'normal'];
const N = +(process.argv[3] || 40);
const dt = 1 / 120;
const stats = { wins: [0, 0, 0], time: 0, ev: {}, maxCombo: 0, nan: 0 };
for (let n = 0; n < N; n++) {
  const w = new World({ chars: ['clawd', 'codex'], seed: 100 + n });
  const bots = [new Bot(0, levels[0], 11 + n * 7), new Bot(1, levels[1], 23 + n * 13)];
  w.begin();
  let t = 0;
  while (t < 140) {
    w.step([bots[0].think(w, dt), bots[1].think(w, dt)], dt);
    for (const e of w.events) {
      stats.ev[e.type] = (stats.ev[e.type] || 0) + 1;
      if (e.type === 'hit' && e.combo) stats.maxCombo = Math.max(stats.maxCombo, e.combo);
    }
    w.events.length = 0;
    for (const f of w.fighters) if (!Number.isFinite(f.x + f.y + f.z + f.hp)) stats.nan++;
    t += dt;
    if (w.over && w.overT > 1) break;
  }
  stats.wins[w.winner < 0 ? 2 : w.winner]++;
  stats.time += w.roundTime - w.timeLeft;
}
console.log(levels.join(' vs '), '| clawd/codex/draw wins:', stats.wins.join('/'), '| avg round', (stats.time / N).toFixed(1) + 's', '| max combo', stats.maxCombo, '| NaN', stats.nan);
console.log(Object.entries(stats.ev).map(([k, v]) => `${k}:${(v / N).toFixed(1)}`).join('  '));
