/*
 * Behaviour tests for qwerty-hancock.js note on/off semantics.
 * Run: node test/test-qwerty-hancock.js
 */
'use strict';

var assert = require('assert');
var dom = require('./dom-stub');
var path = require('path');

var document, windowEl, container, QH;

function freshEnvironment() {
  document = dom.makeDocument();
  windowEl = dom.makeWindow(document);
  container = dom.makeElement('div', 'keyboard');
  container.offsetWidth = 400;
  container.offsetHeight = 150;
  document._register('keyboard', container);

  global.document = document;
  global.window = windowEl;
  global.exports = undefined;
  global.module = undefined;

  delete require.cache[require.resolve(path.join('..', 'javascript', 'qwerty-hancock.js'))];
  QH = require(path.join('..', 'javascript', 'qwerty-hancock.js'));
}

function makeKeyboard(settings) {
  var events = [];
  var qh = new QH(Object.assign({ id: 'keyboard', octaves: 2, startNote: 'C4' }, settings || {}));
  qh.keyDown = function (note, freq) { events.push({ type: 'on', note: note, freq: freq }); };
  qh.keyUp = function (note, freq) { events.push({ type: 'off', note: note, freq: freq }); };
  return { qh: qh, events: events };
}

function keyElement(note) {
  return document.getElementById(note);
}

function keyDown(keyCode) { windowEl.dispatch('keydown', { keyCode: keyCode }); }
function keyUp(keyCode) { windowEl.dispatch('keyup', { keyCode: keyCode }); }

function mouseDownOn(note) {
  container.dispatch('mousedown', { target: keyElement(note) });
}
function mouseUpOver(note) {
  container.dispatch('mouseup', { target: keyElement(note) });
}
function mouseUpAnywhere(target) {
  windowEl.dispatch('mouseup', { target: target || dom.makeElement('body') });
}
function mouseOver(note) {
  container.dispatch('mouseover', { target: keyElement(note) });
}
function mouseOut(note) {
  container.dispatch('mouseout', { target: keyElement(note) });
}

var passed = 0;
function test(name, fn) {
  freshEnvironment();
  fn();
  passed++;
  console.log('  ok - ' + name);
}

// ---------------------------------------------------------------------------
test('keyboard: one note-on while held, one note-off on release (req 1)', function () {
  var k = makeKeyboard();
  keyDown(65); // 'A' key -> first white note, C4
  keyDown(65); // auto-repeat while held
  keyDown(65);
  assert.deepStrictEqual(k.events, [{ type: 'on', note: 'C4', freq: k.events[0].freq }]);
  assert.strictEqual(k.events.length, 1);

  keyUp(65);
  assert.strictEqual(k.events.length, 2);
  assert.strictEqual(k.events[1].type, 'off');
  assert.strictEqual(k.events[1].note, 'C4');

  keyUp(65); // stray release with no matching press
  assert.strictEqual(k.events.length, 2, 'stray key-up must not emit note-off');
});

test('keyboard: note-off keeps old note name after octave change (req 2)', function () {
  var k = makeKeyboard({ startNote: 'C4' });
  keyDown(65); // C4
  assert.strictEqual(k.events[0].note, 'C4');

  k.qh.setStartNote('C5');

  // A newly pressed physical key now maps into the new octave.
  keyDown(83); // 'S' key -> D5
  assert.strictEqual(k.events[1].note, 'D5', 'new presses use the new octave');

  // Releasing the old key still releases C4, not C5.
  keyUp(65);
  assert.strictEqual(k.events[2].type, 'off');
  assert.strictEqual(k.events[2].note, 'C4', 'held key releases its original note');

  keyUp(83);
  assert.strictEqual(k.events[3].type, 'off');
  assert.strictEqual(k.events[3].note, 'D5');

  // Nothing left hanging.
  assert.strictEqual(k.events.length, 4);
});

test('keyboard: two physical keys interleave without cross-talk (req 1/2)', function () {
  var k = makeKeyboard({ startNote: 'C4' });
  keyDown(65); // C4
  keyDown(83); // D4
  k.qh.setStartNote('C6');
  keyUp(65);   // must be C4
  keyUp(83);   // must be D4
  assert.deepStrictEqual(k.events.map(function (e) { return e.type + ':' + e.note; }),
    ['on:C4', 'on:D4', 'off:C4', 'off:D4']);
});

