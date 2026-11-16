// One benchmark scene, shared by motlab, Remotion and HyperFrames. Everything visible is a function of t (seconds):
// a gradient that turns, 160 cards that move, turn, scale and fade, each with a number, a title, a frame counter and
// a progress bar. drawCanvas draws it on a 2D canvas; dom/applyDom build and move the same thing as HTML elements.
(function (g) {
  const W = 1920, H = 1080, TOTAL = 10, N = 160, COLS = 16, CW = 96, CH = 64, FONT = '"Segoe UI", system-ui, sans-serif';

  function state(t) {
    const cards = [];
    for (let i = 0; i < N; i++) {
      const col = i % COLS, row = (i / COLS) | 0, ph = i * 0.37;
      cards.push({
        x: 64 + col * 114 + Math.sin(t * 1.3 + ph) * 18,
        y: 170 + row * 82 + Math.cos(t * 1.1 + ph) * 14,
        r: Math.sin(t * 0.9 + ph) * 0.6,
        s: 0.85 + 0.15 * Math.sin(t * 2 + ph),
        a: 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 1.7 + ph)),
        hue: (i * 7 + t * 40) % 360,
        label: String((i + Math.floor(t * 10)) % 100),
      });
    }
    return {
      angle: (t * 20) % 360,                       // CSS degrees: 0 = to top, clockwise
      bg1: `hsl(${(220 + t * 15) % 360}, 60%, 18%)`, bg2: `hsl(${(300 + t * 15) % 360}, 55%, 30%)`,
      titleY: 70 + Math.sin(t * 2.4) * 10,
      counter: `frame ${Math.round(t * 30)}`,
      progress: t / TOTAL,
      cards,
    };
  }

  function drawCanvas(ctx, t) {
    const st = state(t), a = st.angle * Math.PI / 180;
    const dx = Math.sin(a), dy = -Math.cos(a), half = (Math.abs(W * dx) + Math.abs(H * dy)) / 2;
    const gr = ctx.createLinearGradient(W / 2 - dx * half, H / 2 - dy * half, W / 2 + dx * half, H / 2 + dy * half);
    gr.addColorStop(0, st.bg1); gr.addColorStop(1, st.bg2);
    ctx.globalAlpha = 1; ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `600 24px ${FONT}`;
    for (const c of st.cards) {
      ctx.save();
      ctx.translate(c.x + CW / 2, c.y + CH / 2); ctx.rotate(c.r); ctx.scale(c.s, c.s);
      ctx.globalAlpha = c.a;
      ctx.fillStyle = `hsl(${c.hue}, 70%, 60%)`;
      ctx.beginPath(); ctx.roundRect(-CW / 2, -CH / 2, CW, CH, 12); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.fillText(c.label, 0, 1);
      ctx.restore();
    }
    ctx.globalAlpha = 1; ctx.fillStyle = '#ffffff';
    ctx.font = `700 72px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('Benchmark', 64, st.titleY + 60);
    ctx.font = `400 32px ${FONT}`; ctx.textAlign = 'right';
    ctx.fillText(st.counter, W - 64, st.titleY + 50);
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(64, H - 60, W - 128, 12);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(64, H - 60, (W - 128) * st.progress, 12);
  }

  // DOM: build once into a W x H container, then applyDom(els, t) per frame.
  function dom(root, doc) {
    doc = doc || document;
    const mk = (css, text) => { const e = doc.createElement('div'); e.style.cssText = 'position:absolute;' + css; if (text != null) e.textContent = text; root.appendChild(e); return e; };
    root.style.cssText += `;position:relative;width:${W}px;height:${H}px;overflow:hidden;font-family:${FONT};color:#fff`;
    const els = { bg: mk(`left:0;top:0;width:${W}px;height:${H}px`), cards: [] };
    for (let i = 0; i < N; i++) els.cards.push(mk(`left:0;top:0;width:${CW}px;height:${CH}px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:24px;line-height:1`, ''));
    els.title = mk('left:64px;top:0;font-weight:700;font-size:72px;line-height:1;white-space:nowrap', 'Benchmark');
    els.counter = mk('right:64px;top:0;font-size:32px;line-height:1;white-space:nowrap', '');
    mk(`left:64px;top:${H - 60}px;width:${W - 128}px;height:12px;background:rgba(255,255,255,0.25)`);
    els.bar = mk(`left:64px;top:${H - 60}px;width:0;height:12px;background:#fff`);
    return els;
  }
  function applyDom(els, t) {
    const st = state(t);
    els.bg.style.background = `linear-gradient(${st.angle}deg, ${st.bg1}, ${st.bg2})`;
    st.cards.forEach((c, i) => {
      const e = els.cards[i];
      e.style.transform = `translate(${c.x}px, ${c.y}px) rotate(${c.r}rad) scale(${c.s})`;
      e.style.opacity = c.a; e.style.background = `hsl(${c.hue}, 70%, 60%)`;
      if (e.textContent !== c.label) e.textContent = c.label;
    });
    els.title.style.transform = `translateY(${st.titleY}px)`;
    els.counter.style.transform = `translateY(${st.titleY + 22}px)`;
    els.counter.textContent = st.counter;
    els.bar.style.width = `${(W - 128) * st.progress}px`;
  }

  const BENCH = { W, H, TOTAL, state, drawCanvas, dom, applyDom };
  g.BENCH = BENCH;
  if (typeof module !== 'undefined' && module.exports) module.exports = BENCH;
})(typeof window !== 'undefined' ? window : globalThis);
