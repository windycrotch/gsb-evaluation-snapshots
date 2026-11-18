# Harmony and the keyboard

**Files:** `src/audio/scales.js`, `src/core/keymap.js`

## The core idea

Keys are not notes, they are scale degrees. Degree 0 is the bottom-left key and
degrees increase left to right, bottom row upwards. Whatever scale is selected,
consecutive keys are consecutive degrees of it, so any combination of keys is
inside the harmony. You can mash the keyboard while a build runs and it will
still sound like music.

## Scales

All eight share the tonic **A**, so turning the SCALE knob is a mode change
rather than a key change. That's what makes the knob feel musical instead of
random — the melody you were playing keeps its centre of gravity.

| Name | Steps | Root | Mood tag |
| --- | --- | --- | --- |
| MAJOR | 0 2 4 5 7 9 11 | 45 (A2) | bright |
| MINOR | 0 2 3 5 7 8 10 | 45 (A2) | dark |
| DORIAN | 0 2 3 5 7 9 10 | 45 (A2) | cool |
| LYDIAN | 0 2 4 6 7 9 11 | 45 (A2) | dreamy |
| PENTA UP | 0 2 4 7 9 | 33 (A1) | bright |
| PENTA DOWN | 0 3 5 7 10 | 33 (A1) | dark |
| HIRAJOSHI | 0 2 3 7 8 | 33 (A1) | zen |
| BLUES | 0 3 5 6 7 10 | 33 (A1) | wild |

The `mood` tag is read by the pet, so scale character leaks into the creature's
behaviour.

`root` differs because 30 keys span a different number of octaves depending on
how many notes the scale has: a 7-note scale covers just over four octaves, a
5-note scale covers six. Seven-note scales start at A2 and top out near B6;
five- and six-note scales start an octave lower and reach into the sevenths,
where `pitchGain` in the engine quietly rolls them off.

When adding a scale, pick `root` so the top key stays at or below roughly MIDI
102 and the bottom key stays at or above roughly MIDI 33.

## Keyboard layout

Three rows of ten, mapped by physical `event.code` so non-QWERTY layouts get the
same physical arrangement:

```
row 0   Q W E R T Y U I O P     degrees 20–29   (highest)
row 1   A S D F G H J K L ;     degrees 10–19
row 2   Z X C V B N M , . /     degrees  0–9    (lowest)
```

`src/core/keymap.js` builds a `PADS` table once, holding each pad's row, column,
key code, display glyph and degree. Both the renderer and the hit zones read
from it, so there is exactly one definition of what a key means.

Keys whose degree is the tonic get a small accent dot, which makes the shape of
the current scale visible on the device.

The two kit presets in the `DRUMS` pack reinterpret this: they read the pitch
class of the note the keyboard produced and pick a drum from it, so the scale
decides which pieces land where instead of which notes play. See
[audio.md](audio.md).

## Velocity

The keyboard has no velocity, so `App.velocityFor` invents a plausible one:
a base around 0.79, an accent bonus after a rest longer than 0.7 s, a small
reduction for notes struck within 60 ms of each other (chords), and a divisor
that scales with the live voice count to keep dense playing from clipping.

Velocity feeds the voice, the screen shake, the spark burst size and the pet's
bounce, so it's doing visual work as well as musical work.

## Retuning on scale change

Changing scale releases everything currently held. Without this, a held key
would keep sounding a note from the old scale while its key now means something
else.
