import { hexToCss } from './utils.js';

/** DOM 层 HUD 与全屏界面控制 */
export class HUD {
  constructor() {
    this.root = document.getElementById('hud');
    this.heartsEl = document.getElementById('hearts');
    this.levelName = document.getElementById('levelName');
    this.levelSub = document.getElementById('levelSub');
    this.shardBar = document.getElementById('shardBar');
    this.shardNow = document.getElementById('shardNow');
    this.shardTotal = document.getElementById('shardTotal');
    this.timer = document.getElementById('timer');
    this.toastEl = document.getElementById('toast');
    this.hint = document.getElementById('hint');
    this.flashEl = document.getElementById('flash');
    this.fadeEl = document.getElementById('fade');
    this.screens = {
      title: document.getElementById('title'),
      pause: document.getElementById('pause'),
      over: document.getElementById('over'),
      win: document.getElementById('win'),
    };
    this._toastTimer = null;
    this._lastTime = '';
    this.setHearts(3, 3);
  }

  showHUD(v) {
    this.root.classList.toggle('visible', v);
  }

  setAccent(hex) {
    document.documentElement.style.setProperty('--accent', hexToCss(hex));
    const c = hexToCss(hex);
    document.documentElement.style.setProperty('--accent-soft', c + '33');
  }

  setLevel(index, name, sub) {
    this.levelName.textContent = name;
    this.levelSub.textContent = sub || `SECTOR ${String(index + 1).padStart(2, '0')}`;
    this.levelName.classList.remove('swap');
    void this.levelName.offsetWidth;
    this.levelName.classList.add('swap');
  }

  setHearts(current, max = 3) {
    this.heartsEl.innerHTML = '';
    for (let i = 0; i < max; i++) {
      const d = document.createElement('i');
      d.className = 'heart' + (i < current ? ' on' : '');
      this.heartsEl.appendChild(d);
    }
  }

  setShards(now, total) {
    this.shardNow.textContent = String(now);
    this.shardTotal.textContent = String(total);
    const pct = total > 0 ? Math.min(1, now / total) : 0;
    this.shardBar.style.width = (pct * 100).toFixed(2) + '%';
    this.shardBar.parentElement.classList.toggle('full', pct >= 1);
  }

  setTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const text = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    if (text !== this._lastTime) {
      this._lastTime = text;
      this.timer.textContent = text;
    }
  }

  toast(text, ms = 1800, tone = '') {
    const el = this.toastEl;
    el.textContent = text;
    el.className = 'toast show ' + tone;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      el.className = 'toast ' + tone;
    }, ms);
  }

  showHint(ms = 9000) {
    this.hint.classList.add('visible');
    this.hint.style.opacity = '1';
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => {
      this.hint.style.opacity = '0';
    }, ms);
  }

  hideHint() {
    this.hint.style.opacity = '0';
  }

  hideScreens() {
    Object.values(this.screens).forEach((s) => s && s.classList.remove('visible'));
  }

  showScreen(name) {
    this.hideScreens();
    const el = this.screens[name];
    if (el) el.classList.add('visible');
  }

  isScreenVisible(name) {
    const el = this.screens[name];
    return el ? el.classList.contains('visible') : false;
  }

  flash(color = '255,120,150', peak = 0.55, duration = 420) {
    const el = this.flashEl;
    el.style.background = `radial-gradient(circle at 50% 55%, rgba(${color},${peak}) 0%, rgba(${color},0) 70%)`;
    el.style.transition = 'none';
    el.style.opacity = '1';
    requestAnimationFrame(() => {
      el.style.transition = `opacity ${duration}ms ease-out`;
      el.style.opacity = '0';
    });
  }

  fade(to, duration = 600) {
    return new Promise((resolve) => {
      const el = this.fadeEl;
      el.style.transition = `opacity ${duration}ms ease-in-out`;
      el.style.opacity = String(to);
      setTimeout(resolve, duration + 20);
    });
  }
}
