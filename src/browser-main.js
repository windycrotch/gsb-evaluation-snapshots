// Browser entry: wires real keyboard/mouse/pointer-lock input and a 2D
// interpolating renderer to the DOM-free fixed-step PhysicsEngine. The engine
// stays the single source of truth — this file only collects inputs per frame
// and draws renderState(alpha); it never writes physics state directly.

import { PhysicsEngine } from './engine.js';
import { MAX_STEPS_PER_FRAME, STEP_SECONDS } from './constants.js';

const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const hud = {
  speed: document.getElementById('hud-speed'),
  state: document.getElementById('hud-state'),
  rate: document.getElementById('hud-rate'),
  auto: document.getElementById('hud-auto'),
};
const overlay = document.getElementById('overlay');
const pauseMenu = document.getElementById('pause-menu');
const autoToggle = document.getElementById('auto-toggle');
const resumeBtn = document.getElementById('resume-btn');
const resetBtn = document.getElementById('reset-btn');

const engine = new PhysicsEngine({ autoHop: true });

const keys = { forward: false, back: false, left: false, right: false };
let mouseDX = 0;
let jumpEdge = false;
let paused = true;
let lastTime = 0;
let frameCount = 0;
let fpsWindowStart = 0;

function resize() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
}
window.addEventListener('resize', resize);
resize();

// --- Input -------------------------------------------------------------------

const KEY_MAP = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
};

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    // Pointer lock exit itself drives the pause; nothing else to do.
    return;
  }
  const k = KEY_MAP[e.code];
  if (k) {
    keys[k] = true;
    e.preventDefault();
  }
  if ((e.code === 'Space' || e.code === 'WheelUp') && !e.repeat) {
    jumpEdge = true;
    e.preventDefault();
  }
  if (e.code === 'KeyR') resetRun();
});

window.addEventListener('keyup', (e) => {
  const k = KEY_MAP[e.code];
  if (k) keys[k] = false;
});

// Mouse wheel also jumps, the classic bhop binding.
window.addEventListener('wheel', (e) => {
  if (!paused) {
    jumpEdge = true;
    e.preventDefault();
  }
}, { passive: false });

// Accumulate horizontal mouse movement; the engine spreads it across ticks.
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas) {
    mouseDX += e.movementX;
  }
});

canvas.addEventListener('click', () => {
  if (paused) canvas.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  paused = !locked;
  overlay.hidden = locked;
  pauseMenu.hidden = locked;
  if (!locked) {
    // Drop held inputs while paused so a stuck key cannot steer after resume.
    keys.forward = keys.back = keys.left = keys.right = false;
    mouseDX = 0;
    jumpEdge = false;
  }
});

autoToggle.addEventListener('change', () => {
  engine.autoHop = autoToggle.checked;
  hud.auto.textContent = String(engine.autoHop);
});

resumeBtn.addEventListener('click', () => canvas.requestPointerLock());
resetBtn.addEventListener('click', resetRun);

function resetRun() {
  engine.reset({
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    autoHop: autoToggle.checked,
  });
  mouseDX = 0;
  jumpEdge = false;
}

// --- Main loop ---------------------------------------------------------------

function frame(now) {
  if (!lastTime) lastTime = now;
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  // Clamp tab-switch spikes so the accumulator cannot queue a huge backlog.
  dt = Math.min(dt, MAX_STEPS_PER_FRAME * STEP_SECONDS);

  if (!paused) {
    engine.frame({
      dt,
      mouseDX,
      keys,
      jumpPressed: jumpEdge,
    });
    // Per-frame inputs are consumed; the engine owns any carry-over.
    mouseDX = 0;
    jumpEdge = false;
  }

  draw(engine.renderState(engine.alpha));
  updateHud();
  requestAnimationFrame(frame);
}

// --- Rendering (display-only interpolation) ----------------------------------

function draw(view) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, w, h);

  // Ground grid gives a sense of motion; it is purely decorative.
  ctx.strokeStyle = '#1c2430';
  ctx.lineWidth = 1;
  const grid = 100;
  const cx = w / 2;
  const cy = h * 0.62;
  const scale = 2;
  for (let gx = -10; gx <= 10; gx++) {
    const x = cx + (gx * grid - view.position.y) * scale * 0.4;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let gy = -10; gy <= 10; gy++) {
    const y = cy + (gy * grid - view.position.x) * scale * 0.4;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Player marker; vertical position lifts the dot, yaw rotates its heading.
  const px = cx;
  const py = cy - Math.max(view.position.z, 0) * 0.6;
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(view.yaw);
  ctx.fillStyle = view.grounded ? '#58a6ff' : '#f0883e';
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(-8, -8);
  ctx.lineTo(-4, 0);
  ctx.lineTo(-8, 8);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Trailing breadcrumb from the last ticks (physics snapshots, not simulated here).
  ctx.fillStyle = '#30363d';
  ctx.fillText('top-down interpolated view (render only)', 12, h - 12);
}

function updateHud() {
  hud.speed.textContent = engine.current.horizontalSpeed.toFixed(1);
  hud.state.textContent = engine.current.grounded ? 'ground' : 'air';
  hud.auto.textContent = String(engine.autoHop);

  frameCount++;
  const now = performance.now();
  if (now - fpsWindowStart >= 500) {
    const fps = (frameCount * 1000) / (now - fpsWindowStart);
    hud.rate.textContent = `${fps.toFixed(0)} fps / 128 Hz sim (${engine.lastFrame.steps} ticks/frame)`;
    frameCount = 0;
    fpsWindowStart = now;
  }
}

autoToggle.checked = engine.autoHop;
hud.auto.textContent = String(engine.autoHop);
requestAnimationFrame(frame);
