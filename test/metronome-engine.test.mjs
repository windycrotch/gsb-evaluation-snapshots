import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { importTs } from "./support/load-ts.mjs";

const { MetronomeEngine, DOWNBEAT_FREQUENCY, NORMAL_FREQUENCY, LOOKAHEAD_MS } =
  await importTs("lib/audio/metronome-engine.ts");

// Virtual-clock harness: the engine's interval/timeout callbacks and the
// "audio clock" are all driven manually, so scheduling is fully deterministic
// and assertions can inspect every queued/cancelled click.
function makeHarness({ bpm = 60, beatsPerBar = 4, startTime = 0 } = {}) {
  let now = startTime;
  let nextId = 1;
  const intervals = new Map();
  const timeouts = new Map();
  const clicks = [];
  const cancelled = [];
  const beatEvents = [];

  const engine = new MetronomeEngine({
    bpm,
    beatsPerBar,
    getAudioTime: () => now,
    scheduleClick: (beatIndex, isDownbeat, time) => {
      const click = { beatIndex, isDownbeat, time, cancelled: false };
      clicks.push(click);
      return () => {
        click.cancelled = true;
        cancelled.push(click);
      };
    },
    onBeat: (beat) => beatEvents.push({ beat, at: now }),
    setIntervalFn: (cb) => {
      const id = nextId++;
      intervals.set(id, cb);
      return id;
    },
    clearIntervalFn: (id) => intervals.delete(id),
    setTimeoutFn: (cb, ms) => {
      const id = nextId++;
      timeouts.set(id, { at: now + ms / 1000, cb });
      return id;
    },
    clearTimeoutFn: (id) => timeouts.delete(id),
  });

  function tickScheduler() {
    for (const cb of [...intervals.values()]) cb();
  }

  function fireDueTimeouts() {
    for (const [id, entry] of [...timeouts]) {
      if (entry.at <= now + 1e-9) {
        timeouts.delete(id);
        entry.cb();
      }
    }
  }

  // Keep firing the 25 ms scheduler tick (advancing the virtual clock with
  // it) until a click gets queued inside the lookahead window.
  function waitForQueue() {
    let guard = 0;
    while (timeouts.size === 0) {
      now += LOOKAHEAD_MS / 1000;
      tickScheduler();
      if (++guard > 1000) throw new Error("scheduler never queued a click");
    }
  }

  // Advance to the next queued click's sounding time and fire its indicator.
  function advanceBeat() {
    waitForQueue();
    const next = [...timeouts.values()].sort((a, b) => a.at - b.at)[0];
    now = next.at;
    fireDueTimeouts();
  }

  function collectBeats(n) {
    const start = beatEvents.length;
    for (let i = 0; i < n; i++) advanceBeat();
    return beatEvents.slice(start).map((e) => e.beat);
  }

  return {
    engine,
    clicks,
    cancelled,
    beatEvents,
    timeouts,
    tickScheduler,
    waitForQueue,
    fireDueTimeouts,
    advanceBeat,
    collectBeats,
    setTime: (t) => {
      now = t;
    },
    get time() {
      return now;
    },
  };
}

test("downbeats land on beat 1 of every bar at start", () => {
  const h = makeHarness({ bpm: 60, beatsPerBar: 4 });
  h.engine.start();

  const beats = h.collectBeats(9);
  assert.deepEqual(beats, [0, 1, 2, 3, 0, 1, 2, 3, 0]);

  // Every emitted click agrees with the bar position it claims.
  for (const click of h.clicks) {
    assert.equal(click.isDownbeat, click.beatIndex === 0);
  }
  assert.deepEqual(
    h.clicks.map((c) => c.beatIndex),
    [0, 1, 2, 3, 0, 1, 2, 3, 0],
  );
});

test("changing time signature while running restarts from the new bar's beat 1", () => {
  // Fast tempo (0.2 s/beat) so several clicks sit inside the 0.1 s lookahead
  // window and the pending-set teardown has more than one entry to clear.
  const h = makeHarness({ bpm: 300, beatsPerBar: 4 });
  h.engine.start();
  assert.deepEqual(h.collectBeats(2), [0, 1]); // mid-bar: two beats of 4/4 played

  // Queue the next clicks under the old signature, then switch to 3/4.
  h.waitForQueue();
  const clicksBeforeSwitch = h.clicks.length;
  // Sounded clicks stay in the log, so "pending" means scheduled in the future.
  const oldPending = h.clicks.filter((c) => !c.cancelled && c.time > h.time);
  assert.ok(oldPending.length > 0);
  assert.equal(oldPending[0].beatIndex, 2);
  const oldTime = oldPending[0].time;
  const pendingVisuals = h.timeouts.size;
  assert.ok(pendingVisuals > 0);

  h.engine.setBeatsPerBar(3);

  // Every click queued under the old signature is pulled back, along with
  // every indicator update it had scheduled...
  assert.deepEqual(h.cancelled, oldPending);
  assert.ok(oldPending.every((c) => c.cancelled));
  // ...and a fresh set of clicks is re-queued in its place.
  assert.equal(h.timeouts.size, pendingVisuals);
  assert.ok(h.timeouts.size > 0);

  // The new bar starts on beat 0 at the earliest pending time: gap-free.
  const newClicks = h.clicks.slice(clicksBeforeSwitch);
  assert.ok(newClicks.length > 0);
  assert.equal(newClicks[0].beatIndex, 0);
  assert.equal(newClicks[0].isDownbeat, true);
  assert.equal(newClicks[0].time, oldTime);

  // All subsequent bars follow the new 3/4 count, no inherited offset.
  assert.deepEqual(h.collectBeats(7), [0, 1, 2, 0, 1, 2, 0]);
  for (const click of h.clicks.slice(-7)) {
    assert.equal(click.isDownbeat, click.beatIndex === 0);
  }
});

