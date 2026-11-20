/**
 * NOCTIS GP - race director.
 *
 * Owns every rule in the game: the state machine, the fixed-step physics
 * clock, car-to-car contact, checkpoint and lap accounting, boost pads,
 * standings and the results classification.
 *
 * Deliberately free of DOM, cameras, dust emission and menu wiring, so the
 * exact code the browser runs can also be driven headlessly by
 * tools/race-sim.ts. Presentation reads this object's public state each
 * frame; it never writes to it.
 */

import * as THREE from 'three';
import { clamp01 } from '../core/util';
import { LIVERIES } from '../core/liveries';
import type { Livery } from '../core/liveries';
import { CarSim, CATCHUP_SETTLE } from './car';
import { AIController } from './ai';
import { ItemField } from './items';
import { NEUTRAL_INPUT } from './types';
import type { DriveInput, ItemKind, ResultsData, SimEnv, StandingRow } from './types';

export const LAPS = 3;
export const CAR_COUNT = 8;
export const CHECKPOINTS = 12;
const FIXED_DT = 1 / 120;
const MAX_SUBSTEPS = 6;

/**
 * Catch-up tuning.
 *
 * A raw difficulty setting is the wrong tool for an arcade racer: the thing
 * that strands a new player is not that the AI is quick, it is that the pack
 * disappears over the horizon and there is nothing left to race. So instead of
 * making everyone slower, rivals close and open the gap by a few percent based
 * on where they are relative to the player.
 *
 * Deliberately weak: easing tops out at 16%, so a car in front can still win
 * and a player doing well gets no help at all.
 */
const CATCHUP_RANGE = 700; // metres of gap before the effect is at full strength
const CATCHUP_EASE = 0.16;
// CATCHUP_SETTLE (how long a teleported car is held at neutral) lives on
// CarSim, because every teleport goes through resetToTrack and that is what
// sets the hold. The director only reads it.

/**
 * How a car is built. The browser passes a factory that also creates the mesh,
 * shield and name tag; the headless verifier passes nothing and gets bare
 * simulation objects. This is the seam that keeps the rules render-agnostic.
 */
export type CarFactory = (livery: Livery, isPlayer: boolean, name: string) => CarSim;

export type RaceState = 'attract' | 'countdown' | 'race' | 'paused' | 'results';

/**
 * Total order for the classification.
 *
 * This is the single definition of "who is ahead", shared by the live
 * standings, the results board and the position readout, so those three can
 * never disagree. Every path ends in a distinct value, so no two cars can
 * compare equal and the sort can never leave their order up to the engine's
 * stability.
 *
 * Class groups: finished (0), still running (1), retired (2). A retired car is
 * behind every car still on the road even if it covered more distance, which
 * is the only reading of "withdrawn" that cannot be gamed by stopping on the
 * line.
 */
export function compareClassified(a: CarSim, b: CarSim): number {
  const ga = a.finished ? 0 : a.retired ? 2 : 1;
  const gb = b.finished ? 0 : b.retired ? 2 : 1;
  if (ga !== gb) return ga - gb;

  if (ga === 0) {
    // Finished: earlier clock wins. Same-substep crossings share a clock, so
    // fall through to the interpolated position within the substep.
    if (a.finishTime !== b.finishTime) return a.finishTime - b.finishTime;
    if (a.finishCrossFrac !== b.finishCrossFrac) return a.finishCrossFrac - b.finishCrossFrac;
    if (a.finishOrder !== b.finishOrder) return a.finishOrder - b.finishOrder;
    return a.gridIndex - b.gridIndex;
  }

  // Both running or both retired: more distance covered ranks ahead.
  if (a.totalDist !== b.totalDist) return b.totalDist - a.totalDist;
  return a.gridIndex - b.gridIndex;
}

export interface GridRow {
  name: string;
  color: string;
  isPlayer: boolean;
  x: number;
  z: number;
  s: number;
  lap: number;
  finished: boolean;
}

