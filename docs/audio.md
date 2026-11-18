# Audio

**Files:** `src/audio/engine.js`, `src/audio/presets.js`, `src/audio/packs/*.js`,
`src/audio/voice.js`, `src/audio/dsp.js`, `src/audio/audit.js`

Everything is synthesized at runtime. There are no samples, so the whole app is
a few hundred kilobytes of source.

## The graph

```
voice ─┬─ dry ─────────────────────────────────┐
       ├─ revSend ─ convolver ─ revReturn ─────┤
       └─ delSend ─ delay ⇄ lowpass ⇄ feedback ┤
                          └─ delReturn ────────┤
                                               ▼
                        sum ─ compressor ─ softclip ─ highpass ─ master ─ analyser ─ out
```

All voices connect to a shared `bus`, and the send levels are properties of the
current preset rather than of individual voices — only one preset is active at a
time, so per-voice sends would be wasted work. `applyPreset` ramps the send
gains and the bus gain with `setTargetAtTime`, so switching sounds mid-phrase
doesn't click. A preset can also set `delayTime` to move the delay away from the
default 0.27 s; that ramps too, so the tail bends rather than jumps.

The tail of the chain is doing real work: the compressor glues chords together,
the `tanh` waveshaper catches anything that still peaks, and the highpass at
28 Hz keeps DC out of the low pentatonic notes.

The reverb impulse response is generated in `makeImpulse` — exponentially
decaying noise with a one-pole lowpass applied as it's written, so the tail
darkens as it fades.

The analyser (`fftSize: 256`) feeds both the on-screen oscilloscope and the RMS
level that drives the VU meter, the screen glow, and the pet's energy.

## Voice lifecycle

`src/audio/voice.js` owns the two shapes a voice can take. Both are objects with
`release(t)` and `kill(t)`.

**Ringing voices** (`ringVoice`) ignore key release and let their own envelope
finish, with the oscillator stop time scheduled at build time. Bells, plucks,
drums and marimbas behave like real instruments — hammering the keys sounds
right instead of choked. The engine schedules a timer to drop them from the
voice map.

**Held voices** (`heldVoice`) sustain until release, then ramp down over the
preset's release time.

`Engine.noteOn` is keyed by an arbitrary id (the app uses `k<padIndex>`), so
re-pressing a key kills its previous voice first. Polyphony is capped at 16, or
at the preset's own `poly` when it sets one — the big pads run eight or six
voices because forty detuned oscillators are not worth the CPU. Voice stealing
drops ringing voices before held ones.

Sustain moves released ids into a `sustained` set instead of freeing them;
turning sustain off releases the whole set.

`pitchGain` rolls high notes off above MIDI 72 (about −6 dB per two octaves) so
the top of a pentatonic keyboard doesn't bite.

`voice.js` also carries the transient generators the percussive presets share:
`click` (a filtered impulse), `burst` (a windowed slice of the noise buffer
through a filter that can sweep) and `blip` (a short pitched ping).

## DSP toolkit

`dsp.js` is the primitive layer. Beyond the obvious `osc`/`gain`/`filter`
wrappers:

| Helper | What it's for |
| --- | --- |
| `pulseWave`, `harmonicWave` | Cached `PeriodicWave`s — fixed duty pulses, drawbar-style additive spectra |
| `noise`, `noiseBuffer` | One shared second of white noise, looped or sliced |
| `constant` | A `ConstantSourceNode`, for DC offsets and modulation floors |
| `modulate` | An LFO wired to one param or a whole array of them |
| `shaper` + `driveCurve` / `foldCurve` / `crushCurve` | Saturation, wavefolding, bit reduction |
| `comb` | A short feedback delay, i.e. a tuned resonator |
| `formants`, `VOWELS` | Three parallel bandpasses at vowel frequencies |
| `pluckBuffer` | Karplus–Strong rendered offline into a buffer and cached |

Two of these exist because of Web Audio's limits rather than by preference.
`DelayNode` can't run short enough or feed back tightly enough for a plucked
string at audio rate, so `pluckBuffer` runs the classic delay-line algorithm in
plain JS and hands back an `AudioBuffer`. And a `PeriodicWave` has its duty
cycle baked in at construction, so real PWM is a sawtooth plus a moving DC
offset sliced by a hard shaper (see `LEADS/PWM CRY`).

`fadeOut` anchors its ramp with `setValueAtTime(param.value, now)` before the
exponential. Without that anchor, a gain that has never been automated
interpolates from the start of the context — which is silence, so the release
chops instead of fading.

## Sound packs

48 presets in eight packs. The knob picks the pack, clicking the knob steps
through the sounds inside it.

