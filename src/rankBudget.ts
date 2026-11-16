// The share of dab ranks kept on screen, linked to the drawing resolution.
//
// Every dab has a fixed rank in 0..1 (see Dabs.rank in paint.ts). The dab vertex shader keeps a rank only
// while it is small enough for the current picture: `rank * cover < budget`, where cover is how much the
// dab has already grown past its least screen size. Lowering the budget keeps fewer ranks and grows the
// surviving dabs more, so the stroke LOD follows the render resolution instead of leaving the fine dabs
// to drop out as unreadable sub-pixel marks.
//
// Two guarantees live here:
//
//   fixed ranks ── the budget is one scalar for the whole frame and never depends on where the camera is,
//                  so any one dab is either shown in every frame of a budget level or hidden in every one.
//                  It can never blink on and off as the eye moves.
//
//   no holes ───── a rank that drops out is below a dab that already covers it (cover >= 1/budget), so the
//                  neighbours that stay overlap and the underpainting never shows through. The shader
//                  implements exactly the same comparison; this module only decides the scalar.
//
// The budget moves in quantised levels with dwell-time hysteresis, so a sharpness that wobbles on a
// threshold cannot add and remove strokes every frame.

/** Each step down in resolution multiplies the kept rank share by this. */
export const RANK_STEP = 0.78
/** The finest rank share ever kept, however slow the frames get. */
export const MIN_RANK_BUDGET = 0.4
/** A new level must hold for this long before the budget follows it: the anti-flicker dwell. */
export const RANK_HOLD_SECONDS = 0.5

/** The budget of level n: level 0 is full resolution, each level keeps RANK_STEP fewer ranks. */
export function rankBudgetAtLevel(level: number) {
  return Math.max(MIN_RANK_BUDGET, Math.pow(RANK_STEP, level))
}

/** Deepest level that changes the budget; deeper levels all return MIN_RANK_BUDGET. */
export const FLOOR_LEVEL = (() => {
  let level = 0
  while (rankBudgetAtLevel(level) > MIN_RANK_BUDGET) level++
  return level
})()

/** The level a sharpness (the share of screen pixels drawn, 1 at full resolution) asks for. */
export function levelForSharpness(sharpness: number) {
  // log of 0 is infinite: clamp the input well above it
  const asked = Math.max(0, Math.ceil(Math.log(Math.min(1, Math.max(sharpness, 1e-4))) / Math.log(RANK_STEP) - 1e-9))
  return Math.min(asked, FLOOR_LEVEL)
}

/**
 * Holds the current rank budget and moves it between levels with dwell-time hysteresis.
 * Call update() every frame with the sharpness keepPace settled on.
 */
export class RankBudget {
  private level = 0
  private candidate = 0
  private dwell = 0

  /** the budget the dab shader should use this frame, MIN_RANK_BUDGET..1 */
  get value() {
    return rankBudgetAtLevel(this.level)
  }
  /** the active level, for the debug hook and tests */
  get currentLevel() {
    return this.level
  }
  /** the level sharpness is asking for, which only takes effect after the dwell */
  get askedLevel() {
    return this.candidate
  }

  /** Reset to full resolution (a window resize starts the picture over). */
  reset() {
    this.level = 0
    this.candidate = 0
    this.dwell = 0
  }

  /**
   * Recompute from the settled sharpness. Returns the budget for this frame. A change of asked level
   * restarts the dwell, so rapid back-and-forth on a threshold never reaches the active level.
   */
  update(sharpness: number, dt: number) {
    const asked = levelForSharpness(sharpness)
    if (asked !== this.candidate) {
      this.candidate = asked
      this.dwell = 0
    } else if (asked !== this.level) {
      this.dwell += dt
      if (this.dwell >= RANK_HOLD_SECONDS) {
        this.level = asked
        this.dwell = 0
      }
    } else {
      this.dwell = 0
    }
    return this.value
  }
}
