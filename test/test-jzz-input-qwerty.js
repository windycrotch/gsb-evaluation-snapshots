/*
 * Integration tests for JZZ.input.Qwerty: the qwerty-hancock callbacks are
 * translated into 0x90/0x80 MIDI messages on a real JZZ input port, and
 * construction failures are reported through port._crash.
 * Run: node test/test-jzz-input-qwerty.js
 */
'use strict';

var assert = require('assert');
var path = require('path');
var dom = require('./dom-stub');

var JZZ_SRC = path.join('..', 'node_modules', 'jzz', 'javascript', 'JZZ.js');
var WRAPPER_SRC = path.join('..', 'javascript', 'JZZ.input.Qwerty.js');
var QH_SRC = path.join('..', 'javascript', 'qwerty-hancock.js');

function boot(opts) {
  opts = opts || {};
  var document = dom.makeDocument();
  var windowEl = dom.makeWindow(document);
  var container = dom.makeElement('div', 'keyboard');
  container.offsetWidth = 400;
  container.offsetHeight = 150;
  document._register('keyboard', container);

  global.document = document;
  global.window = windowEl;
  delete global.JZZ;
  delete global.QwertyHancock;

  delete require.cache[require.resolve(JZZ_SRC)];
  delete require.cache[require.resolve(WRAPPER_SRC)];
  delete require.cache[require.resolve(QH_SRC)];

  global.JZZ = require(JZZ_SRC);
  if (opts.thrower) {
    global.QwertyHancock = opts.thrower;
  } else if (opts.qwertyHancock) {
    global.QwertyHancock = opts.qwertyHancock;
  } else {
    global.QwertyHancock = require(QH_SRC);
  }
  require(WRAPPER_SRC);

  return { document: document, window: windowEl, container: container };
}

function openPort(env, arg) {
  var port = global.JZZ.input.Qwerty('test-port', Object.assign({
    id: 'keyboard', octaves: 2, startNote: 'C4'
  }, arg || {}));
  var messages = [];
  port.connect(function (msg) {
    messages.push(Array.prototype.slice.call(msg));
  });
  return { port: port, messages: messages };
}

function noteOn(note, vel)  { return [0x90, noteValue(note), vel === undefined ? 127 : vel]; }
function noteOff(note, vel) { return [0x80, noteValue(note), vel === undefined ? 127 : vel]; }
// Note names follow the JZZ note-name convention (C4 == 48).
function noteValue(note) {
  return typeof note === 'number' ? note : global.JZZ.MIDI.noteValue(note);
}

var passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ok - ' + name);
}

// ---------------------------------------------------------------------------
test('MIDI: held keyboard key emits exactly one 0x90, release one 0x80 (req 1)', function () {
  var env = boot();
  var p = openPort(env);
  env.window.dispatch('keydown', { keyCode: 65 });
  env.window.dispatch('keydown', { keyCode: 65 }); // auto-repeat
  env.window.dispatch('keydown', { keyCode: 65 });
  assert.deepStrictEqual(p.messages, [noteOn('C4')]);
  env.window.dispatch('keyup', { keyCode: 65 });
  assert.deepStrictEqual(p.messages, [noteOn('C4'), noteOff('C4')]);
  env.window.dispatch('keyup', { keyCode: 65 }); // stray release
  assert.strictEqual(p.messages.length, 2);
});

test('MIDI: octave change - new presses new notes, old held key releases old note (req 2)', function () {
  var env = boot();
  var p = openPort(env);
  env.window.dispatch('keydown', { keyCode: 65 }); // C4 = 60
  assert.deepStrictEqual(p.messages, [noteOn('C4')]);

  p.port.qwerty.setStartNote('C5');

  env.window.dispatch('keydown', { keyCode: 83 }); // D5 = 74
  assert.deepStrictEqual(p.messages[1], noteOn('D5'));

  env.window.dispatch('keyup', { keyCode: 65 });   // old key -> old note C4
  assert.deepStrictEqual(p.messages[2], noteOff('C4'));
  env.window.dispatch('keyup', { keyCode: 83 });   // D5
  assert.deepStrictEqual(p.messages[3], noteOff('D5'));
  assert.strictEqual(p.messages.length, 4);
});