/** Optional presentation hook, used by main.ts to drive the menu. */
export interface RaceEvents {
  onCountdown?(text: string | null): void;
  onNotice?(text: string, ms: number): void;
  onResults?(data: ResultsData): void;
  onStateChange?(state: RaceState): void;
}

export class RaceDirector {
  readonly env: SimEnv;
  readonly items: ItemField;
  readonly cars: CarSim[] = [];
  player!: CarSim;

  state: RaceState = 'attract';
  clock = 0;
  bestLap: number | null = null;
  order: CarSim[] = [];
  playerInput: DriveInput = { ...NEUTRAL_INPUT };

  countdownT = 0;
  private prevCountdown = 0;
  private acc = 0;
  private standingsT = 0;
  private wrongWayT = 0;
  private noticeT = 0;
  private finishDelay = 0;
  private usedItemPrev = false;
  /** Monotonic counter for cars taking the flag, breaks same-substep ties. */
  private finishCount = 0;
  /** Guards showResults so a delayed finish cannot emit the board twice. */
  private resultsShown = false;
  private events: RaceEvents = {};

  /**
   * Set each frame by the presenter. Return true on the frame the use-item key
   * goes down; the director edge-detects against the RETURN VALUE, never
   * against the existence of this function.
   */
  onItemRequested: (() => boolean) | null = null;

  /**
   * In a normal race the chequered flag falls when the PLAYER crosses the
   * line, and everyone still out on track is classified as running. The
   * verifier turns this off so it can prove that every car really can cover
   * the full three laps, rather than only the ones ahead of the player.
   */
  classifyOnPlayerFinish = true;

  /** Rival catch-up. Disabled by the verifier to measure its effect. */
  catchUp = true;

  private readonly carFactory: CarFactory;
  /** The eight race cars, built once and reused across restarts. */
  private raceField: CarSim[] | null = null;

  constructor(env: SimEnv, events: RaceEvents = {}, carFactory?: CarFactory) {
    this.env = env;
    this.events = events;
    this.carFactory = carFactory ?? ((livery, isPlayer, name) => new CarSim(null, { name, color: livery.color, isPlayer }));
    this.items = new ItemField(env);
    env.track.makeCheckpoints(CHECKPOINTS);
    this.spawnAttractPack();
  }

  setEvents(events: RaceEvents): void {
    this.events = events;
  }

  // ---- setup -------------------------------------------------------------

  private clearCars(): void {
    for (const c of this.cars) {
      if (c.mesh) this.env.scene.remove(c.mesh);
      if (c.shieldMesh) this.env.scene.remove(c.shieldMesh);
    }
    this.cars.length = 0;
  }

  private makeCar(livery: Livery, isPlayer: boolean, name?: string): CarSim {
    return this.carFactory(livery, isPlayer, name ?? livery.name);
  }

  /**
   * Attract mode runs two packs of four so the cinematic camera always has
   * traffic to frame, rather than one car on an empty circuit.
   */
  spawnAttractPack(): void {
    this.clearCars();
    const L = this.env.track.length;
    const packGap = 26;
    for (let i = 0; i < CAR_COUNT; i++) {
      const livery = LIVERIES[i];
      const sim = this.makeCar(livery, false);
      sim.gridIndex = i;
      const pack = i < 4 ? 0 : 0.5;
      const s = (pack + 0.002) * L + (i % 4) * packGap;
      const f = this.env.track.frameAt(s % L);
      sim.placeAt(f, s % L, this.env.terrain);
      sim.totalDist = s % L;
      // NOT disabled: the attract pack has to actually drive, because the
      // cinematic camera is framing it in motion.
      sim.ai = new AIController(sim, { skill: 0.9 + (i % 4) * 0.035, boldness: 0.9 + (i % 3) * 0.05 });
      this.cars.push(sim);
    }
    this.player = this.cars[0];
  }

