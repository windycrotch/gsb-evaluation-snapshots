/**
 * The offline player: the script inside the single-file page that "Save player page" in the Export dialog makes. It plays the animations of a
 * skeleton the way the editor shows them (same posing, same renderer), with nothing to download: the skeleton and the pictures are in the page.
 * The page shell (a canvas and a control bar) and the data are made by `core/export/playerPage.ts`.
 */
import { applyAnimation, applyPhysicsResets } from '@/core/animate';
import type { Animation } from '@/core/model';
import { advancePlayback, playOf } from '@/core/playback';
import { compileSkeleton, createSkeleton } from '@/core/skeleton';
import type { Skeleton } from '@/core/skeleton';
import { GLRenderer } from '@/render/gl';
import type { PlayerPayload } from '@/core/export/playerPage';
import { playerLang, playerText } from '@/core/export/playerText';
import type { PlayerKey } from '@/core/export/playerText';
import { canvasToWorld, nearestBone, viewScale, worldToCanvas } from '@/core/export/playerView';
import type { BoneSegment } from '@/core/export/playerView';
import { makeComment, serializeReview } from '@/core/review';
import type { ReviewComment } from '@/core/review';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function loadImages(payload: PlayerPayload): Promise<Map<string, HTMLImageElement>> {
  const out = new Map<string, HTMLImageElement>();
  await Promise.all(
    Object.entries(payload.images).map(async ([name, url]) => {
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
        out.set(name, img);
      } catch {
        /* a picture that does not decode is left out: the slot draws nothing */
      }
    }),
  );
  return out;
}

