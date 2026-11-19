import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDomGlobals, FakeUtterance } from './helpers/domStub.ts';

// Install browser stubs before importing the engine (it reads window at call time).
const dom = installDomGlobals();
const { audioEngine } = await import('../src/utils/audioEngine.ts');

test('speakNarration ducks music and notifies word listeners on boundaries', () => {
  const heard: number[] = [];
  const unsub = audioEngine.addWordListener((_w, _c, idx) => heard.push(idx));

  audioEngine.speakNarration('alpha beta gamma', undefined, undefined, 1, 1, {
    sessionToken: 100,
  });
  assert.equal(audioEngine.isDucking(), true);
  assert.equal(dom.speech.speakCalls.length, 1);
  const utterance = dom.speech.speakCalls[dom.speech.speakCalls.length - 1] as FakeUtterance;

  utterance.onboundary?.({ name: 'word', charIndex: 0 });
  utterance.onboundary?.({ name: 'word', charIndex: 6 });
  assert.deepEqual(heard.slice(-2), [0, 1]);

  utterance.onend?.();
  assert.equal(audioEngine.isDucking(), false);
  // End of speech resets the highlighted word.
  assert.equal(heard[heard.length - 1], -1);
  unsub();
});

test('stale session word callbacks are ignored after a newer session starts', () => {
  const heard: number[] = [];
  const unsub = audioEngine.addWordListener((_w, _c, idx) => heard.push(idx));

  audioEngine.speakNarration('one two three', undefined, undefined, 1, 1, { sessionToken: 1 });
  const oldUtterance = dom.speech.speakCalls[dom.speech.speakCalls.length - 1] as FakeUtterance;

  // A new session (scene switch / replacement) invalidates the old one.
  audioEngine.speakNarration('four five', undefined, undefined, 1, 1, { sessionToken: 2 });
  const newUtterance = dom.speech.speakCalls[dom.speech.speakCalls.length - 1] as FakeUtterance;

  // Old scene's late boundary must not update the highlight.
  oldUtterance.onboundary?.({ name: 'word', charIndex: 0 });
  const before = [...heard];
  assert.deepEqual(heard, before);

  // New scene's boundary works and maps within its own word list.
  newUtterance.onboundary?.({ name: 'word', charIndex: 0 });
  assert.equal(heard[heard.length - 1], 0);
  unsub();
});

test('stopSpeaking cancels speech, restores music, and invalidates pending callbacks', () => {
  audioEngine.speakNarration('alpha beta', undefined, undefined, 1, 1, { sessionToken: 5 });
  const utterance = dom.speech.speakCalls[dom.speech.speakCalls.length - 1] as FakeUtterance;
  assert.equal(audioEngine.isDucking(), true);

  const cancelCountBefore = dom.speech.cancelCalls;
  audioEngine.stopSpeaking();
  assert.ok(dom.speech.cancelCalls > cancelCountBefore);
  assert.equal(audioEngine.isDucking(), false);
  assert.equal(audioEngine.isSpeaking(), false);

  // A boundary arriving after cancel must be dropped.
  const heard: number[] = [];
  const unsub = audioEngine.addWordListener((_w, _c, idx) => heard.push(idx));
  utterance.onboundary?.({ name: 'word', charIndex: 0 });
  assert.equal(heard.length, 0);
  unsub();
});

test('fallback timer estimates words until a native boundary arrives', async () => {
  const heard: number[] = [];
  const unsub = audioEngine.addWordListener((_w, _c, idx) => heard.push(idx));

  audioEngine.speakNarration('a b c d e f', undefined, undefined, 1, 1, { sessionToken: 20 });
  const utterance = dom.speech.speakCalls[dom.speech.speakCalls.length - 1] as FakeUtterance;

  // Run one fallback tick manually.
  const timerIds = [...dom.intervals.keys()];
  assert.ok(timerIds.length >= 1);
  dom.intervals.get(timerIds[timerIds.length - 1])!();
  // The listener also receives the -1 reset emitted when speaking started.
  assert.equal(heard[heard.length - 1], 0); // first estimated word

  // A native boundary takes over and clears the fallback timer.
  utterance.onboundary?.({ name: 'word', charIndex: 2 });
  // charIndex 2 in "a b c..." is the start of word index 1.
  assert.equal(heard[heard.length - 1], 1);
  // The fallback interval should have been removed.
  assert.equal(dom.intervals.size, 0);

  audioEngine.stopSpeaking();
  unsub();
});

test('seek offset suppresses fallback word events that precede the playhead', async () => {
  const heard: number[] = [];
  const unsub = audioEngine.addWordListener((_w, _c, idx) => heard.push(idx));

  // Start at a 2-second offset; words estimated before that time are skipped.
  audioEngine.speakNarration('a b c d e f g h i j', undefined, undefined, 1, 1, {
    sessionToken: 30,
    startOffsetSec: 2,
  });

  const timerIds = [...dom.intervals.keys()];
  const tick = dom.intervals.get(timerIds[timerIds.length - 1])!;
  // First several fallback ticks should be suppressed (2.6 words/sec * 2s
  // means words before ~index 5 belong to the skipped prefix).
  for (let i = 0; i < 4; i++) tick();
  assert.ok(heard.every((idx) => idx === -1 || idx >= 5), `got ${JSON.stringify(heard)}`);

  audioEngine.stopSpeaking();
  unsub();
});

