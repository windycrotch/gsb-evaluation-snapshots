// Unit tests for the Frost Nova settlement chain (src/weapons.js `_fireNova`).
// Uses the real Weapon class + the real FROST_NOVA definition from data.js and
// the real EffectLayer scheduler from effects.js. Player/game are minimal
// stubs — no browser, no wall-clock timers: "pausing" is simulated by simply
// not calling `effects.update(dt)`, exactly how the real game loop behaves
// while paused.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Weapon } from '../src/weapons.js';
import { WEAPONS } from '../src/data.js';
import { EffectLayer } from '../src/effects.js';
import { GameState } from '../src/config.js';

const DEF = WEAPONS.FROST_NOVA;
const AFTERSHOCK_DELAY = 0.4;
const AFTERSHOCK_MULT = 0.6;

function approx(actual, expected, msg) {
    assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: expected ${expected}, got ${actual}`);
}

// Minimal player satisfying every getter Weapon touches. `stats` is mutable
// so tests can change attributes between the nova and its aftershock.
function makePlayer(overrides = {}) {
    const stats = Object.assign({ crit: 0, dmgMult: 1, cdMult: 1, areaMult: 1 }, overrides);
    return {
        x: 0,
        y: 0,
        dead: false,
        passives: {},
        weapons: [],
        stats,
        getDamageMult() {
            return this.stats.dmgMult;
        },
        getCooldownMult() {
            return this.stats.cdMult;
        },
        getAreaMult() {
            return this.stats.areaMult;
        },
        getCritChance() {
            return this.stats.crit;
        }
    };
}

function makeEnemy(x, y, hp = 1000) {
    return {
        x,
        y,
        hp,
        damageTaken: 0,
        takeDamage(d) {
            this.hp -= d;
            this.damageTaken += d;
        },
        slowTimer: 0,
        slowPct: 0
    };
}

// Minimal game stub backed by the REAL EffectLayer scheduler.
function makeGame(player) {
    return {
        player,
        state: GameState.PLAYING,
        effects: new EffectLayer(),
        enemies: [],
        particles: [],
        createParticles(x, y, color, n) {
            this.particles.push({ x, y, color, n });
        },
        createFloatingText() {},
        audio: {
            shoots: 0,
            shoot() {
                this.shoots++;
            }
        },
        projectiles: [],
        mines: []
    };
}

function makeEvolvedNova() {
    const w = new Weapon(DEF);
    for (let i = 1; i < DEF.evolveLevel; i++) w.levelUp();
    assert.ok(w.isEvolved());
    return w;
}

test('Frost Nova: in-range enemies are damaged and slowed, out-of-range untouched', () => {
    const w = new Weapon(DEF); // level 1, not evolved
    const p = makePlayer();
    const g = makeGame(p);
    const near = makeEnemy(50, 0);
    const far = makeEnemy(9999, 0);
    g.enemies = [near, far];

    w.fire(p, g);

    const expectedDmg = DEF.baseDamage; // level 1, dmgMult 1, no crit
    approx(near.damageTaken, expectedDmg, 'near enemy damage');
    approx(near.slowTimer, DEF.slowDuration, 'near enemy slowTimer');
    approx(near.slowPct, DEF.slowPct, 'near enemy slowPct');

    assert.equal(far.damageTaken, 0, 'far enemy must not be damaged');
    assert.equal(far.slowTimer, 0, 'far enemy must not be slowed');
    assert.equal(far.slowPct, 0, 'far enemy must not gain slowPct');
});

test('Frost Nova: a stronger/longer existing slow is never overwritten', () => {
    const w = new Weapon(DEF);
    const p = makePlayer();
    const g = makeGame(p);
    const enemy = makeEnemy(10, 0);
    // Pre-existing slow that is both longer and stronger than the nova's.
    enemy.slowTimer = DEF.slowDuration + 3;
    enemy.slowPct = DEF.slowPct + 0.3;
    g.enemies = [enemy];

    w.fire(p, g);

    assert.ok(enemy.damageTaken > 0, 'damage still applies');
    approx(enemy.slowTimer, DEF.slowDuration + 3, 'longer slowTimer preserved');
    approx(enemy.slowPct, DEF.slowPct + 0.3, 'stronger slowPct preserved');
});

test('Frost Nova: a stronger existing slow is not overwritten even when shorter', () => {
    const w = new Weapon(DEF);
    const p = makePlayer();
    const g = makeGame(p);
    const enemy = makeEnemy(10, 0);
    // Stronger pct, but less remaining time than the nova's duration.
    enemy.slowTimer = DEF.slowDuration - 0.5;
    enemy.slowPct = DEF.slowPct + 0.2;
    g.enemies = [enemy];

    w.fire(p, g);

    approx(enemy.slowPct, DEF.slowPct + 0.2, 'stronger slowPct preserved');
    approx(enemy.slowTimer, DEF.slowDuration - 0.5, 'existing timer preserved');
});

test('Frost Nova: a weaker existing slow IS refreshed by the nova', () => {
    const w = new Weapon(DEF);
    const p = makePlayer();
    const g = makeGame(p);
    const enemy = makeEnemy(10, 0);
    enemy.slowTimer = 0.3;
    enemy.slowPct = 0.1;
    g.enemies = [enemy];

    w.fire(p, g);

    approx(enemy.slowTimer, DEF.slowDuration, 'weaker slow upgraded to nova duration');
    approx(enemy.slowPct, DEF.slowPct, 'weaker slow upgraded to nova pct');
});

test('Frost Nova: unevolved nova does not schedule an aftershock', () => {
    const w = new Weapon(DEF);
    const p = makePlayer();
    const g = makeGame(p);
    g.enemies = [makeEnemy(10, 0)];

    w.fire(p, g);

    assert.equal(g.effects.delays.length, 0, 'no scheduled callbacks before evolve');
});

test('Frost Nova: evolved aftershock is queued on the effects scheduler, not a wall-clock timer', () => {
    const w = makeEvolvedNova();
    const p = makePlayer();
    const g = makeGame(p);
    const enemy = makeEnemy(10, 0);
    g.enemies = [enemy];

    w.fire(p, g);

    assert.equal(g.effects.delays.length, 1, 'aftershock queued in the sim-time scheduler');
    const afterFire = enemy.damageTaken;
    // No update() call — i.e. game paused — so nothing may happen, no matter
    // how much wall-clock time passes outside the simulation.
    assert.equal(enemy.damageTaken, afterFire, 'no aftershock without sim time advancing');
});

test('Frost Nova: aftershock does not advance while paused and settles exactly once on resume', () => {
    const w = makeEvolvedNova();
    const p = makePlayer();
    const g = makeGame(p);
    const enemy = makeEnemy(10, 0);
    g.enemies = [enemy];

    const pulseDmg = w.getDamage(p); // crit chance 0 → deterministic
    w.fire(p, g);
    approx(enemy.damageTaken, pulseDmg, 'initial pulse only');

    // Partially advance, then "pause" (stop calling update).
    g.effects.update(0.3);
    approx(enemy.damageTaken, pulseDmg, 'aftershock not yet due');
    const entry = g.effects.delays[0];
    const remainingWhenPaused = entry.t;

    // ...any amount of wall-clock time passes here; the sim is paused, so
    // nothing is called and nothing may change.
    approx(entry.t, remainingWhenPaused, 'scheduled time frozen while paused');
    approx(enemy.damageTaken, pulseDmg, 'no damage while paused');

    // Resume: the remaining 0.1s of sim time elapses → aftershock fires once.
    g.effects.update(0.2);
    approx(enemy.damageTaken, pulseDmg + pulseDmg * AFTERSHOCK_MULT, 'aftershock hit once');
    assert.equal(g.effects.delays.length, 0, 'queue drained after firing');

    // Further sim time must not re-trigger the same nova's aftershock.
    g.effects.update(5);
    approx(enemy.damageTaken, pulseDmg + pulseDmg * AFTERSHOCK_MULT, 'no double settle');
});

test('Frost Nova: duplicate invocation of the aftershock callback settles only once', () => {
    const w = makeEvolvedNova();
    const p = makePlayer();
    const g = makeGame(p);
    const enemy = makeEnemy(10, 0);
    g.enemies = [enemy];

    const pulseDmg = w.getDamage(p);
    w.fire(p, g);

    // Invoke the queued callback directly, twice (defensive double-fire).
    const fn = g.effects.delays[0].fn;
    fn();
    fn();
    approx(enemy.damageTaken, pulseDmg + pulseDmg * AFTERSHOCK_MULT, 'settled exactly once');

    // The scheduler entry still fires on schedule — the guard must absorb it.
    g.effects.update(AFTERSHOCK_DELAY + 0.1);
    approx(enemy.damageTaken, pulseDmg + pulseDmg * AFTERSHOCK_MULT, 'still only one settle');
});

test('Frost Nova: aftershock is fully silent when the player died before it fires', () => {
    const w = makeEvolvedNova();
    const p = makePlayer();
    const g = makeGame(p);
    const enemy = makeEnemy(10, 0);
    g.enemies = [enemy];

    w.fire(p, g);
    const particlesAtFire = g.particles.length;
    const shootsAtFire = g.audio.shoots;
    const dmgAtFire = enemy.damageTaken;

    p.dead = true; // player dies before the 0.4s follow-up
    g.effects.update(1.0);

    approx(enemy.damageTaken, dmgAtFire, 'no aftershock damage after death');
    assert.equal(g.particles.length, particlesAtFire, 'no aftershock particles after death');
    assert.equal(g.audio.shoots, shootsAtFire, 'no aftershock audio after death');
});

test('Frost Nova: aftershock is fully silent when the run has ended (gameover)', () => {
    const w = makeEvolvedNova();
    const p = makePlayer();
    const g = makeGame(p);
    const enemy = makeEnemy(10, 0);
    g.enemies = [enemy];

    w.fire(p, g);
    const particlesAtFire = g.particles.length;
    const dmgAtFire = enemy.damageTaken;

    g.state = GameState.GAMEOVER; // run ended before the follow-up
    g.effects.update(1.0);

    approx(enemy.damageTaken, dmgAtFire, 'no aftershock damage after game over');
    assert.equal(g.particles.length, particlesAtFire, 'no aftershock particles after game over');
});

test('Frost Nova: aftershock uses fire-time snapshot of range and damage', () => {
    const w = makeEvolvedNova();
    const p = makePlayer();
    const g = makeGame(p);
    const rangeAtFire = w.getRange(p);
    const enemy = makeEnemy(rangeAtFire - 30, 0); // inside range at fire time
    g.enemies = [enemy];

    const pulseDmg = w.getDamage(p);
    w.fire(p, g);
    approx(enemy.damageTaken, pulseDmg, 'initial pulse');

    // Massively change stats between the pulse and the aftershock: damage up,
    // area down to almost nothing. A live re-read would buff the damage and
    // shrink the radius so the enemy is missed entirely.
    p.stats.dmgMult = 10;
    p.stats.areaMult = 0.01;

    g.effects.update(AFTERSHOCK_DELAY + 0.1);

    approx(
        enemy.damageTaken,
        pulseDmg + pulseDmg * AFTERSHOCK_MULT,
        'aftershock uses the fire-time damage snapshot'
    );
});

test('Frost Nova: aftershock only hits enemies inside the snapshotted radius', () => {
    const w = makeEvolvedNova();
    const p = makePlayer();
    const g = makeGame(p);
    const rangeAtFire = w.getRange(p);
    const inside = makeEnemy(rangeAtFire - 30, 0);
    const outside = makeEnemy(rangeAtFire + 30, 0);
    g.enemies = [inside, outside];

    const pulseDmg = w.getDamage(p);
    w.fire(p, g);
    assert.equal(outside.damageTaken, 0, 'outside enemy untouched by pulse');

    g.effects.update(AFTERSHOCK_DELAY + 0.1);

    approx(inside.damageTaken, pulseDmg + pulseDmg * AFTERSHOCK_MULT, 'inside hit by both');
    assert.equal(outside.damageTaken, 0, 'outside enemy untouched by aftershock');
});
