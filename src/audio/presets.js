// The sound library, grouped into packs. The SOUND knob selects the pack;
// clicking it steps through the presets inside.
//
// A preset is:
//   { id, name, accent, mood, reverb, delay, gain, delayTime?, poly?, build() }
//
// `build(ctx, { midi, freq, vel, t0, out })` creates its nodes, connects them to
// `out`, starts them, and returns `ringVoice(...)` or `heldVoice(...)` from
// `voice.js`. Everything else — the knob positions, the screen palette, every
// accent on the device — follows from the arrays below and each preset's single
// `accent` colour.

import { BASS } from './packs/bass.js';
import { CLASSIC } from './packs/classic.js';
import { DRUMS } from './packs/drums.js';
import { EXOTIC } from './packs/exotic.js';
import { LEADS } from './packs/leads.js';
import { MOTION } from './packs/motion.js';
import { PADS_PACK } from './packs/pads.js';
import { RETRO } from './packs/retro.js';

// Knob order. Familiar first, weirdest last.
export const PACKS = [CLASSIC, LEADS, BASS, PADS_PACK, EXOTIC, DRUMS, RETRO, MOTION];
