// Transient, user-visible notice shown when a boolean operation had to repair
// a mesh (welding, hole filling, ...) before it could run. Auto-hides after a
// few seconds; the operation itself stays undoable as a single step.
export class RepairNotice {
  constructor(editor) {
    this.editor = editor;
    this.signals = editor.signals;
    this.container = document.getElementById('repair-notice');
    this._hideTimer = null;

    this.signals.repairNotice.add((text) => this.show(text));
  }

  show(text) {
    if (!this.container || !text) return;

    this.container.textContent = text;
    this.container.classList.add('active');

    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => this.hide(), 8000);
  }

  hide() {
    if (!this.container) return;
    this.container.classList.remove('active');
  }
}
