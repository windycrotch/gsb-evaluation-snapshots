import * as THREE from 'three';
import '@fontsource-variable/archivo/wdth.css';
import './ui/style.css';
import { Stage } from './stage.js';
import { Input } from './core/input.js';
import { Bot } from './sim/ai.js';
import { HUD } from './ui/hud.js';
import { Menu, Overlay } from './ui/menu.js';
import { AudioEngine, soundForEvent } from './audio/audio.js';
import { CHARS } from './sim/moves.js';
import { ST } from './sim/constants.js';
import { ease, damp, sat } from './core/math.js';

const QUALITY_STEPS = ['low', 'medium', 'high'];

// Start discrete GPUs on high and everything else (integrated graphics, unknown) on medium; the
// frame-time watchdog below still steps down if the machine cannot keep up.
function guessQuality() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
    return /(RTX|GTX|Radeon RX|Radeon Pro|Arc\(TM\) [AB]\d|Apple M\d)/i.test(name) ? 'high' : 'medium';
  } catch { return 'medium'; }
}
const WINS_NEEDED = 2;

export async function run(params) {
  const canvas = document.getElementById('stage');
  const ui = document.getElementById('ui');
  let quality = params.get('q') || localStorage.getItem('mc.quality') || guessQuality();
  if (!QUALITY_STEPS.includes(quality)) quality = 'medium';
  const stage = new Stage(canvas, { quality });
  const input = new Input(window);
  const audio = new AudioEngine();
  const hud = new HUD(ui);
  const overlay = new Overlay(ui);
  const G = { state: 'boot', t: 0, char: 'clawd', level: localStorage.getItem('mc.level') || 'normal', round: 1, wins: [0, 0], bot: null, paused: false, flags: {}, menuX: 0 };
  window.__game = { stage, G, audio };

  const resize = () => stage.resize(innerWidth, innerHeight, Math.min(devicePixelRatio || 1, 1.5));
  addEventListener('resize', resize);
  resize();

  stage.onEvent = (e, w) => {
    soundForEvent(e, w, audio, stage.camera);
    hud.onEvent(e, w);
  };

  const menu = new Menu(ui, {
    onPick: (c, soft) => { G.char = c; audio.cue('ui', { f: c === 'clawd' ? 660 : 880, gain: soft ? 0.6 : 1 }); },
    onLevel: (d) => { G.level = d; localStorage.setItem('mc.level', d); audio.cue('ui', { f: 990 }); },
    onStart: () => { if (G.state === 'menu') { audio.unlock(); audio.cue('uiok'); startMatch(); } },
  });
  menu.level = G.level;
  menu.sync();
  addEventListener('pointerdown', () => audio.unlock(), { once: false });
  addEventListener('keydown', () => audio.unlock());

  // ---------------------------------------------------------------- menu stage
  const _p = new THREE.Vector3(), _t = new THREE.Vector3();
  function enterMenu() {
    G.state = 'menu';
    G.t = 0;
    overlay.close();
    hud.show(false);
    menu.show(true);
    input.enabled = false; input.mouseEnabled = false;
    const w = stage.newWorld({ chars: ['clawd', 'codex'], seed: 1 });
    stage.controllers = [null, null];
    stage.player = 0;
    w.fighters[0].x = -2.5; w.fighters[0].z = 0;
    w.fighters[1].x = 2.5; w.fighters[1].z = 0;
    stage.rig.cine = { pos: new THREE.Vector3(0, 1.7, 10), target: new THREE.Vector3(0, 1.2, 0), fov: 34 };
    stage.R.look.dof = 7; stage.R.look.focus = 10; stage.R.look.focusRange = 9;
    audio.music(1);
  }
  function updateMenu(dt) {
    G.t += dt;
    const w = stage.world, sel = G.char === 'clawd' ? 0 : 1;
    G.menuX = damp(G.menuX, sel === 0 ? -1 : 1, 5, dt);
    for (let i = 0; i < 2; i++) {
      const f = w.fighters[i], a = stage.actors[i], on = i === sel;
      // face the camera, the chosen one steps up
      f.z = damp(f.z, on ? 1.3 : -0.2, 6, dt);
      a.stance = (i === 0 ? 0.32 : -0.32) - f.yaw;
      a.heatMin = on ? 0.14 + 0.05 * Math.sin(G.t * 3) : 0;
    }
    const c = stage.rig.cine;
    c.pos.set(G.menuX * 1.1 + Math.sin(G.t * 0.25) * 0.5, 1.75 + Math.sin(G.t * 0.4) * 0.08, 10.4);
    c.target.set(G.menuX * 0.5, 1.2, 0.4);
    stage.R.look.focus = 9.6;
  }

  // ---------------------------------------------------------------- match flow
  function startMatch() {
    G.wins = [0, 0];
    G.round = 1;
    menu.show(false);
    overlay.close();
    startRound();
  }
  function startRound() {
    const other = G.char === 'clawd' ? 'codex' : 'clawd';
    const seed = (Math.random() * 1e9) | 0;
    const w = stage.newWorld({ chars: [G.char, other], seed });
    for (const a of stage.actors) a.heatMin = 0;
    stage.player = 0;
    G.bot = new Bot(1, G.level, seed ^ 0x5f3759df);
    const demo = params.get('demo') ? new Bot(0, params.get('demo'), seed ^ 0x9e3779b9) : null; // attract mode: bot plays both sides
    stage.controllers = [demo ? (wd, dt) => demo.think(wd, dt) : () => input.read(), (wd, dt) => G.bot.think(wd, dt)];
    stage.R.look.dof = 0;
    hud.setup(w, 0, G.wins);
    hud.show(true);
    G.state = 'intro';
    G.t = 0;
    G.flags = {};
    input.enabled = false; input.mouseEnabled = false;
    stage.rig.cine = { pos: new THREE.Vector3(), target: new THREE.Vector3(0, 1.3, 0), fov: 42 };
    audio.music(2);
    introCam(0);
  }
  function introCam(t) {
    // sweep from a wide side view to the over-the-shoulder fight camera
    const w = stage.world, me = w.fighters[0], op = w.fighters[1];
    const base = Math.atan2(op.x - me.x, op.z - me.z);
    const k = ease.inOut(sat(t / 2.0));
    const ang = base + Math.PI + (1 - k) * 1.9;
    const rad = 17 - 5.5 * k, hgt = 2.2 + 3.3 * k;
    const c = stage.rig.cine;
    c.pos.set(me.x * k + Math.sin(ang) * rad, hgt, me.z * k + Math.cos(ang) * rad);
    c.target.set(0, 1.3, 0);
    c.fov = 40 + 6 * k;
  }
  function updateIntro(dt) {
    G.t += dt;
    if (stage.rig.cine) introCam(G.t);
    if (G.t > 0.2 && !G.flags.round) { G.flags.round = true; hud.announce(`Round ${G.round}`, `${CHARS[stage.world.fighters[0].char].name} vs ${CHARS[stage.world.fighters[1].char].name}`, 1.35); audio.cue('drum'); }
    if (G.t > 1.75 && !G.flags.fight) { G.flags.fight = true; hud.announce('Fight', '', 0.8); audio.cue('sting'); }
    if (G.t > 2.0) {
      stage.rig.cine = null;
      stage.world.begin();
      input.enabled = true; input.mouseEnabled = true;
      G.state = 'fight';
      audio.music(3);
    }
  }
  function updateFight(dt) {
    const w = stage.world;
    if (w.over && G.state === 'fight') {
      G.state = 'over';
      G.t = 0;
      input.enabled = false; input.mouseEnabled = false;
      hud.announce(w.fighters.some((f) => f.state === ST.KO) ? 'K.O.' : 'Time', '', 1.8);
      audio.music(1);
    }
    if (G.state === 'over') {
      G.t += dt;
      if (G.t > 3.4) {
        audio.releaseAll();
        if (w.winner >= 0) G.wins[w.winner]++;
        const champ = G.wins.findIndex((n) => n >= WINS_NEEDED);
        if (champ >= 0) {
          G.state = 'result';
          hud.show(false);
          audio.cue('sting');
          overlay.open(champ === 0 ? 'You win' : 'You lose', `${CHARS[w.fighters[champ].char].name} takes the match · ${G.wins[0]}–${G.wins[1]}`, [['Rematch', startMatch], ['Change fighter', enterMenu]]);
        } else {
          G.round++;
          startRound();
        }
      }
    }
  }

  // ---------------------------------------------------------------- pause / keys
  function setPaused(p) {
    if (G.state !== 'fight' && G.state !== 'intro' && !G.paused) return;
    G.paused = p;
    audio.pause(p);
    if (p) {
      const next = QUALITY_STEPS[(QUALITY_STEPS.indexOf(stage.R.qualityName) + 1) % QUALITY_STEPS.length];
      overlay.open('Paused', `Graphics · ${stage.R.qualityName}`, [['Resume', () => setPaused(false)], [`Graphics: ${next}`, () => { setQuality(next); setPaused(true); }], ['Quit to menu', () => { G.paused = false; audio.pause(false); audio.releaseAll(); enterMenu(); }]]);
    } else overlay.close();
  }
  function setQuality(q) {
    stage.R.setQuality(q);
    stage.vfx.density = q === 'low' ? 0.5 : q === 'medium' ? 0.75 : 1;
    localStorage.setItem('mc.quality', q);
  }
  input.onKey = (code) => {
    if (code === 'Escape' || code === 'KeyP') { if (G.paused) setPaused(false); else setPaused(true); return; }
    if (G.state === 'menu') menu.key(code);
    else if (G.state === 'result' && (code === 'Enter' || code === 'Space')) startMatch();
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden && G.state === 'fight') setPaused(true); });

  // ---------------------------------------------------------------- main loop
  let last = performance.now(), slowFrames = 0, frames = 0, acc = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.1) dt = 0.1; // tab was in the background
    if (G.paused) return;
    if (G.state === 'menu') updateMenu(dt);
    else if (G.state === 'intro') updateIntro(dt);
    else if (G.state === 'fight' || G.state === 'over') updateFight(dt);
    stage.step(dt);
    if (G.state !== 'menu') hud.update(stage.world, dt);
    stage.render(dt);
    // drop a quality step if the machine cannot hold ~45 fps
    acc += dt; frames++;
    if (frames >= 90) {
      const avg = acc / frames;
      slowFrames = avg > 1 / 42 ? slowFrames + 1 : 0;
      if (slowFrames >= 2 && !params.get('q')) {
        const i = QUALITY_STEPS.indexOf(stage.R.qualityName);
        if (i > 0) setQuality(QUALITY_STEPS[i - 1]);
        slowFrames = 0;
      }
      acc = 0; frames = 0;
    }
  }
  enterMenu();
  if (params.get('autostart')) { G.char = params.get('autostart'); if (params.get('level')) G.level = params.get('level'); startMatch(); }
  await document.fonts.ready;
  window.__ready = true;
  requestAnimationFrame(frame);
}
