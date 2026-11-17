/**
 * 键鼠 / 触屏输入。跳跃与冲刺使用"边沿触发"，避免长按连续触发。
 */
export class Input {
  constructor(dom) {
    this.dom = dom;
    this.keys = new Set();
    this.jumpQueued = false;
    this.dashQueued = false;
    this.axis = { x: 0, z: 0 };
    this.pointerActive = false;
    this.touch = { x: 0, z: 0, active: false };
    this.jumpTouch = false;
    this.dashTouch = false;
    this.enabled = true;

    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      const code = e.code;
      if (
        ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(
          code
        )
      ) {
        e.preventDefault();
      }
      if (code === 'Space' && !this.keys.has('Space')) this.jumpQueued = true;
      if ((code === 'ShiftLeft' || code === 'ShiftRight') && !this.keys.has(code)) this.dashQueued = true;
      this.keys.add(code);
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onBlur = () => this.keys.clear();

    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);

    this._setupTouch(dom);
  }

  _setupTouch(dom) {
    const stick = document.getElementById('stick');
    const knob = document.getElementById('stickKnob');
    const jumpBtn = document.getElementById('jumpBtn');
    const dashBtn = document.getElementById('dashBtn');
    if (!stick || !knob) return;

    const radius = 52;
    let pid = null;
    let cx = 0;
    let cy = 0;

    stick.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.enabled) return;
        pid = e.pointerId;
        stick.setPointerCapture(pid);
        const r = stick.getBoundingClientRect();
        cx = r.left + r.width / 2;
        cy = r.top + r.height / 2;
        this.touch.active = true;
        this._moveStick(e, cx, cy, radius, knob);
      },
      { passive: true }
    );
    stick.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerId !== pid) return;
        this._moveStick(e, cx, cy, radius, knob);
      },
      { passive: true }
    );
    const end = (e) => {
      if (e.pointerId !== pid) return;
      pid = null;
      this.touch.active = false;
      this.touch.x = 0;
      this.touch.z = 0;
      knob.style.transform = 'translate(-50%, -50%)';
    };
    stick.addEventListener('pointerup', end);
    stick.addEventListener('pointercancel', end);

    if (jumpBtn) {
      jumpBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.jumpQueued = true;
      });
    }
    if (dashBtn) {
      dashBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.dashQueued = true;
      });
    }
  }

  _moveStick(e, cx, cy, radius, knob) {
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const len = Math.hypot(dx, dy);
    if (len > radius) {
      dx = (dx / len) * radius;
      dy = (dy / len) * radius;
    }
    this.touch.x = dx / radius;
    this.touch.z = dy / radius;
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }

  update() {
    if (this.sim) {
      this.axis.x = this.sim.x;
      this.axis.z = this.sim.z;
      return;
    }
    const k = this.keys;
    let x = 0;
    let z = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) z += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) z -= 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (this.touch.active) {
      x += this.touch.x;
      z -= this.touch.z;
    }
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    this.axis.x = x;
    this.axis.z = z;
  }

  consumeJump() {
    const v = this.jumpQueued;
    this.jumpQueued = false;
    return v;
  }

  consumeDash() {
    const v = this.dashQueued;
    this.dashQueued = false;
    return v;
  }

  clear() {
    this.keys.clear();
    this.jumpQueued = false;
    this.dashQueued = false;
    this.touch.active = false;
    this.touch.x = 0;
    this.touch.z = 0;
  }
}
