import { describe, it, expect } from 'vitest'
import { BoxGeometry, Texture, Vector3 } from 'three'
import { Fire } from '../src/Fire'
import { FireTSL } from '../src/tsl/FireTSL'
import {
  FIRE_STEP_FACTOR,
  computeFireStep,
  writeWorldBoundingBoxSize,
} from '../src/internal/fireStep'

const STEP_AT_IDENTITY = FIRE_STEP_FACTOR * Math.sqrt(3)

describe('fireStep helpers', () => {
  describe('computeFireStep', () => {
    it('reproduces the historical step length for the unit cube', () => {
      // BoxGeometry(1,1,1) at identity has extents (1,1,1).
      const step = computeFireStep(new Vector3(1, 1, 1))
      expect(step).toBeCloseTo(STEP_AT_IDENTITY)
      // And matches the legacy `0.0288 * length(scale)` expression exactly.
      expect(step).toBeCloseTo(0.0288 * new Vector3(1, 1, 1).length())
    })

    it('grows monotonically as any bounding-box axis grows', () => {
      let previous = -1
      for (const extent of [0, 0.5, 1, 2, 4, 8]) {
        const step = computeFireStep(new Vector3(extent, extent, extent))
        expect(step).toBeGreaterThanOrEqual(previous)
        previous = step
      }

      // Monotonic in each axis independently.
      const base = computeFireStep(new Vector3(1, 1, 1))
      expect(computeFireStep(new Vector3(2, 1, 1))).toBeGreaterThan(base)
      expect(computeFireStep(new Vector3(1, 2, 1))).toBeGreaterThan(base)
      expect(computeFireStep(new Vector3(1, 1, 2))).toBeGreaterThan(base)
    })

    it('returns 0 (not NaN/Infinity) for a fully collapsed box', () => {
      const step = computeFireStep(new Vector3(0, 0, 0))
      expect(Number.isNaN(step)).toBe(false)
      expect(Number.isFinite(step)).toBe(true)
      expect(step).toBe(0)
    })

    it('handles partial zero extents without producing NaN/Infinity', () => {
      const step = computeFireStep(new Vector3(0, 2, 0))
      expect(Number.isFinite(step)).toBe(true)
      expect(step).toBeCloseTo(FIRE_STEP_FACTOR * 2)
    })
  })

  describe('writeWorldBoundingBoxSize', () => {
    const makeFires = () => {
      const texture = new Texture()

      return {
        glsl: new Fire({ fireTex: texture }),
        tsl: new FireTSL({ fireTex: texture }),
      }
    }

    it('measures the unit cube as (1,1,1) at identity for both back-ends', () => {
      const { glsl, tsl } = makeFires()
      const a = writeWorldBoundingBoxSize(glsl, new Vector3())
      const b = writeWorldBoundingBoxSize(tsl, new Vector3())

      expect(a).toMatchObject({ x: 1, y: 1, z: 1 })
      expect(b).toMatchObject({ x: 1, y: 1, z: 1 })
    })

    it('returns identical finite extents for GLSL and TSL at every scale', () => {
      const scales: Array<[number, number, number]> = [
        [1, 1, 1],
        [2, 3, 2],
        [0.5, 4, 1.25],
        [0, 0, 0],
        [0, 2, 3],
        [-1, -1, -1],
        [-2, 3, -4],
      ]

      for (const [x, y, z] of scales) {
        const { glsl, tsl } = makeFires()
        glsl.scale.set(x, y, z)
        tsl.scale.set(x, y, z)

        const glslSize = writeWorldBoundingBoxSize(glsl, new Vector3())
        const tslSize = writeWorldBoundingBoxSize(tsl, new Vector3())

        expect(glslSize.x).toBeCloseTo(tslSize.x)
        expect(glslSize.y).toBeCloseTo(tslSize.y)
        expect(glslSize.z).toBeCloseTo(tslSize.z)

        for (const component of [glslSize.x, glslSize.y, glslSize.z]) {
          expect(Number.isFinite(component)).toBe(true)
          expect(component).toBeGreaterThanOrEqual(0)
        }
      }
    })

    it('derives the same step for both back-ends under matching transforms', () => {
      const { glsl, tsl } = makeFires()
      glsl.scale.set(-2, 3, 0)
      tsl.scale.set(-2, 3, 0)

      const glslStep = computeFireStep(writeWorldBoundingBoxSize(glsl, new Vector3()))
      const tslStep = computeFireStep(writeWorldBoundingBoxSize(tsl, new Vector3()))

      expect(glslStep).toBeCloseTo(tslStep)
      expect(Number.isFinite(glslStep)).toBe(true)
    })

    it('uses the actual geometry, not just the scale vector', () => {
      const { glsl } = makeFires()
      glsl.geometry = new BoxGeometry(2, 4, 6)
      glsl.scale.set(1, 1, 1)
      const size = writeWorldBoundingBoxSize(glsl, new Vector3())
      expect(size).toMatchObject({ x: 2, y: 4, z: 6 })
    })
  })
})
