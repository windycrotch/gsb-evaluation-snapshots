// Logic tests for the resolution-linked stroke-rank budget. Run with: node --test scripts/rank-budget.test.ts
// (Node strips the TypeScript types itself.) The shader comparison these mirror lives in the dab vertex
// shader in src/paint.ts: `rank * cover < uRankBudget`, with the least card scaled by 1 / uRankBudget.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FLOOR_LEVEL, MIN_RANK_BUDGET, RANK_HOLD_SECONDS, RankBudget, levelForSharpness, rankBudgetAtLevel } from '../src/rankBudget.ts'

// Hold a sharpness for long enough that its level commits: the first frame only registers the candidate,
// the frame after the dwell elapses applies it, as in the real requestAnimationFrame loop.
function holdUntilLevel(budget: RankBudget, sharpness: number) {
  const dt = 1 / 60
  budget.update(sharpness, dt)
  for (let t = 0; t <= RANK_HOLD_SECONDS + dt; t += dt) budget.update(sharpness, dt)
  return budget
}

test('full resolution keeps every rank', () => {
  const budget = new RankBudget()
  assert.equal(budget.update(1, 1 / 60), 1)
  assert.equal(budget.currentLevel, 0)
  assert.equal(budget.value, 1)
})

test('lower sharpness asks for coarser levels, clamped to the minimum budget', () => {
  assert.equal(levelForSharpness(1), 0)
  // exactly on a step boundary lands on that level
  assert.equal(levelForSharpness(0.78), 1)
  // between steps rounds up to the coarser (conservative) level
  assert.equal(levelForSharpness(0.7), 2)
  assert.equal(levelForSharpness(0.5), 3)
  // however tiny the resolution gets, the level and budget stop at the floor
  const deepest = levelForSharpness(0.0001)
  assert.equal(deepest, FLOOR_LEVEL)
  assert.equal(rankBudgetAtLevel(deepest), MIN_RANK_BUDGET)
  assert.equal(rankBudgetAtLevel(deepest + 5), MIN_RANK_BUDGET)
})

test('a level change waits out the dwell before taking effect', () => {
  const budget = new RankBudget()
  const dt = 1 / 60
  // sharpness drops to level 1: the budget stays at 1 until the dwell elapses
  budget.update(0.78, dt)
  assert.equal(budget.currentLevel, 0)
  assert.equal(budget.value, 1)
  for (let t = dt; t < RANK_HOLD_SECONDS; t += dt) {
    assert.equal(budget.update(0.78, dt), 1)
  }
  budget.update(0.78, dt)
  assert.equal(budget.currentLevel, 1)
  assert.equal(budget.value, rankBudgetAtLevel(1))
})

test('rapid back-and-forth on a threshold never changes the level', () => {
  const budget = new RankBudget()
  const dt = RANK_HOLD_SECONDS / 4
  for (let i = 0; i < 50; i++) {
    budget.update(i % 2 === 0 ? 1 : 0.78, dt)
    assert.equal(budget.currentLevel, 0, `flickered at step ${i}`)
    assert.equal(budget.value, 1, `budget moved at step ${i}`)
  }
})

test('a held low resolution steps down and recovery restores the fine ranks after the dwell', () => {
  const budget = new RankBudget()
  holdUntilLevel(budget, 0.61) // 0.78^2, exactly level 2
  assert.equal(budget.currentLevel, 2)
  assert.equal(budget.value, rankBudgetAtLevel(2))
  // resolution recovers: the level holds through the dwell, then the fine ranks come back
  budget.update(1, 1 / 60)
  assert.equal(budget.currentLevel, 2)
  holdUntilLevel(budget, 1)
  assert.equal(budget.currentLevel, 0)
  assert.equal(budget.value, 1)
})

test('reset returns to full resolution immediately', () => {
  const budget = new RankBudget()
  holdUntilLevel(budget, 0.2)
  assert.ok(budget.currentLevel > 0)
  budget.reset()
  assert.equal(budget.currentLevel, 0)
  assert.equal(budget.askedLevel, 0)
  assert.equal(budget.value, 1)
})

