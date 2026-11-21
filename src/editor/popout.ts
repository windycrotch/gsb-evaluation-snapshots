/**
 * The Preview in a window of its own (a second monitor): the editor keeps drawing the preview and copies each frame into a canvas of the
 * new window, so the player, the mix table and the sounds stay exactly what the panel shows. Closing the window just stops the copying.
 */

let win: Window | null = null;

/** Opens the window (or brings the open one to the front). Returns it, or null when the browser blocked the pop-up. */
export function openPopout(background: [number, number, number]): Window | null {
  if (win && !win.closed) {
    win.focus();
    return win;
  }
  const w = window.open('', 'bone2d-preview', 'popup=yes,width=640,height=640');
  if (!w) return null;
  const bg = `rgb(${background.map((c) => Math.round(c * 255)).join(',')})`;
  w.document.title = 'Bone 2D · Preview';
  w.document.body.style.cssText = `margin:0;overflow:hidden;background:${bg}`;
  const canvas = w.document.createElement('canvas');
  canvas.id = 'c';
  canvas.style.cssText = 'display:block;width:100vw;height:100vh';
  w.document.body.replaceChildren(canvas);
  win = w;
  return w;
}

/** Copies the frame of `source` into the window's canvas, fitted inside it without stretching. A closed window is forgotten. */
export function mirrorToPopout(source: HTMLCanvasElement, background: [number, number, number]) {
  if (!win) return;
  if (win.closed) {
    win = null;
    return;
  }
  const canvas = win.document.getElementById('c') as HTMLCanvasElement | null;
  if (!canvas) return;
  const dpr = win.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(win.innerWidth * dpr));
  const h = Math.max(1, Math.round(win.innerHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx || !source.width || !source.height) return;
  ctx.fillStyle = `rgb(${background.map((c) => Math.round(c * 255)).join(',')})`;
  ctx.fillRect(0, 0, w, h);
  const k = Math.min(w / source.width, h / source.height);
  const dw = source.width * k;
  const dh = source.height * k;
  ctx.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh);
}
