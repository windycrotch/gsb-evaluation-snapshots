// The track menu's 3D overview, worker side (stunts/hires-capture.js), exercised with a fake
// original game and fake shared memory — no game files, no browser, no worker needed.
//
//   node stunts/tools/preview-hold-test.mjs
//
// A small make-believe machine stands in for the real thing: 1 MB of memory with the VGA screen
// at A0000, the menu's window sprite (what sprite1 draws to) off-screen, a dseg of symbols the
// capture layer reads, and stubs for the original's functions. The original's draw_track_preview
// draws its plan view of the preview rectangle in batches, the way the real one does (a tile at
// a time); the menu loop presents its window to the screen, and while the overview is up it also
// puts the original's picture back over the see-through window (its stale buffers, its window
// blitted again on every hover) — the fight this fix ends.
//
// Three cases:
//   1. world buffer + the page confirms the W[2]/W[3] handshake
//      -> the overview frame is published and the see-through window held until the menu closes
//   2. no world buffer (W = null)
//      -> the original's drawing only, no overview frame published
//   3. the handshake is never confirmed (times out after ~3 s)
//      -> the published see-through window is still held
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, '..', 'hires-capture.js')));   // attaches StuntsHires to globalThis
const H = globalThis.StuntsHires, KEY = H.KEY;

// the make-believe machine's layout
const VGA = 0xA0000, WND = 0x20000, DSEG = 0x1000, SSEG = 0x4000, SOFF = 0x100, ROWTAB = 0x8000;
const RECT = { L: 8, R: 312, T: 40, Bt: 140 };          // the preview rectangle (trackpreview_cliprect)
const ORIG = [77, 78, 79, 80];                          // the original's plan-view pattern
const MENU_BG = 20;                                     // the menu's own background colour
const rectIdx = [];
for (let y = RECT.T; y < RECT.Bt; y++) for (let x = RECT.L; x < RECT.R; x++) rectIdx.push(y * 320 + x);
const origPixel = i => ORIG[((i % 320) + ((i / 320) | 0)) & 3];

let failures = 0;
function check(name, cond, detail) {
  console.log(`    ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : (detail ? '  — ' + detail : '')}`);
  if (!cond) failures++;
}
const inRect = (arr, base, pred) => { let c = 0; for (const i of rectIdx) if (pred(arr[base + i])) c++; return c; };

function makeEnv(withWorld) {
  const mem = new Uint8Array(0x100000);
  const scene = new SharedArrayBuffer(H.BYTES), bg = new SharedArrayBuffer(320000);
  const world = withWorld ? new SharedArrayBuffer(H.WBYTES) : null;
  const I = new Int32Array(scene), B = new Uint8Array(bg), W = world ? new Int32Array(world) : null;
  const phys = (seg, off) => (((seg << 4) + (off & 0xFFFF)) & 0xFFFFF);
  const pc = {
    mem, inIrq: false, mouseHold: false,
    rb: (seg, off) => mem[phys(seg, off)],
    rw: (seg, off) => mem[phys(seg, off)] | (mem[phys(seg, off + 1)] << 8),
    wb: (seg, off, v) => { mem[phys(seg, off)] = v & 0xFF; },
    ww: (seg, off, v) => { mem[phys(seg, off)] = v & 0xFF; mem[phys(seg, off + 1)] = (v >> 8) & 0xFF; },
    rd: (seg, off) => (pc.rw(seg, off) | (pc.rw(seg, off + 2) << 16)) | 0,
    push() {}, call() {}, ret() {},
  };
  // every symbol the capture layer reads gets its own dseg offset (memory starts zeroed)
  const SYM = new Proxy({}, { get: (t, n) => t[n] ?? (t[n] = ((makeEnv._o = (makeEnv._o || 0x200) + 0x40) & 0xFFFF)) });
  // sprite1 -> the menu's window sprite at WND, 320 bytes a row (row table at SSEG:ROWTAB)
  pc.ww(SSEG, SOFF, 0); pc.ww(SSEG, SOFF + 2, 0x2000); pc.ww(SSEG, SOFF + 10, ROWTAB);
  for (let y = 0; y < 200; y++) pc.ww(SSEG, ROWTAB + y * 2, y * 320);
  // the preview rectangle
  const rc = SYM.trackpreview_cliprect;
  pc.ww(DSEG, rc, RECT.L); pc.ww(DSEG, rc + 2, RECT.R); pc.ww(DSEG, rc + 4, RECT.T); pc.ww(DSEG, rc + 6, RECT.Bt);
  // the menu's own picture, before any preview
  mem.fill(MENU_BG, WND, WND + 64000); mem.fill(MENU_BG, VGA, VGA + 64000);

  const env = { mem, scene, bg, world, I, B, W, pc, SYM, menuLoop: null, r: { ss: SSEG, sp: 0x8000, ds: DSEG, ax: 0, bp: 0x8000 }, m: { ret() {} } };
  const present = () => { mem.set(mem.subarray(WND, WND + 64000), VGA); };
  const P = {
    // the original: its plan view of the preview rectangle, drawn in batches (a tile row at a time)
    draw_track_preview() { for (const i of rectIdx) mem[WND + i] = origPixel(i); },
    // the menu loop's presents: the window sprite blitted to the screen
    sprite_blit_to_video: present, sprite_copy_2_to_1: present, sprite_copy_2_to_1_2: present, sprite_copy_2_to_1_clear: present,
    sprite_free_wnd() {},
    // the real menu: the preview drawn (the track's shapes freed right after), then the loop
    run_tracks_menu(r, m, PP, e) { P.draw_track_preview(r, m, PP, e); if (env.menuLoop) env.menuLoop(); P.sprite_free_wnd(); },
  };
  env.P = P;
  H.install(pc, { P, DSEG, SYM, CSYM: { sprite1: [SSEG, SOFF] } }, scene, bg, { world, keepOriginal: false });
  env.paintOriginal = base => { for (const i of rectIdx) mem[base + i] = origPixel(i); };
  env.present = () => P.sprite_blit_to_video(env.r, env.m, P, null);
  env.runMenu = () => P.run_tracks_menu(env.r, env.m, P, null);
  env.previewFlag = () => I[16 + I[0] * H.BUF + 14];
  return env;
}

