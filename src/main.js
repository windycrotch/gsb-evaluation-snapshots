import * as THREE from 'three';
import { createStage } from './scene.js';
import { ParticleSystem } from './fx.js';
import { Player } from './player.js';
import { Level } from './world.js';
import { Input } from './input.js';
import { AudioEngine } from './audio.js';
import { HUD } from './hud.js';

export const PALETTES = [
  { name: '潮汐之境', sub: 'SECTOR 01 · TIDAL DRIFT', accent: 0x4ae4ff, accent2: 0x8f7bff, base: 0x101a2c, rock: 0x1b2233 },
  { name: '绯红浮岛', sub: 'SECTOR 02 · CRIMSON ISLES', accent: 0xff5fa8, accent2: 0xffa45f, base: 0x1e1022, rock: 0x281a2a },
  { name: '翡翠回廊', sub: 'SECTOR 03 · EMERALD HALLS', accent: 0x4dffb8, accent2: 0x54d4ff, base: 0x0c1d1d, rock: 0x172828 },
  { name: '琥珀熔炉', sub: 'SECTOR 04 · AMBER FORGE', accent: 0xffb547, accent2: 0xff6a3d, base: 0x21180d, rock: 0x2c2317 },
  { name: '深瞳之心', sub: 'SECTOR 05 · THE DEEP EYE', accent: 0xa97bff, accent2: 0x2ee6ff, base: 0x150f26, rock: 0x1e1836 },
];

const canvas = document.getElementById('scene');

// 运行时错误可视化（调试用）
window.__lastError = '';
window.addEventListener('error', (e) => {
  window.__lastError = String(e.message || e.error);
  const el = document.getElementById('toast');
  if (el) {
    el.className = 'toast show';
    el.style.whiteSpace = 'normal';
    el.textContent = 'ERR: ' + (e.message || e.error);
  }
  console.error('[game]', e.message, e.error);
});
const stage = createStage(canvas);
const particles = new ParticleSystem(stage.scene, 700);
particles.setDpr(stage.dpr);

const hud = new HUD();
const input = new Input(canvas);
const audio = new AudioEngine();
const player = new Player(stage.scene, PALETTES[0]);
player.setDpr(stage.dpr);

let level = null;
let mode = 'title';
let levelIndex = 0;
let elapsed = 0;
let shardsBanked = 0;
let combo = 0;
let comboTimer = 0;
let busy = false;
let warpZoom = 0;
let shake = 0;
let fallCooldown = 0;
let menuT = 0;
let hintShown = false;

const clock = new THREE.Clock();
const tmpV = new THREE.Vector3();

// ------------------------------------------------------------------ level
function buildLevel(index) {
  if (level) level.dispose();
  const palette = PALETTES[index];
  level = new Level({
    scene: stage.scene,
    palette,
    index,
    seed: 20261018 + index * 911,
    particles,
  });

  level.onCollect = onCollect;
  level.onDamage = onDamage;
  level.onPortal = completeLevel;

  player.setPalette(palette);
  player.reset(level.bodies);

  stage.setAccent(palette.accent, palette.accent2);
  hud.setAccent(palette.accent);
  hud.setLevel(index, palette.name, palette.sub);
  hud.setShards(0, level.totalShards);
  hud.setHearts(player.health, player.maxHealth);

  const b = level.bodies[0];
  camera.position
    .copy(player.position)
    .addScaledVector(player.normal, 6.2)
    .addScaledVector(player.facing, -10);
  camera.up.copy(player.normal);
  camera.lookAt(player.position);
  camera.fov = 56;
  camera.updateProjectionMatrix();
  shake = 0;
  warpZoom = 0;
}

const camera = stage.camera;

// ------------------------------------------------------------------ events
function onCollect(count, total, pos) {  combo = Math.min(combo + 1, 10);
  comboTimer = 2.4;
  audio.collect(combo);
  hud.setShards(count, total);
  shake = Math.max(shake, 0.05);
  if (count === 1 && !hintShown) {
    hud.toast('星屑共鸣 · 收集全部星屑点亮星门', 2200);
  }
  if (count >= total) {
    setTimeout(() => {
      if (mode === 'playing') {
        audio.portal();
        hud.toast('星门已开启 · 追随光柱前往下一星域', 3000, 'accent');
      }
    }, 300);
  }
}