async function main() {
  const payload = JSON.parse($('b2d-data').textContent ?? '{}') as PlayerPayload;
  const doc = payload.skeleton;
  const canvas = $<HTMLCanvasElement>('stage');
  const over = $<HTMLCanvasElement>('over');
  // the words follow the language of the browser that opens the page
  const lang = playerLang(navigator.language);
  const T = (key: PlayerKey, vars: Record<string, string | number> = {}) => playerText(lang, key, vars);
  const images = await loadImages(payload);
  const renderer = new GLRenderer(canvas);
  renderer.source = { get: (n) => (images.has(n) ? { bitmap: images.get(n)!, version: 1 } : null) };
  renderer.setSmoothing(payload.smooth);

  const data = compileSkeleton(doc);
  const hasPhysics = data.constraints.some((c) => c.kind === 'physics');
  let skeleton: Skeleton = createSkeleton(data, null);
  let anim: Animation | null = doc.animations[0] ?? null;
  let time = 0;
  let dir: 1 | -1 = 1;
  let playing = true;
  let dark = true;
  let last = -1;
  const view = { x: 0, y: 0, zoom: 1 };
  let fit = { x: 0, y: 0, w: 100, h: 100 };
  /** The bone a click in the picture pointed at: a comment can say which bone it is about. */
  let picked: string | null = null;

  const play = $<HTMLButtonElement>('play');
  const seek = $<HTMLInputElement>('seek');
  const label = $('time');
  const animSel = $<HTMLSelectElement>('anim');
  const skinSel = $<HTMLSelectElement>('skin');

  /** The box every frame of the animation fits in, so the picture does not jump about. */
  const measure = () => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const frames = anim ? Math.min(240, Math.max(1, Math.round(anim.duration * doc.fps))) : 1;
    for (let i = 0; i <= frames; i++) {
      applyAnimation(skeleton, anim, anim ? (anim.duration * i) / frames : 0);
      skeleton.updateWorldTransform('none');
      const b = skeleton.getBounds();
      if (!b) continue;
      minX = Math.min(minX, b[0]);
      minY = Math.min(minY, b[1]);
      maxX = Math.max(maxX, b[0] + b[2]);
      maxY = Math.max(maxY, b[1] + b[3]);
    }
    fit =
      minX === Infinity
        ? { x: 0, y: 0, w: 100, h: 100 }
        : { x: (minX + maxX) / 2, y: (minY + maxY) / 2, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
    view.x = view.y = 0;
    view.zoom = 1;
  };

  /** Poses the skeleton at `t`. `dt` is how long ago the previous pose was (physics keeps its state); `reset` starts the physics again. */
  const pose = (t: number, dt: number, reset: boolean) => {
    applyAnimation(skeleton, anim, t);
    if (!hasPhysics) skeleton.updateWorldTransform('none');
    else if (reset || last < 0 || !anim) {
      skeleton.updateWorldTransform('reset');
    } else {
      applyPhysicsResets(skeleton, anim, last, t);
      skeleton.update(dt);
      skeleton.updateWorldTransform('update');
    }
    last = t;
  };

  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const scale = viewScale(w, h, fit, view.zoom);
    renderer.begin(
      { x: fit.x + view.x, y: fit.y + view.y, scale, width: w, height: h },
      dark ? [0.075, 0.082, 0.1, 1] : [0.95, 0.95, 0.96, 1],
    );
    renderer.drawSkeleton(skeleton);
    renderer.end();
    drawPicked(w, h);
  };

  /** The bone a click picked is drawn over the picture (a second canvas, so the renderer stays as it is). */
  const drawPicked = (w: number, h: number) => {
    if (over.width !== w || over.height !== h) {
      over.width = w;
      over.height = h;
    }
    const ctx = over.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const b = picked ? skeleton.bones.find((x) => x.data.name === picked) : undefined;
    if (!b) return;
    const [x1, y1] = worldToCanvas(b.worldX, b.worldY, w, h, fit, view);
    const [x2, y2] = worldToCanvas(b.tipX, b.tipY, w, h, fit, view);
    const dpr = window.devicePixelRatio || 1;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#ffb454';
    ctx.lineWidth = 4 * dpr;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.fillStyle = '#ffb454';
    ctx.beginPath();
    ctx.arc(x1, y1, 5 * dpr, 0, Math.PI * 2);
    ctx.fill();
  };

  const showTime = () => {
    const d = anim?.duration ?? 0;
    label.textContent = `${time.toFixed(2)} / ${d.toFixed(2)} s`;
    seek.max = String(Math.max(1, Math.round(d * 1000)));
    seek.value = String(Math.round(time * 1000));
    play.textContent = playing ? T('pause') : T('play');
  };

  const choose = (a: Animation | null) => {
    anim = a;
    time = 0;
    dir = 1;
    last = -1;
    measure();
    pose(0, 0, true);
    showTime();
  };
  const setSkin = (id: string | null) => {
    skeleton = createSkeleton(data, id);
    last = -1;
    measure();
    pose(time, 0, true);
  };

  for (const a of doc.animations) animSel.add(new Option(a.name, a.id));
  animSel.hidden = doc.animations.length < 2;
  animSel.onchange = () => choose(doc.animations.find((a) => a.id === animSel.value) ?? null);
  skinSel.add(new Option(T('defaultSkin'), ''));
  for (const s of doc.skins.slice(1)) skinSel.add(new Option(s.name, s.id));
  skinSel.hidden = doc.skins.length < 2;
  skinSel.onchange = () => setSkin(skinSel.value || null);
  play.onclick = () => {
    playing = !playing;
    showTime();
  };
  seek.oninput = () => {
    playing = false;
    time = Number(seek.value) / 1000;
    pose(time, 0, true);
    showTime();
  };
  $('bg').onclick = () => {
    dark = !dark;
    document.body.classList.toggle('light', !dark);
  };
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      view.zoom = Math.min(20, Math.max(0.2, view.zoom * Math.exp(-e.deltaY * 0.0015)));
    },
    { passive: false },
  );
  let drag: { x: number; y: number } | null = null;
  let pressed: { x: number; y: number } | null = null;
  canvas.onpointerdown = (e) => {
    drag = { x: e.clientX, y: e.clientY };
    pressed = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove = (e) => {
    if (!drag) return;
    const dpr = window.devicePixelRatio || 1;
    const scale = viewScale(canvas.clientWidth * dpr, canvas.clientHeight * dpr, fit, view.zoom);
    view.x -= ((e.clientX - drag.x) * dpr) / scale;
    view.y += ((e.clientY - drag.y) * dpr) / scale;
    drag = { x: e.clientX, y: e.clientY };
  };
  canvas.onpointerup = (e) => {
    drag = null;
    // a click that did not move (a drag is a pan): the bone under it is picked, a click on nothing lets go of the bone
    if (pressed && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) < 4) {
      const dpr = window.devicePixelRatio || 1;
      const r = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      const [wx, wy] = canvasToWorld((e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr, w, h, fit, view);
      const segments: BoneSegment[] = skeleton.bones.map((b) => ({
        name: b.data.name,
        x1: b.worldX,
        y1: b.worldY,
        x2: b.tipX,
        y2: b.tipY,
      }));
      setPicked(nearestBone(segments, wx, wy, (10 * dpr) / viewScale(w, h, fit, view.zoom)));
    }
    pressed = null;
  };
  canvas.ondblclick = () => {
    view.x = view.y = 0;
    view.zoom = 1;
  };

  // ---- comments: the reviewer puts a note on a moment of an animation and sends a small file back (see core/review.ts)
  const note = $<HTMLButtonElement>('note');
  const send = $<HTMLButtonElement>('send');
  const dlg = $('dlg');
  const who = $<HTMLInputElement>('who');
  const what = $<HTMLTextAreaElement>('what');
  const mine = $('mine');
  const boneRow = $('bonerow');
  const comments: ReviewComment[] = [];
  const setPicked = (name: string | null) => {
    picked = name;
    boneRow.hidden = !name;
    $('bone').textContent = name ? T('bone', { name }) : '';
  };
  // the page speaks the language of the browser: the shell is written in English and the words are put in here
  const words: [string, PlayerKey, 'text' | 'title' | 'placeholder' | 'aria-label'][] = [
    ['bg', 'background', 'text'],
    ['bg', 'backgroundTip', 'title'],
    ['note', 'comment', 'text'],
    ['note', 'commentTip', 'title'],
    ['send', 'sendTip', 'title'],
    ['dcancel', 'close', 'text'],
    ['dsave', 'addComment', 'text'],
    ['who', 'yourName', 'placeholder'],
    ['who', 'yourName', 'aria-label'],
    ['what', 'whatShould', 'placeholder'],
    ['what', 'dialogLabel', 'aria-label'],
    ['anim', 'animation', 'title'],
    ['skin', 'skin', 'title'],
    ['dlgbox', 'dialogLabel', 'aria-label'],
    ['bonehint', 'boneHint', 'text'],
    ['bonex', 'clearBone', 'title'],
  ];
  document.documentElement.lang = lang;
  for (const [id, key, where] of words) {
    const el = $(id);
    if (where === 'text') el.textContent = T(key);
    else el.setAttribute(where, T(key));
  }
  $('bonex').onclick = () => setPicked(null);
  const NAME_KEY = 'bone2d-reviewer';
  const remembered = () => {
    try {
      return localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  };
  const randomId = () => {
    const bytes = new Uint8Array(8);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  };
  const listMine = () => {
    mine.textContent = '';
    for (const c of comments) {
      const li = document.createElement('li');
      li.textContent = `${c.animation} ${c.time.toFixed(2)} s${c.bone ? ` [${c.bone}]` : ''}: ${c.text}`;
      li.onclick = () => {
        const a = doc.animations.find((x) => x.name === c.animation);
        if (a && a !== anim) {
          animSel.value = a.id;
          choose(a);
        }
        playing = false;
        time = c.time;
        pose(time, 0, true);
        showTime();
      };
      mine.appendChild(li);
    }
    send.hidden = comments.length === 0;
    send.textContent = T('send', { n: comments.length });
  };
  const closeDialog = () => {
    dlg.hidden = true;
  };
  note.onclick = () => {
    playing = false;
    showTime();
    $('dlghead').textContent = `${anim?.name ?? ''} · ${time.toFixed(2)} s`;
    who.value = who.value || remembered();
    dlg.hidden = false;
    what.focus();
  };
  $('dcancel').onclick = closeDialog;
  $('dsave').onclick = () => {
    const text = what.value.trim();
    if (!text || !anim) return;
    try {
      localStorage.setItem(NAME_KEY, who.value.trim());
    } catch {
      /* the name is not remembered: nothing else is lost */
    }
    comments.push(makeComment(randomId(), anim.name, time, text, who.value, picked ?? undefined));
    setPicked(null);
    what.value = '';
    listMine();
    what.focus();
  };
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDialog();
  });
  send.onclick = () => {
    const blob = new Blob([serializeReview(payload.title, comments)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(payload.title || 'animation').replace(/[^\w-]+/g, '_')}-comments.b2dreview.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 2000);
  };

  choose(anim);
  let before = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - before) / 1000);
    before = now;
    if (playing && anim && anim.duration > 0) {
      const next = advancePlayback({ time, dir }, dt, anim.duration, playOf(anim));
      const wrapped = next.time < time && next.dir === dir;
      time = next.time;
      dir = next.dir;
      if (next.stopped) playing = false;
      pose(time, dt, wrapped);
      showTime();
    }
    draw();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // for tests and embedding: draws one frame at a time without waiting for the browser
  (window as unknown as { bone2d: unknown }).bone2d = {
    show(t: number) {
      playing = false;
      time = t;
      pose(t, 0, true);
      showTime();
      draw();
    },
    animations: doc.animations.map((a) => a.name),
    canvas,
  };
  document.body.dataset.ready = '1';
}

main().catch((e: unknown) => {
  const reason = e instanceof Error ? e.message : String(e);
  document.body.dataset.error = reason;
  const msg = document.createElement('p');
  msg.className = 'error';
  msg.textContent = playerText(playerLang(navigator.language), 'couldNotStart', { message: reason });
  document.body.appendChild(msg);
});
