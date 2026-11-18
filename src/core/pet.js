// The little creature in the display. It watches what you play and turns it
// into an expression, a pose, and the occasional thought bubble.

const CHORD_WINDOW = 0.09;
const COMBO_GAP = 0.9;

function approach(cur, target, rate, dt) {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

function rand(a, b) {
  return a + Math.random() * (b - a);
}

class Spring {
  constructor(k = 180, damp = 14) {
    this.x = 0;
    this.v = 0;
    this.k = k;
    this.damp = damp;
  }

  kick(amount) {
    this.v += amount;
  }

  update(dt) {
    const steps = Math.max(1, Math.ceil(dt / 0.008));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.v += (-this.k * this.x - this.damp * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}

export class Pet {
  constructor() {
    this.t = 0;
    this.idle = 0;
    this.focused = true;
    this.unfocusedFor = 0;

    this.recent = [];
    this.lastNoteAt = -99;
    this.lastMidi = null;
    this.lastDegree = null;
    this.repeat = 0;
    this.combo = 0;
    this.bestCombo = 0;
    this.rising = 0;
    this.chordCount = 0;
    this.chordAt = -99;

    this.intensity = 0;
    this.energy = 0;
    this.affection = 0.25;
    this.wonder = 0;

    this.gaze = { x: 0, y: 0 };
    this.gazeTarget = { x: 0, y: 0 };
    this.nextSaccade = 2;

    this.blink = 0;
    this.blinkTimer = rand(1.5, 4);
    this.blinkQueue = 0;

    this.bob = new Spring(220, 13);
    this.squash = new Spring(300, 12);
    this.lean = new Spring(120, 11);

    this.mood = 'idle';
    this.moodHold = 0;
    this.flash = 0;
    this.glitch = 0;
    this.shock = 0;
    this.pet = 0;
    this.hold = 0;

    this.emotes = [];
    this.notesPlayed = 0;
  }

  // ---- events -------------------------------------------------------------

  onNote({ midi, degree, velocity = 0.8, isTonic = false, pitchNorm = 0.5 }) {
    const t = this.t;
    this.notesPlayed++;
    this.recent.push(t);
    if (this.recent.length > 48) this.recent.shift();

    if (t - this.chordAt < CHORD_WINDOW) this.chordCount++;
    else {
      this.chordAt = t;
      this.chordCount = 1;
    }

    if (t - this.lastNoteAt < COMBO_GAP) this.combo++;
    else this.combo = 1;
    this.bestCombo = Math.max(this.bestCombo, this.combo);

    if (this.lastDegree === degree) this.repeat++;
    else this.repeat = 0;

    if (this.lastMidi != null) {
      const interval = Math.abs(midi - this.lastMidi);
      if (interval > 0 && (interval % 12 === 0 || interval % 12 === 7)) {
        this.affection = Math.min(1, this.affection + 0.06);
        if (Math.random() < 0.55) this.emote('heart');
      }
      if (midi > this.lastMidi) this.rising = Math.max(0, this.rising) + 1;
      else if (midi < this.lastMidi) this.rising = Math.min(0, this.rising) - 1;
    }

    if (this.chordCount === 3) {
      this.emote('star');
      this.affection = Math.min(1, this.affection + 0.1);
    }
    if (this.combo === 12 || this.combo === 24 || this.combo === 40) this.emote('star');
    if (isTonic && Math.random() < 0.3) this.emote('note');
    if (Math.random() < 0.22) this.emote('note');

    this.lastNoteAt = t;
    this.lastMidi = midi;
    this.lastDegree = degree;
    this.idle = 0;
    this.hold = 0;

    const punch = 0.35 + velocity * 0.75;
    this.bob.kick(-190 * punch);
    this.squash.kick(-150 * punch);
    this.lean.kick((pitchNorm - 0.5) * 220);
    this.gazeTarget.x = (pitchNorm - 0.5) * 2.2;
    this.gazeTarget.y = -0.45 + (1 - pitchNorm) * 1.1;
    this.nextSaccade = rand(0.35, 0.8);
    this.affection = Math.min(1, this.affection + 0.006);
  }

  onScaleChange(scale) {
    this.shock = 1;
    this.wonder = 1;
    this.emote(scale.mood === 'dark' ? 'note' : 'star');
    this.gazeTarget = { x: rand(-1, 1), y: -1 };
    this.bob.kick(-120);
  }

  onPresetChange(preset) {
    // The preset's own mood tag decides how hard the change lands, so switching
    // to a pad doesn't jolt the creature the way switching to a drum kit does.
    const mood = preset?.mood;
    const gentle = mood === 'calm' || mood === 'zen' || mood === 'chill' || mood === 'dreamy';
    this.glitch = gentle ? 0.5 : 1;
    this.shock = gentle ? 0.45 : 0.8;
    this.emote(mood === 'happy' ? 'star' : gentle ? 'note' : 'bolt');
    this.squash.kick(gentle ? -70 : -120);
  }

  onPet() {
    this.pet = 1;
    this.affection = Math.min(1, this.affection + 0.16);
    this.idle = 0;
    this.bob.kick(-80);
    if (Math.random() < 0.8) this.emote('heart');
  }

  emote(kind) {
    if (this.emotes.length > 6) return;
    this.emotes.push({ kind, spread: rand(-1, 1) });
  }

  takeEmotes() {
    if (!this.emotes.length) return null;
    const out = this.emotes;
    this.emotes = [];
    return out;
  }

  // ---- per-frame ----------------------------------------------------------

  update(dt, { level = 0, voices = 0, focused = true } = {}) {
    this.t += dt;
    const t = this.t;
    this.focused = focused;
    this.unfocusedFor = focused ? 0 : this.unfocusedFor + dt;

    while (this.recent.length && t - this.recent[0] > 1) this.recent.shift();
    const nps = this.recent.length;
    this.intensity = approach(this.intensity, Math.min(1, nps / 9), 7, dt);
    this.energy = approach(this.energy, Math.min(1, level * 3.4), voices > 0 ? 16 : 6, dt);

    if (voices > 0) this.hold += dt;
    this.idle = voices > 0 || t - this.lastNoteAt < 0.35 ? 0 : this.idle + dt;

    this.flash = Math.max(0, this.flash - dt * 4);
    this.glitch = Math.max(0, this.glitch - dt * 2.2);
    this.shock = Math.max(0, this.shock - dt * 1.7);
    this.pet = Math.max(0, this.pet - dt * 0.9);
    this.wonder = Math.max(0, this.wonder - dt * 0.5);
    this.affection = Math.max(0, this.affection - dt * 0.012);
    if (t - this.lastNoteAt > COMBO_GAP && this.combo) {
      this.lastCombo = this.combo;
      this.lastComboAt = t;
      this.combo = 0;
      this.rising = 0;
    }

    this.mood = this.pickMood();
    this.updateGaze(dt);
    this.updateBlink(dt);
    this.bob.update(dt);
    this.squash.update(dt);
    this.lean.update(dt);
  }

  pickMood() {
    const t = this.t;
    const playing = t - this.lastNoteAt < 0.45;
    if (!this.focused && this.unfocusedFor > 9) return 'asleep';
    if (this.idle > 52) return 'asleep';
    if (this.pet > 0.15) return 'loved';
    if (this.shock > 0.55) return 'shocked';
    if (this.intensity > 0.92) return 'dizzy';
    if (this.intensity > 0.66) return 'strained';
    if (this.chordCount >= 3 && t - this.chordAt < 1.1) return 'ecstatic';
    if (this.repeat >= 6) return 'annoyed';
    if (this.hold > 1.3 && this.energy > 0.12) return 'singing';
    if (playing) return 'playing';
    if (this.lastComboAt && t - this.lastComboAt < 1.6 && (this.lastCombo ?? 0) >= 8) return 'proud';
    if (this.idle > 22) return 'sleepy';
    if (this.idle > 6) return 'curious';
    return 'idle';
  }

  updateGaze(dt) {
    this.nextSaccade -= dt;
    if (this.nextSaccade <= 0) {
      const m = this.mood;
      if (m === 'curious' || m === 'idle') {
        this.gazeTarget.x = rand(-1.6, 1.6);
        this.gazeTarget.y = rand(-0.8, 0.8);
        this.nextSaccade = rand(0.9, 2.6);
      } else if (m === 'sleepy' || m === 'asleep') {
        this.gazeTarget.x = rand(-0.4, 0.4);
        this.gazeTarget.y = 0.6;
        this.nextSaccade = rand(2, 4);
      } else {
        this.nextSaccade = rand(0.4, 1.2);
      }
    }
    const speed = this.mood === 'playing' || this.mood === 'strained' ? 22 : 9;
    this.gaze.x = approach(this.gaze.x, this.gazeTarget.x, speed, dt);
    this.gaze.y = approach(this.gaze.y, this.gazeTarget.y, speed, dt);
  }

  updateBlink(dt) {
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0 && this.blink === 0) {
      this.blink = 0.0001;
      this.blinkDir = 1;
      this.blinkTimer = this.blinkQueue > 0 ? 0.16 : rand(1.8, 5.5);
      if (this.blinkQueue > 0) this.blinkQueue--;
      else if (Math.random() < 0.22) this.blinkQueue = 1;
    }
    if (this.blink > 0) {
      const rate = 11;
      this.blink += this.blinkDir * rate * dt;
      if (this.blink >= 1) {
        this.blink = 1;
        this.blinkDir = -1;
      } else if (this.blink <= 0) {
        this.blink = 0;
      }
    }
  }

  /** Everything the face renderer needs, as plain numbers and shape names. */
  expression() {
    const t = this.t;
    const m = this.mood;
    const breathe = Math.sin(t * (m === 'asleep' ? 1.1 : 2.2)) * (m === 'asleep' ? 1.1 : 0.5);
    const base = {
      mood: m,
      eyes: 'normal',
      mouth: 'neutral',
      brow: 0,
      blush: this.affection * 0.6 + this.pet * 0.6,
      gaze: this.gaze,
      blink: this.blink,
      bob: this.bob.x * 0.045 + breathe,
      squash: this.squash.x * 0.0035,
      lean: this.lean.x * 0.02,
      glitch: this.glitch,
      energy: this.energy,
      intensity: this.intensity,
      sweat: 0,
      zzz: 0,
      spiral: 0,
      openness: Math.min(1, this.energy * 1.5),
    };

    switch (m) {
      case 'asleep':
        return { ...base, eyes: 'closed', mouth: 'sleep', blink: 1, zzz: 1, brow: -0.2, openness: 0 };
      case 'sleepy':
        return { ...base, eyes: 'sleepy', mouth: 'flat', brow: -0.35, zzz: 0.35, openness: 0 };
      case 'curious':
        return { ...base, eyes: 'normal', mouth: 'smallSmile', brow: 0.3 };
      case 'playing': {
        const wide = this.intensity > 0.3;
        return {
          ...base,
          eyes: wide ? 'wide' : 'normal',
          mouth: base.openness > 0.55 ? 'bigO' : 'o',
          brow: 0.25,
        };
      }
      case 'singing':
        return { ...base, eyes: 'happy', mouth: 'wave', brow: 0.1, blush: base.blush + 0.25 };
      case 'ecstatic':
        return { ...base, eyes: 'star', mouth: 'grin', brow: 0.6, blush: base.blush + 0.4 };
      case 'loved':
        return { ...base, eyes: 'heart', mouth: 'cat', brow: 0.4, blush: 1 };
      case 'proud':
        return { ...base, eyes: 'happy', mouth: 'grin', brow: 0.5, blush: base.blush + 0.2 };
      case 'strained':
        return { ...base, eyes: 'wide', mouth: 'gasp', brow: -0.4, sweat: 0.7 };
      case 'dizzy':
        return { ...base, eyes: 'spiral', mouth: 'wobble', brow: -0.6, sweat: 1, spiral: 1 };
      case 'annoyed':
        return { ...base, eyes: 'angry', mouth: 'frown', brow: -1, sweat: 0.3 };
      case 'shocked':
        return { ...base, eyes: 'shock', mouth: 'bigO', brow: 1 };
      default:
        return { ...base, mouth: this.affection > 0.5 ? 'smallSmile' : 'neutral' };
    }
  }
}