function onDamage(pos) {
  if (!player.takeDamage()) return;
  hud.setHearts(player.health, player.maxHealth);
  audio.hit();
  hud.flash('255,70,110', 0.5, 480);
  shake = Math.max(shake, 0.55);
  if (player.health <= 0) gameOver();
}

function onJump(isDouble, pos, normal) {
  audio[isDouble ? 'doubleJump' : 'jump']();
  particles.burst(pos.clone().addScaledVector(normal, -0.55), PALETTES[levelIndex].accent, {
    count: isDouble ? 20 : 12,
    speed: isDouble ? 5.5 : 3.4,
    size: 0.42,
    life: 0.55,
    drag: 3.2,
    grow: -0.5,
    up: normal,
    bias: -0.8,
  });
  if (isDouble) shake = Math.max(shake, 0.14);
}

function onDash(pos, dir, normal) {
  audio.dash();
  particles.burst(pos.clone().addScaledVector(dir, -0.4), PALETTES[levelIndex].accent2, {
    count: 22,
    speed: 7,
    size: 0.4,
    life: 0.5,
    drag: 4,
    grow: -0.6,
  });
  shake = Math.max(shake, 0.2);
}

function onLand(pos, normal) {
  particles.burst(pos.clone().addScaledVector(normal, -0.4), PALETTES[levelIndex].accent, {
    count: 9,
    speed: 2.4,
    size: 0.35,
    life: 0.45,
    drag: 3.5,
    grow: -0.6,
    up: normal,
    bias: 1,
  });
}

function onFall() {
  if (fallCooldown > 0) return;
  fallCooldown = 1.6;
  player.takeDamage();
  hud.setHearts(player.health, player.maxHealth);
  hud.flash('120,180,255', 0.4, 500);
  audio.hit();
  shake = 0.3;
  if (player.health <= 0) {
    gameOver();
    return;
  }
  player.respawn(level.bodies);
  hud.toast('坠入虚空 · 已被星核拉回', 1600);
}

const playerEvents = {
  onJump,
  onDash,
  onLand,
  onFall,
};

// ------------------------------------------------------------------ flow
function startGame() {
  audio.init();
  audio.resume?.();
  audio.ui();
  levelIndex = 0;
  elapsed = 0;
  shardsBanked = 0;
  combo = 0;
  hintShown = false;
  busy = false;
  buildLevel(0);
  hud.hideScreens();
  hud.showHUD(true);
  hud.setTime(0);
  mode = 'playing';
  input.clear();
  hud.showHint(10000);
  hud.toast('第 1 星域 · 潮汐之境', 2400, 'accent');
}

function gameOver() {
  if (mode === 'over') return;
  mode = 'over';
  audio.gameOver();
  hud.showScreen('over');
  document.getElementById('overShards').textContent = String(shardsBanked + (level?.collected ?? 0));
}

function retryLevel() {
  audio.ui();
  buildLevel(levelIndex);
  hud.hideScreens();
  hud.showHUD(true);
  mode = 'playing';
  input.clear();
  hud.toast('重新开始本星域', 1600);
}

function backToTitle() {
  audio.ui();
  mode = 'title';
  busy = false;
  warpZoom = 0;
  buildLevel(0);
  hud.showHUD(false);
  hud.hideHint();
  hud.showScreen('title');
  document.getElementById('fade').style.opacity = '0';
}

function togglePause() {
  if (mode === 'playing') {
    mode = 'paused';
    hud.showScreen('pause');
    input.clear();
    audio.ui();
  } else if (mode === 'paused') {
    resumeGame();
  }
}

function resumeGame() {
  audio.ui();
  mode = 'playing';
  hud.hideScreens();
  input.clear();
}