  /**
   * Build the eight-car race field exactly once.
   *
   * Keeping the cars (and therefore their meshes, shields, name tags and
   * materials) alive across restarts avoids re-uploading the whole field to the
   * GPU every time the player hits RACE AGAIN. The cost is that correctness now
   * depends on the per-race reset being complete, which is why the reset lives
   * on CarSim/AIController rather than being an ad-hoc list in startRace: a
   * field that is reused MUST be indistinguishable from a fresh one.
   */
  private ensureRaceField(): CarSim[] {
    if (this.raceField) return this.raceField;
    const n = LIVERIES.length;
    const field: CarSim[] = [];
    for (let i = 0; i < n; i++) {
      const isPlayer = i === n - 1; // the player starts at the back
      const livery = LIVERIES[i];
      const sim = this.makeCar(livery, isPlayer, isPlayer ? 'YOU' : livery.name);
      sim.gridIndex = i;
      sim.ai = new AIController(sim, { skill: 0.92 + i * 0.013, boldness: 0.92 + ((i * 7) % 5) * 0.035 });
      field.push(sim);
    }
    this.raceField = field;
    return field;
  }

  /** Seat a car on its grid slot and arm it for a new race. */
  private seatOnGrid(sim: CarSim): void {
    const L = this.env.track.length;
    const i = sim.gridIndex;
    const row = Math.floor(i / 2);
    const col = i % 2;
    const s = L - 16 - row * 7.5;
    const f = this.env.track.frameAt(s);
    const lat = col === 0 ? -4.2 : 4.2;
    sim.placeAt({ ...f, x: f.x + f.rx * lat, z: f.z + f.rz * lat }, s, this.env.terrain);
    sim.totalDist = s - L;
    sim.disabled = true;
    sim.idling = true;
  }

  /**
   * Put the field back on the grid for a new race.
   *
   * The pool is reused, so every piece of per-race state - finish flag, finish
   * time, laps, lap times, checkpoints, retired flag, power-ups, and the AI's
   * smoothed catch-up bias - is reset explicitly. Continuous restarts are then
   * idempotent: restarting twice leaves the field exactly where restarting once
   * does, because the second start re-applies the same reset to the same
   * baseline rather than compounding the first.
   */
  private spawnRaceGrid(): void {
    this.clearCars();
    const field = this.ensureRaceField();
    for (const sim of field) {
      if (sim.mesh) this.env.scene.add(sim.mesh);
      this.seatOnGrid(sim);
      sim.resetRaceState();
      (sim.ai as AIController | null)?.resetForRace();
      this.cars.push(sim);
      if (sim.isPlayer) this.player = sim;
    }
  }

  // ---- public API --------------------------------------------------------

  startRace(): void {
    this.env.audio.ensure();
    this.env.audio.duck(false);
    // Re-seat and fully reset the field. spawnRaceGrid reuses the pool but
    // resets every piece of per-race state, so a restart is indistinguishable
    // from a fresh race.
    this.spawnRaceGrid();
    this.items.reset();
    // Race-level state is reset here rather than only at construction, because
    // startRace is the one entry point a restart (and a second restart) uses.
    this.state = 'countdown';
    this.countdownT = 3.9;
    this.prevCountdown = 4;
    this.clock = 0;
    this.acc = 0;
    this.bestLap = null;
    this.finishDelay = 0;
    this.wrongWayT = 0;
    this.noticeT = 0;
    this.usedItemPrev = false;
    this.wasBoosting = false;
    this.standingsT = 0;
    this.resultsShown = false;
    this.finishCount = 0;
    this.order = this.cars.slice();
    this.recomputeOrder();
    this.events.onStateChange?.(this.state);
  }

  pause(): void {
    if (this.state !== 'race' && this.state !== 'countdown') return;
    this.resumeTo = this.state;
    this.state = 'paused';
    this.env.audio.duck(true);
    this.events.onStateChange?.(this.state);
  }

