# Style guide

The rules that keep DeskSynth feeling like one object. When something new looks
wrong, it's usually breaking one of these.

## Pixel rules

- **Integer everything.** Every coordinate is rounded before it's drawn. Motion
  happens in whole pixels; nothing is anti-aliased, ever.
- **Dither instead of blend** for soft edges. `bayer(x, y)` thresholds against
  the screen-space grid, so gradients shimmer correctly when things move.
- **Light is additive.** Glows use `p.add`, which brightens existing pixels
  rather than laying a wash over them. Anything that represents emitted light —
  LEDs, antenna tips, knob indicator, screen spill — should use it.
- **One outline colour.** The case is outlined in `SHELL.ink`; the pet is
  outlined in the screen's `mid`. Don't introduce a third outline treatment.

## Palette

The case is cool desaturated grey-blue, deliberately quiet, so the screen is the
only saturated thing on your desktop. Keys are warm cream — the one warm element,
which is what makes them read as pressable.

Every accent on the device — knob tick, indicator, position dots, LEDs, key
glow, tonic markers, info text, power LED, screen spill — comes from the current
preset's single `accent` colour via `screenTheme`. Never hard-code an accent.
Adding a preset should recolour the whole device with one hex value.

`SHELL.red` and `SHELL.amber` are the only exceptions: red for the clipping LEDs
and the close button, amber for the active pin. They mean "warning" and "on".

## Typography

One font, 5 px tall. Labels are uppercase. Case labels use `SHELL.creamLo`,
screen text uses theme colours by importance: `hi` for the live value, `mid` for
context, `dim` for decoration.

## Juice

Every input gets feedback on at least three channels. Pressing a key produces:
the key physically dropping, an accent tint, a glow ring, a spark burst, a
floating note name, a screen ripple, a shake impulse, the VU meter jumping, the
pet's bounce and mouth opening, the header note name lighting up, and the sound
itself. That density is the point.

Guidelines:

- **Physical before decorative.** Make the object move first (drop, squash,
  bounce), then add particles. Particles alone feel like a screensaver.
- **Springs, not tweens,** for anything the pet does. Kicked springs overshoot
  and settle, which reads as alive.
- **Shake the picture, not the frame.** The screen contents vibrate inside the
  bezel; the case never moves. Shake is clamped and decays fast.
- **Nothing is ever fully still.** Idle still has breathing, blinking, drifting
  gaze, twinkling stars, the scrolling floor and the pulsing power LED.
- **Reward, don't punish.** Fast playing makes the pet sweat and go cross-eyed,
  which is funny; nothing ever scolds the player or degrades the sound.
- **A control that does two things must show both.** The sound knob turns for
  packs and clicks for presets, so it has two dot rows: the pack row full width,
  the preset row finer and below it. If you can't show the second value, the
  control shouldn't have one.
- **One gesture, one light.** A click gets the press rim and its shockwave; it
  does not also get the detent glow. Stacking two light effects on the same
  gesture saturates to a solid band and stops reading as light.

## Sound

- Percussive voices ring out after release. A toy synth that chokes its own
  bells feels cheap.
- Every parameter change ramps. No stepped gain changes, ever.
- High notes roll off automatically so no scale or preset can produce something
  painful.
- UI actions have their own small sounds (knob detent, sustain, petting) at a
  much lower level than notes. A knob click ticks lower than a detent, because a
  button should feel heavier than a notch.
- **Presets are balanced against each other, not in isolation.** Switching sounds
  must never change the perceived volume of the instrument. Use the audit rather
  than your ears one preset at a time.
- **Reach past the oscillator shapes.** A pack earns its place when each sound
  uses a different mechanism — folding, formants, resonators, quantization — not
  the same voice with a different filter setting.

## Copy

Terse, uppercase, and never twee. `HELLO`, `SHHH`, `KEYS PLAY - ARROWS TURN
KNOBS`. The creature is expressive but silent — it never speaks in words.