async function completeLevel() {
  if (busy) return;
  busy = true;
  const prevMode = mode;
  mode = 'transition';
  audio.warp();
  shake = 0.15;
  await wait(320);
  warpZoom = 1;
  await wait(420);
  await hud.fade(1, 620);

  shardsBanked += level.collected;
  levelIndex++;

  if (levelIndex >= PALETTES.length) {
    showVictory();
    await hud.fade(0, 800);
    mode = 'win';
    hud.showHUD(false);
  } else {
    buildLevel(levelIndex);
    hud.hideScreens();
    hud.showHUD(true);
    await hud.fade(0, 760);
    mode = 'playing';
    hud.toast(`第 ${levelIndex + 1} 星域 · ${PALETTES[levelIndex].name}`, 2400, 'accent');
  }
  busy = false;
}

function showVictory() {
  mode = 'win';
  audio.victory();
  document.getElementById('winTime').textContent = formatTime(elapsed);
  document.getElementById('winShards').textContent = String(shardsBanked);
  hud.showScreen('win');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ camera
function updateCamera(dt) {
  if (mode === 'title' || mode === 'win') {
    menuT += dt;
    const r = (level?.mainRadius ?? 9) * 3.1 + 14;
    const target = new THREE.Vector3(Math.cos(menuT * 0.16) * r, (level?.mainRadius ?? 9) * 1.7, Math.sin(menuT * 0.16) * r);
    camera.position.lerp(target, 1 - Math.exp(-1.6 * dt));
    camera.up.lerp(new THREE.Vector3(0, 1, 0), 1 - Math.exp(-3 * dt)).normalize();
    camera.lookAt(0, 0, 0);
    if (shake > 0.001) {
      camera.position.x += (Math.random() - 0.5) * shake;
      camera.position.y += (Math.random() - 0.5) * shake;
    }
    shake *= Math.exp(-6 * dt);
    const fovTarget = 56;
    if (Math.abs(camera.fov - fovTarget) > 0.01) {
      camera.fov += (fovTarget - camera.fov) * (1 - Math.exp(-5 * dt));
      camera.updateProjectionMatrix();
    }
    return;
  }

  const up = player.normal;
  const dist = 10.4 * (1 - warpZoom * 0.72);
  const height = 5.4 * (1 - warpZoom * 0.4);
  const desired = tmpV
    .copy(player.position)
    .addScaledVector(up, height)
    .addScaledVector(player.facing, -dist);

  const body = player.body;
  if (body) {
    const rel = desired.clone().sub(body.center);
    const minD = body.radius + 2.1;
    if (rel.length() < minD) desired.copy(body.center).addScaledVector(rel.normalize(), minD);
  }

  camera.position.lerp(desired, 1 - Math.exp(-5.2 * dt));
  camera.up.lerp(up, 1 - Math.exp(-7.5 * dt)).normalize();

  if (shake > 0.001) {
    camera.position.x += (Math.random() - 0.5) * shake;
    camera.position.y += (Math.random() - 0.5) * shake;
    camera.position.z += (Math.random() - 0.5) * shake;
    shake *= Math.exp(-7 * dt);
  }

  const look = player.position.clone().addScaledVector(up, 1.3).addScaledVector(player.velocity, 0.05);
  camera.lookAt(look);

  const speed = Math.hypot(player.velocity.x, player.velocity.y, player.velocity.z);
  const fovTarget = 56 + Math.min(8, speed * 0.22) + (player.dashTimer > 0 ? 7 : 0);
  if (Math.abs(camera.fov - fovTarget) > 0.02) {
    camera.fov += (fovTarget - camera.fov) * (1 - Math.exp(-6 * dt));
    camera.updateProjectionMatrix();
  }
}

// ------------------------------------------------------------------ loop
let fpsTime = 0;
let fpsFrames = 0;
let lowQualityStreak = 0;
let qualityStep = 2;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  stage.update(t);
  particles.update(dt);
  comboTimer = Math.max(0, comboTimer - dt);
  if (comboTimer <= 0) combo = 0;
  fallCooldown = Math.max(0, fallCooldown - dt);

  if (mode === 'playing' || mode === 'transition') {
    input.update();
    if (level && player.alive) {
      player.update(dt, input, camera, level.bodies, playerEvents);
      level.update(dt, t, player);
    }
    if (mode === 'playing') {
      elapsed += dt;
      hud.setTime(elapsed);
    }
  } else if (mode === 'title' || mode === 'win' || mode === 'over' || mode === 'paused') {
    if (level) level.update(dt, t, player);
    player.idle(dt, t);
  }

  updateCamera(dt);
  stage.composer.render();

  // 自适应画质
  fpsTime += dt;
  fpsFrames++;
  if (fpsTime > 2.2) {
    const fps = fpsFrames / fpsTime;
    (window.__fps = window.__fps || []).push(+fps.toFixed(1));
    fpsTime = 0;
    fpsFrames = 0;
    if (fps < 44 && qualityStep > 0) {
      qualityStep--;
      stage.setQuality(qualityStep);
      lowQualityStreak++;
      if (lowQualityStreak >= 2) stage.setBloomEnabled(false);
    }
  }
}

