/**
 * The cue → pulse fold: what the picture feels of the music. The audio engine
 * (src/app/audio.ts) writes cues on the audio clock; each frame the page hands
 * the due ones here, and the pulses they make — a kick, a snare, a chord — go
 * to the renderer, which turns them into motion and colour.
 *
 * What this fold promises, and tests/pulse.mjs and tests/cues.mjs hold it to:
 *
 * - Cues are applied oldest first, however they arrive.
 * - Several of a kind in one batch do not swallow each other: a drum pulse
 *   keeps the strongest hit of the batch, and the chord shown is the last in
 *   time.
 * - Pulses decay by the real seconds passed, never by a frame time a renderer
 *   may have clamped — a flash faded by a clamped time would glow on long
 *   after its beat.
 * - Calm motion makes no flashes, as it always has.
 */
import type { Voice } from './music';

/** A cue as the audio engine writes it; src/app/audio.ts's Cue is assignable to this. */
export type PulseCue =
  | { kind: 'note'; time: number; voice: Voice; midi: number; velocity: number }
  | { kind: 'chord'; time: number; name: string; root: number }
  | { kind: 'section'; time: number; section: number }
  | { kind: 'bar'; time: number; section: number; bar: number };

/** What one frame of the picture reads; the renderer's uniforms come from this. */
export interface Pulse {
  /** Beats per second of the music now. */
  beatsPerSecond: number;
  /** 0..1, decaying: the kick, the snare/clap, melody notes, a crash. */
  beat: number;
  snare: number;
  note: number;
  flash: number;
  /** 0..1, smoothed: how busy the music is. */
  energy: number;
  level: number;
  /** Palette offset from the chord now playing. */
  chordHue: number;
  calm: boolean;
}

export const makePulse = (beatsPerSecond: number, calm: boolean): Pulse => ({
  beatsPerSecond,
  beat: 0,
  snare: 0,
  note: 0,
  flash: 0,
  energy: 0.4,
  level: 0,
  chordHue: 0,
  calm,
});

/** The chord, section and bar cues of a batch, in time order, for the page to show and act on. */
export type CueEvent =
  | { kind: 'chord'; name: string; root: number }
  | { kind: 'section'; section: number }
  | { kind: 'bar'; section: number; bar: number };

export interface ApplyOptions {
  /** Calm motion: a crash makes no flash. */
  calm: boolean;
  /** Without drums, the pad's chords carry the pulse. */
  padCarriesBeat: boolean;
  /** A note this late is over before it could show: skipped, not thumped late. */
  late?: (cue: PulseCue) => boolean;
}

/**
 * Folds one batch of due cues into `pulse`, oldest first, and returns the
 * batch's chord, section and bar cues in that same order. Drum pulses take
 * the strongest hit of the batch; a later chord replaces an earlier one.
 */
export function applyCues(pulse: Pulse, cues: readonly PulseCue[], options: ApplyOptions): CueEvent[] {
  const late = options.late ?? (() => false);
  const events: CueEvent[] = [];
  const ordered = [...cues].sort((a, b) => a.time - b.time);
  for (const cue of ordered) {
    switch (cue.kind) {
      case 'note': {
        if (late(cue)) break;
        const v = cue.velocity;
        if (cue.voice === 'kick') pulse.beat = Math.max(pulse.beat, v);
        else if (cue.voice === 'snare' || cue.voice === 'clap') pulse.snare = Math.max(pulse.snare, v);
        else if (cue.voice === 'tom') pulse.beat = Math.max(pulse.beat, v * 0.8);
        else if (cue.voice === 'crash') pulse.flash = options.calm ? 0 : 1;
        else if (cue.voice === 'lead' || cue.voice === 'arp') pulse.note = Math.max(pulse.note, v * (cue.voice === 'lead' ? 1 : 0.5));
        else if (cue.voice === 'pad' && options.padCarriesBeat) pulse.beat = Math.max(pulse.beat, v * 0.35);
        break;
      }
      case 'chord':
        events.push({ kind: 'chord', name: cue.name, root: cue.root });
        break;
      case 'section':
        events.push({ kind: 'section', section: cue.section });
        break;
      case 'bar':
        events.push({ kind: 'bar', section: cue.section, bar: cue.bar });
        break;
    }
  }
  return events;
}

/**
 * The palette offset a chord pulls the colours toward: around the circle of
 * fifths, chords a fifth apart shift the colours a little, distant ones more.
 */
export const chordHue = (root: number): number => (((root * 7) % 12) / 12) * 0.35;

/**
 * Decays the pulses by `dt` real seconds. This must be given the time that
 * truly passed: a renderer may clamp a long frame for its own clocks, but a
 * flash faded by a clamped time would glow on long after its beat.
 */
export function decayPulse(pulse: Pulse, dt: number): void {
  pulse.beat *= Math.exp(-dt * 7);
  pulse.snare *= Math.exp(-dt * 9);
  pulse.note *= Math.exp(-dt * 5);
  pulse.flash *= Math.exp(-dt * 4);
}
