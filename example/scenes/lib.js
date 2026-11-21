// Shared by the example scenes: a 1920x1080 canvas (times ?scale=) and the page contract.
const q = new URLSearchParams(location.search), S = parseFloat(q.get('scale') || '1'), W = 1920, H = 1080;
const cv = document.getElementById('c'); cv.width = W * S; cv.height = H * S;
const ctx = cv.getContext('2d');
const CREAM = '#F4F1EA', INK = '#161616', ORANGE = '#FF5B2E', FONT = '"Segoe UI", system-ui, sans-serif';
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = x => 1 - Math.pow(1 - clamp(x), 3);          // fast, then slow
const prog = (t, a, b) => clamp((t - a) / (b - a));        // 0..1 between seconds a and b

function scene(total, draw) {
  window.TOTAL = total;
  window.renderAt = t => { ctx.setTransform(S, 0, 0, S, 0, 0); ctx.globalAlpha = 1; draw(t); };
  window.ready = document.fonts.ready.then(() => window.renderAt(parseFloat(q.get('t') || '0')));
}
