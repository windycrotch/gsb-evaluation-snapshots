/**
 * The cue → pulse fold (src/core/pulse.ts), unit-tested: a batch of cues is
 * applied oldest first, a drum pulse keeps the strongest hit of the batch,
 * the chord shown is the last in time, late notes are skipped, calm motion
 * makes no flashes, and decay follows the real seconds passed.
 */
import { checker, load } from '../tools/load.mjs';

const { check, done } = checker();
const { makePulse, applyCues, decayPulse, chordHue } = await load('core/pulse');

const note = (time, voice, velocity) => ({ kind: 'note', time, voice, midi: 36, velocity });
const opts = { calm: false, padCarriesBeat: false };
const round = (x) => +x.toFixed(6);

// Several of a kind in one batch: the strongest hit wins, none is swallowed
{
  const pulse = makePulse(2, false);
  applyCues(pulse, [note(1.0, 'kick', 0.4), note(1.0, 'kick', 0.9), note(1.0, 'kick', 0.6)], opts);
  check('one batch, three kicks: the strongest hits', pulse.beat, 0.9);
}
{
  const pulse = makePulse(2, false);
  applyCues(pulse, [note(1.0, 'snare', 0.3), note(1.0, 'clap', 0.8), note(1.0, 'snare', 0.5)], opts);
  check('snare and clap share one pulse, strongest wins', pulse.snare, 0.8);
}
{
  const pulse = makePulse(2, false);
  applyCues(pulse, [note(1.0, 'tom', 1), note(1.0, 'lead', 0.7), note(1.0, 'arp', 0.9)], opts);
  check('a tom thumps softer than a kick', pulse.beat, 0.8);
  check('an arp note rings softer than a lead', pulse.note, 0.7);
}

// Time order, not arrival order: the last chord in time is the one shown
{
  const pulse = makePulse(2, false);
  const events = applyCues(
    pulse,
    [
      { kind: 'chord', time: 2, name: 'Gm', root: 43 },
      { kind: 'chord', time: 1, name: 'Cmaj7', root: 48 },
    ],
    opts,
  );
  check('chords come out in time order', events.map((e) => e.name), ['Cmaj7', 'Gm']);
}
{
  const pulse = makePulse(2, false);
  const events = applyCues(
    pulse,
    [
      { kind: 'bar', time: 3, section: 0, bar: 1 },
      { kind: 'section', time: 1, section: 0 },
      { kind: 'chord', time: 2, name: 'F', root: 41 },
    ],
    opts,
  );
  check('mixed cues keep time order', events.map((e) => e.kind), ['section', 'chord', 'bar']);
  check('bar and section cues pass through', events[2], { kind: 'bar', section: 0, bar: 1 });
}

// A note already well past is skipped, not thumped late
{
  const pulse = makePulse(2, false);
  applyCues(pulse, [note(1.0, 'kick', 1)], { ...opts, late: () => true });
  check('a late kick makes no pulse', pulse.beat, 0);
}

// Without drums the pad carries the pulse; with drums it does not
{
  const pulse = makePulse(2, false);
  applyCues(pulse, [note(1.0, 'pad', 1)], { ...opts, padCarriesBeat: true });
  check('pad carries the beat without drums', pulse.beat, 0.35);
  const withDrums = makePulse(2, false);
  applyCues(withDrums, [note(1.0, 'pad', 1)], opts);
  check('pad stays quiet with drums', withDrums.beat, 0);
}

// Calm motion: a crash makes no flash, as it never has
{
  const pulse = makePulse(2, false);
  applyCues(pulse, [note(1.0, 'crash', 1)], opts);
  check('a crash flashes', pulse.flash, 1);
  const calm = makePulse(2, true);
  applyCues(calm, [note(1.0, 'crash', 1)], { ...opts, calm: true });
  check('calm motion: no flash', calm.flash, 0);
}

// Decay follows the real seconds passed, a long frame included
{
  const pulse = makePulse(2, false);
  pulse.beat = pulse.snare = pulse.note = pulse.flash = 1;
  decayPulse(pulse, 1.5);
  check('a 1.5 s frame: the flash fades by 1.5 s', round(pulse.flash), round(Math.exp(-4 * 1.5)));
  check('a 1.5 s frame: the beat fades by 1.5 s', round(pulse.beat), round(Math.exp(-7 * 1.5)));
  check('a 1.5 s frame: the snare fades by 1.5 s', round(pulse.snare), round(Math.exp(-9 * 1.5)));
  check('a 1.5 s frame: the note fades by 1.5 s', round(pulse.note), round(Math.exp(-5 * 1.5)));
}

// The chord's pull on the palette, around the circle of fifths
check('a fifth apart shifts the colours a little', round(chordHue(48 + 7) - chordHue(48)), round(0.35 / 12));

done('pulse');