test("changing BPM while running keeps the bar position and only retunes future gaps", () => {
  const h = makeHarness({ bpm: 60, beatsPerBar: 4 }); // 1 s per beat
  h.engine.start();
  assert.deepEqual(h.collectBeats(4), [0, 1, 2, 3]);
  const timeBefore = h.time;

  h.engine.setBpm(120); // 0.5 s per beat; position must NOT reset

  // The bar continues from its next position (beat 0 of the next bar)...
  assert.deepEqual(h.collectBeats(5), [0, 1, 2, 3, 0]);
  // ...and the new gaps use the new tempo while the first downbeat kept the
  // already-scheduled time (no jump, no double-length gap).
  const newClicks = h.clicks.slice(-5);
  assert.equal(newClicks[0].time, timeBefore + 1);
  for (let i = 1; i < newClicks.length; i++) {
    assert.ok(Math.abs(newClicks[i].time - newClicks[i - 1].time - 0.5) < 1e-9);
  }
  for (const click of newClicks) {
    assert.equal(click.isDownbeat, click.beatIndex === 0);
  }
});

test("stop cancels queued clicks and indicator flashes, and restart begins on the downbeat", () => {
  const h = makeHarness({ bpm: 60, beatsPerBar: 4 });
  h.engine.start();
  assert.deepEqual(h.collectBeats(1), [0]);

  // One click is already queued for the future when the user hits stop.
  h.waitForQueue();
  const queuedClick = h.clicks.at(-1);
  assert.equal(queuedClick.cancelled, false);
  assert.equal(h.timeouts.size, 1);

  h.engine.stop();
  assert.equal(h.engine.isRunning, false);
  assert.ok(queuedClick.cancelled);
  assert.equal(h.timeouts.size, 0); // no indicator update can fire later
  assert.deepEqual(h.beatEvents.at(-1), { beat: null, at: h.time });

  // Let the audio clock run well past the cancelled click: nothing sounds.
  const eventsBefore = h.beatEvents.length;
  h.setTime(h.time + 10);
  h.fireDueTimeouts();
  h.tickScheduler(); // no interval is registered anymore
  assert.equal(h.beatEvents.length, eventsBefore);

  // Restart must begin a fresh bar on beat 1 (the downbeat).
  h.engine.start();
  assert.equal(h.engine.currentBeatInBar, 0);
  assert.deepEqual(h.collectBeats(4), [0, 1, 2, 3]);
  assert.equal(h.clicks.at(-4).isDownbeat, true);
  assert.equal(h.clicks.at(-4).beatIndex, 0);
});

test("the indicator switches when a click sounds, not when it is scheduled", () => {
  const h = makeHarness({ bpm: 60, beatsPerBar: 3, startTime: 10 });
  h.engine.start();

  // After a scheduler pass the click is queued ~50 ms in the future, but no
  // indicator event may fire yet.
  h.tickScheduler();
  const clickTime = h.clicks[0].time;
  assert.ok(clickTime > h.time);
  assert.equal(h.beatEvents.length, 0);

  // Reaching the click's actual sounding time flips the indicator exactly then.
  h.setTime(clickTime);
  h.fireDueTimeouts();
  assert.deepEqual(h.beatEvents, [{ beat: 0, at: clickTime }]);

  h.advanceBeat();
  assert.equal(h.beatEvents.at(-1).beat, 1);
  h.advanceBeat();
  assert.equal(h.beatEvents.at(-1).beat, 2);
});

test("downbeat and normal click pitches are 1200 Hz and 800 Hz", () => {
  assert.equal(DOWNBEAT_FREQUENCY, 1200);
  assert.equal(NORMAL_FREQUENCY, 800);
});

test("the UI keeps the 30-280 BPM range and the 2/3/4/6 time-signature options", async () => {
  const source = await readFile(
    new URL("../app/metronome/Metronome.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /const MIN_BPM = 30;/);
  assert.match(source, /const MAX_BPM = 280;/);
  assert.match(source, /const options = \[2, 3, 4, 6\];/);
});
