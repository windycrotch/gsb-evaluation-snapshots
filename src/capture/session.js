import * as THREE from 'three';
import { Stage } from '../stage.js';
import { Bot } from '../sim/ai.js';

// Deterministic frame-by-frame capture. A scenario owns the fight (who does what, where the camera
// is); the node tool calls __cap.frame(i) for every output frame and screenshots the page.
//
// Scenarios: { duration, setup(stage), tick(t, dt) (per sub-step, before stepping), hud? }

const cinePreset = {
  side: { pos: [0, 2.2, 15], target: [0, 1.5, 0], fov: 38 },
  wide: { pos: [8, 8, 26], target: [0, 1.5, 0], fov: 40 },
  low: { pos: [-10, 0.6, 9], target: [0, 1.6, 0], fov: 32 },
  top: { pos: [0, 30, 12], target: [0, 0, 0], fov: 42 },
};

function botfight(params) {
  const seed = +(params.get('seed') || 3);
  const lv = (params.get('lv') || 'hard,hard').split(',');
  let bots;
  return {
    duration: +(params.get('dur') || 20),
    setup(stage) {
      const w = stage.newWorld({ seed });
      bots = [new Bot(0, lv[0], seed * 7 + 1), new Bot(1, lv[1], seed * 13 + 5)];
      stage.controllers = bots.map((b) => (wd, dt) => b.think(wd, dt));
      stage.player = +(params.get('player') || 0);
      const cam = params.get('cam');
      if (cam && cinePreset[cam]) {
        const c = cinePreset[cam];
        stage.rig.cine = { pos: new THREE.Vector3(...c.pos), target: new THREE.Vector3(...c.target), fov: c.fov };
      }
      if (params.get('energy')) for (const f of w.fighters) f.energy = +params.get('energy');
      w.begin();
    },
    tick() {},
  };
}

export async function run(params) {
  const canvas = document.getElementById('stage');
  const fps = +(params.get('fps') || 60), S = +(params.get('s') || 4);
  const stage = new Stage(canvas, { quality: params.get('q') || 'film', preserve: true });
  stage.resize(innerWidth, innerHeight, 1);
  stage.R.look.grain = 0.02; // a touch finer than the game: the encoder has to carry it
  const name = params.get('scene') || 'botfight';
  let scenario;
  if (name === 'botfight') scenario = botfight(params);
  else scenario = (await import('./director.js')).makeShowcase(params);
  await scenario.setup(stage);
  // The simulation always advances in 1/480 s steps, whatever the output frame rate or blur
  // sample count, so a 30 fps single-sample preview plays out exactly like the 60 fps, 8-sample
  // master. (fps x samples must divide 480.)
  const STEP = 1 / 480;
  const simPer = Math.max(1, Math.round(1 / fps / S / STEP));
  let n = 0, t = 0;
  const stepFrame = (render) => {
    const dt = 1 / fps;
    const before = (h) => { t = n * STEP; scenario.tick(t, h, stage); n++; };
    if (render) stage.renderFilm(dt, S, before, simPer);
    else for (let i = 0; i < S * simPer; i++) { before(STEP); stage.step(STEP); }
    t = n * STEP;
    scenario.afterFrame?.(t, stage);
  };
  window.__cap = {
    fps,
    total: Math.round(scenario.duration * fps),
    frame() { stepFrame(true); return t; },
    skip(n = 1) { for (let i = 0; i < n; i++) stepFrame(false); return t; },
    cues: () => scenario.cues?.() ?? [],
    audio: (dur) => scenario.audio?.(dur),
    stage,
  };
  // warm up shaders so the first captured frame does not hitch or miss programs
  stage.R.drawWorld(stage.scene, stage.camera, -1);
  window.__info = { gpu: (() => { const g = stage.R.gl.getContext(); const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; })() };
  window.__ready = true;
}