// the page, for the handshake: answers every W[2] request with W[3] (hires-view.js renderModern)
const ACKER_SRC = `
  const { workerData } = require('worker_threads');
  const W = new Int32Array(workerData);
  setInterval(() => {
    const req = Atomics.load(W, 2);
    if (Atomics.load(W, 3) !== req) { Atomics.store(W, 3, req); Atomics.notify(W, 3); }
  }, 20);
`;

async function caseConfirmed() {
  console.log('\ncase 1: world buffer, the page confirms the handshake');
  const env = makeEnv(true), { I, B, W, mem } = env;
  const acker = new Worker(ACKER_SRC, { eval: true, workerData: env.world });
  try {
    let published = 0;
    env.menuLoop = () => {
      published = I[1];
      env.present();   // the menu's first present of its window
      check('preview frame published (flag on the current buffer)', env.previewFlag() === 1);
      check('handshake confirmed (W[2] === W[3] > 0)', W[2] > 0 && W[3] === W[2], `W[2]=${W[2]} W[3]=${W[3]}`);
      check('the preview rectangle is see-through on screen', inRect(mem, VGA, v => v === KEY) === rectIdx.length);
      check('...and marked see-through for the page (bg + 128000)', inRect(B, 128000, v => v === 1) === rectIdx.length);
      check("the original's picture kept aside for OG mode (bg + 192000)", inRect(B, 192000, v => ORIG.includes(v)) === rectIdx.length);
      // the fight: the original's later batches / stale buffers put its plan view back over the window
      env.paintOriginal(WND); env.paintOriginal(VGA);
      env.present();
      check("the original's later batches can not cover the window", inRect(mem, VGA, v => v === KEY) === rectIdx.length,
        `${inRect(mem, VGA, v => v !== KEY)} pixels covered`);
      // a dialog over the preview (pixels that are not the original's picture) is left alone
      mem[WND + 60 * 320 + 100] = 200;
      env.present();
      check('other pixels in the rectangle (a dialog) are left alone', mem[VGA + 60 * 320 + 100] === 200);
      check('the overview frame stays published while the menu is up', I[1] === published && env.previewFlag() === 1);
    };
    env.runMenu();
    // the menu closed: the hold ends with it
    env.paintOriginal(WND);
    env.present();
    check('the hold ends when the menu closes', inRect(mem, VGA, v => v === KEY) === 0);
    // and the next preview request publishes and holds again
    let second = 0;
    env.menuLoop = () => { second = I[1]; env.present(); };
    env.runMenu();
    check('the next preview request publishes again', second === published + 1 && env.previewFlag() === 1 && W[2] === 2 && W[3] === 2);
    console.log(`    -> preview frame published: yes, see-through window held: yes, publishes: ${I[1]}`);
  } finally { await acker.terminate(); }
}

function caseNoWorld() {
  console.log('\ncase 2: no world buffer (W = null)');
  const env = makeEnv(false), { I, mem } = env;
  env.menuLoop = () => {
    env.present();
    check('no frame published', I[1] === 0);
    check("the original's picture stays on screen (fallback)", inRect(mem, VGA, v => ORIG.includes(v)) === rectIdx.length);
    check('nothing made see-through', inRect(mem, VGA, v => v === KEY) === 0);
  };
  env.runMenu();
  check('still nothing published after the menu', I[1] === 0);
  console.log('    -> preview frame published: no, fallback original drawing only: yes');
}

function caseTimeout() {
  console.log('\ncase 3: the handshake is never confirmed (times out after ~3 s)');
  const env = makeEnv(true), { I, W, mem } = env;   // no acker: the page never answers
  env.menuLoop = () => {
    env.present();
    check('the request was made, never confirmed (W[2] = 1, W[3] = 0)', W[2] === 1 && W[3] === 0, `W[2]=${W[2]} W[3]=${W[3]}`);
    check('the preview frame was published anyway', env.previewFlag() === 1);
    check('the window is see-through on screen', inRect(mem, VGA, v => v === KEY) === rectIdx.length);
    env.paintOriginal(WND);
    env.present();
    check('timed out, and the original still can not cover the window', inRect(mem, VGA, v => v === KEY) === rectIdx.length,
      `${inRect(mem, VGA, v => v !== KEY)} pixels covered`);
  };
  const t0 = performance.now();
  env.runMenu();
  const ms = performance.now() - t0;
  check(`the worker waited about 3 s for the page (${(ms / 1000).toFixed(1)} s)`, ms > 2500 && ms < 6000);
  console.log('    -> preview frame published: yes, handshake confirmed: no, see-through window held: yes');
}

await caseConfirmed();
caseNoWorld();
caseTimeout();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
