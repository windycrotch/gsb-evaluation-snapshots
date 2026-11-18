// fretboard.js — 指板画布：弦为横向通道、品为纵向分界。
// 四种视觉状态：idle（待机）/ detected（检测到）/ correct（正确）/ error（错误）。
// 点亮的位置先保持再淡出，由 requestAnimationFrame 驱动。

import { MAX_FRET } from './tuning.js';

const HOLD_MS = 650;      // 点亮保持时间
const FADE_MS = 900;      // 淡出时长

const COLORS = {
  wood: '#241a12',
  woodLight: '#2f2318',
  fret: '#c9b48f',
  string: '#d8d8de',
  idle: 'rgba(120, 130, 150, 0.10)',
  detected: { fill: 'rgba(88, 166, 255, 0.92)', glow: 'rgba(88, 166, 255, 0.55)' },
  correct: { fill: 'rgba(74, 201, 122, 0.95)', glow: 'rgba(74, 201, 122, 0.6)' },
  error: { fill: 'rgba(235, 99, 99, 0.95)', glow: 'rgba(235, 99, 99, 0.6)' },
  target: 'rgba(240, 200, 96, 0.30)',
};

export class FretboardRenderer {
  constructor(canvas, stringCount, tuningNames) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.stringCount = stringCount;
    this.tuningNames = tuningNames;
    this.fretCount = MAX_FRET;
    this.markers = [];   // { string, fret, state, bornAt }
    this.target = null;  // 练习模式目标 { string, fret }
    this.raf = null;
    this._loop = this._loop.bind(this);
    this.raf = requestAnimationFrame(this._loop);
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  setTuning(stringCount, tuningNames) {
    this.stringCount = stringCount;
    this.tuningNames = tuningNames;
    this.markers = [];
    this.target = null;
  }

  setTarget(target) {
    this.target = target; // {string, fret} 或 null
  }

  // 登记一次检测；同位置同状态刷新 bornAt，不同状态覆盖。
  show(string, fret, state) {
    const existing = this.markers.find((m) => m.string === string && m.fret === fret);
    const now = performance.now();
    if (existing) {
      existing.state = state;
      existing.bornAt = now;
    } else {
      this.markers.push({ string, fret, state, bornAt: now });
    }
  }

  clearMarkers() {
    this.markers = [];
  }

  _layout() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.canvas.clientWidth || 900;
    const cssH = this.canvas.clientHeight || 260;
    if (this.canvas.width !== Math.round(cssW * dpr) || this.canvas.height !== Math.round(cssH * dpr)) {
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const padL = 56;
    const padR = 14;
    const padT = 16;
    const padB = 22;
    const w = cssW - padL - padR;
    const h = cssH - padT - padB;
    // 真实指板品距按 1/17.817 递减，这里用简化的等比透视
    const laneH = h / this.stringCount;
    return { cssW, cssH, padL, padR, padT, padB, w, h, laneH };
  }

  _fretX(layout, fret) {
    // 品界位置：累加分品距（从琴枕往高把位越来越窄）
    const usable = layout.w;
    const scale = 1 / 17.817;
    let x = layout.padL;
    let remaining = usable / (1 - Math.pow(1 - scale, this.fretCount));
    for (let f = 1; f <= fret; f++) {
      x += remaining * scale;
      remaining *= 1 - scale;
    }
    return x;
  }

  _loop() {
    if (this.raf === null) return; // destroy() 后不再调度
    const ctx = this.ctx;
    const L = this._layout();
    ctx.clearRect(0, 0, L.cssW, L.cssH);

    // 木质底板（横向弦通道交替深浅）
    for (let s = 0; s < this.stringCount; s++) {
      ctx.fillStyle = s % 2 ? COLORS.wood : COLORS.woodLight;
      const y = L.padT + s * L.laneH;
      ctx.fillRect(L.padL, y, L.w, L.laneH);
    }

    // 练习目标格
    if (this.target) {
      const x1 = this._fretX(L, this.target.fret);
      const x2 = this._fretX(L, this.target.fret + 1);
      const y = L.padT + (this.target.string - 1) * L.laneH;
      ctx.fillStyle = COLORS.target;
      ctx.fillRect(x1, y, x2 - x1, L.laneH);
    }

    // 品丝（纵向分界）与品位号
    ctx.strokeStyle = COLORS.fret;
    ctx.lineWidth = 1.5;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(220,210,190,0.75)';
    ctx.textAlign = 'center';
    for (let f = 0; f <= this.fretCount; f++) {
      const x = this._fretX(L, f);
      ctx.beginPath();
      ctx.moveTo(x, L.padT);
      ctx.lineTo(x, L.padT + L.h);
      ctx.stroke();
      if (f > 0) ctx.fillText(String(f), x + (this._fretX(L, f + 1) - x) / 2, L.padT + L.h + 15);
    }

    // 弦（横向通道中线）与空弦音名
    ctx.strokeStyle = COLORS.string;
    ctx.lineWidth = 1.4;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(225,225,230,0.9)';
    for (let s = 0; s < this.stringCount; s++) {
      const y = L.padT + (s + 0.5) * L.laneH;
      ctx.beginPath();
      ctx.moveTo(L.padL, y);
      ctx.lineTo(L.padL + L.w, y);
      ctx.stroke();
      ctx.fillText(this.tuningNames[s] ?? '', L.padL - 8, y + 4);
    }

    // 状态标记：保持 HOLD_MS 后在 FADE_MS 内淡出
    const now = performance.now();
    this.markers = this.markers.filter((m) => now - m.bornAt < HOLD_MS + FADE_MS);
    for (const m of this.markers) {
      const age = now - m.bornAt;
      const alpha = age < HOLD_MS ? 1 : Math.max(0, 1 - (age - HOLD_MS) / FADE_MS);
      const x1 = this._fretX(L, m.fret);
      const x2 = this._fretX(L, m.fret + 1);
      const y = L.padT + (m.string - 1) * L.laneH + L.laneH * 0.14;
      const r = Math.min(L.laneH * 0.36, (x2 - x1) * 0.42);
      const cx = (x1 + x2) / 2;
      const cy = y + L.laneH * 0.36;
      const c = COLORS[m.state] || COLORS.detected;

      ctx.globalAlpha = alpha;
      ctx.shadowColor = c.glow;
      ctx.shadowBlur = 16;
      ctx.fillStyle = c.fill;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // 品数文字
      ctx.fillStyle = '#10141a';
      ctx.font = `bold ${Math.max(10, r * 0.95)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(String(m.fret), cx, cy + r * 0.34);
      ctx.globalAlpha = 1;
    }

    this.raf = requestAnimationFrame(this._loop);
  }
}
