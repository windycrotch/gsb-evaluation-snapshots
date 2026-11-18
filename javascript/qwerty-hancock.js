/*
 * Qwerty Hancock keyboard library v0.5.2
 * The web keyboard for now people.
 * Copyright 2012-15, Stuart Memo
 *
 * Licensed under the MIT License
 * http://opensource.org/licenses/mit-license.php
 *
 * http://stuartmemo.com/qwerty-hancock
 */

(function () {
    var root = this;
    /* In <script> context, `this` is the window.
     * In node context (browserify), `this` is the node global.
     */
    var globalWindow = typeof global === 'undefined' ? root : root.window;
    var version = '0.5.2',
        settings = {},
        // Is the mouse button currently held down on the keyboard?
        mouse_is_down = false,
        // Notes currently sounding because of the ongoing mouse press.
        // The last entry is the note under the pointer. Re-entering any
        // note in this list never re-triggers a note-on; mouseUp releases
        // exactly the notes still sounding, each once.
        mouse_notes_on = [],
        // Notes that were switched on at some point during the ongoing
        // press, so dragging back over them can never start them twice.
        mouse_notes_seen = {},
        // keyCode -> note name captured at key-down time, so key-up always
        // releases the same note even if the octave was changed meanwhile.
        keysDown = {},
        key_map = {
            65: 'Cl',
            87: 'C#l',
            83: 'Dl',
            69: 'D#l',
            68: 'El',
            70: 'Fl',
            84: 'F#l',
            71: 'Gl',
            89: 'G#l',
            90: 'G#l',
            72: 'Al',
            85: 'A#l',
            74: 'Bl',
            75: 'Cu',
            79: 'C#u',
            76: 'Du',
            80: 'D#u',
            59: 'Eu',
            186: 'Eu',
            222: 'Fu',
            221: 'F#u',
            220: 'Gu'
        },
        keyDownCallback,
        keyUpCallback;

    /**
     * Calculate width of white key.
     * @return {number} Width of a single white key in pixels.
     */
    var getWhiteKeyWidth = function (number_of_white_keys) {
        return Math.floor((settings.width - number_of_white_keys) / number_of_white_keys);
    };

    /**
     * Merge user settings with defaults.
     * @param  {object} user_settings
     */
    var init = function (us) {
        var container;

        user_settings = us || {};

        settings = {
            id:             user_settings.id || 'keyboard',
            octaves:        user_settings.octaves || 3,
            width:          user_settings.width,
            height:         user_settings.height,
            startNote:      user_settings.startNote || 'A3',
            whiteKeyColour: user_settings.whiteKeyColour || '#fff',
            blackKeyColour: user_settings.blackKeyColour || '#000',
            activeColour:   user_settings.activeColour || 'yellow',
            borderColour:   user_settings.borderColour || '#000',
            keyboardLayout: user_settings.keyboardLayout || 'en'
        };

        container = document.getElementById(settings.id);

        if (typeof settings.width === 'undefined') {
            settings.width = container.offsetWidth;
        }

        if (typeof settings.height === 'undefined') {
            settings.height = container.offsetHeight;
        }

        settings.startOctave = getOctaveOfNote(settings.startNote);

        createKeyboard();
        addListeners.call(this, container);
    };

    /**
     * Extract the octave number from a note name such as 'A3' or 'C#5'.
     * @param  {string} note Note name whose final character(s) are the octave.
     * @return {number} Octave number.
     */
    var getOctaveOfNote = function (note) {
        return parseInt(note.charAt(note.length - 1), 10);
    };

    /**
     * Get frequency of a given note.
     * @param  {string} note Musical note to convert into hertz.
     * @return {number} Frequency of note in hertz.
     */
    var getFrequencyOfNote = function (note) {
        var notes = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'],
            key_number,
            octave;

        if (note.length === 3) {
            octave = note.charAt(2);
        } else {
            octave = note.charAt(1);
        }

        key_number = notes.indexOf(note.slice(0, -1));

        if (key_number < 3) {
            key_number = key_number + 12 + ((octave - 1) * 12) + 1;
        } else {
            key_number = key_number + ((octave - 1) * 12) + 1;
        }

        return 440 * Math.pow(2, (key_number - 49) / 12);
    };

    /**
     * Lighten up man. Change the colour of a key.
     * @param  {element} el DOM element to change colour of.
     */
    var lightenUp = function lightenUp (el) {
        if (el !== null && typeof el !== 'undefined') {
            el.style.backgroundColor = settings.activeColour;
        }
    };

    /**
     * Revert key to original colour.
     * @param  {element} el DOM element to change colour of.
     */
    var darkenDown = function darkenDown (el) {
        if (el !== null) {
            if (el.getAttribute('data-note-type') === 'white') {
                el.style.backgroundColor = settings.whiteKeyColour;
            } else {
                el.style.backgroundColor = settings.blackKeyColour;
            }
        }
    };

    /**
     * Order notes into order defined by starting key in settings.
     * @param {array} notes_to_order Notes to be ordered.
     * @return {array{ ordered_notes Ordered notes.
     */
    var orderNotes = function (notes_to_order) {
        var i,
            keyOffset = 0,
            number_of_notes_to_order = notes_to_order.length,
            ordered_notes = [];

        for (i = 0; i < number_of_notes_to_order; i++) {
            if (settings.startNote.charAt(0) === notes_to_order[i]) {
                keyOffset = i;
                break;
            }
        }

        for (i = 0; i < number_of_notes_to_order; i++) {
            if (i + keyOffset > number_of_notes_to_order - 1) {
                ordered_notes[i] = notes_to_order[i + keyOffset - number_of_notes_to_order];
            } else {
                ordered_notes[i] = notes_to_order[i + keyOffset];
            }
        }

        return ordered_notes;
    };

    /**
     * Add styling to individual white key.
     * @param  {element} el White key DOM element.
     */
    var styleWhiteKey = function (key) {
        key.el.style.backgroundColor = settings.whiteKeyColour;
        key.el.style.border = '1px solid ' + settings.borderColour;
        key.el.style.borderRight = 0;
        key.el.style.height = settings.height + 'px';
        key.el.style.width = key.width + 'px';
        key.el.style.borderRadius = '0 0 5px 5px';

        if (key.noteNumber === getTotalWhiteKeys() - 1) {
            key.el.style.border = '1px solid ' + settings.borderColour;
        }
    };

    /**
     * Add styling to individual black key.
     * @param  {element} el Black key DOM element.
     */
    var styleBlackKey = function (key) {
        var white_key_width = getWhiteKeyWidth(getTotalWhiteKeys()),
            black_key_width = Math.floor(white_key_width / 2);

        key.el.style.backgroundColor = settings.blackKeyColour;
        key.el.style.border = '1px solid ' + settings.borderColour;
        key.el.style.position = 'absolute';
        key.el.style.left = Math.floor(((white_key_width + 1) * (key.noteNumber + 1)) - (black_key_width / 2)) + 'px';
        key.el.style.width = black_key_width + 'px';
        key.el.style.height = (settings.height / 1.5) + 'px';
        key.el.style.borderRadius = '0 0 3px 3px';
    };

    /**
    * Add styling to individual key on keyboard.
    * @param  {object} key Element of key.
    */
    var styleKey = function (key) {
        key.el.style.display = 'inline-block';
        key.el.style['-webkit-user-select'] = 'none';

        if (key.colour === 'white') {
            styleWhiteKey(key);
        } else {
            styleBlackKey(key);
        }
    };

    /**
    * Reset styles on keyboard container and list element.
    * @param {element} keyboard Keyboard container DOM element.
    */
    var styleKeyboard = function (keyboard) {
        var styleElement = function (el) {
            el.style.cursor = 'default';
            el.style.fontSize = '0px';
            el.style.height = settings.height + 'px';
            el.style.padding = 0;
            el.style.position = 'relative';
            el.style.listStyle = 'none';
            el.style.margin = 0;
            el.style.width = settings.width + 'px';
            el.style['-webkit-user-select'] = 'none';
        };

        styleElement(keyboard.container);
        styleElement(keyboard.el);
    };

    /**
    * Call user's mouseDown event.
    *
    * Starts the press with the pressed note. mouse_notes_seen remembers
    * every note switched on during the whole press so a note can never
    * receive a second note-on, while mouse_notes_on holds the notes that
    * are still sounding and therefore still need a note-off.
    */
    var mouseDown = function (element, callback) {
        if (element.tagName.toLowerCase() == 'li') {
            mouse_is_down = true;
            mouse_notes_on = [element.title];
            mouse_notes_seen = {};
            mouse_notes_seen[element.title] = true;
            lightenUp(element);
            callback(element.title, getFrequencyOfNote(element.title));
        }
    };

    /**
    * Call user's mouseUp event.
    *
    * Releases every note still held by this press, each exactly once;
    * the note that was switched on first is therefore guaranteed its
    * matching note-off even if the pointer was dragged around the
    * keyboard or released outside it.
    */
    var mouseUp = function (element, callback) {
        var note;

        if (!mouse_is_down || mouse_notes_on.length === 0) {
            return;
        }

        mouse_is_down = false;

        while (mouse_notes_on.length) {
            note = mouse_notes_on.pop();
            darkenDown(document.getElementById(note));
            callback(note, getFrequencyOfNote(note));
        }

        mouse_notes_seen = {};
    };

    /**
    * Call user's mouseDown if required.
    *
    * Fires only while the mouse button is held. Entering a note that was
    * already switched on during this press (e.g. the mouseover that
    * follows a mousedown on the same key, or dragging out of a key and
    * back into it) does nothing; entering a new note switches the
    * previously sounding note off and the new note on, supporting
    * glissando without ever repeating a note-on or dropping a note-off.
    *
    * @param {element}  element      DOM element under the pointer.
    * @param {function} downCallback User's note-down callback.
    * @param {function} upCallback   User's note-up callback.
    */
    var mouseOver = function (element, downCallback, upCallback) {
        var previous_note;

        if (mouse_is_down && element.tagName.toLowerCase() == 'li') {
            if (element.title in mouse_notes_seen) {
                // Already switched on during this press: do not retrigger.
                return;
            }

            previous_note = mouse_notes_on.pop();
            darkenDown(document.getElementById(previous_note));
            upCallback(previous_note, getFrequencyOfNote(previous_note));

            mouse_notes_on.push(element.title);
            mouse_notes_seen[element.title] = true;
            lightenUp(element);
            downCallback(element.title, getFrequencyOfNote(element.title));
        }
    };

    /**
    * Moving off a key while the button is held must not send a note-off:
    * notes are released either when the pointer enters another key or on
    * mouseUp (which also covers releasing the button outside the
    * keyboard), otherwise notes would get stuck.
    */
    var mouseOut = function (element, callback) {
        return;
    };

    /**
    * Create key DOM element.
    * @return {object} Key DOM element.
    */
    var createKey = function (key) {
        key.el = document.createElement('li');
        key.el.id = key.id;
        key.el.title = key.id;
        key.el.setAttribute('data-note-type', key.colour);

        styleKey(key);

        return key;
    };

    var getTotalWhiteKeys = function () {
        return settings.octaves * 7;
    };

    var createKeys = function () {
        var that = this,
            i,
            key,
            keys = [],
            note_counter = 0,
            octave_counter = settings.startOctave,
            total_white_keys = getTotalWhiteKeys();

        for (i = 0; i < total_white_keys; i++) {

            if (i % this.whiteNotes.length === 0) {
                note_counter = 0;
            }

            bizarre_note_counter = this.whiteNotes[note_counter];

            if ((bizarre_note_counter === 'C') && (i !== 0)) {
                octave_counter++;
            }

            key = createKey({
                colour: 'white',
                octave: octave_counter,
                width: getWhiteKeyWidth(total_white_keys),
                id: this.whiteNotes[note_counter] + octave_counter,
                noteNumber: i
            });

            keys.push(key.el);

            if (i !== total_white_keys - 1) {
                this.notesWithSharps.forEach(function (note, index) {
                    if (note === that.whiteNotes[note_counter]) {
                        key = createKey({
                            colour: 'black',
                            octave: octave_counter,
                            width: getWhiteKeyWidth(total_white_keys) / 2,
                            id: that.whiteNotes[note_counter] + '#' + octave_counter,
                            noteNumber: i
                        });

                        keys.push(key.el);
                    }
                });
            }
            note_counter++;
        }

        return keys;
    };

    var addKeysToKeyboard = function (keyboard) {
        keyboard.keys.forEach(function (key) {
            keyboard.el.appendChild(key);
        });
    };

    var setKeyPressOffset = function (sorted_white_notes) {
        settings.keyPressOffset = sorted_white_notes[0] === 'C' ? 0 : 1;
    };

    var createKeyboard = function () {
        var keyboard = {
            container: document.getElementById(settings.id),
            el: document.createElement('ul'),
            whiteNotes: orderNotes(['C', 'D', 'E', 'F', 'G', 'A', 'B']),
            notesWithSharps: orderNotes(['C', 'D', 'F', 'G', 'A']),
        };

        keyboard.keys = createKeys.call(keyboard);

        setKeyPressOffset(keyboard.whiteNotes);
        styleKeyboard(keyboard);

        // When the keyboard is rebuilt (e.g. after an octave change) drop the
        // previously generated key list; the event listeners live on the
        // container/window and therefore must not be registered again.
        while (keyboard.container.firstChild) {
            keyboard.container.removeChild(keyboard.container.firstChild);
        }

        // Add keys to keyboard, and keyboard to container.
        addKeysToKeyboard(keyboard);

        keyboard.container.appendChild(keyboard.el);

        return keyboard;
    };

    /**
     * Change the starting note (typically its octave) at runtime and rebuild
     * the keyboard. Notes already held down keep the note names captured at
     * their key-down time, so their key-up still releases the original note.
     * @param  {string} startNote New starting note, e.g. 'A4'.
     */
    var setStartNote = function (startNote) {
        if (typeof startNote !== 'string' || startNote.length < 2) {
            return;
        }

        settings.startNote = startNote;
        settings.startOctave = getOctaveOfNote(startNote);
        createKeyboard();
    };

    var getKeyPressed = function (keyCode) {
        return key_map[keyCode]
                .replace('l', parseInt(settings.startOctave, 10) + settings.keyPressOffset)
                .replace('u', (parseInt(settings.startOctave, 10) + settings.keyPressOffset + 1)
                .toString());
    };

    /**
     * Handle a keyboard key being pressed.
     * @param {object} key The keyboard event of the currently pressed key.
     * @param {callback} callback The user's noteDown function.
     */
    var keyboardDown = function (key, callback) {
        var key_pressed;

        // Repeated keydown events while the key is held must not send
        // another note-on.
        if (key.keyCode in keysDown) {
           return;
        }

       if (typeof key_map[key.keyCode] === 'undefined') {
            return;
       }

       // Capture the note name at press time so key-up releases the same
       // note even when the octave is changed while the key is held.
       key_pressed = getKeyPressed(key.keyCode);
       keysDown[key.keyCode] = key_pressed;

       // Call user's noteDown function.
       callback(key_pressed, getFrequencyOfNote(key_pressed));
       lightenUp(document.getElementById(key_pressed));
    };

    /**
     * Handle a keyboard key being released.
     * @param {element} key The DOM element of the key that was released.
     * @param {callback} callback The user's noteUp function.
     */
    var keyboardUp = function (key, callback) {
        var key_pressed = keysDown[key.keyCode];

        // Ignore key-ups without a matching key-down so no note-off is
        // ever emitted without a preceding note-on.
        if (typeof key_pressed === 'undefined') {
            return;
        }

        delete keysDown[key.keyCode];

        // Release the note captured at key-down time, never a note of the
        // same name from a different octave selected afterwards.
        callback(key_pressed, getFrequencyOfNote(key_pressed));
        darkenDown(document.getElementById(key_pressed));
    };

    /**
     * Add event listeners to keyboard.
     *
     * Listeners are attached to the container and the window only, so
     * rebuilding the keyboard's key elements never registers duplicates.
     * @param {element} keyboard_element
     */
    var addListeners = function (keyboard_element) {
        var that = this;

        // Key is pressed down on keyboard.
        globalWindow.addEventListener('keydown', function (key) {
            keyboardDown(key, that.keyDown);
        });

        // Key is released on keyboard.
        globalWindow.addEventListener('keyup', function (key) {
            keyboardUp(key, that.keyUp);
        });

        // Mouse is clicked down on keyboard element.
        keyboard_element.addEventListener('mousedown', function (event) {
            mouseDown(event.target, that.keyDown);
        });

        // Mouse is released over the keyboard element.
        keyboard_element.addEventListener('mouseup', function (event) {
            mouseUp(event.target, that.keyUp);
        });

        // Releasing the button anywhere (e.g. after dragging the pointer
        // outside the keyboard) must still send the pending note-off,
        // otherwise the note would hang and mouse_is_down would stay stuck.
        globalWindow.addEventListener('mouseup', function (event) {
            mouseUp(event.target, that.keyUp);
        });

        // Mouse is moved over keyboard element.
        keyboard_element.addEventListener('mouseover', function (event) {
            mouseOver(event.target, that.keyDown, that.keyUp);
        });

        // Moving off a key never triggers a note-off by itself; the note is
        // released on mouseup. The handler is kept for API compatibility.
        keyboard_element.addEventListener('mouseout', function (event) {
            mouseOut(event.target, that.keyUp);
        });

        // Device supports touch events.
        if ('ontouchstart' in document.documentElement) {
            keyboard_element.addEventListener('touchstart', function (event) {
                mouseDown(event.target, that.keyDown);
            });

            keyboard_element.addEventListener('touchend', function (event) {
                mouseUp(event.target, that.keyUp);
            });

            keyboard_element.addEventListener('touchleave', function (event) {
                mouseUp(event.target, that.keyUp);
            });

            keyboard_element.addEventListener('touchcancel', function (event) {
                mouseUp(event.target, that.keyUp);
            });
        }
    };

    /**
     * Qwerty Hancock constructor.
     * @param {object} settings Optional user settings.
     */
    var QwertyHancock = function (settings) {
        this.version = version;

        this.keyDown = function () {
            // Placeholder function.
        };

        this.keyUp = function () {
            // Placeholder function.
        };

        // Rebuild the keyboard for a new starting note/octave at runtime.
        this.setStartNote = function (startNote) {
            setStartNote(startNote);
        };

        init.call(this, settings);
    };

    if (typeof exports !== 'undefined') {
      if (typeof module !== 'undefined' && module.exports) {
        exports = module.exports = QwertyHancock;
      }
      exports.QwertyHancock = QwertyHancock;
    } else {
      root.QwertyHancock = QwertyHancock;
    }
})(this);
