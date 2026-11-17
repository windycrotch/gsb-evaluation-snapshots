import { CHARS } from '../sim/moves.js';
import { DIFFICULTIES } from '../sim/constants.js';
import { TINT } from './hud.js';

const cap = (s) => s[0].toUpperCase() + s.slice(1);

// Fighter select + difficulty. The 3D stage behind it shows both mascots; this is only the chrome.
export class Menu {
  constructor(root, { onPick, onLevel, onStart }) {
    this.cb = { onPick, onLevel, onStart };
    this.char = 'clawd';
    this.level = 'normal';
    const el = (this.el = document.createElement('div'));
    el.className = 'menu hidden';
    const card = (c) => {
      const s = CHARS[c];
      return `<button class="card" data-c="${c}" style="--c:${TINT[c]}" aria-pressed="false">
        <span class="nm"><i></i>${s.name}</span><span class="bl">${s.blurb}</span>
        <ul><li>${s.moves.s1}</li><li>${s.moves.s2}</li><li>${s.moves.ult}</li></ul></button>`;
    };
    el.innerHTML = `
      <div><h1>Merge<br>Conflict</h1><div class="tag">Two coding mascots, one arena. Pick a side.</div></div>
      <div class="pick">${card('clawd')}${card('codex')}</div>
      <div class="foot">
        <div><div class="lbl">Difficulty</div><div class="seg" role="radiogroup" aria-label="Difficulty">${DIFFICULTIES.map((d) => `<button data-d="${d}" role="radio">${cap(d)}</button>`).join('')}</div></div>
        <div class="help">
          <span><kbd>WASD</kbd> move</span><span><kbd>J</kbd> light</span><span><kbd>K</kbd> heavy</span><span><kbd>Q</kbd><kbd>E</kbd> specials</span>
          <span><kbd>R</kbd> ultimate</span><span><kbd>L</kbd> block</span><span><kbd>Shift</kbd> dash</span><span><kbd>Space</kbd> jump</span>
        </div>
        <button class="go">Fight</button>
      </div>`;
    root.appendChild(el);
    this.cards = [...el.querySelectorAll('.card')];
    this.segs = [...el.querySelectorAll('.seg button')];
    for (const c of this.cards) {
      c.addEventListener('click', () => this.pick(c.dataset.c));
      c.addEventListener('mouseenter', () => this.pick(c.dataset.c, true));
    }
    for (const s of this.segs) s.addEventListener('click', () => this.setLevel(s.dataset.d));
    el.querySelector('.go').addEventListener('click', () => this.cb.onStart());
    this.sync();
  }
  show(v) { this.el.classList.toggle('hidden', !v); }
  get visible() { return !this.el.classList.contains('hidden'); }
  pick(c, soft) {
    if (c === this.char) return;
    this.char = c;
    this.sync();
    this.cb.onPick(c, soft);
  }
  setLevel(d) {
    if (d === this.level) return;
    this.level = d;
    this.sync();
    this.cb.onLevel(d);
  }
  sync() {
    for (const c of this.cards) { const on = c.dataset.c === this.char; c.classList.toggle('sel', on); c.setAttribute('aria-pressed', on); }
    for (const s of this.segs) { const on = s.dataset.d === this.level; s.classList.toggle('sel', on); s.setAttribute('aria-checked', on); }
  }
  key(code) {
    if (!this.visible) return false;
    const di = DIFFICULTIES.indexOf(this.level);
    if (code === 'KeyA' || code === 'ArrowLeft') this.pick('clawd');
    else if (code === 'KeyD' || code === 'ArrowRight') this.pick('codex');
    else if (code === 'KeyW' || code === 'ArrowUp') this.setLevel(DIFFICULTIES[Math.min(DIFFICULTIES.length - 1, di + 1)]);
    else if (code === 'KeyS' || code === 'ArrowDown') this.setLevel(DIFFICULTIES[Math.max(0, di - 1)]);
    else if (code === 'Enter' || code === 'Space' || code === 'KeyJ') this.cb.onStart();
    else return false;
    return true;
  }
}

export class Overlay {
  constructor(root) {
    const el = (this.el = document.createElement('div'));
    el.className = 'overlay hidden';
    root.appendChild(el);
    el.style.pointerEvents = 'auto';
  }
  open(title, sub, buttons) {
    this.el.innerHTML = `<div class="sub">${sub}</div><div class="ttl">${title}</div><div class="btns">${buttons.map((b, i) => `<button class="${i === 0 ? 'pri' : ''}">${b[0]}</button>`).join('')}</div>`;
    [...this.el.querySelectorAll('button')].forEach((b, i) => b.addEventListener('click', buttons[i][1]));
    this.el.classList.remove('hidden');
    this.buttons = buttons;
    this.el.querySelector('button').focus();
  }
  close() { this.el.classList.add('hidden'); }
  get visible() { return !this.el.classList.contains('hidden'); }
}
