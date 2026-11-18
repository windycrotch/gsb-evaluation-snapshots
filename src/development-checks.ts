import type * as Schemas from "./schema"

export const DEV: boolean = (() => {
  try {
    return process.env.NODE_ENV !== "production"
  } catch {
    return false
  }
})()

export type Checked = "box" | "fit" | "plate" | "soundName" | "soundOptions" | "soundConfig"

const NAMES = ["x", "y", "z", "w", "d", "h"] as const

const problemIn = (item: unknown): string | null => {
  const point = Array.isArray(item)
  const names = point ? NAMES.slice(0, 3) : NAMES
  const values: ReadonlyArray<unknown> = point ? item : names.map((name) => (item as Record<string, unknown> | null | undefined)?.[name])
  for (const [index, name] of names.entries()) {
    const value = values[index]
    if (typeof value !== "number") return `${name} must be a number`
    if (!Number.isFinite(value)) return `${name} must be a finite number`
    if (index > 2 && value < 0) return `${name} cannot be negative`
  }
  return null
}

/**
 * Every reason a figure cannot be drawn, worded like the zod schema so the
 * on-screen note and the console agree. Identical reasons appear once, in the
 * order they were found. Only a missing fit is excused by a viewBox: a box
 * or point that cannot be drawn is a problem either way. Development only;
 * reads no schemas.
 */
export function figureProblems(fit: ReadonlyArray<unknown> | undefined, viewBox: string | undefined): string[] {
  const items = Array.isArray(fit) ? fit : []
  const problems = new Set(items.map(problemIn).filter((problem): problem is string => problem !== null))
  if (!viewBox && !items.length) problems.add("needs a fit (boxes or points) or a viewBox")
  return [...problems]
}

let schemas: Promise<typeof Schemas> | null = null
const reported = new Set<string>()

const schemaFor = (loaded: typeof Schemas, kind: Checked) =>
  ({
    box: loaded.box3Schema,
    fit: loaded.fitSchema,
    plate: loaded.plateFrameSchema,
    soundName: loaded.soundNameSchema,
    soundOptions: loaded.soundOptionsSchema,
    soundConfig: loaded.soundConfigSchema,
  })[kind]

export function check(kind: Checked, value: unknown, where: string): void {
  if (!DEV) return
  schemas ??= import("./schema")
  schemas.then(
    (loaded) => {
      const result = schemaFor(loaded, kind).safeParse(value)
      if (result.success) return
      const message = `react-isokit: ${where}\n${loaded.describe(result.error)}`
      if (reported.has(message)) return
      reported.add(message)
      console.warn(message)
    },
    () => {},
  )
}
