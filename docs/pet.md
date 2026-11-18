# The pet

**Files:** `src/core/pet.js`, `src/render/face.js`

The creature in the display is the reason the thing is fun to leave running.
It's split in two on purpose: `Pet` decides *how it feels* and knows nothing
about pixels; `face.js` decides *how that looks* and knows nothing about music.

## What it watches

`Pet.onNote` receives every note and maintains:

- **Note density** — timestamps in a rolling one-second window, smoothed into
  `intensity`
- **Combo** — consecutive notes with gaps under 0.9 s
- **Chords** — notes landing within 90 ms of each other
- **Repeats** — the same degree played over and over
- **Melodic direction** — a running rising/falling counter
- **Intervals** — octaves and fifths raise affection and can throw a heart
- **Hold time** — how long any voice has been alive
- **Idle time**, and how long the window has been unfocused

`Pet.update` also takes the live audio level, which becomes `energy` and drives
anything that should breathe with the sound.

Affection is a slow stat: it creeps up when you play well or pet the creature,
decays gently over time, and shows as blush and as the hearts in the screen
header.

## Moods

`pickMood` is a priority ladder, checked top to bottom each frame:

| Mood | Trigger |
| --- | --- |
| `asleep` | Unfocused for 9 s, or idle for 52 s |
| `loved` | Recently petted |
| `shocked` | Just after a scale or preset change |
| `dizzy` | Sustained very high note density |
| `strained` | High note density |
| `ecstatic` | Three or more notes within the chord window |
| `annoyed` | Same key six times in a row |
| `singing` | A note held over 1.3 s with audible level |
| `playing` | A note within the last 0.45 s |
| `proud` | Just finished a combo of 8 or more |
| `sleepy` / `curious` | Idle over 22 s / over 6 s |
| `idle` | Default |

`expression()` turns the mood into a flat pose: eye shape, mouth shape, brow
angle, blush, gaze, blink phase, bob, squash, lean, and the transient overlays
(sweat, zzz, glitch). Everything numeric is smoothed — gaze eases towards a
target, and bob, squash and lean are critically-damped springs kicked by note
velocity, so hits produce a physical bounce rather than a jump.

Blinking runs on its own timer with an occasional double-blink.

## Rendering the face

`drawFace` places the pet at `area.cx / area.cy` with a ground shadow on the
horizon that shrinks as it hovers. The body is a filled rounded blob with a
bright outline, a dithered top-left highlight and a darker bottom edge. Two
antennae sway with the audio level and their tips glow additively.

Eye shapes: `normal`, `wide`, `happy`, `closed`, `sleepy`, `star`, `heart`,
`spiral`, `angry`, `shock`. Mouth shapes: `neutral`, `smallSmile`, `smile`,
`grin`, `o`, `bigO`, `gasp`, `wave`, `wobble`, `cat`, `frown`, `sleep`, `flat`.
Blink is applied as an eyelid drawn in the body colour over the top of the eye,
so it works with any shape.

Emotes (`note`, `heart`, `star`, `bolt`, `question`, `bang`) are queued by
`Pet.emote`, drained by the app each frame, and spawned as particles beside the
head rather than over it, so the face stays readable.

## Reacting to the sound

`onScaleChange` and `onPresetChange` both read the `mood` tag off the thing that
changed — the scale's tag, or the preset's. A calm, zen, chill or dreamy preset
lands softly: half the glitch, a lighter squash, and a music note instead of a
lightning bolt. A drum kit or an acid bass jolts the creature. That tag is the
only channel through which the character of a sound reaches the pet.

## Adding a reaction

1. Detect the condition in `onNote` or `update` and store it as state.
2. Add a case to `pickMood` at the right priority.
3. Add a case to `expression()` returning eye/mouth/brow/overlay values.
4. If it needs a new eye or mouth shape, add it to `drawEye` or `drawMouth`.

Check it with the screenshot harness, which can pin any mood:

```bash
node tools/shots.mjs mood:yourmood
```