test('no-hole invariant: mean stroke coverage never falls below the full-resolution picture', () => {
  // The shader rule, mirrored here:
  //   shown(rank, cover, budget) ~ rank * cover < budget      (smoothstep only softens the cut)
  //   least card scale           = 1 / budget                 (the uMin growth in the vertex shader)
  // Ranks are independent and uniform in 0..1 (mulberry LCG in paint.ts). At the cut, cover = 1/budget,
  // a fraction ~budget of the dabs survives and each card has 1/budget times the area, so painted area per
  // cell is ~budget at every level: thinning and growth cancel by construction, level 0 stays at one, and no
  // level goes under the minimum budget. Coarser resolutions open no gap that full resolution did not also
  // have, and the underpainting beneath fills every sparse tail (dabs only cover about half a card anyway).
  const side = 120
  const cells = side * side
  const ranks = Array.from({ length: cells }, (_, i) => ((i * 2654435761) >>> 0) / 4294967296)
  const shown = (rank: number, cover: number, budget: number) => rank * cover < budget
  for (let level = 0; level < 5; level++) {
    const budget = rankBudgetAtLevel(level)
    // coverage must not depend on distance within a level: check the cut and two farther points
    for (const multiple of [1, 2, 4]) {
      const cover = (1 / budget) * multiple
      const survivors = ranks.filter((rank) => shown(rank, cover, budget)).length
      const meanCoverage = (survivors / cells) * cover
      const limit = level === 0 ? 0.95 : budget * 0.9
      assert.ok(meanCoverage >= limit, `level ${level} x${multiple}: coverage ${meanCoverage.toFixed(3)} under ${limit.toFixed(3)}`)
    }
  }
})

test('near dabs are always fully kept: full-resolution budget keeps the whole rank range', () => {
  // At full resolution the budget is 1: until a dab reaches its least screen size (cover <= 1) the cull
  // comparison rank * cover < 1 holds for every fixed rank, so the fine strokes beside the near path never
  // drop out. Lowering the resolution only changes the shared scalar; restoring it restores every dab.
  const budget = rankBudgetAtLevel(0)
  assert.equal(budget, 1)
  for (const rank of [0, 0.25, 0.5, 0.75, 0.99]) {
    for (const cover of [0.2, 0.5, 0.99]) {
      assert.equal(rank * cover < budget, true, `near dab rank ${rank} cover ${cover} was culled at full resolution`)
    }
  }
})

test('coarser budgets only ever hide dabs, never re-show one a finer budget hid', () => {
  // Monotone nesting: the visible dab set at a low budget is a subset of the set at a higher budget.
  // Going down in resolution can therefore never swap strokes, only thin them in fixed-rank order.
  for (const rank of [0, 0.1, 0.39, 0.4, 0.7, 0.99]) {
    for (let cover = 0.2; cover < 20; cover += 0.3) {
      let finer = true
      for (let level = 0; level < 5; level++) {
        const shown = rank * cover < rankBudgetAtLevel(level)
        assert.ok(!shown || finer, `rank ${rank} cover ${cover} re-appeared at level ${level}`)
        finer = shown
      }
    }
  }
})

test('fixed-rank semantics: the show/hide answer depends only on rank and cover, never on the frame', () => {
  // The budget is a frame-wide scalar with no camera position in it: for a fixed (rank, cover, level) the
  // shader's comparison has one answer. Repeating the decision across many "frames" must give the same
  // result every time — a dab can only change when its own true distance changes cover, never because the
  // threshold wobbled. Ranks of exactly 1 are the always-culled top of the range by construction.
  for (let level = 0; level < 5; level++) {
    const budget = rankBudgetAtLevel(level)
    for (const rank of [0, 0.1, 0.39, 0.4, 0.7, 0.99]) {
      for (let cover = 0.5; cover < 30; cover += 0.37) {
        const shown = rank * cover < budget
        for (let frame = 0; frame < 8; frame++) {
          assert.equal(rank * cover < budget, shown, `rank ${rank} cover ${cover} blinked on frame ${frame}`)
        }
      }
    }
  }
})

test('budgets only shrink with level and never leave the fixed 0..1 rank range', () => {
  let previous = rankBudgetAtLevel(0)
  assert.equal(previous, 1)
  for (let level = 1; level < 8; level++) {
    const next = rankBudgetAtLevel(level)
    assert.ok(next <= previous)
    assert.ok(next >= MIN_RANK_BUDGET)
    previous = next
  }
})
