// The preview window state machine behind PreviewPlayer: window boundaries,
// the end card firing exactly once, replay re-arming, and a film switch
// starting clean. The player itself is not involved — PreviewPlayer feeds the
// controller playback positions and applies the actions it returns.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PreviewWindowController } from '../../src/views/components/discover/previewWindow.js';

// A window into the middle of a full film: 0:30 → 1:30.
const WINDOW = { startSec: 30, durationSec: 60 };

describe('preview window controller', () => {
  it('starts armed, with the whole window left on the countdown', () => {
    const c = new PreviewWindowController(WINDOW);
    assert.equal(c.ended, false);
    assert.equal(c.remaining, 60);
  });

  it('counts down inside the window', () => {
    const c = new PreviewWindowController(WINDOW);
    assert.deepEqual(c.onTimeChanged(30), { type: 'tick', remaining: 60 });
    assert.deepEqual(c.onTimeChanged(45), { type: 'tick', remaining: 45 });
    assert.deepEqual(c.onTimeChanged(75), { type: 'tick', remaining: 15 });
  });

  it('ignores positions before the window while the start offset is still applying', () => {
    const c = new PreviewWindowController(WINDOW);
    // The player reports positions from 0 before the start offset takes hold;
    // none of these is the user seeking back.
    assert.deepEqual(c.onTimeChanged(0), { type: 'ignore' });
    assert.deepEqual(c.onTimeChanged(12), { type: 'ignore' });
    assert.deepEqual(c.onTimeChanged(30), { type: 'tick', remaining: 60 });
  });

  it('jumps back to the window start when the user drags before it, once per drag', () => {
    const c = new PreviewWindowController(WINDOW);
    c.onTimeChanged(40); // the window is reached and playing
    assert.deepEqual(c.onTimeChanged(5), { type: 'seek-back', to: 30 });
    // Old positions keep arriving while the seek lands: no second seek.
    assert.deepEqual(c.onTimeChanged(6), { type: 'ignore' });
    assert.deepEqual(c.onTimeChanged(7), { type: 'ignore' });
    // The seek lands at the window start; a later drag back seeks again.
    assert.deepEqual(c.onTimeChanged(30), { type: 'tick', remaining: 60 });
    assert.deepEqual(c.onTimeChanged(2), { type: 'seek-back', to: 30 });
  });

  it('ends exactly at the window end', () => {
    const c = new PreviewWindowController(WINDOW);
    assert.deepEqual(c.onTimeChanged(89), { type: 'tick', remaining: 1 });
    assert.deepEqual(c.onTimeChanged(90), { type: 'finish' });
    assert.equal(c.ended, true);
    assert.equal(c.remaining, 0);
  });

  it('ends when the user drags past the window', () => {
    const c = new PreviewWindowController(WINDOW);
    c.onTimeChanged(40);
    assert.deepEqual(c.onTimeChanged(400), { type: 'finish' });
    assert.equal(c.remaining, 0);
  });

  it('treats the stream itself ending as the window end', () => {
    const c = new PreviewWindowController(WINDOW);
    c.onTimeChanged(60);
    assert.deepEqual(c.onPlaybackFinished(), { type: 'finish' });
    assert.equal(c.ended, true);
  });

  it('shows the end card exactly once per pass', () => {
    const c = new PreviewWindowController(WINDOW);
    assert.deepEqual(c.onTimeChanged(90), { type: 'finish' });
    // Positions keep arriving after the pause, and the stream may also fire
    // PlaybackFinished: none of them may re-fire the end.
    assert.deepEqual(c.onTimeChanged(90.5), { type: 'ignore' });
    assert.deepEqual(c.onPlaybackFinished(), { type: 'ignore' });
    assert.deepEqual(c.onTimeChanged(120), { type: 'ignore' });
  });

  it('replay re-arms: full countdown, from the window start, ending again', () => {
    const c = new PreviewWindowController(WINDOW);
    c.onTimeChanged(90);
    assert.equal(c.ended, true);

    assert.equal(c.replay(), 30, 'replay seeks back to the window start');
    assert.equal(c.ended, false);
    assert.equal(c.remaining, 60);

    // The second pass behaves like the first, including a single end card.
    assert.deepEqual(c.onTimeChanged(75), { type: 'tick', remaining: 15 });
    assert.deepEqual(c.onTimeChanged(90), { type: 'finish' });
    assert.deepEqual(c.onTimeChanged(91), { type: 'ignore' });
  });

  it('after replay, pre-window positions are ignored until the window is reached again', () => {
    const c = new PreviewWindowController(WINDOW);
    c.onTimeChanged(40);
    c.onTimeChanged(90); // ended
    c.replay();
    // The seek back to the start is still landing; these are not user drags.
    assert.deepEqual(c.onTimeChanged(3), { type: 'ignore' });
    assert.deepEqual(c.onTimeChanged(30), { type: 'tick', remaining: 60 });
  });
});

describe('film switch on the same component', () => {
  it('a fresh controller per film carries no countdown or end marker over', () => {
    // Film A plays its window to the end: end card up, countdown at zero.
    const a = new PreviewWindowController({ startSec: 30, durationSec: 60 });
    a.onTimeChanged(40);
    assert.deepEqual(a.onTimeChanged(90), { type: 'finish' });
    assert.equal(a.ended, true);
    assert.equal(a.remaining, 0);

    // PreviewPlayer builds a new controller per film (and resets its UI state
    // with it), so film B starts armed with its own window and its own
    // countdown — none of A's end state leaks into it.
    const b = new PreviewWindowController({ startSec: 10, durationSec: 20 });
    assert.equal(b.ended, false);
    assert.equal(b.remaining, 20);
    assert.deepEqual(b.onTimeChanged(10), { type: 'tick', remaining: 20 });
    assert.deepEqual(b.onTimeChanged(30), { type: 'finish' }, "film B's window ends at its own boundary");
  });

  it("the previous film's controller keeps its own state, untouched by the next film", () => {
    const a = new PreviewWindowController({ startSec: 30, durationSec: 60 });
    a.onTimeChanged(90);
    const b = new PreviewWindowController({ startSec: 10, durationSec: 20 });
    b.onTimeChanged(15);
    b.replay();
    assert.equal(a.ended, true, 'film A stays ended');
    assert.equal(a.remaining, 0);
  });
});
