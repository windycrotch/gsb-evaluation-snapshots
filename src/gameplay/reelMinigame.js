// The reel-in fight: tension vs catch-progress with telegraphed surges, fish
// fatigue, gear modifiers, a wandering fight point on the water, leaping fish
// during surges, and the final landing arc into the boat/dock.
//
// Lifecycle contract:
//  - freeze()/unfreeze(): while frozen, update() is a no-op, so the fight
//    timer, tension, progress, surge cycle and jump/landing animations all
//    stop dead and resume exactly where they left off. Reeling input raised
//    during a freeze is ignored.
//  - finish*() handles in-fight outcomes (snap / escape / landed). It fires
//    its outcome event at most once, then tears the fight down.
//  - abort() tears a fight down WITHOUT any outcome event (location switch,
//    quit to menu, forced cleanup). It is idempotent and safe to call on an
//    idle or frozen fight, and guarantees no further fight:* events can be
//    emitted afterwards. end() is the silent-cleanup alias used by old code.

import * as THREE from "three";
import { CONFIG } from "../data/config.js";
import { events } from "../state/gameState.js";
import { FISH_BY_ID } from "../data/fishData.js";
import { createFishMesh } from "../fish/fishFactory.js";
import { clamp, lerp, randRange } from "../utils/utils.js";

const WATER_Y = CONFIG.water.level;

export class ReelFight {
  constructor(scene, effects, audio) {
    this.scene = scene;
    this.effects = effects;
    this.audio = audio;
    this.active = false;
    this.frozen = false;
    this.phase = "idle"; // idle | fight | landing
    this.fishPoint = new THREE.Vector3();
    this.playerSpot = new THREE.Vector3();
    this.fishMesh = null;
    this.fish = null;
    this.jump = null;
    this.landing = null;
  }

  /**
   * @param {object} fish   rolled fish instance
   * @param {Vector3} startPos bobber position when hooked
   * @param {Vector3} playerSpot
   * @param {object} stats { reelSpeed, lineStrength, control }
   */
  start(fish, startPos, playerSpot, stats) {
    // Never start on top of a half-torn-down fight: clear it silently first.
    this.teardown();

    this.fish = fish;
    this.stats = stats;
    this.playerSpot.copy(playerSpot);
    this.active = true;
    this.frozen = false;
    this.phase = "fight";
    this.t = 0;
    this.reeling = false;
    this.tension = CONFIG.reel.startTension;
    this.progress = CONFIG.reel.startProgress;

    const dx = startPos.x - playerSpot.x;
    const dz = startPos.z - playerSpot.z;
    this.startDist = Math.max(4, Math.sqrt(dx * dx + dz * dz));
    this.angle = Math.atan2(dx, dz); // angle around player, z-forward convention
    this.angleDrift = randRange(0.2, 0.5) * (Math.random() < 0.5 ? -1 : 1);
    this.fishPoint.copy(startPos);
    this.fishPoint.y = WATER_Y;

    this.surgeState = "calm"; // calm | telegraph | active
    this.surgeTimer = randRange(...fish.fight.surgeEvery) * 0.7; // first surge comes a bit early
    this.surgeT = 0;
    this.splashTimer = 0;

    // a real mesh of the actual rolled fish, revealed during jumps + landing
    this.fishMesh = createFishMesh(FISH_BY_ID[fish.speciesId], fish.sizeCm);
    this.fishMesh.visible = false;
    this.scene.add(this.fishMesh);
    this.jump = null;
    this.landing = null;
  }

  /** Pause every time-driven part of the fight and drop any held input. */
  freeze() {
    if (!this.active) return;
    this.frozen = true;
    this.reeling = false;
  }

  /** Resume a frozen fight; its state is untouched so it continues in place. */
  unfreeze() {
    if (!this.active) return;
    this.frozen = false;
  }

  setReeling(on) {
    // Input while paused (or after the fight is over) must never move state.
    if (!this.active || this.frozen) return;
    if (this.phase === "fight") this.reeling = on;
  }