| Pack | Idea |
| --- | --- |
| `CLASSIC` | The six voices DeskSynth shipped with: `GLASSBELL`, `PLUCK`, `MARIMBA`, `CHIPTUNE`, `ORGANIC`, `VAPOR` |
| `LEADS` | Bright and moving: `HYPERSAW`, `SYNCSAW`, `PWM CRY`, `FM BRASS`, `VOWEL`, `SLIDE` |
| `BASS` | Everything under 400 Hz: `SUB DROP`, `REESE`, `ACID`, `GROWL`, `SLAP`, `DONK` |
| `PADS` | Slow, never static: `WARMTH`, `CHOIR`, `GLACIER`, `DRONE`, `SHIMMER`, `TAPE` |
| `EXOTIC` | Struck metal, wood and air: `GAMELAN`, `SITAR`, `KALIMBA`, `HANG`, `BOWL`, `SHAKU` |
| `DRUMS` | `808 KIT`, `909 KIT`, `TOMS`, `METAL`, `BLOCKS`, `GLITCH` |
| `RETRO` | Specific silicon: `NES`, `SID`, `OPL`, `GAMEBOY`, `ARCADE`, `ATARI` |
| `MOTION` | One key press is an event, not a note: `GATE`, `ARP`, `ECHO`, `SPIN`, `BUBBLE`, `RIPPLE` |

Three of these packs need a note about how they work.

**DRUMS.** The two kit presets ignore pitch and map each *pitch class* to a
different piece, so a scale hands you a kit instead of thirty tuned copies of one
drum. The `KIT` table (pitch class → piece) is arranged so every one of the eight
scales lands on a kick, a snare or clap, and a hat. The other four presets do
track pitch.

**MOTION.** A voice can't schedule anything after it starts — there is no
callback into a running voice — so every figure here is written into the timeline
at build time and then plays itself out. `ARP` schedules four stabs, `ECHO` four
taps climbing an octave each, `BUBBLE` a stepped sample-and-hold on cutoff and
octave, `RIPPLE` sixteen grains scattered up the harmonic series. `GATE` and
`SPIN` are the exception: an LFO chops one and two sweeping combs rotate the
other, so those two do follow the key.

**RETRO.** Each preset leans on the limitation that gave the original chip its
character: fixed duty cycles, ring modulation, two-operator FM, four-bit volume
steps, integer frequency dividers. `ATARI` keeps its main oscillator in tune and
puts the quantized divider on a second one, because quantizing the actual pitch
plays audibly wrong notes.

Every preset carries an `accent` colour that drives the whole screen palette and
every accent on the device, a `mood` tag that decides how hard the pet reacts to
the change, and its `reverb`/`delay` send amounts.

## Adding a preset

Drop it into one of the pack arrays in `src/audio/packs/`, or add a new pack file
and list it in `PACKS` in `presets.js`. `build(ctx, { midi, freq, vel, t0, out })`
must create its nodes, connect them to `out`, start them, and return the result
of `ringVoice` or `heldVoice`. Knob positions, the screen theme and every accent
colour follow from the arrays and the `accent` field — no other file needs
touching.

Optional fields: `poly` to cap voices for an expensive sound, `delayTime` to
retune the shared delay.

Keep `gain` in the range the audit reports as balanced, and remember the
compressor should be catching peaks rather than working full time.

## Auditing levels

48 presets cannot be balanced by ear one at a time. `src/audio/audit.js` renders
every one of them in an `OfflineAudioContext` across six notes (MIDI 36 to 71),
releasing partway through, and reports peak and sustained level:

```bash
DESKSYNTH_SHOT_DELAY=25000 node tools/shots.mjs audit
```

It prints one line per preset. Anything above 1.25 peak is `HOT`, anything below
0.15 is `QUIET`, and a preset that throws is reported with its error. The
thresholds are set from `CLASSIC/PLUCK`, the loudest of the original sounds. The
audit is also the fastest way to catch a preset that builds a node graph but
never makes a sound.

It runs in the renderer and reports through `console.warn`, which `main.js`
forwards to the terminal — so it needs the shot harness (or a live window with
devtools open) rather than plain `node`. The delay has to outlast 288 offline
renders.

## UI sound

`Engine.tick` plays a short filtered noise burst plus a triangle blip for knob
detents, sustain, and petting. Its one argument is pitch, so a knob *click* ticks
lower than a detent: a button should feel heavier than a notch. Scale changes
also trigger a
three-note arpeggio of the new scale (`App.audition`), which doubles as a
preview and lights up the corresponding keys.