  private resumeTo: RaceState = 'race';

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = this.resumeTo;
    this.env.audio.duck(false);
    this.events.onStateChange?.(this.state);
  }

  quitToMenu(): void {
    this.state = 'attract';
    this.env.audio.duck(true);
    this.spawnAttractPack();
    this.events.onCountdown?.(null);
    this.events.onStateChange?.(this.state);
  }

  resetPlayer(): void {
    if (this.state !== 'race') return;
    if (this.player.finished || this.player.retired) return;
    this.player.resetToTrack(this.env);
    this.player.disabled = false;
    // The teleport changed the reference point every rival's bias is measured
    // from, so hold the whole field at neutral while the old biases decay.
    this.holdCatchUp();
  }

  /**
   * Withdraw the player from the race.
   *
   * A retired car stops taking input and is classified behind the field. The
   * important part for catch-up is that it also stops being a reference: there
   * is no gap to chase any more, so every rival's bias is released to neutral
   * rather than frozen at whatever it was when the player parked.
   */
  retirePlayer(): void {
    if (this.state !== 'race' && this.state !== 'countdown') return;
    const p = this.player;
    if (p.retired || p.finished) return;
    p.retired = true;
    p.disabled = true;
    p.idling = true;
    p.item = null;
    this.finishDelay = 2.0;
    this.recomputeOrder();
    this.events.onNotice?.('RETIRED', 2000);
  }

  /**
   * Hold every rival's catch-up bias at neutral for a moment. Used whenever a
   * car is teleported, because the gap it measures is briefly an artefact.
   */
  private holdCatchUp(): void {
    for (const c of this.cars) {
      if (c === this.player || c.finished || c.retired) continue;
      c.catchUpHoldT = CATCHUP_SETTLE;
      // Apply the neutral target now, not on the next substep: the teleport
      // has already changed the reference, so there is no window in which the
      // old, artefact-driven target should still be live.
      (c.ai as AIController | null)?.setCatchUp(1);
    }
  }

  // ---- per-frame ---------------------------------------------------------

  update(dt: number): void {
    switch (this.state) {
      case 'attract':
        this.simulate(dt, 4);
        break;
      case 'countdown':
        this.updateCountdown(dt);
        break;
      case 'race':
        this.raceStep(dt);
        break;
      case 'results':
        // Slow-motion roll behind the results board.
        this.simulate(dt * 0.35, 4);
        break;
      case 'paused':
        break;
    }
  }

  /** Attract/results: AI only, no race logic. */
  private simulate(dt: number, maxSteps: number): void {
    this.acc += dt;
    let steps = 0;
    while (this.acc >= FIXED_DT && steps < maxSteps) {
      for (const c of this.cars) {
        const ai = c.ai as AIController | null;
        const input = c.retired ? NEUTRAL_INPUT : ai ? ai.computeInput(this.env, this.cars) : NEUTRAL_INPUT;
        c.step(input, FIXED_DT, this.env);
      }
      this.acc -= FIXED_DT;
      steps++;
    }
    if (steps >= maxSteps) this.acc = 0; // spiral-of-death guard
  }

  private updateCountdown(dt: number): void {
    this.prevCountdown = Math.ceil(this.countdownT);
    this.countdownT -= dt;
    const now = Math.ceil(this.countdownT);
    if (now !== this.prevCountdown) {
      if (now >= 1 && now <= 3) {
        this.events.onCountdown?.(String(now));
        this.env.audio.countdown(now);
      } else if (now === 0) {
        this.events.onCountdown?.('GO');
        this.env.audio.countdown(0);
      }
    }
    // Hold the grid, but let the idle shimmer animate.
    for (const c of this.cars) {
      c.disabled = true;
      c.throttleViz = 0.05 + 0.03 * Math.sin(performance.now() * 0.01 + c.pos.x);
    }
    if (this.countdownT <= -0.55) {
      this.events.onCountdown?.(null);
      for (const c of this.cars) {
        // A car withdrawn during the countdown stays withdrawn.
        c.disabled = c.retired;
        c.idling = c.retired;
        c.lapStart = 0;
      }
      this.state = 'race';
      this.clock = 0;
      this.events.onStateChange?.(this.state);
    }
  }

  private raceStep(dt: number): void {
    this.acc += dt;
    let steps = 0;
    while (this.acc >= FIXED_DT && steps < MAX_SUBSTEPS) {
      // The race clock advances with the physics, not with the render frame.
      // A frame can contain several substeps and two cars can cross the line
      // in different ones; if the clock only moved once per frame they would
      // share a finish time and their order would be arbitrary. Advancing it
      // per substep makes "who crossed first" a real, ordered quantity.
      this.clock += FIXED_DT;
      this.physicsSubstep(FIXED_DT);
      this.acc -= FIXED_DT;
      steps++;
    }
    if (steps >= MAX_SUBSTEPS) this.acc = 0;

    this.standingsT -= dt;
    if (this.standingsT <= 0) {
      this.standingsT = 0.25;
      this.recomputeOrder();
    }
    const pos = this.order.indexOf(this.player) + 1;

    // Wrong-way warning. A finished or retired player is not driving, so it
    // has no bearing on the warning or on item use.
    const p = this.player;
    if (!p.finished && !p.retired) {
      const f = this.env.track.frameAt(p.s);
      const facing = Math.sin(p.yaw) * f.tx + Math.cos(p.yaw) * f.tz;
      if (facing < -0.3 && p.speed > 12) this.wrongWayT += dt;
      else this.wrongWayT = 0;
      this.noticeT -= dt;
      if (this.wrongWayT > 0.8 && this.noticeT <= 0) {
        this.events.onNotice?.('WRONG WAY', 1400);
        this.noticeT = 3;
      }
    }

    // Item use is edge triggered, so holding the key fires exactly once.
    // The callback is INVOKED here: testing the reference itself would be
    // permanently true and the item would never fire at all.
    const useNow = this.onItemRequested ? !!this.onItemRequested() : false;
    if (useNow && !this.usedItemPrev && p.item && !p.finished && !p.retired) {
      this.items.useItem(p, this.cars);
    }
    this.usedItemPrev = useNow;

    this.items.update(dt, this.cars, (car) => this.order.indexOf(car) + 1, true);

    let near: CarSim | null = null;
    let nd = Infinity;
    for (const c of this.cars) {
      if (c === p) continue;
      const d = c.pos.distanceTo(p.pos);
      if (d < nd) {
        nd = d;
        near = c;
      }
    }
    this.env.audio.updateEngine(p, near ? { dist: nd, speed: near.speed } : null, dt);
    if (p.boosting && !this.wasBoosting) this.env.audio.whoosh();
    this.wasBoosting = p.boosting;

    // The flag falls when the PLAYER finishes or withdraws. A retirement runs
    // the field a little longer first, so the catch-up bias has visibly
    // settled before the board freezes the background.
    if ((p.finished || p.retired) && this.classifyOnPlayerFinish) {
      this.finishDelay -= dt;
      if (this.finishDelay <= 0) this.showResults();
    }
    void pos;
  }

  private wasBoosting = false;

  private physicsSubstep(dt: number): void {
    this.updateCatchUp(dt);
    for (const c of this.cars) {
      let input: DriveInput;
      if (c === this.player && !this.env.autopilot) {
        input = c.disabled || c.retired ? NEUTRAL_INPUT : this.playerInput;
      } else {
        const ai = c.ai as AIController | null;
        input = c.disabled || c.retired || !ai ? NEUTRAL_INPUT : ai.computeInput(this.env, this.cars);
      }
      c.step(input, dt, this.env);
    }

    for (let i = 0; i < this.cars.length; i++) {
      for (let j = i + 1; j < this.cars.length; j++) {
        this.contact(this.cars[i], this.cars[j]);
      }
    }

    for (const c of this.cars) this.raceLogic(c);

    // Recovery: an AI that ends up facing the wrong way, off in the boulder
    // field, or wedged, is put back on the line rather than left stranded.
    for (const c of this.cars) {
      if (!c.ai || c.finished || c.retired) continue;
      const f = this.env.track.frameAt(c.s);
      const facing = Math.sin(c.yaw) * f.tx + Math.cos(c.yaw) * f.tz;
      if (facing < -0.2 && c.speed > 8) c.wrongWayT += dt;
      else c.wrongWayT = 0;
      const nearSelf = this.env.track.nearestS(c.pos.x, c.pos.z);
      if (nearSelf.dist > nearSelf.frame.hw + 3) c.offRoadT += dt;
      else c.offRoadT = 0;
      if (c.wrongWayT > 4 || c.stuckTimer > 5 || c.offRoadT > 6) {
        c.resetToTrack(this.env);
        c.lastS = c.s;
        this.recomputeOrder();
      }
    }
  }

  /**
   * Give each car ahead of the player a small pace adjustment from its gap.
   *
   * The gap is measured on unwrapped total distance. A car a lap ahead is
   * simply far ahead; a car a lap behind is simply far behind and never flips
   * sign as it passes the line. Wrapping the difference to (-L/2, L/2] looked
   * tidy but made the bias discontinuous half a lap out, which showed up as a
   * rival that could never settle.
   *
   * The bias only ever acts on cars that are LEADING the player, easing them so
   * the pack stays in sight. A car level with or behind the player is given a
   * neutral target, so the moment it drops behind, its bias converges back to 1
   * instead of holding last lap's pace.
   *
   * Finished and retired cars take no part in the comparison at all - neither
   * as a recipient nor as the reference. Once the player has taken the flag (or
   * withdrawn) there is no race left to catch up to, so every rival converges
   * to neutral rather than freezing at whatever gap it had at that instant.
   *
   * `dt` is used to run down the per-car settle timer set by resetToTrack.
   */
  private updateCatchUp(dt: number): void {
    if (!this.catchUp) return;
    const p = this.player;
    // A player who has finished, retired, or is held on the grid is not a
    // reference: there is no live gap to measure against.
    const refValid = !p.finished && !p.retired && !p.disabled;
    for (const c of this.cars) {
      if (c === p) continue;
      const ai = c.ai as AIController | null;
      if (!ai) continue;
      // A finished or retired car is out of the comparison: it is neither a
      // recipient nor a reference. Give it a neutral target so its stale pace
      // decays away instead of holding an eased value from before the flag.
      if (c.finished || c.retired) {
        ai.setCatchUp(1);
        continue;
      }
      if (c.catchUpHoldT > 0) {
        c.catchUpHoldT = Math.max(0, c.catchUpHoldT - dt);
        ai.setCatchUp(1);
        continue;
      }
      if (!refValid) {
        ai.setCatchUp(1);
        continue;
      }
      const gap = c.totalDist - p.totalDist;
      if (gap <= 0) {
        // Level with or behind the player is not a leader: no easing, and the
        // existing bias is allowed to decay back to neutral.
        ai.setCatchUp(1);
        continue;
      }
      const t = Math.min(gap / CATCHUP_RANGE, 1);
      ai.setCatchUp(1 - CATCHUP_EASE * t);
    }
  }

  /**
   * Two contact circles per car, one at the nose and one at the tail, so a
   * 5.4 m car cannot pass through another the way a single small circle allows.
   */
  private contact(a: CarSim, b: CarSim): void {
    const OFF = 1.5;
    const R2 = 2.4;
    const ax = Math.sin(a.yaw) * OFF;
    const az = Math.cos(a.yaw) * OFF;
    const bx = Math.sin(b.yaw) * OFF;
    const bz = Math.cos(b.yaw) * OFF;
    for (const oa of [-1, 1]) {
      for (const ob of [-1, 1]) {
        const pax = a.pos.x + ax * oa;
        const paz = a.pos.z + az * oa;
        const pbx = b.pos.x + bx * ob;
        const pbz = b.pos.z + bz * ob;
        const dx = pbx - pax;
        const dz = pbz - paz;
        const d = Math.hypot(dx, dz);
        if (d >= R2 || d < 1e-3 || Math.abs(a.pos.y - b.pos.y) >= 1.6) continue;
        const nx = dx / d;
        const nz = dz / d;
        const push = (R2 - d) * 0.5;
        a.pos.x -= nx * push;
        a.pos.z -= nz * push;
        b.pos.x += nx * push;
        b.pos.z += nz * push;
        const rel = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
        if (rel < 0) {
          const imp = rel * 0.55;
          a.vel.x += nx * imp;
          a.vel.z += nz * imp;
          b.vel.x -= nx * imp;
          b.vel.z -= nz * imp;
          const hit = Math.min(0.5, -rel / 25);
          a.impact = Math.max(a.impact, hit);
          b.impact = Math.max(b.impact, hit);
        }
      }
    }
  }

  private raceLogic(c: CarSim): void {
    const track = this.env.track;
    const L = track.length;

    // A retired car is out of the race: no laps, no checkpoints, no finish.
    // It still has physics (it coasts to a stop), but it must not be able to
    // drift over the line later and claim a result it withdrew from.
    if (c.retired) {
      c.lastS = c.s;
      return;
    }

    // Signed arc progress, wrapping across the line.
    let ds = c.s - c.lastS;
    if (ds > L / 2) ds -= L;
    if (ds < -L / 2) ds += L;
    if (Math.abs(ds) > 200) ds = 0; // ignore projection teleports
    c.totalDist += ds;

    if (ds > 0 && !c.finished) {
      const cps = track.checkpoints;
      const next = cps[c.cpIndex % cps.length];
      const nearSelf = track.nearestS(c.pos.x, c.pos.z);
      const onCorridor = nearSelf.dist < nearSelf.frame.hw + 9;
      let crossed: boolean;
      if (c.lastS <= c.s) crossed = next > c.lastS && next <= c.s;
      else crossed = next > c.lastS || next <= c.s; // wrapped the line

      if (crossed && onCorridor) {
        c.cpIndex++;
        if (c === this.player) this.env.audio.checkpoint();
      }

      if (c.lastS > L * 0.75 && c.s < L * 0.25 && onCorridor) {
        if (c.totalDist < L * 0.5) {
          // Opening crossing. The grid sits just behind the line, so the very
          // first pass STARTS lap 1: arm the checkpoints and sync the clock.
          c.cpIndex = 1;
          c.lapStart = this.clock;
        } else if (c.cpIndex >= cps.length) {
          c.lap++;
          const lapT = this.clock - c.lapStart;
          c.lapStart = this.clock;
          c.lapTimes.push(lapT);
          c.cpIndex = 1; // checkpoint 0 sits on the line, already passed
          if (c === this.player) {
            if (this.bestLap === null || lapT < this.bestLap) this.bestLap = lapT;
            this.env.audio.checkpoint();
          }
          if (c.lap >= LAPS && !c.finished) {
            // The guard above is what makes a car record exactly ONE finish:
            // once `finished` is set, this whole block is skipped for it, so a
            // second crossing (or a third) can never overwrite finishTime.
            c.finished = true;
            c.finishTime = this.clock;
            // Several cars can cross the line inside the same 1/120 s physics
            // substep, where the race clock is identical. Recover which of them
            // crossed first from how far each had already travelled past the
            // line: distance from lastS to the line is L-lastS, then s beyond
            // it, so the fraction of the substep at the crossing is
            // (L-lastS)/((L-lastS)+s). Smaller means crossed earlier.
            const toLine = L - c.lastS;
            c.finishCrossFrac = toLine > 0 ? toLine / (toLine + Math.max(0, c.s)) : 1;
            c.finishOrder = ++this.finishCount;
            if (c === this.player) {
              this.finishDelay = 2.6;
              this.env.audio.finish();
              this.events.onNotice?.('FINISH', 2200);
            }
            this.recomputeOrder();
          }
        } else if (c === this.player && this.noticeT <= 0) {
          this.events.onNotice?.('MISSED CHECKPOINT', 1500);
          this.noticeT = 3;
        }
      }
    }
    c.lastS = c.s;

    this.applyBoostPads(c);
  }

  private applyBoostPads(c: CarSim): void {
    const track = this.env.track;
    const L = track.length;
    if (c.boost < 0.999) {
      for (const pad of track.chevrons) {
        let d = Math.abs(c.s - pad.s);
        if (d > L - d) d = L - d;
        if (d >= 7 || !c.grounded) continue;
        const dx = c.pos.x - pad.x;
        const dz = c.pos.z - pad.z;
        if (dx * dx + dz * dz >= 64) continue;
        if (c.padCooldown === pad.s) continue;
        c.boost = Math.min(1, c.boost + 0.5);
        c.boostFlash = 1;
        c.padCooldown = pad.s;
        if (c === this.player) this.env.audio.boostPad();
        if (pad.mesh) (pad.mesh.material as THREE.Material & { opacity: number }).opacity = 1.4;
      }
    }
    // Pads re-arm once the car is well past them.
    for (const pad of track.chevrons) {
      let d = Math.abs(c.s - pad.s);
      if (d > L - d) d = L - d;
      if (d > 30 && c.padCooldown === pad.s) c.padCooldown = -1;
    }
  }

  /**
   * Classify the field into a strict total order.
   *
   * 1. Anyone who took the flag ranks ahead of anyone who did not.
   * 2. Finished cars go by finish time; ties (which happen whenever several
   *    cars cross in one physics substep) go by the interpolated crossing
   *    fraction, then by the order the director saw them, then by grid slot.
   * 3. Cars still running go by total distance; exact ties fall back to grid.
   * 4. Retired cars always rank behind everyone still running and are ordered
   *    by how far they got, then by grid slot.
   *
   * Every branch ends in a value that cannot be equal for two cars, so the
   * result is a total order: no duplicate positions, no dropped car, and the
   * same input always produces the same standings.
   */
  private recomputeOrder(): void {
    this.order = this.cars.slice().sort(compareClassified);
  }

  private showResults(): void {
    if (this.resultsShown) return;
    this.resultsShown = true;
    this.state = 'results';
    this.recomputeOrder();
    // The winner's own clock when they finished, which is what a gap column is
    // measured from. Falling back to the current clock would make every gap
    // drift as the results screen idled.
    const firstFinisher = this.order.find((c) => c.finished);
    const leaderT = firstFinisher ? firstFinisher.finishTime : 0;
    this.events.onResults?.({
      position: this.order.indexOf(this.player) + 1,
      total: this.cars.length,
      totalTime: this.player.finished ? this.player.finishTime : null,
      bestLap: this.bestLap,
      laps: this.player.lapTimes,
      standings: this.order.map((c) => ({
        name: c.name,
        time: c.finished ? c.finishTime : null,
        gap: c.finished ? c.finishTime - leaderT : null,
        isPlayer: c === this.player,
      })),
    });
    this.events.onStateChange?.(this.state);
  }

  // ---- read-only views for the presenter ---------------------------------

  get playerPosition(): number {
    return this.order.indexOf(this.player) + 1;
  }

  get raceProgress(): number {
    return clamp01((this.player.totalDist + this.env.track.length) / (this.env.track.length * LAPS));
  }

  hudStandings(): StandingRow[] {
    return this.order.map((c) => ({
      name: c.name,
      color: '#' + new THREE.Color(c.color).getHexString(),
      lap: Math.min(LAPS, c.lap + (c.finished ? 0 : 1)),
      me: c === this.player,
      finished: c.finished,
    }));
  }

  get playerItem(): ItemKind {
    return this.player.item;
  }

  /** Debug/verification hook: the current grid, for headless assertions. */
  grid(): GridRow[] {
    return this.cars.map((c) => ({
      name: c.name,
      color: '#' + new THREE.Color(c.color).getHexString(),
      isPlayer: c.isPlayer,
      x: +c.pos.x.toFixed(2),
      z: +c.pos.z.toFixed(2),
      s: +c.s.toFixed(1),
      lap: c.lap,
      finished: c.finished,
    }));
  }

  /**
   * Debug/verification hook: the classification exactly as the results board
   * would show it. Returned in order and with explicit positions, so a test can
   * assert on uniqueness and completeness without re-deriving the rules.
   */
  classification(): { position: number; name: string; finished: boolean; retired: boolean; time: number | null; totalDist: number }[] {
    this.recomputeOrder();
    return this.order.map((c, i) => ({
      position: i + 1,
      name: c.name,
      finished: c.finished,
      retired: c.retired,
      time: c.finished ? c.finishTime : null,
      totalDist: c.totalDist,
    }));
  }
}