  /**
   * External teardown for leaving a fight without an outcome: switching
   * fishing spots, returning to the main menu, or any forced cleanup.
   * Removes the fish model and clears surge/jump/landing/input state. Never
   * emits fight:snap / fight:escape / fight:landed and is safe to repeat.
   */
  abort() {
    this.teardown();
  }

  /** Backwards-compatible silent cleanup alias (same semantics as abort). */
  end() {
    this.teardown();
  }

  teardown() {
    this.active = false;
    this.frozen = false;
    this.phase = "idle";
    this.reeling = false;
    if (this.fishMesh) {
      this.scene.remove(this.fishMesh);
      this.fishMesh = null;
    }
    this.jump = null;
    this.landing = null;
    this.surgeState = "calm";
    this.surgeTimer = 0;
    this.surgeT = 0;
    this.splashTimer = 0;
    this.fish = null;
  }

  /**
   * Resolve an in-fight outcome. Guarded so a snap/escape/landed event can
   * only ever fire once: the first call tears the fight down, and any later
   * update() returns at the frozen/inactive guard before reaching here.
   */
  finishOutcome(event, payload) {
    if (!this.active) return;
    const fish = this.fish;
    this.teardown();
    events.emit(event, { fish, ...payload });
  }

  get tired() {
    return this.fish !== null && this.t > this.fish.fight.stamina;
  }

  // ---------- surge cycle ----------

  updateSurge(dt) {
    const f = this.fish.fight;
    if (this.surgeState === "calm") {
      this.surgeTimer -= dt;
      if (this.surgeTimer <= 0) {
        this.surgeState = "telegraph";
        this.surgeT = CONFIG.reel.telegraphTime;
        this.audio.play("surgeWarn");
        this.tryJump();
      }
    } else if (this.surgeState === "telegraph") {
      this.surgeT -= dt;
      if (this.surgeT <= 0) {
        this.surgeState = "active";
        this.surgeT = randRange(...CONFIG.reel.surgeDuration);
      }
    } else if (this.surgeState === "active") {
      this.surgeT -= dt;
      if (this.surgeT <= 0) {
        this.surgeState = "calm";
        const spacing = this.tired ? CONFIG.reel.tiredSurgeSpacing : 1;
        this.surgeTimer = randRange(...f.surgeEvery) * spacing;
      }
    }
  }

  tryJump() {
    if (this.fish.sizeCm < 30 || Math.random() > 0.75) {
      this.effects.splash(this.fishPoint, 0.9);
      return;
    }
    this.jump = { t: 0, dur: 0.85, from: this.fishPoint.clone() };
    this.effects.splash(this.fishPoint, 1.2);
    this.audio.play("splash", { strength: 0.8 });
  }

  updateJump(dt) {
    if (!this.jump) return;
    this.jump.t += dt;
    const k = this.jump.t / this.jump.dur;
    if (k >= 1) {
      this.effects.splash(this.fishPoint, 1.1);
      this.effects.ripple(this.fishPoint, 2.4, 1);
      this.fishMesh.visible = false;
      this.jump = null;
      return;
    }
    const h = clamp(this.fish.sizeCm / 110, 0.5, 2.2);
    const arc = Math.sin(k * Math.PI) * h;
    this.fishMesh.visible = true;
    this.fishMesh.position.set(this.fishPoint.x, WATER_Y + arc, this.fishPoint.z);
    this.fishMesh.rotation.z = lerp(0.9, -1.2, k);
    this.fishMesh.rotation.y = this.angle + Math.PI / 2;
  }

  // ---------- main update ----------

