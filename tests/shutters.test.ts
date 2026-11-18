// Local verification of the shutter state machine with a minimal fake wing and a fake frame
// clock (no DOM, WebGL or real timers). Run with:
//
//   node --experimental-strip-types --test tests/shutters.test.ts
//
// (also wired as `npm run test:shutters`). The four required scenarios are covered:
//   1. a normal close then open reaches the resting states with the expected angles;
//   2. repeated open/close requests while a swing runs are ignored, never stacked;
//   3. switching the stroke view mid-swing neither jumps p nor loses the exterior repaint;
//   4. missing/failed exterior data degrades to plain backs but the wings still shut and reopen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShutterMachine, SWING_MS, ease } from '../src/ui/shutterMachine.ts';
import type { FrameClock, ShutterHooks } from '../src/ui/shutterMachine.ts';

// A controllable clock: time advances only when the test says so, and due rAF callbacks run
// synchronously with the timestamp they would have seen on a real browser frame.
class FakeClock implements FrameClock {
  nowMs = 0; // last frame time, always a 16 ms slot (what performance.now returns inside rAF)
  queue: { cb: (now: number) => void; due: number }[] = [];
  seq = 0;
  rafCount = 0; // total frame requests ever scheduled
  reduced = false;
  now(): number { return this.nowMs; }
  raf(cb: (now: number) => void): number {
    // a 60 Hz browser fires frames on fixed slots; the callback argument is that slot's timestamp
    const due = (Math.floor(this.nowMs / 16) + 1) * 16;
    this.queue.push({ cb, due });
    this.rafCount++;
    return this.seq++;
  }
  reducedMotion(): boolean { return this.reduced; }
  // Advance virtual time and flush every due rAF frame synchronously, in slot order. No microtask
  // draining happens inside a frame: a real browser runs promise continuations as separate tasks
  // between frames, which the tests drive explicitly with macrotask()/until().
  advance(ms: number): void {
    const target = this.nowMs + ms;
    while (this.queue.length && this.queue[0].due <= target) {
      const job = this.queue.shift()!;
      this.nowMs = job.due;
      job.cb(job.due);
    }
  }
  finishSwing(): void { this.advance(SWING_MS + 32); }
}

interface FakeHooks extends ShutterHooks {
  places: number[]; // every p handed to the place hook
  prepareCloseCalls: number;
  prepareOpenCalls: number;
  paintCalls: number;
  closedEvents: number;
  openedEvents: number;
  failPaint: boolean;
  paintExterior(): Promise<void>;
}

function makeHooks(overrides: Partial<ShutterHooks> = {}): FakeHooks {
  const h: FakeHooks = {
    places: [],
    prepareCloseCalls: 0,
    prepareOpenCalls: 0,
    paintCalls: 0,
    closedEvents: 0,
    openedEvents: 0,
    failPaint: false,
    async prepareClose() { h.prepareCloseCalls++; },
    async prepareOpen() { h.prepareOpenCalls++; },
    async paintExterior() {
      h.paintCalls++;
      if (h.failPaint) throw new Error('missing exterior strokes 0/0_0.bin');
    },
    place(p: number) { h.places.push(p); },
    onClosed() { h.closedEvents++; },
    onOpened() { h.openedEvents++; },
    ...overrides,
  };
  return h;
}

function makeMachine(clock = new FakeClock(), hooks = makeHooks()) {
  return { clock, hooks, m: new ShutterMachine(clock, hooks) };
}

// Let the async close/open chain arm its first rAF before the clock advances. In the DOM app the
// swing starts after awaited camera/painting work, so frames are always scheduled before the
// browser's next flush; this makes the virtual clock line up with that.
const macrotask = () => new Promise((r) => setTimeout(r, 0));

// Yield the real event loop until cond() holds. Unlike counting microtasks this is insensitive to
// how many awaits a promise chain internally needs; it fails the test if the condition never lands.
async function until(cond: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.fail(`condition not reached after ${tries} waits: ${cond.toString()}`);
}

