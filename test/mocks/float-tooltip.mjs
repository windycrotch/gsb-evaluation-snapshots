// Mock of float-tooltip
export default class Tooltip {
  constructor(container) {
    this.container = container;
    this._content = null;
    this.el = document.createElement('div');
    this.el.className = 'tooltip';
  }
  content(value) {
    if (arguments.length) {
      this._content = value;
      return this;
    }
    return this._content;
  }
}