test('mouse: single press/release gives exactly one on and one off (req 1)', function () {
  var k = makeKeyboard();
  mouseDownOn('C4');
  mouseUpOver('C4');
  assert.deepStrictEqual(k.events.map(function (e) { return e.type + ':' + e.note; }),
    ['on:C4', 'off:C4']);
});

test('mouse: drag out and back does not repeat note-on or lose note-off (req 3)', function () {
  var k = makeKeyboard();
  mouseDownOn('C4');
  mouseOut('C4');
  mouseOver('C4');   // re-enter the same note: no new note-on
  mouseOut('C4');
  mouseOver('C4');
  assert.deepStrictEqual(k.events.map(function (e) { return e.type + ':' + e.note; }),
    ['on:C4'], 'only the original note-on while dragging in/out');

  mouseUpOver('C4');
  assert.deepStrictEqual(k.events.map(function (e) { return e.type + ':' + e.note; }),
    ['on:C4', 'off:C4']);
});

test('mouse: release outside the keyboard still sends the note-off (req 3)', function () {
  var k = makeKeyboard();
  mouseDownOn('C4');
  mouseOut('C4');
  mouseUpAnywhere();
  assert.deepStrictEqual(k.events.map(function (e) { return e.type + ':' + e.note; }),
    ['on:C4', 'off:C4']);

  // State must have been reset: a later press works normally.
  mouseDownOn('D4');
  mouseUpOver('D4');
  assert.deepStrictEqual(k.events.slice(2).map(function (e) { return e.type + ':' + e.note; }),
    ['on:D4', 'off:D4']);
});

test('mouse: glissando across different keys, back to origin retrigger-free (req 3)', function () {
  var k = makeKeyboard();
  mouseDownOn('C4');
  mouseOver('D4'); // D4 on, C4 off
  mouseOver('E4'); // E4 on, D4 off
  mouseOver('C4'); // C4 already sounded earlier -> no retrigger, E4 stays
  mouseUpAnywhere(); // remaining note E4 released exactly once
  assert.deepStrictEqual(k.events.map(function (e) { return e.type + ':' + e.note; }),
    ['on:C4', 'off:C4', 'on:D4', 'off:D4', 'on:E4', 'off:E4']);
});

test('mouse: every note-on during a drag gets exactly one matching note-off (req 1/3)', function () {
  var k = makeKeyboard();
  mouseDownOn('C4');
  mouseOver('D4');
  mouseOver('E4');
  mouseUpAnywhere();
  var ons = k.events.filter(function (e) { return e.type === 'on'; });
  var offs = k.events.filter(function (e) { return e.type === 'off'; });
  assert.strictEqual(ons.length, offs.length);
  ons.forEach(function (on) {
    assert.strictEqual(offs.filter(function (off) { return off.note === on.note; }).length, 1,
      'note ' + on.note + ' has exactly one note-off');
  });
});

test('mouse: bubbling mouseup over the keyboard fires note-off only once (req 1)', function () {
  var k = makeKeyboard();
  mouseDownOn('C4');
  // In a real browser the mouseup bubbles from the li through the container
  // to the window, so both listeners run for one physical release.
  mouseUpOver('C4');
  mouseUpAnywhere(keyElement('C4'));
  assert.deepStrictEqual(k.events.map(function (e) { return e.type + ':' + e.note; }),
    ['on:C4', 'off:C4']);
});

test('mouse: events with button up are ignored (req 1)', function () {
  var k = makeKeyboard();
  mouseOver('C4');   // hovering without pressing
  mouseOut('C4');
  assert.strictEqual(k.events.length, 0);
  mouseUpAnywhere(); // releasing with nothing held
  assert.strictEqual(k.events.length, 0);
});

test('octave rebuild does not duplicate key listeners (req 2)', function () {
  var k = makeKeyboard({ startNote: 'C4' });
  k.qh.setStartNote('C5');
  k.qh.setStartNote('C6');
  keyDown(65); // C6 now
  assert.strictEqual(k.events.length, 1, 'single note-on despite rebuilds');
  assert.strictEqual(k.events[0].note, 'C6');
  keyUp(65);
  assert.strictEqual(k.events.length, 2);
});

test('frequency is physically correct for the note', function () {
  var k = makeKeyboard();
  keyDown(72); // 'H' -> A in the lower row, A4 when startNote C4
  var a4 = k.events[0];
  assert.strictEqual(a4.note, 'A4');
  assert.ok(Math.abs(a4.freq - 440) < 1e-9, 'A4 must be 440 Hz, got ' + a4.freq);
});

console.log('\nqwerty-hancock: ' + passed + ' tests passed');
