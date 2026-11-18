// Every key on the keyboard is a scale degree, so nothing can ever sound wrong.
// All scales share the tonic A; switching the knob is a mode change, not a key
// change, which makes the knob feel musical instead of random.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const SCALES = [
  { id: 'major', name: 'MAJOR', steps: [0, 2, 4, 5, 7, 9, 11], root: 45, mood: 'bright' },
  { id: 'minor', name: 'MINOR', steps: [0, 2, 3, 5, 7, 8, 10], root: 45, mood: 'dark' },
  { id: 'dorian', name: 'DORIAN', steps: [0, 2, 3, 5, 7, 9, 10], root: 45, mood: 'cool' },
  { id: 'lydian', name: 'LYDIAN', steps: [0, 2, 4, 6, 7, 9, 11], root: 45, mood: 'dreamy' },
  { id: 'penta', name: 'PENTA UP', steps: [0, 2, 4, 7, 9], root: 33, mood: 'bright' },
  { id: 'pentam', name: 'PENTA DOWN', steps: [0, 3, 5, 7, 10], root: 33, mood: 'dark' },
  { id: 'hira', name: 'HIRAJOSHI', steps: [0, 2, 3, 7, 8], root: 33, mood: 'zen' },
  { id: 'blues', name: 'BLUES', steps: [0, 3, 5, 6, 7, 10], root: 33, mood: 'wild' },
];

/** Scale degree (0 = lowest key) to MIDI note number. */
export function degreeToMidi(scale, degree) {
  const n = scale.steps.length;
  const oct = Math.floor(degree / n);
  const idx = ((degree % n) + n) % n;
  return scale.root + oct * 12 + scale.steps[idx];
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function noteName(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12];
}

export function noteLabel(midi) {
  return `${noteName(midi)}${Math.floor(midi / 12) - 1}`;
}

/** Degree within the current octave, used for "is this the tonic" feedback. */
export function degreeIndex(scale, degree) {
  const n = scale.steps.length;
  return ((degree % n) + n) % n;
}
