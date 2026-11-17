// ReelFight lifecycle tests with a fake scene / effects / audio and the local
// offline THREE stub. Covers:
//   1. freeze() fully stops the fight (timers, tension, progress, surge
//      cycle, jump & landing animation, effects, audio and HUD events) and
//      unfreeze() resumes from the exact frozen state.
//   2. leaving a fight (abort/end, snap, escape, landing) cleans up the fish
//      model, surge state and input flags, and outcome events fire once.
//   3. an aborted fight can never push another fight:update to the HUD.
//   4. the normal snap (one snaps-worthy event) and landing (fight:landed
//      after the landing animation) paths are unchanged.

import { events } from "../src/state/gameState.js";
import { FISH_BY_ID } from "../src/data/fishData.js";
import { CONFIG } from "../src/data/config.js";
import { ReelFight } from "../src/gameplay/reelMinigame.js";
import { describe, it, ok, eq, approxEq } from "./harness.js";
// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

class FakeScene {
  constructor() {
    this.added = [];
    this.removed = [];
  }
  add(obj) {
    this.added.push(obj);
  }
  remove(obj) {
    this.removed.push(obj);
  }
}

function makeEffects() {
  return {
    splashes: 0,
    ripples: 0,
    lastSplash: null,
    lastRipple: null,
    splash(pos, strength) {
      this.splashes += 1;
      this.lastSplash = { pos: pos.clone ? pos.clone() : { ...pos }, strength };
    },
    ripple(pos, scale, dur) {
      this.ripples += 1;
      this.lastRipple = { pos: pos.clone ? pos.clone() : { ...pos }, scale, dur };
    },
  };
}

function makeAudio() {
  return {
    plays: [],
    play(name, opts) {
      this.plays.push({ name, opts: opts ? { ...opts } : undefined });
    },
  };
}

function makeFish(overrides = {}) {
  const species = FISH_BY_ID.bluegill;
  return {
    speciesId: species.id,
    name: species.name,
    rarity: species.rarity,
    sizeCm: 20,
    weightKg: 0.3,
    value: 6,
    xp: 12,
    sizeNorm: 0.5,
    stars: 1,
    fight: {
      strength: species.fight.strength,
      surgeEvery: [...species.fight.surgeEvery],
      heft: species.fight.heft,
      stamina: species.fight.stamina,
    },
    ...overrides,
  };
}

const STATS = { reelSpeed: 1, lineStrength: 1, control: 1 };

function makeFight(overrides = {}) {
  const scene = new FakeScene();
  const effects = makeEffects();
  const audio = makeAudio();
  const fight = new ReelFight(scene, effects, audio);
  fight.start(
    makeFish(overrides.fish),
    { x: 0, y: 0, z: 10, clone() { return { ...this }; } },
    { x: 0, y: 0, z: 0, clone() { return { ...this }; } },
    overrides.stats || STATS
  );
  return { fight, scene, effects, audio };
}

/** Collect every payload emitted on one or more events for the duration of fn(). */
async function collect(eventNames, fn) {
  const names = Array.isArray(eventNames) ? eventNames : [eventNames];
  const got = [];
  const offs = names.map((name) => events.on(name, (d) => got.push(d)));
  try {
    await fn();
  } finally {
    for (const off of offs) off();
  }
  return got;
}

function snapState(fight) {
  return {
    t: fight.t,
    tension: fight.tension,
    progress: fight.progress,
    surgeState: fight.surgeState,
    surgeTimer: fight.surgeTimer,
    surgeT: fight.surgeT,
    phase: fight.phase,
    reeling: fight.reeling,
    point: { ...fight.fishPoint },
    jump: fight.jump ? { ...fight.jump } : null,
    meshPos: fight.fishMesh ? { ...fight.fishMesh.position } : null,
    meshVisible: fight.fishMesh ? fight.fishMesh.visible : null,
  };
}

// ---------------------------------------------------------------------------
// suites
// ---------------------------------------------------------------------------