// ------------------------------------------------------------------ ui
function bindUI() {
  document.getElementById('startBtn').addEventListener('click', startGame);
  document.getElementById('againBtn').addEventListener('click', startGame);
  document.getElementById('resumeBtn').addEventListener('click', resumeGame);
  document.getElementById('retryBtn').addEventListener('click', retryLevel);
  document.getElementById('restartBtn').addEventListener('click', () => {
    audio.ui();
    levelIndex = 0;
    elapsed = 0;
    shardsBanked = 0;
    startGame();
  });
  document.getElementById('homeBtn').addEventListener('click', backToTitle);
  document.getElementById('homeBtn2').addEventListener('click', backToTitle);

  const muteBtn = document.getElementById('muteBtn');
  muteBtn.addEventListener('click', () => {
    audio.init();
    audio.setMuted(!audio.muted);
    muteBtn.classList.toggle('muted', audio.muted);
    muteBtn.textContent = audio.muted ? '⨯' : '♪';
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      e.preventDefault();
      if (mode === 'playing' || mode === 'paused') togglePause();
    }
    if (e.code === 'KeyM') {
      audio.init();
      audio.setMuted(!audio.muted);
      muteBtn.classList.toggle('muted', audio.muted);
      muteBtn.textContent = audio.muted ? '⨯' : '♪';
    }
    if (e.code === 'Enter' && (mode === 'title' || mode === 'win')) startGame();
  });

  window.addEventListener('blur', () => {
    if (mode === 'playing') togglePause();
  });

  // 任意点击激活音频上下文（浏览器策略）
  window.addEventListener(
    'pointerdown',
    () => {
      audio.init();
      audio.resume?.();
    },
    { once: true }
  );
}

// ------------------------------------------------------------------ boot
buildLevel(0);
hud.showHUD(false);
hud.showScreen('title');
bindUI();
animate();

// 调试：?auto 自动进入游戏；?sim 自动行走验证物理
if (location.search.includes('auto') || location.search.includes('sim')) {
  setTimeout(() => startGame(), 400);
}
if (location.search.includes('sim')) {
  setTimeout(() => {
    input.sim = { x: 0.9, z: 0.35 };
    setInterval(() => {
      input.jumpQueued = true;
    }, 3000);
    setInterval(() => {
      input.dashQueued = true;
    }, 7500);
  }, 1200);
  setInterval(() => {
    const el = document.getElementById('toast');
    if (el)
      el.textContent = `DBG mode=${mode} t=${elapsed.toFixed(1)} err=${window.__lastError || 'none'}`;
  }, 700);
}

// 方便调试
window.__game = {
  get mode() {
    return mode;
  },
  startGame,
  buildLevel,
  player,
  get level() {
    return level;
  },
  stage,
  get levelIndex() {
    return levelIndex;
  },
  set levelIndex(v) {
    levelIndex = v;
  },
};
