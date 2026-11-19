// Reproducible local sample for the atomic quality switch.
//
// Build and serve (from the repo root):
//   npm run sample:quality
// then open http://localhost:8792/examples/quality-switch/
//
// What to watch — each is also asserted in test/atmosphere.test.ts,
// test/governor.test.ts and e2e/sky.spec.ts:
//   - pressing a quality button logs "pending" while a variant links and the
//     read-back quality stays the OLD one until a "settled -> true" edge lands,
//     where cloudScale and cumulonimbus change together — never split
//   - settled goes false for the link and true again, and onSettled(true) fires
//     exactly on the commit; whenSettled() pending at the switch resolves true
//   - the adaptive factor stays at its ceiling and the canvas pixel size never
//     moves in response to a switch; only GPU time at the true canvas size can
//     move it (try DevTools' GPU throttling with a tight budget)
//   - "Custom pair" sets cloudScale alone to 0.5 with the auto tower: quality
//     reads undefined, since no preset names that combination
//   - emulate prefers-reduced-motion: reduce (DevTools > Rendering) or hide the
//     canvas, then switch: when the variant links, the still frame is redrawn
//     with the new picture rather than left on the old one
//   - after Dispose, further presses log nothing and no redraw or onSettled
//     fires; a whenSettled() left pending resolves false

import { Atmosphere, type QualityPreset } from '../../src/index.js';

const canvas = document.querySelector('canvas')!;
const logEl = document.querySelector('#log')!;
const $ = (id: string) => document.getElementById(id)!;

const log = (msg: string, cls = '') => {
  const line = document.createElement('div');
  line.className = cls;
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  logEl.prepend(line);
};

let events: boolean[] = [];
let disposed = false;

const sky = new Atmosphere(canvas, {
  time: 13,
  weather: 'summer',
  resolutionScale: 1,
  cloudScale: 1,                 // given so cloudScale is changeable at run time
  quality: 'high',
  adaptiveResolution: { budget: 25 },
  onReady: (ok) => log(`onReady(${ok})`, ok ? 'ok' : 'err'),
  onSettled: (ok) => {
    events.push(ok);
    log(`onSettled(${ok})`, ok ? 'ok' : 'err');
  },
});
(globalThis as Record<string, unknown>).sky = sky;

// Observe the public surface on a slow clock and log only the edges, so the
// atomicity is visible without touching the library's internals.
let lastPic = '';
let lastSettled = sky.settled;
setInterval(() => {
  const pic = `${sky.quality ?? 'undefined'} (cloudScale ${sky.cloudScale}, ${sky.cumulonimbus})`;
  if (pic !== lastPic) {
    log(`picture now: ${pic}`, 'wait');
    lastPic = pic;
    markButtons();
  }
  if (sky.settled !== lastSettled) {
    log(`settled -> ${sky.settled}`, sky.settled ? 'ok' : 'wait');
    lastSettled = sky.settled;
  }
  render();
}, 120);

// a whenSettled() left pending when the sky is disposed must end false
let waiters = 0;
function armWaiter() {
  if (disposed || waiters > 0 || sky.settled) return;
  waiters++;
  sky.whenSettled().then((ok) => {
    waiters--;
    log(`whenSettled() resolved ${ok}`, ok ? 'ok' : 'err');
  });
}

function render() {
  $('r-quality').textContent = String(sky.quality);
  $('r-pic').textContent = `cloudScale ${sky.cloudScale}, cumulonimbus '${sky.cumulonimbus}'`;
  $('r-settled').innerHTML = `<span class="flag${sky.settled ? '' : ' off'}">${sky.settled}</span>`;
  $('r-resolution').textContent =
    `factor ${sky.resolution.toFixed(3)}, canvas ${canvas.width}×${canvas.height}`;
  $('r-events').textContent = `[${events.join(', ')}]`;
  $('r-waiters').textContent = String(waiters);
}

function switchQuality(q: QualityPreset) {
  if (disposed) { log('disposed: switch ignored', 'err'); return; }
  const before = sky.quality;
  armWaiter();
  sky.quality = q;
  const state = sky.settled
    ? 'committed at once (no new variant needed)'
    : 'pending — old picture keeps drawing until the variant links';
  log(`quality ${before} -> ${q}: ${state}`, sky.settled ? 'ok' : 'wait');
}

document.querySelectorAll<HTMLButtonElement>('[data-quality]').forEach((btn) => {
  btn.addEventListener('click', () => switchQuality(btn.dataset.quality as QualityPreset));
});

$('custom').addEventListener('click', () => {
  if (disposed) return;
  armWaiter();
  // a pair no preset names: quality must read undefined while it is in effect
  sky.cloudScale = 0.5;
  log('cloudScale = 0.5 with the auto tower: quality reads undefined', 'wait');
});

$('offscreen').addEventListener('click', () => {
  const hidden = canvas.style.display === 'none';
  canvas.style.display = hidden ? '' : 'none';
  log(`canvas ${hidden ? 'back in layout' : 'hidden (display: none)'}`, 'wait');
});

$('dispose').addEventListener('click', () => {
  armWaiter();
  sky.dispose();
  disposed = true;
  log('dispose() called: no further redraws or onSettled may fire', 'err');
});

function markButtons() {
  document.querySelectorAll<HTMLButtonElement>('[data-quality]').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.quality === sky.quality);
  });
}
markButtons();
render();
log('sample ready — press a quality button', 'ok');
