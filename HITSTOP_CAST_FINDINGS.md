# HITSTOP UNDER GROUP DAMAGE + CAST/COOLDOWN CONSISTENCY

**Report.** Group hits stuttered in bursts; heavy + crit stacked worst; and the skill bar read
"ready" while presses did nothing. Both were real, both are fixed, both are measured in a live
browser (headless Chrome over CDP, `tools/live/*.mjs`).

## 1. The freeze budget now caps ANY one-second window, not the long-run average

`src/core/clock.js`. The old budget was a **leaky token bucket**: it bounded the *long-run* average
at 7% but not an arbitrary stretch of real time. A full bucket (75 ms) plus the 70 ms it refilled
over the next second allowed **~145 ms of freeze inside one second — 14.5% against a cap that
claimed 7%**. Group damage arrives in clumps (one AoE hits 8 targets, a projectile detonates, a brute
answers within 100 ms), so the long-run average was the wrong instrument and the clumps are exactly
what you see as "一阵阵" stutter.

The clock now keeps the recently **granted** freeze intervals and refuses any grant that would push
frozen time in **any** `windowSec`-length real window above `maxDuty·windowSec`. Every window is
capped, and any longer span splits into window-length chunks, so the bound holds for **arbitrary**
real time, by construction.

- `maxDuty 0.07 × windowSec 1.0 = 70 ms` of freeze in any one second — **equal to the single-hit
  ceiling** (`HITSTOP_MAX 70 ms` in `combat.js`), so one isolated crit slam is never clipped, while
  sustained group hits only ever **shorten** later grants.
- A shortfall is **shortened, not dropped**, and the clipped milliseconds are counted
  (`hitstopStats.clipped`) and shown live on F3 (`hitstop clipped`, `hitstop %`).
- The grant feasibility check is **exact** (the windowed-overlap maximum of a fixed interval set is
  piecewise-linear in the window start, so its maximum sits on an interval start or `end − window`),
  then bisected. Measured cost: **8 µs/request** at ~10 live intervals.

**Measured, headless Chrome, live page:**

| scenario | worst frozen load in any 1 s | cap |
|---|---|---|
| 12-target pack, spam AoE ~3.5 s | **50.4 ms** | 70 ms |
| forced burst 8×~55 ms every 120 ms for 3 s | **68.9 ms** | 70 ms |
| 200 randomized burst trials (fuzzed) | **70.000 ms** (never exceeded) | 70 ms |
| isolated ground-slam crit | **70 ms granted, 0 clipped** | 70 ms |

An AoE over 10 targets now emits **ONE** aggregated hitstop request (the per-cast `beginAgg/endAgg`
max already existed; verified `hitstopEmits: 1`), so the multi-target path is not the source of the
burst — the clumping of *successive* casts and enemy answers was, and that is what the window cap
bounds.

## 2. Casts are atomic; cooldowns run on the real clock

`src/combat/combat.js`, `src/entity/player.js`, `src/ui/skillbar.js`, `src/ui/hud.js`.

The "扣了法力却没产生效果 / 冷却已走但技能未执行" states had two roots:

1. **Combat deducted before it could fail, and the HUD deducted again.** `tryCast` spent mana and
   wrote cooldowns *before* `executeSkill`; and `hud.js` separately subtracted mana on **every**
   `EV.PLAYER_CAST` — an event emitted on the **wind-up frame**, before combat accepts or rejects the
   strike. A press combat rejected still emptied the orb and started a HUD sweep.
2. **Cooldowns were timed in `World.time` (sim time).** Hitstop scales sim to 14%, so a cooldown
   barely advanced during a freeze while the HUD sweep (frame dt) crawled — the two disagreed and the
   bar could show ready on a skill that was not.

Fixes:

- `tryCast` is now **validate → execute → commit**. Execute first inside a `try`; a throw leaves mana
  and both cooldowns untouched. Mana is charged **exactly once**, by combat, only on success.
- Cooldowns and the GCD are held in **REAL seconds** on `World.clock` (the same clock the freeze
  budget reads), so a second of wall time buys a second of cooldown regardless of how much was
  frozen. `remaining` is clamped `Math.max(0, …)` — never negative, never wedged.
- The skill bar **mirrors** `World.combat`; it spends nothing and keeps no timers of its own. It
  flashes on combat's `combat:castCommitted` (emitted only after cost + cooldowns are written), so it
  can never celebrate a rejected press.
- Player locomotion asks `World.combat.canCast` **silently** before starting a wind-up, so a doomed
  press plays no animation; the strike-time re-validation (the only place a resource moves) is the
  only place denial feedback is emitted.

**Measured, live page:**

| check | result |
|---|---|
| `PLAYER_CAST` fireball ×1 | mana **−18 exactly**, cooldown started |
| `PLAYER_CAST` fireball ×2 immediately (GCD) | **−0** mana (second press rejected) |
| 40 casts of ground-slam inside a freeze | **40 rejected, 0 mana spent**, cooldown unchanged, `≥0` |
| cooldown elapsed across 1.0 s of real time while frozen | **1.000 s** |

## 3. A rebuilt level inherits no freeze, cooldown or queued attack

New `window.__rebuildLevel(seed)` (`src/main.js` → `level.rebuild()`), which re-runs the generator and
re-emits `LEVEL_READY`. Every listener already runs idempotently, so one event returns each subsystem
to a clean initial state:

- **clock.js** — `reset()` on `LEVEL_READY`: clears deadline, grant log, counters.
- **combat.js** — `resetCastState()` on `LEVEL_READY`: clears cooldowns, the GCD, telegraphed
  wind-ups (`pending`), held channels, ground fields and live projectiles.
- **director.js** — `setup()` now calls `_teardown()` first (it was not re-entrant): disposes enemy
  controllers, empties `delayed` (queued enemy/boss strikes), `pendingAdds`, live telegraph decals,
  and resets `wave`/boss flags. **`ai.js` never subscribed to `LEVEL_READY`** when `World.level` was
  already set (level runs first), so a rebuild left the AI armed on the *old* nav grid — fixed by
  always subscribing.
- **enemies.js** — `dispose()` made idempotent (director teardown and cull can both call it).

**Measured, live page:**

| after rebuild | value |
|---|---|
| freeze granted / frozen | **0 ms / false** (was 70 ms / true before) |
| ground-slam cooldown | **0 s** |
| director `delayed` / `pendingAdds` / `enemies` / `wave` | **0 / 0 / 0 / 0** |
| entity & scene-child counts over 3 consecutive rebuilds | **33 / 514 unchanged** (no leak) |
| page console errors | **0** |

## Reproduce

```bash
npm run dev                       # 127.0.0.1:5188
npm test                          # hitstop budget + cast atomicity (node, no browser)
node tools/live/final.mjs         # the in-browser acceptance run above (needs dev server)
```

`tools/hitstop.test.mjs` drives the budget through an injected clock and asserts: isolated heavy hit
lands whole; **no 1 s window over cap** under sustained bursts and under 200 randomized patterns;
shortfall is shortened **and counted**; redundant in-flight requests add nothing; `requested ==
granted + clipped + redundant` exactly; `LEVEL_READY` resets to clean initial values.
`tools/cast.test.mjs` drives real `combat.init()` and asserts the cast/cooldown/reset requirements.

Not changed: hitstop depth (`FROZEN_SCALE 0.14`), per-skill freeze weights, and group-hit damage.
The task's "不得以关闭冻结或删除群体命中来规避" is respected — freeze is intact and group hits still
hit every target; only the aggregate real-time budget and the cast accounting changed.
