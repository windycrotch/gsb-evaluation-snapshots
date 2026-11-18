/*
 * End-to-end check of the page-level logic used in html/qwerty.html:
 * the octave +/- buttons, the MIDI monitor, and the held-key semantics
 * through the real JZZ.input.Qwerty port.
 */
'use strict';

var assert = require('assert');
var path = require('path');
var dom = require('./dom-stub');

var document = dom.makeDocument();
var windowEl = dom.makeWindow(document);
['qwerty1', 'qwerty2', 'midi-log', 'clear-log', 'qh1-oct-down', 'qh1-oct-up', 'qh1-start-note']
  .forEach(function (id) {
    var el = dom.makeElement('div', id);
    el.offsetWidth = 281;
    el.offsetHeight = 150;
    document._register(id, el);
  });

global.document = document;
global.window = windowEl;
global.alert = function (msg) { throw new Error('unexpected alert: ' + msg); };
global.JZZ = require(path.join('..', 'node_modules', 'jzz', 'javascript', 'JZZ.js'));
global.QwertyHancock = require(path.join('..', 'javascript', 'qwerty-hancock.js'));
require(path.join('..', 'javascript', 'JZZ.input.Qwerty.js'));

// --- Re-implement the page wiring (mirrors html/qwerty.html) ---------------
var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function noteName(n) { return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1); }

var logEl = document.getElementById('midi-log');
function logMessage(portName, msg) {
  var line = dom.makeElement('div');
  line.textContent = portName + ' ' + (msg[0] === 0x90 ? 'on ' : 'off') + ' ' + noteName(msg[1]);
  logEl.appendChild(line);
}

var qh1 = global.JZZ.input.Qwerty('qh1', { id: 'qwerty1', width: 281, height: 150, octaves: 1, startNote: 'C4' });
assert.ok(!qh1._orig._bad, 'qh1 must open');
var messages = [];
qh1.connect(function (msg) {
  messages.push(Array.prototype.slice.call(msg));
  logMessage('qh1', msg);
});

// Octave switcher, same code as the page's shiftQh1Octave().
var qh1Start = 'C4';
function shiftQh1Octave(delta) {
  var noteLetter = qh1Start.slice(0, -1);
  var octave = parseInt(qh1Start.slice(-1), 10) + delta;
  qh1Start = noteLetter + octave;
  qh1.qwerty.setStartNote(qh1Start);
  document.getElementById('qh1-start-note').textContent = qh1Start;
}

// --- Scenario from the acceptance criteria --------------------------------
// 1. Hold one key: single note-on.
windowEl.dispatch('keydown', { keyCode: 65 });
assert.strictEqual(messages.length, 1);
assert.strictEqual(messages[0][0], 0x90);
var oldNote = messages[0][1];

// 2. Change octave while the key is still held.
shiftQh1Octave(1);
assert.strictEqual(document.getElementById('qh1-start-note').textContent, 'C5');

// 3. Newly pressed key uses the new octave (a whole octave higher).
windowEl.dispatch('keydown', { keyCode: 83 });
assert.strictEqual(messages.length, 2);
assert.strictEqual(messages[1][0], 0x90);
assert.strictEqual(messages[1][1], global.JZZ.MIDI.noteValue('D5'), 'S key maps to D5 in the new octave');
assert.strictEqual(messages[1][1] - oldNote, 14, 'D5 is 14 semitones above C4 (one octave + one whole step)');

// 4. Releasing the old-held key closes the OLD note (old octave).
windowEl.dispatch('keyup', { keyCode: 65 });
assert.strictEqual(messages.length, 3);
assert.strictEqual(messages[2][0], 0x80);
assert.strictEqual(messages[2][1], oldNote, 'old key releases its original note');

// 5. Releasing the new key closes the new-octave note.
windowEl.dispatch('keyup', { keyCode: 83 });
assert.strictEqual(messages.length, 4);
assert.strictEqual(messages[3][0], 0x80);
assert.strictEqual(messages[3][1], global.JZZ.MIDI.noteValue('D5'));

// 6. Monitor rendered one line per message.
assert.strictEqual(logEl.children.length, 4);

// 7. Mouse drag out-and-back on the rebuilt keyboard: no duplicate note-on.
var c5 = document.getElementById('C5');
assert.ok(c5, 'rebuilt keyboard has C5 key');
document.getElementById('qwerty1').dispatch('mousedown', { target: c5 });
document.getElementById('qwerty1').dispatch('mouseout', { target: c5 });
document.getElementById('qwerty1').dispatch('mouseover', { target: c5 });
assert.strictEqual(messages.length, 5, 'no repeated note-on when re-entering the key');
assert.strictEqual(messages[4][0], 0x90);
windowEl.dispatch('mouseup', { target: dom.makeElement('body') });
assert.strictEqual(messages.length, 6);
assert.strictEqual(messages[5][0], 0x80);
assert.strictEqual(messages[5][1], messages[4][1]);

console.log('qwerty.html page flow: all assertions passed');
console.log('message sequence:', JSON.stringify(messages));