export default async function reelFightSuite() {
  describe("freeze / unfreeze", () => {
    it("pauses timer, tension, progress, point drift and HUD events while frozen", async () => {
      const { fight, effects } = makeFight();

      fight.update(0.5); // let it accumulate some state first
      const before = snapState(fight);
      ok(before.t > 0, "fight should have advanced before the freeze");

      const updates = await collect("fight:update", async () => {
        fight.freeze();
        ok(fight.frozen && fight.active, "frozen flag set while still active");
        fight.update(0.25);
        fight.update(0.25);
        fight.update(0.5);
      });

      eq(updates.length, 0, "no fight:update HUD events while frozen");

      const frozen = snapState(fight);
      approxEq(frozen.t, before.t, 1e-12, "fight timer frozen");
      approxEq(frozen.tension, before.tension, 1e-12, "tension frozen");
      approxEq(frozen.progress, before.progress, 1e-12, "progress frozen");
      eq(frozen.surgeState, before.surgeState, "surge cycle frozen");
      approxEq(frozen.surgeTimer, before.surgeTimer, 1e-12, "surge timer frozen");
      approxEq(frozen.surgeT, before.surgeT, 1e-12, "surge phase timer frozen");
      eq(frozen.point.x, before.point.x, "fight point x frozen");
      eq(frozen.point.z, before.point.z, "fight point z frozen");
      const effectsAfterFreeze = { s: effects.splashes, r: effects.ripples };
      fight.update(0.3);
      eq(effects.splashes, effectsAfterFreeze.s, "no splash effects while frozen");
      eq(effects.ripples, effectsAfterFreeze.r, "no ripple effects while frozen");

      fight.unfreeze();
      ok(!fight.frozen && fight.active, "unfrozen but still active");
      fight.update(0.25);
      const resumed = snapState(fight);
      approxEq(resumed.t, before.t + 0.25, 1e-12, "timer continues from frozen value");
      ok(resumed.tension !== before.tension || resumed.progress !== before.progress,
        "tension/progress move again after resume");
    });

    it("ignores reeling input raised during the freeze and clears the held flag", () => {
      const { fight } = makeFight();
      fight.setReeling(true);
      eq(fight.reeling, true, "reeling engages while running");

      fight.freeze();
      eq(fight.reeling, false, "freeze drops the held-input flag");
      fight.setReeling(true);
      eq(fight.reeling, false, "setReeling(true) cannot take hold while frozen");
      fight.update(0.5);
      eq(fight.reeling, false, "reeling stays off through frozen updates");

      fight.unfreeze();
      fight.setReeling(true);
      eq(fight.reeling, true, "reeling works again after resume");
    });

    it("freezes the telegraphed surge cycle so its rhythm resumes in place", () => {
      const { fight, audio } = makeFight();
      // force the calm timer to expire on the next update -> telegraph + warn
      fight.surgeState = "calm";
      fight.surgeTimer = 0.01;

      fight.update(0.1);
      eq(fight.surgeState, "telegraph", "surge telegraph starts");
      const warnCount = audio.plays.filter((p) => p.name === "surgeWarn").length;
      eq(warnCount, 1, "one surge warning cue");
      const telegraphT = fight.surgeT;

      fight.freeze();
      for (let i = 0; i < 5; i++) fight.update(0.3);
      eq(fight.surgeState, "telegraph", "surge never goes active while frozen");
      approxEq(fight.surgeT, telegraphT, 1e-12, "telegraph countdown frozen");
      eq(audio.plays.filter((p) => p.name === "surgeWarn").length, 1,
        "no extra warning cues while frozen");

      fight.unfreeze();
      fight.update(CONFIG.reel.telegraphTime + 0.05);
      eq(fight.surgeState, "active", "surge activates after resume, on the frozen schedule");
    });

    it("freezes a jump animation: the fish mesh keeps its frozen pose", () => {
      const big = makeFish({ sizeCm: 50 }); // big enough to be eligible for jumps
      const { fight } = makeFight({ fish: big });
      fight.surgeState = "calm";
      fight.surgeTimer = 0.01;
      // make the jump roll deterministic for this assertion
      const origRandom = Math.random;
      Math.random = () => 0.1; // <= 0.75 so a jump starts
      try {
        fight.update(0.1);
      } finally {
        Math.random = origRandom;
      }
      ok(fight.jump, "a jump started with the telegraph");
      ok(fight.fishMesh.visible, "fish mesh shown during the jump");

      fight.update(0.2);
      const frozen = snapState(fight);
      fight.freeze();
      fight.update(0.4);
      fight.update(0.4);
      const still = snapState(fight);
      eq(still.jump.t, frozen.jump.t, "jump animation timer frozen");
      eq(still.meshPos.y, frozen.meshPos.y, "fish mesh height frozen mid-jump");
      eq(still.meshVisible, true, "mesh stays visible at the frozen pose");

      fight.unfreeze();
      fight.update(1); // longer than the 0.85s jump duration
      eq(fight.jump, null, "jump completes after resume");
      eq(fight.fishMesh.visible, false, "fish hidden again once the jump lands");
    });

    it("freezes the landing arc and still emits fight:landed exactly once after resume", async () => {
      const { fight } = makeFight();
      fight.tension = 50;
      fight.progress = 99.9;
      fight.setReeling(true);
      fight.update(0.5); // crosses 100 -> beginLanding()
      eq(fight.phase, "landing", "fight moved into the landing phase");
      ok(fight.landing, "landing arc data exists");

      fight.update(0.3);
      const frozenK = fight.landing.t / fight.landing.dur;
      ok(frozenK < 1, "landing still in progress");
      const frozenPos = { ...fight.fishMesh.position };

      const landed = await collect("fight:landed", async () => {
        fight.freeze();
        fight.update(0.3);
        fight.update(0.3);
        eq(fight.landing.t, frozenK * fight.landing.dur, "landing animation frozen");
        eq(fight.fishMesh.position.x, frozenPos.x, "landing mesh position frozen");
        fight.unfreeze();
        fight.update(1); // finish the arc
        fight.update(1); // extra frames must not re-emit
      });

      eq(landed.length, 1, "fight:landed fires exactly once");
      eq(fight.active, false, "fight is over after landing");
      eq(fight.phase, "idle", "phase back to idle");
      eq(fight.fishMesh, null, "fish mesh removed after landing");
    });

    it("is a harmless no-op when there is no active fight", () => {
      const { fight } = makeFight();
      fight.abort();
      fight.freeze();
      eq(fight.frozen, false, "cannot freeze an idle fight");
      fight.unfreeze();
      fight.update(1); // must not throw
      eq(fight.active, false, "stays idle");
    });
  });

  describe("teardown and outcome events", () => {
    it("abort() removes the fish model and clears surge/jump/input state silently", async () => {
      const big = makeFish({ sizeCm: 50 });
      const { fight, scene } = makeFight({ fish: big });
      fight.setReeling(true);
      fight.surgeState = "active";
      fight.surgeT = 0.5;
      fight.jump = { t: 0.2, dur: 0.85, from: { x: 0, y: 0, z: 10 } };
      const mesh = fight.fishMesh;
      ok(scene.added.includes(mesh), "fish mesh was attached to the scene");

      const eventsSeen = await collect(
        ["fight:snap", "fight:escape", "fight:landed", "fight:update"],
        async () => {
          fight.abort();
          fight.update(0.5);
          fight.abort(); // idempotent
        }
      );

      eq(eventsSeen.length, 0, "abort emits no fight events at all");
      eq(fight.active, false, "no longer active");
      eq(fight.frozen, false, "frozen flag cleared");
      eq(fight.phase, "idle", "phase idle");
      eq(fight.reeling, false, "held-input flag cleared");
      eq(fight.fishMesh, null, "fish mesh reference dropped");
      eq(fight.jump, null, "jump state cleared");
      eq(fight.landing, null, "landing state clear");
      eq(fight.surgeState, "calm", "surge state reset");
      eq(fight.fish, null, "fish instance released");
      ok(scene.removed.includes(mesh), "fish mesh removed from the scene");
    });

    it("can abort a frozen fight (pause -> quit / travel) without side effects", () => {
      const { fight } = makeFight();
      fight.update(0.4);
      fight.freeze();
      ok(fight.frozen, "precondition: frozen");
      fight.abort();
      eq(fight.active, false, "abort works while frozen");
      eq(fight.frozen, false, "frozen flag cleared by abort");
      eq(fight.fishMesh, null, "mesh cleaned up even from a frozen fight");
    });

    it("end() behaves identically to abort() (silent cleanup)", () => {
      const { fight, scene } = makeFight();
      const mesh = fight.fishMesh;
      fight.end();
      eq(fight.active, false, "end deactivates");
      eq(fight.fishMesh, null, "end drops the mesh");
      ok(scene.removed.includes(mesh), "end removes the mesh from the scene");
    });

    it("snap fires exactly once when tension hits 100, even with further updates", async () => {
      const { fight } = makeFight();
      const snaps = await collect("fight:snap", async () => {
        fight.tension = 99.9;
        fight.setReeling(true);
        fight.update(0.5); // tension crosses 100
        fight.update(0.5); // must be ignored: fight already torn down
        fight.update(0.5);
      });
      eq(snaps.length, 1, "exactly one fight:snap (no duplicate line-break event)");
      ok(snaps[0].fish, "snap payload still carries the fish");
      eq(fight.active, false, "fight torn down after the snap");
      eq(fight.reeling, false, "input flag cleared after the snap");
      eq(fight.fishMesh, null, "fish model removed after the snap");
    });

    it("escape fires once when progress drains to zero past the grace window", async () => {
      const { fight } = makeFight();
      const escapes = await collect("fight:escape", async () => {
        fight.t = CONFIG.reel.escapeGraceTime + 0.1;
        fight.progress = 0.1;
        fight.setReeling(false);
        fight.update(0.5); // progress drains below zero
        fight.update(0.5);
      });
      eq(escapes.length, 1, "exactly one escape event");
      eq(escapes[0].reason, "It slipped the hook and swam off...", "escape reason preserved");
      eq(fight.active, false, "fight torn down after escape");
      eq(fight.fishMesh, null, "fish model removed after escape");
    });

    it("timeout escape fires once when the fight exceeds maxFightTime", async () => {
      const { fight } = makeFight();
      const escapes = await collect("fight:escape", async () => {
        fight.t = CONFIG.reel.maxFightTime;
        fight.tension = 40;
        fight.progress = 50;
        fight.update(0.1);
        fight.update(0.1);
      });
      eq(escapes.length, 1, "one timeout escape");
      eq(escapes[0].reason, "It outlasted you and shook free...");
      eq(fight.active, false, "fight torn down");
    });

    it("normal landing path: landing animation then a single fight:landed", async () => {
      const { fight, effects, audio } = makeFight();
      fight.tension = 50;
      fight.progress = 99;
      fight.setReeling(true);

      const updates = await collect("fight:update", async () => {
        fight.update(0.5); // progress >= 100 -> beginLanding
      });
      eq(fight.phase, "landing", "enters landing, not an instant settle");
      ok(updates.some((u) => u.landing === true), "HUD told the landing animation started");
      ok(effects.ripples > 0 && effects.splashes > 0, "landing splash/ripple effects play");
      ok(audio.plays.some((p) => p.name === "splash"), "landing splash cue plays");

      const landed = await collect("fight:landed", async () => {
        fight.update(0.45); // mid-arc
        eq(fight.fishMesh.visible, true, "fish visible along the landing arc");
        fight.update(0.45); // arc completes
        fight.update(0.5); // no re-emit
      });
      eq(landed.length, 1, "single fight:landed after the animation");
      ok(landed[0].fish, "landed payload carries the fish");
      eq(fight.fishMesh, null, "mesh cleaned up after landing");
    });
  });

  describe("HUD isolation across spot switches", () => {
    it("an aborted fight never emits another fight:update; a new fight works normally", async () => {
      const first = makeFight();
      first.fight.update(0.3);
      first.fight.abort(); // simulate travelTo() leaving the old spot

      const stray = await collect("fight:update", async () => {
        first.fight.update(0.5);
        first.fight.update(0.5);
        first.fight.setReeling(true);
      });
      eq(stray.length, 0, "old fight cannot push HUD updates after the switch");

      const second = makeFight();
      const fresh = await collect("fight:update", async () => {
        second.fight.update(0.25);
      });
      ok(fresh.length >= 1, "the fight at the new spot pushes HUD updates");
      ok(second.scene.added.includes(second.fight.fishMesh), "new spot has its own fish mesh");
      ok(!first.scene.removed.includes(second.fight.fishMesh),
        "the two fights keep independent scenes/meshes");

      second.fight.abort();
    });

    it("restarting a fight cleans up the previous mesh before creating a new one", () => {
      const { fight, scene } = makeFight();
      const oldMesh = fight.fishMesh;
      fight.start(
        makeFish(),
        { x: 0, y: 0, z: 8, clone() { return { ...this }; } },
        { x: 0, y: 0, z: 0, clone() { return { ...this }; } },
        STATS
      );
      ok(scene.removed.includes(oldMesh), "previous fish mesh removed on restart");
      ok(fight.fishMesh && fight.fishMesh !== oldMesh, "a fresh mesh is created");
      eq(fight.phase, "fight", "restart begins in the fight phase");
      eq(fight.frozen, false, "restart is never frozen");
      eq(fight.t, 0, "restart resets the fight clock");
      fight.abort();
    });
  });
}