test('1. normal close then open ends in the resting states with the expected angles', async () => {
  const { clock, hooks, m } = makeMachine();
  assert.equal(m.state, 'open');
  assert.equal(m.p, 1);
  assert.equal(m.busy, false);

  const closing = m.close();
  await macrotask();
  assert.equal(m.state, 'closing');
  assert.equal(m.busy, true);
  assert.equal(hooks.prepareCloseCalls, 1);

  clock.advance(SWING_MS / 2); // half a swing: monotonic, eased, still on the way
  const mid = m.p;
  assert.ok(mid > 0 && mid < 1, `mid-swing p should be between 0 and 1, got ${mid}`);
  assert.ok(Math.abs(mid - (1 - ease(0.5))) < 0.02, 'angle follows the preserved cubic ease (within one frame)');
  assert.ok(mid > 0.5, 'easeInOut cubic has not reached the half-way angle at half time');

  clock.finishSwing();
  await closing;
  assert.equal(m.state, 'closed');
  assert.equal(m.p, 0, 'closed means p === 0 (hinge flat over the centre)');
  assert.equal(m.busy, false);
  assert.equal(hooks.closedEvents, 1);
  assert.equal(m.covering, true);

  const opening = m.open();
  await macrotask();
  assert.equal(m.state, 'opening');
  clock.finishSwing();
  await opening;
  assert.equal(m.state, 'open');
  assert.equal(m.p, 1, 'open means p === 1 (wings back beside the centre panel)');
  assert.equal(hooks.openedEvents, 1);
  assert.equal(m.covering, false);
  // every frame placed the wings; split the recorded angles by swing leg and check monotonicity
  assert.ok(hooks.places.length >= 2);
  const firstOpen = hooks.places.indexOf(0); // the close leg ends at the first shut pose
  const closeLeg = hooks.places.slice(0, firstOpen + 1);
  const openLeg = hooks.places.slice(firstOpen + 1);
  for (let i = 1; i < closeLeg.length; i++) assert.ok(closeLeg[i] <= closeLeg[i - 1], 'closing never reverses');
  for (let i = 1; i < openLeg.length; i++) assert.ok(openLeg[i] >= openLeg[i - 1], 'opening never reverses');
});

test('2. repeated triggers during a swing are ignored, never superimposed', async () => {
  const { clock, hooks, m } = makeMachine();
  const closing = m.close();
  await macrotask();
  clock.advance(400);
  const pBefore = m.p;
  const framesBefore = clock.rafCount;

  // hammer the controls while closing: another close, an open, and toggles, all must no-op
  await Promise.all([m.toggle(), m.close(), m.open(), m.toggle()]);
  assert.equal(m.state, 'closing');
  assert.equal(m.p, pBefore, 'ignored requests must not move the angle');
  assert.equal(clock.rafCount, framesBefore, 'ignored requests must not schedule frames');
  assert.equal(hooks.prepareCloseCalls, 1, 'the preparation runs exactly once');

  clock.finishSwing();
  await closing;
  assert.equal(m.state, 'closed');
  assert.equal(m.p, 0);
  assert.equal(hooks.closedEvents, 1);

  // same guard on the way back out
  const opening = m.open();
  await macrotask();
  clock.advance(300);
  const pOpen = m.p;
  await Promise.all([m.toggle(), m.open(), m.close()]);
  assert.equal(m.state, 'opening');
  assert.equal(m.p, pOpen);
  assert.equal(hooks.prepareOpenCalls, 1);
  clock.finishSwing();
  await opening;
  assert.equal(m.state, 'open');
  assert.equal(m.p, 1);
  assert.equal(hooks.openedEvents, 1);
});