  update(dt) {
    // A torn-down or paused fight does nothing at all — no timers, no
    // tension/progress drift, no surge or jump animation, no HUD events.
    if (!this.active || this.frozen) return;

    if (this.phase === "landing") {
      this.updateLanding(dt);
      return;
    }

    const R = CONFIG.reel;
    const f = this.fish.fight;
    this.t += dt;

    const strength = f.strength * (this.tired ? R.tiredStrengthMult : 1);
    const { reelSpeed, lineStrength, control } = this.stats;

    this.updateSurge(dt);
    this.updateJump(dt);
    const surging = this.surgeState === "active";

    if (this.reeling) {
      // rod control tames how vicious a surge is allowed to get
      const surgeMult = surging ? 1 + (R.surgeReelMult - 1) / control : 1;
      this.tension += dt * R.tensionGain * strength * surgeMult / lineStrength;
      this.progress += dt * (R.reelRate * reelSpeed / f.heft) * (surging ? 0.55 : 1);
    } else {
      this.tension -= dt * R.tensionRecover * (surging ? 0.45 : 1);
      if (surging) this.tension += dt * R.surgeRestGain * strength / lineStrength;
      this.progress -= dt * R.escapeRate * strength * (surging ? 1.5 : 0.9);
    }

    // fail states checked on raw values before clamping for display
    if (this.tension >= 100) {
      this.finishOutcome("fight:snap", {});
      return;
    }
    if (this.progress <= 0 && this.t > R.escapeGraceTime) {
      this.finishOutcome("fight:escape", { reason: "It slipped the hook and swam off..." });
      return;
    }
    if (this.t > R.maxFightTime) {
      this.finishOutcome("fight:escape", { reason: "It outlasted you and shook free..." });
      return;
    }

    this.tension = clamp(this.tension, 0, 100);

    if (this.progress >= 100) {
      this.beginLanding();
      return;
    }

    // fight point wanders around the player and closes in with progress
    const dist = lerp(this.startDist, R.minFishDist, this.progress / 100);
    this.angle += Math.sin(this.t * 0.7) * this.angleDrift * dt;
    if (surging) this.angle += Math.sin(this.t * 6) * 1.1 * dt;
    this.fishPoint.set(
      this.playerSpot.x + Math.sin(this.angle) * dist,
      WATER_Y,
      this.playerSpot.z + Math.cos(this.angle) * dist
    );

    this.splashTimer -= dt;
    if (this.splashTimer <= 0 && !this.jump) {
      this.effects.ripple(this.fishPoint, surging ? 2.2 : 1.4, 0.8);
      if (surging || Math.random() < 0.4) this.effects.splash(this.fishPoint, surging ? 0.8 : 0.4);
      this.splashTimer = surging ? 0.13 : 0.26;
    }

    events.emit("fight:update", {
      tension: this.tension,
      progress: clamp(this.progress, 0, 100),
      surge: this.surgeState,
      time: this.t,
    });
  }

  // ---------- landing ----------

  beginLanding() {
    this.phase = "landing";
    this.reeling = false;
    this.effects.splash(this.fishPoint, 1.6);
    this.effects.ripple(this.fishPoint, 3.4, 1.4);
    this.audio.play("splash", { strength: 1.3 });
    const from = this.fishPoint.clone();
    from.y = WATER_Y;
    const to = this.playerSpot.clone();
    to.y += 1.1;
    const mid = from.clone().lerp(to, 0.5);
    mid.y += 3.4;
    this.landing = { t: 0, dur: 0.9, from, mid, to };
    events.emit("fight:update", { tension: 0, progress: 100, surge: "calm", landing: true });
  }

  updateLanding(dt) {
    const L = this.landing;
    L.t += dt;
    const k = clamp(L.t / L.dur, 0, 1);
    // quadratic bezier through the high midpoint
    const a = L.from.clone().lerp(L.mid, k);
    const b = L.mid.clone().lerp(L.to, k);
    const p = a.lerp(b, k);
    this.fishMesh.visible = true;
    this.fishMesh.position.copy(p);
    this.fishMesh.rotation.y += dt * 4;
    this.fishMesh.rotation.z = lerp(0.8, -0.4, k);
    if (k >= 1) {
      this.finishOutcome("fight:landed", {});
    }
  }
}