test('MIDI: mouse press/drag-out/drag-back gives no duplicate note-on, one note-off (req 3)', function () {
  var env = boot();
  var p = openPort(env);
  var c4 = env.document.getElementById('C4');
  env.container.dispatch('mousedown', { target: c4 });
  env.container.dispatch('mouseout', { target: c4 });
  env.container.dispatch('mouseover', { target: c4 }); // back onto same key
  env.container.dispatch('mouseout', { target: c4 });
  env.container.dispatch('mouseover', { target: c4 });
  assert.deepStrictEqual(p.messages, [noteOn('C4')]);

  env.window.dispatch('mouseup', { target: dom.makeElement('body') });
  assert.deepStrictEqual(p.messages, [noteOn('C4'), noteOff('C4')]);
});

test('MIDI: mouse release outside keyboard still closes the note (req 3)', function () {
  var env = boot();
  var p = openPort(env);
  env.container.dispatch('mousedown', { target: env.document.getElementById('C4') });
  env.window.dispatch('mouseup', { target: dom.makeElement('body') });
  assert.deepStrictEqual(p.messages, [noteOn('C4'), noteOff('C4')]);
});

test('MIDI: note names from the keyboard library resolve via JZZ.MIDI', function () {
  var env = boot();
  var p = openPort(env);
  // 'H' maps to A in the lower row -> A4 = 69 with startNote C4
  env.window.dispatch('keydown', { keyCode: 72 });
  assert.deepStrictEqual(p.messages[0], noteOn('A4'));
  env.window.dispatch('keyup', { keyCode: 72 });
  assert.deepStrictEqual(p.messages[1], noteOff('A4'));
});

test('MIDI: every note-on in a drag sequence is balanced by a note-off', function () {
  var env = boot();
  var p = openPort(env);
  env.container.dispatch('mousedown', { target: env.document.getElementById('C4') });
  env.container.dispatch('mouseover', { target: env.document.getElementById('D4') });
  env.container.dispatch('mouseover', { target: env.document.getElementById('E4') });
  env.window.dispatch('mouseup', { target: dom.makeElement('body') });

  var ons = p.messages.filter(function (m) { return m[0] === 0x90; });
  var offs = p.messages.filter(function (m) { return m[0] === 0x80; });
  assert.strictEqual(ons.length, offs.length);
  ons.forEach(function (on) {
    var matches = offs.filter(function (off) { return off[1] === on[1]; });
    assert.strictEqual(matches.length, 1, 'note ' + on[1] + ' closed exactly once');
  });
});

test('crash: QwertyHancock constructor failure is reported through _crash (req 4)', function () {
  var boom = function () { throw new Error('synthetic construction failure'); };
  var env = boot({ thrower: boom });
  var port = global.JZZ.input.Qwerty('crashed-port', { id: 'keyboard' });

  assert.strictEqual(port._orig._bad, true, 'port must be marked bad');
  assert.ok(port._orig._log.some(function (e) {
    return /synthetic construction failure/.test(e);
  }), 'error text must reach the port log: ' + JSON.stringify(port._orig._log));

  // The .or() rejection path used by qwerty.html must fire.
  var orFired = false;
  port.or(function () { orFired = true; });
  assert.strictEqual(orFired, true, '.or() handler must run for a crashed port');
  assert.strictEqual(port.qwerty, undefined, 'no qwerty handle on a failed port');
});

test('crash: non-Error throw values are still reported, never swallowed (req 4)', function () {
  var stringThrower = function () { throw 'boom-string'; };
  var env = boot({ thrower: stringThrower });
  var port = global.JZZ.input.Qwerty('crashed-port-2', { id: 'keyboard' });
  assert.strictEqual(port._orig._bad, true);
  assert.ok(port._orig._log.indexOf('boom-string') !== -1);
});

console.log('\nJZZ.input.Qwerty: ' + passed + ' tests passed');