test('3. stroke-view switch mid-swing keeps the angle and still repaints once at rest', async () => {
  const { clock, hooks, m } = makeMachine();
  const closing = m.close();
  await macrotask();
  clock.advance(SWING_MS / 3);
  const pAtSwitch = m.p;

  // the user flips "show each stroke in its own colour" while the wings are moving: the request
  // is accepted but deferred, and never touches the hinge angle
  await m.repaint();
  assert.equal(m.p, pAtSwitch, 'the repaint must not touch the hinge angle');
  assert.equal(hooks.paintCalls, 0, 'no exterior painting may start while a swing runs');
  clock.advance(120); // a few more frames
  assert.ok(Math.abs(m.p - pAtSwitch) > 0, 'the swing keeps advancing on its own clock');
  assert.equal(hooks.paintCalls, 0);

  // a second rapid toggle before rest coalesces: still a single queued repaint
  await m.repaint();
  clock.finishSwing();
  await closing;
  await until(() => hooks.paintCalls === 1); // the queued repaint runs as a continuation at rest
  assert.equal(m.state, 'closed');
  assert.equal(m.p, 0);
  assert.equal(hooks.paintCalls, 1, 'the mid-swing switches result in exactly one repaint');
  assert.equal(hooks.places.at(-1), 0, 'post-repaint placement reuses the closed angle, not open');
  assert.equal(m.p, 0, 'the angle after the repaint is unchanged');
  assert.equal(m.exterior, 'ready');

  // repaints while at rest run immediately and still leave p alone
  const pBefore = m.p;
  await m.repaint();
  assert.equal(hooks.paintCalls, 2);
  assert.equal(m.p, pBefore);
});

test('3b. a window resize (re-placing at the current p) cannot jump or reset the angle', async () => {
  const { clock, hooks, m } = makeMachine();
  const closing = m.close();
  await macrotask();
  clock.advance(SWING_MS / 2);
  const pMid = m.p;
  // the DOM layer's frame() equivalent: recompute geometry at the machine's current p
  hooks.place(m.p);
  assert.equal(m.p, pMid, 're-placement reads p; it never writes it');
  clock.finishSwing();
  await closing;
  hooks.place(m.p); // resize while closed
  assert.equal(m.p, 0);
  assert.equal(m.state, 'closed');
});

test('4. missing exterior data degrades to plain backs but the wings still shut and reopen', async () => {
  const clock = new FakeClock();
  // In the DOM layer the exterior fetch/paint happens inside prepareClose; a missing stroke file
  // rejects there. Any later repaint attempt fails the same way.
  const hooks = makeHooks({
    async prepareClose() { throw new Error('missing exterior strokes 0/0_0.bin'); },
  });
  const m = new ShutterMachine(clock, hooks);

  const closing = m.close();
  await macrotask();
  clock.finishSwing();
  await closing;
  assert.equal(m.state, 'closed', 'a failed fetch must not leave the wings stuck closing');
  assert.equal(m.p, 0, 'the degraded wings still reach the shut pose');
  assert.equal(m.exterior, 'unavailable');
  assert.equal(hooks.closedEvents, 1);

  // the plain-back triptych behaves normally from then on
  const opening = m.open();
  await macrotask();
  clock.finishSwing();
  await opening;
  assert.equal(m.state, 'open');
  assert.equal(m.p, 1);
  assert.equal(m.exterior, 'unavailable', 'one failed load does not flip back to "ready" by itself');
  assert.equal(hooks.openedEvents, 1);

  // a later repaint that also fails stays degraded without jamming
  hooks.failPaint = true;
  await m.repaint();
  assert.equal(m.exterior, 'unavailable');
  assert.equal(m.state, 'open');
  assert.equal(m.p, 1);
});

test('4b. preparation that throws outright is still contained as degradation', async () => {
  const clock = new FakeClock();
  const hooks = makeHooks({
    async prepareClose() { throw new Error('WebGL2 context lost'); },
  });
  const m = new ShutterMachine(clock, hooks);
  const closing = m.close();
  await macrotask();
  clock.finishSwing();
  await closing;
  assert.equal(m.state, 'closed');
  assert.equal(m.p, 0);
  assert.equal(m.exterior, 'unavailable');
});
