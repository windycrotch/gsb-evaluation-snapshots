/*
 * Minimal DOM stub for exercising qwerty-hancock.js under Node.
 * Implements only the surface the library touches; it is not a browser.
 */
'use strict';

function makeElement(tag, id) {
  var el = {
    tagName: (tag || 'div').toUpperCase(),
    _id: id || '',
    title: '',
    style: {},
    children: [],
    _listeners: {},
    _attrs: {},
    setAttribute: function (k, v) { this._attrs[k] = v; },
    getAttribute: function (k) { return this._attrs[k]; },
    appendChild: function (child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild: function (child) {
      var i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      return child;
    },
    addEventListener: function (type, fn) {
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push(fn);
    },
    dispatch: function (type, event) {
      var fns = this._listeners[type] || [];
      event = event || {};
      event.target = event.target || this;
      fns.forEach(function (fn) { fn(event); });
    }
  };
  return el;
}

function makeDocument() {
  var byId = {};
  return {
    documentElement: makeElement('html'),
    createElement: function (tag) {
      var el = makeElement(tag);
      // Track ids the way browsers index elements on creation/mutation.
      Object.defineProperty(el, 'id', {
        enumerable: true,
        get: function () { return this._id || ''; },
        set: function (v) {
          if (this._id && byId[this._id] === this) delete byId[this._id];
          this._id = v;
          if (v) byId[v] = this;
        }
      });
      return el;
    },
    getElementById: function (id) { return byId[id] || null; },
    _register: function (id, el) { el._id = id; byId[id] = el; }
  };
}

function makeWindow(document) {
  var win = makeElement('window');
  win.document = document;
  return win;
}

module.exports = { makeElement: makeElement, makeDocument: makeDocument, makeWindow: makeWindow };
