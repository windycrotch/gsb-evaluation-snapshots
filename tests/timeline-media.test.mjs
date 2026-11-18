import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTimelineMedia } from '../src/systems/TimelineMedia.ts';

// ---------------------------------------------------------------------------
// Local test fixture: a self-made silent WAV sample (no network involved).
// ---------------------------------------------------------------------------

function silentWav(seconds, sampleRate = 8000) {
  const samples = Math.round(seconds * sampleRate);
  const wave = Buffer.alloc(44 + samples * 2);
  wave.write('RIFF', 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(sampleRate * 2, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(samples * 2, 40);
  return wave;
}

function wavDurationSeconds(buffer) {
  return buffer.readUInt32LE(40) / buffer.readUInt32LE(28);
}

// ---------------------------------------------------------------------------
// Minimal HTMLAudioElement stand-in recording every interaction the player
// performs. Duration comes from the local WAV so loop/modulo behaviour can be
// exercised like in a real browser.
// ---------------------------------------------------------------------------

class MockAudio {
  static instances = [];
  static optionsFor = null;

  constructor(url) {
    this.src = url;
    const options = MockAudio.optionsFor?.(url) ?? { duration: 0 };
    // Before metadata arrives a real HTMLAudioElement exposes NaN duration.
    this.duration = options.delayMetadata ? Number.NaN : options.duration;
    this.metadataDuration = Number.isFinite(options.duration) ? options.duration : 0;
    this.rejectPlay = options.rejectPlay === true;
    this.delayMetadata = options.delayMetadata === true;
    this.volume = 1;
    this.loop = false;
    this.preload = 'auto';
    this.paused = true;
    this._currentTime = 0;
    this.currentTimeWrites = [];
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.loadCalls = 0;
    this.removedSrc = false;
    this.listeners = new Map();
    this.releasedMetadata = false;
    MockAudio.instances.push(this);
    if (!this.delayMetadata) queueMicrotask(() => this.emitLoadedMetadata());
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type);
    if (!list) return;
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }

  emitLoadedMetadata() {
    if (this.releasedMetadata) return;
    this.releasedMetadata = true;
    this.duration = this.metadataDuration;
    for (const listener of this.listeners.get('loadedmetadata') ?? []) listener();
  }

  /** Test helper: deliver metadata for an audio whose loading was deferred. */
  releaseMetadata() {
    this.emitLoadedMetadata();
  }

  get currentTime() {
    return this._currentTime;
  }

  set currentTime(value) {
    this._currentTime = value;
    this.currentTimeWrites.push(value);
  }

  async play() {
    this.playCalls += 1;
    if (this.rejectPlay) throw new Error('NotAllowedError: play() blocked by autoplay policy');
    this.paused = false;
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }

  removeAttribute(name) {
    if (name === 'src') {
      this.removedSrc = true;
      this.src = '';
    }
  }

  load() {
    this.loadCalls += 1;
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function createFixture(seconds = 2) {
  const dir = await mkdtemp(join(tmpdir(), 'timeline-media-'));
  const wav = silentWav(seconds);
  const file = join(dir, 'sample.wav');
  await writeFile(file, wav);
  return { dir, soundUrl: pathToFileURL(file).href, audioDuration: wavDurationSeconds(wav) };
}

function makeObject(id, sound) {
  return {
    id,
    name: id,
    type: 'audioSource',
    object: {},
    properties: { sounds: [{ ...sound, name: 'sample', autoPlay: false }] },
  };
}

function makeTimeline(sounds, trigger = 'start', duration = 10) {
  return { duration, trigger, key: '', tracks: [], sounds };
}

function soundSegment(overrides = {}) {
  return { id: 'seg-1', targetId: 'obj-1', soundId: 'snd-1', start: 1, duration: 4, ...overrides };
}

async function setup(timelineOptions = {}) {
  const fixture = await createFixture(timelineOptions.audioDuration ?? 2);
  const loop = timelineOptions.loop === true;
  const objects = [makeObject('obj-1', {
    id: 'snd-1', url: fixture.soundUrl, volume: 0.5, loop,
  })];
  const timeline = makeTimeline(
    [soundSegment(timelineOptions.segment ?? {})],
    timelineOptions.trigger,
    timelineOptions.duration
  );
  MockAudio.instances = [];
  MockAudio.optionsFor = () => ({
    duration: fixture.audioDuration,
    rejectPlay: timelineOptions.rejectPlay === true,
    delayMetadata: timelineOptions.delayMetadata === true,
  });
  const errors = [];
  const media = createTimelineMedia(
    timeline, objects, {}, message => errors.push(message), timelineOptions.preview === true
  );
  const audio = MockAudio.instances[0];
  return {
    media,
    errors,
    get audio() {
      return audio;
    },
    cleanup: async () => {
      media.stop();
      MockAudio.optionsFor = null;
      await rm(fixture.dir, { recursive: true, force: true });
    },
  };
}

test.beforeEach(() => {
  globalThis.Audio = MockAudio;
});

// ---------------------------------------------------------------------------
// Case 1: time jumps relocate the playing sound to its in-segment offset
// ---------------------------------------------------------------------------

test('backward seek while playing relocates currentTime to the segment offset', async () => {
  const harness = await setup();
  const { media, audio } = harness;
  try {
    media.seek(3, true); // offset 2 inside [1, 5)
    assert.equal(audio.playCalls, 1);
    assert.equal(audio.currentTime, 2);

    media.seek(1.5, true); // jump backwards -> offset 0.5
    assert.equal(audio.currentTimeWrites.at(-1), 0.5);
    assert.equal(audio.paused, false);
    assert.equal(audio.playCalls, 1, 'already playing: play() is not called again');
  } finally {
    await harness.cleanup();
  }
});

test('single-frame forward jump longer than 0.3s relocates the sound', async () => {
  const harness = await setup();
  const { media, audio } = harness;
  try {
    media.seek(1, true);
    assert.equal(audio.currentTime, 0);
    media.seek(1.2, true); // normal small advance: no relocation
    assert.equal(audio.currentTimeWrites.length, 1);
    media.seek(1.55, true); // +0.35 > 0.3: jump, offset 0.55
    assert.ok(Math.abs(audio.currentTimeWrites.at(-1) - 0.55) < 1e-9);
  } finally {
    await harness.cleanup();
  }
});

test('normal frame steps under 0.3s never touch currentTime after entry', async () => {
  const harness = await setup();
  const { media, audio } = harness;
  try {
    media.seek(1, true);
    for (let time = 1.1; time < 4.9; time += 0.1) media.seek(time, true);
    assert.equal(audio.currentTimeWrites.length, 1, 'only the initial entry sets currentTime');
    assert.equal(audio.paused, false);
  } finally {
    await harness.cleanup();
  }
});

test('scroll trigger treats every time change as a jump and re-aligns', async () => {
  const harness = await setup({ trigger: 'scroll' });
  const { media, audio } = harness;
  try {
    media.seek(1, true);
    media.seek(1.05, true); // tiny change, but scroll => jump
    assert.ok(Math.abs(audio.currentTimeWrites.at(-1) - 0.05) < 1e-9);
    media.seek(1.04, true); // backward scroll as well
    assert.ok(Math.abs(audio.currentTimeWrites.at(-1) - 0.04) < 1e-9);
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Case 2: pause then resume without a time jump keeps the playback position
// ---------------------------------------------------------------------------

test('pause then resume at the same time does not reset currentTime', async () => {
  const harness = await setup();
  const { media, audio } = harness;
  try {
    media.seek(2.5, true); // offset 1.5
    assert.equal(audio.currentTime, 1.5);
    audio.currentTime = 1.7; // simulate the audio having advanced while playing

    media.seek(2.5, false); // pause inside the segment
    assert.equal(audio.paused, true);
    assert.equal(audio.pauseCalls, 1);

    media.seek(2.5, true); // resume, same time, no jump
    assert.equal(audio.paused, false);
    assert.equal(audio.currentTime, 1.7, 'resume keeps the paused position');
    assert.equal(audio.playCalls, 2);
  } finally {
    await harness.cleanup();
  }
});

test('a jump while paused still re-aligns on resume', async () => {
  const harness = await setup();
  const { media, audio } = harness;
  try {
    media.seek(2.5, true);
    media.seek(2.5, false); // pause inside the segment
    media.seek(2.5, false); // paused frame, unchanged time
    media.seek(4, false); // paused jump: re-align immediately to offset 3
    assert.equal(audio.currentTimeWrites.at(-1), 3);
    const writesBeforeResume = audio.currentTimeWrites.length;
    media.seek(4, true); // resume at the new location: no extra relocation
    assert.equal(audio.paused, false);
    assert.equal(audio.currentTimeWrites.length, writesBeforeResume,
      'resume does not touch currentTime again');
    assert.equal(audio.currentTime, 3);
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Case 3: looped timeline re-entry re-aligns with a fresh offset every time
// ---------------------------------------------------------------------------

test('non-loop sound re-entering the segment starts from the new offset', async () => {
  const harness = await setup();
  const { media, audio } = harness;
  try {
    media.seek(2, true); // offset 1
    assert.equal(audio.currentTime, 1);
    media.seek(6, true); // leave the [1, 5) segment
    assert.equal(audio.paused, true);
    media.seek(1, true); // re-enter from the start
    assert.equal(audio.currentTime, 0, 're-entry re-aligns instead of reusing the old position');
    assert.equal(audio.playCalls, 2);
  } finally {
    await harness.cleanup();
  }
});

test('looping sound wraps the offset modulo the audio duration on re-entry', async () => {
  // 1s audio sample, segment [1, 6): offset 5 wraps to 0 inside the sample.
  const harness = await setup({ loop: true, audioDuration: 1, segment: { start: 1, duration: 5 } });
  const { media, audio } = harness;
  try {
    assert.equal(audio.loop, true);
    media.seek(2, true); // offset 1 -> 1 % 1 = 0
    assert.equal(audio.currentTime, 0);
    media.seek(6, true); // leave
    media.seek(1, true); // re-enter at offset 0
    assert.equal(audio.currentTime, 0);
    media.seek(6, true);
    media.seek(4, true); // re-enter with offset 3 -> 3 % 1 = 0
    assert.equal(audio.currentTime, 0);
    assert.equal(audio.playCalls, 3);
  } finally {
    await harness.cleanup();
  }
});

test('looping sound modulo relocation works for non-integer offsets', async () => {
  // 1.5s sample, offset 2 -> 0.5 after modulo.
  const harness = await setup({ loop: true, audioDuration: 1.5, segment: { start: 1, duration: 4 } });
  const { media, audio } = harness;
  try {
    media.seek(3, true); // offset 2, 2 % 1.5 = 0.5
    assert.ok(Math.abs(audio.currentTime - 0.5) < 1e-9);
    media.seek(1.2, true); // backward jump: offset 0.2 stays 0.2
    assert.ok(Math.abs(audio.currentTime - 0.2) < 1e-9);
  } finally {
    await harness.cleanup();
  }
});

test('looped sound whose metadata arrives late re-applies the modulo offset', async () => {
  // 1s sample with metadata delivery deferred, like a browser still buffering.
  const harness = await setup({
    loop: true, audioDuration: 1, delayMetadata: true, segment: { start: 1, duration: 5 },
  });
  const { media, audio } = harness;
  try {
    assert.ok(Number.isNaN(audio.duration));
    media.seek(4, true); // offset 3, duration unknown -> raw offset used
    assert.equal(audio.currentTime, 3);
    audio.releaseMetadata(); // duration now known: lastOffset 3 -> 3 % 1 = 0
    assert.equal(audio.duration, 1);
    assert.equal(audio.currentTime, 0);

    media.seek(4.5, true); // jumped: offset 3.5 -> 3.5 % 1 = 0.5
    assert.equal(audio.currentTime, 0.5);
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Boundaries, validation, preview and lifecycle
// ---------------------------------------------------------------------------

test('sound is silent outside its half-open segment [start, start+duration)', async () => {
  const harness = await setup();
  const { media, audio } = harness;
  try {
    media.seek(0.9, true);
    assert.equal(audio.playCalls, 0);
    media.seek(1, true); // inclusive start
    assert.equal(audio.playCalls, 1);
    assert.equal(audio.paused, false);
    media.seek(5, true); // exclusive end
    assert.equal(audio.paused, true);
    media.seek(4.999, true); // back in, fresh entry re-aligned to ~3.999
    assert.equal(audio.playCalls, 2);
    assert.ok(Math.abs(audio.currentTime - 3.999) < 1e-9);
  } finally {
    await harness.cleanup();
  }
});

test('paused timeline never starts a sound, even inside the segment', async () => {
  const harness = await setup();
  const { media, audio } = harness;
  try {
    media.seek(2, false);
    assert.equal(audio.playCalls, 0);
    assert.equal(audio.paused, true);
    media.seek(3, false);
    assert.equal(audio.playCalls, 0);
  } finally {
    await harness.cleanup();
  }
});

test('invalid and out-of-bounds sound segments are reported and skipped', async () => {
  const fixture = await createFixture(2);
  const objects = [
    makeObject('obj-1', { id: 'snd-1', url: fixture.soundUrl, volume: 0.5, loop: false }),
    makeObject('obj-2', { id: 'snd-2', url: fixture.soundUrl, volume: 0.5, loop: false }),
  ];
  const timeline = makeTimeline([
    soundSegment({ id: 'bad-target', targetId: 'missing' }),
    soundSegment({ id: 'bad-sound', soundId: 'nope' }),
    soundSegment({ id: 'bad-start', start: -1 }),
    soundSegment({ id: 'bad-duration', duration: 0 }),
    soundSegment({ id: 'out-of-bounds', start: 8, duration: 5 }), // timeline duration is 10
    soundSegment({ id: 'good' }),
  ]);
  const errors = [];
  MockAudio.instances = [];
  const media = createTimelineMedia(timeline, objects, {}, message => errors.push(message), false);
  try {
    assert.equal(errors.length, 5);
    assert.deepEqual(errors.map(message => message.split(':').at(-1)?.trim()),
      ['bad-target', 'bad-sound', 'bad-start', 'bad-duration', 'out-of-bounds']);
    assert.equal(MockAudio.instances.length, 1, 'only the valid segment creates an audio element');
    media.seek(2, true);
    assert.equal(MockAudio.instances[0].playCalls, 1);
    media.stop();
  } finally {
    MockAudio.optionsFor = null;
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('preview mode reports errors but never creates audio elements', async () => {
  const fixture = await createFixture(2);
  const objects = [
    makeObject('obj-1', { id: 'snd-1', url: fixture.soundUrl, volume: 0.5, loop: false }),
  ];
  const timeline = makeTimeline([soundSegment(), soundSegment({ id: 'bad', start: -2 })]);
  const errors = [];
  MockAudio.instances = [];
  const media = createTimelineMedia(timeline, objects, {}, message => errors.push(message), true);
  try {
    media.seek(2, true);
    assert.equal(MockAudio.instances.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /bad/);
    media.stop(); // must not throw without audio elements
  } finally {
    MockAudio.optionsFor = null;
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('stop pauses every sound and clears its src', async () => {
  const fixture = await createFixture(2);
  const objects = [makeObject('obj-1', {
    id: 'snd-1', url: fixture.soundUrl, volume: 0.5, loop: false,
  })];
  const timeline = makeTimeline([soundSegment()]);
  MockAudio.instances = [];
  const media = createTimelineMedia(timeline, objects, {}, () => {}, false);
  const audio = MockAudio.instances[0];
  media.seek(2, true);
  assert.equal(audio.paused, false);
  media.stop();
  assert.equal(audio.paused, true);
  assert.equal(audio.pauseCalls >= 1, true);
  assert.equal(audio.removedSrc, true);
  assert.equal(audio.loadCalls, 1);
  MockAudio.optionsFor = null;
  await rm(fixture.dir, { recursive: true, force: true });
});

test('a rejected play() promise is forwarded through reportError', async () => {
  const harness = await setup({ rejectPlay: true });
  const { media, audio, errors } = harness;
  try {
    media.seek(2, true);
    assert.equal(audio.playCalls, 1);
    await new Promise(resolve => queueMicrotask(resolve));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Timeline sound:/);
    assert.match(errors[0], /NotAllowedError/);
  } finally {
    await harness.cleanup();
  }
});
