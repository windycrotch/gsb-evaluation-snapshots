// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Box, frame, Plate } from "../src"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | undefined
let root: Root | undefined

beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const render = (element: React.ReactNode) => act(() => root?.render(element))
const note = () => host?.querySelector(".ik-note")
const noteLines = () => [...(note()?.querySelectorAll("span") ?? [])].map((span) => span.textContent)

describe("Plate, when a figure cannot be drawn", () => {
  it("says on the plate that a size is negative", () => {
    render(<Plate label="Bad key" fit={[{ x: 0, y: 0, z: 0, w: -40, d: 40, h: 10 }]} />)
    expect(note()).not.toBeNull()
    expect(noteLines()).toContain("w cannot be negative")
  })
  it("says which coordinate is not finite", () => {
    render(<Plate label="Bad point" fit={[{ x: 0, y: 0, z: 0, w: 40, d: 40, h: 10 }, [Number.NaN, 0, 0]]} />)
    expect(noteLines()).toContain("x must be a finite number")
  })
  it("says a fit or viewBox is missing", () => {
    render(<Plate label="No frame" />)
    expect(noteLines()).toContain("needs a fit (boxes or points) or a viewBox")
  })
  it("does not stack a second copy when it re-renders with the same input", () => {
    const fit = [{ x: 0, y: 0, z: 0, w: -40, d: 40, h: 10 }]
    render(<Plate label="Bad key" fit={fit} />)
    render(<Plate label="Bad key" fit={fit} />)
    render(<Plate label="Bad key" fit={[...fit]} />)
    expect(host?.querySelectorAll(".ik-note")).toHaveLength(1)
    expect(noteLines()).toEqual(["w cannot be negative"])
  })
  it("lists an identical problem once", () => {
    render(
      <Plate
        label="Two bad keys"
        fit={[
          { x: 0, y: 0, z: 0, w: -40, d: 40, h: 10 },
          { x: 0, y: 0, z: 0, w: -10, d: 40, h: 10 },
        ]}
      />,
    )
    expect(noteLines()).toEqual(["w cannot be negative"])
  })
  it("reads a point as three numbers, not six", () => {
    render(<Plate label="Points only" fit={[[0, 0, 0], [40, 40, 10]]} />)
    expect(note()).toBeNull()
  })
  it("keeps a good plate clean", () => {
    render(<Plate label="A key" fit={[{ x: 0, y: 0, z: 0, w: 40, d: 40, h: 10 }]} />)
    expect(note()).toBeNull()
  })
  it("still names a box it cannot draw when a viewBox is given", () => {
    render(<Plate label="Own frame" viewBox="0 0 10 10" fit={[{ x: 0, y: 0, z: 0, w: -40, d: 40, h: 10 }]} />)
    expect(host?.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 10 10")
    expect(noteLines()).toEqual(["w cannot be negative"])
  })
  it("does not ask for a fit when a viewBox frames the plate", () => {
    render(<Plate label="Own frame" viewBox="0 0 10 10" />)
    expect(note()).toBeNull()
  })
  it("leaves the note out of a production build", async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.resetModules()
    vi.stubEnv("NODE_ENV", "production")
    const production = await import("../src")
    const bad = { x: 0, y: 0, z: 0, w: -40, d: 40, h: 10 }
    act(() =>
      root?.render(
        <production.Plate label="Bad key" fit={[bad]}>
          <svg>
            <production.Box {...bad} />
          </svg>
        </production.Plate>,
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(host?.querySelector(".ik-note")).toBeNull()
    expect(host?.querySelectorAll(".ik-face")).toHaveLength(0)
    expect(warn.mock.calls.some((call) => String(call[0]).includes("react-isokit:"))).toBe(false)
    expect(production.frame([bad])).not.toContain("NaN")
  })
})

describe("frame, against bad input", () => {
  it("returns a stable viewBox when every point is not finite", () => {
    const box = { x: Number.NaN, y: Number.POSITIVE_INFINITY, z: 0, w: 10, d: 10, h: 10 }
    expect(frame([box])).toBe("0 0 100 100")
    expect(frame([[Number.NaN, 0, 0]])).toBe("0 0 100 100")
    expect(frame([])).toBe("0 0 100 100")
  })
  it("never writes NaN, even with bad aspect or pad", () => {
    const box = { x: 0, y: 0, z: 0, w: 100, d: 60, h: 40 }
    for (const view of [frame([box], Number.NaN, 0.07), frame([box], 0, 0.07), frame([box], -2, 0.07), frame([box], 1.25, Number.NaN), frame([box], 1.25, -1), frame([box], 1.25, Number.POSITIVE_INFINITY)]) {
      expect(view).not.toContain("NaN")
      expect(view.split(" ")).toHaveLength(4)
      expect(view.split(" ").map(Number).every(Number.isFinite)).toBe(true)
    }
  })
  it("falls back to aspect 1.25 and pad 0.07", () => {
    const box = { x: 0, y: 0, z: 0, w: 100, d: 60, h: 40 }
    expect(frame([box], Number.NaN, Number.NaN)).toBe(frame([box], 1.25, 0.07))
    expect(frame([box], 0, -1)).toBe(frame([box], 1.25, 0.07))
    expect(frame([box], Number.POSITIVE_INFINITY, 3)).toBe(frame([box], 1.25, 0.07))
  })
})

describe("Box, in development", () => {
  it("returns nothing for a box it cannot draw and names the parameter once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    render(
      <svg>
        <Box x={0} y={0} z={0} w={40} d={-1} h={10} />
        <Box x={Number.NaN} y={0} z={0} w={40} d={10} h={10} />
      </svg>,
    )
    expect(host?.querySelectorAll(".ik-face")).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const messages = warn.mock.calls.map((call) => String(call[0]))
    expect(messages.some((message) => message.includes("d cannot be negative"))).toBe(true)
    expect(messages.some((message) => message.includes("x must be a finite number"))).toBe(true)
  })
  it("says nothing about a box it can draw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    render(
      <svg>
        <Box x={0} y={0} z={0} w={40} d={40} h={10} />
      </svg>,
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(warn).not.toHaveBeenCalled()
  })
})
