# DeskSynth documentation

One document per system. Start with [architecture](architecture.md) for the map,
then read whichever system you're about to touch.

| Document | Covers |
| --- | --- |
| [architecture.md](architecture.md) | Process model, module map, the frame loop, how state flows |
| [audio.md](audio.md) | Web Audio graph, voice lifecycle, the DSP toolkit, the eight sound packs |
| [harmony.md](harmony.md) | Scales, degree→MIDI mapping, keyboard layout, velocity |
| [pet.md](pet.md) | The creature: mood state machine, poses, reactions |
| [rendering.md](rendering.md) | Pixel buffer, bitmap font, layout system, device chrome |
| [style.md](style.md) | Visual and audio style guide — the rules that keep it coherent |
| [development.md](development.md) | Running it, the screenshot harness, known gotchas |

## The one-paragraph version

DeskSynth is an Electron app that draws a pixel-art pocket synth into a single
`196 × 166` logical-pixel buffer and scales it up with nearest-neighbour. Every
keyboard key is a degree of the currently selected scale, so nothing you play
can be wrong. Two knobs pick the scale and the sound: the sound knob turns to
choose one of eight packs and clicks to step through the six voices inside it. A
creature lives in the display and reacts to how you play.

## Keeping these current

`AGENTS.md` in the repo root is the short version: if you change a system,
update its document in the same change. Each document lists the files it
describes at the top, so the mapping from code to doc is explicit.