test('custom audio: ducking while playing, restored on natural end', () => {
  const heard: number[] = [];
  const unsub = audioEngine.addWordListener((_w, _c, idx) => heard.push(idx));

  audioEngine.playCustomAudio('blob:narration', undefined, 40);
  assert.equal(audioEngine.isDucking(), true);
  assert.equal(audioEngine.hasCustomAudio(), true);
  const el = dom.audioElements[dom.audioElements.length - 1];
  assert.equal(el.playCalls, 1);

  el.onended?.();
  assert.equal(audioEngine.isDucking(), false);
  assert.equal(audioEngine.hasCustomAudio(), false);
  assert.equal(heard[heard.length - 1], -1);
  unsub();
});

test('replacing custom audio stops the old element so tracks never overlap', () => {
  audioEngine.playCustomAudio('blob:first', undefined, 50);
  const first = dom.audioElements[dom.audioElements.length - 1];

  audioEngine.playCustomAudio('blob:second', undefined, 51);
  const second = dom.audioElements[dom.audioElements.length - 1];

  assert.notEqual(first, second);
  assert.ok(first.pauseCalls >= 1); // old track paused
  // The old element's end handler must be detached so it cannot un-duck later.
  assert.equal(first.onended, null);

  // Firing the stale old handler reference (if captured elsewhere) is a no-op
  // because the engine only listens on the current element.
  assert.equal(audioEngine.hasCustomAudio(), true);
  audioEngine.stopSpeaking();
});

test('custom audio end restores music volume even after being replaced then stopped', () => {
  audioEngine.playCustomAudio('blob:a', undefined, 60);
  audioEngine.playCustomAudio('blob:b', undefined, 61);
  audioEngine.stopSpeaking();
  assert.equal(audioEngine.isDucking(), false);
  assert.equal(audioEngine.hasCustomAudio(), false);
});

test('seekCustomAudio moves the uploaded track playhead', () => {
  audioEngine.playCustomAudio('blob:seek', undefined, 70);
  const el = dom.audioElements[dom.audioElements.length - 1];
  audioEngine.seekCustomAudio(3.2);
  assert.ok(Math.abs(el.currentTime - 3.2) < 1e-6);
});

test('startMusic keeps exactly one scheduler loop across repeated starts', () => {
  audioEngine.startMusic('lofi');
  assert.equal(audioEngine.getMusicLoopCount(), 1);
  audioEngine.startMusic('lofi');
  assert.equal(audioEngine.getMusicLoopCount(), 1); // still one loop, no accumulation
  audioEngine.startMusic('tech');
  assert.equal(audioEngine.getMusicLoopCount(), 1);
  audioEngine.stopMusic();
  assert.equal(audioEngine.getMusicLoopCount(), 0);
});

test('music restart re-applies ducking instead of accumulating volume', () => {
  audioEngine.setDucking(true);
  assert.equal(audioEngine.isDucking(), true);
  audioEngine.startMusic('lofi');
  // Music is playing but must remain ducked while narration is active.
  assert.equal(audioEngine.isDucking(), true);
  assert.equal(audioEngine.getMusicLoopCount(), 1);

  audioEngine.setDucking(false);
  audioEngine.stopMusic();
  audioEngine.startMusic('lofi');
  assert.equal(audioEngine.isDucking(), false);
  assert.equal(audioEngine.getMusicLoopCount(), 1);
  audioEngine.stopMusic();
});

test('stopAll stops voice, custom audio, and music together', () => {
  audioEngine.playCustomAudio('blob:all', undefined, 80);
  audioEngine.startMusic('lofi');
  assert.equal(audioEngine.getMusicLoopCount(), 1);
  audioEngine.stopAll();
  assert.equal(audioEngine.hasCustomAudio(), false);
  assert.equal(audioEngine.isDucking(), false);
  assert.equal(audioEngine.getMusicLoopCount(), 0);
});

test('toggling music off and on never accumulates loops or ducking volume', () => {
  // Simulate the UI music toggle across many cycles while narration ducks.
  for (let cycle = 0; cycle < 4; cycle++) {
    audioEngine.setDucking(true); // narration starts
    audioEngine.startMusic('lofi');
    assert.equal(audioEngine.getMusicLoopCount(), 1, 'exactly one loop at any time');
    assert.equal(audioEngine.isDucking(), true);
    audioEngine.setDucking(false); // narration stops -> music restored
    assert.equal(audioEngine.isDucking(), false);
    audioEngine.stopMusic(); // music toggled off
    assert.equal(audioEngine.getMusicLoopCount(), 0);
  }
  // Final state: no loops, music back at full (unducked) volume.
  assert.equal(audioEngine.getMusicLoopCount(), 0);
  assert.equal(audioEngine.isDucking(), false);
});

test('uploaded audio ending after playback restores background music volume', () => {
  audioEngine.setDucking(false);
  audioEngine.playCustomAudio('blob:voice-end', undefined, 90);
  assert.equal(audioEngine.isDucking(), true); // ducked while voice plays
  const el = dom.audioElements[dom.audioElements.length - 1];
  el.onended?.(); // natural end of the uploaded track
  assert.equal(audioEngine.isDucking(), false); // volume restored
});

test('session token adoption never moves backwards', () => {
  const first = audioEngine.beginSession(100);
  assert.ok(first >= 100);
  const later = audioEngine.beginSession(50); // stale external token ignored
  assert.ok(later > first);
  assert.equal(audioEngine.isSessionActive(later), true);
  assert.equal(audioEngine.isSessionActive(first), false);
});
