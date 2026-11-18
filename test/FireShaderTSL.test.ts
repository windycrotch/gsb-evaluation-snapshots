import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFireUniforms, createFireFragmentNode } from '../src/tsl/FireShaderTSL'
import { Color, Texture, Matrix4, Vector3, Vector4, LinearFilter, ClampToEdgeWrapping } from 'three'

/* eslint-disable @typescript-eslint/no-explicit-any */

const tslShaderSource = readFileSync(join(process.cwd(), 'src/tsl/FireShaderTSL.ts'), 'utf8')
const glslShaderSource = readFileSync(join(process.cwd(), 'src/FireShader.ts'), 'utf8')

describe('FireShaderTSL', () => {
  describe('createFireUniforms', () => {
    it('builds uniforms with the expected value types', () => {
      const tex = new Texture()
      const u = createFireUniforms({ fireTex: tex }) as any
      expect(u.fireTex).toBe(tex)
      expect(u.color.value).toBeInstanceOf(Color)
      expect(u.time.value).toBe(0)
      expect(u.seed.value).toBeTypeOf('number')
      expect(u.invModelMatrix.value).toBeInstanceOf(Matrix4)
      expect(u.scale.value).toBeInstanceOf(Vector3)
      expect(u.noiseScale.value).toBeInstanceOf(Vector4)
      expect(u.magnitude.value).toBe(1.3)
      expect(u.lacunarity.value).toBe(2.0)
      expect(u.gain.value).toBe(0.5)
    })

    it('honors a custom config', () => {
      const u = createFireUniforms({
        fireTex: new Texture(),
        color: 0xff4400,
        magnitude: 2,
        lacunarity: 3,
        gain: 0.7,
        noiseScale: [4, 5, 6, 7],
      }) as any
      expect(u.magnitude.value).toBe(2)
      expect(u.lacunarity.value).toBe(3)
      expect(u.gain.value).toBe(0.7)
      expect(u.noiseScale.value).toMatchObject({ x: 4, y: 5, z: 6, w: 7 })
    })

    it('defaults color to 0xeeeeee', () => {
      const u = createFireUniforms({ fireTex: new Texture() }) as any
      expect(u.color.value.getHex()).toBe(new Color(0xeeeeee).getHex())
    })

    it('configures the texture sampler state', () => {
      const tex = new Texture()
      createFireUniforms({ fireTex: tex })
      expect(tex.magFilter).toBe(LinearFilter)
      expect(tex.minFilter).toBe(LinearFilter)
      expect(tex.wrapS).toBe(ClampToEdgeWrapping)
      expect(tex.wrapT).toBe(ClampToEdgeWrapping)
    })
  })

  describe('createFireFragmentNode', () => {
    it('returns a TSL node with default iterations/octaves', () => {
      const u = createFireUniforms({ fireTex: new Texture() })
      const node = createFireFragmentNode(u)
      expect(node).toBeDefined()
      expect(typeof node).toBe('object')
    })

    it('accepts custom iterations and octaves without throwing', () => {
      const u = createFireUniforms({ fireTex: new Texture() })
      expect(() => createFireFragmentNode(u, 30, 5)).not.toThrow()
      expect(() => createFireFragmentNode(u, 10, 1)).not.toThrow()
    })
  })

  describe('march step formula parity with the GLSL path', () => {
    it('uses the same 0.0288 factor and bounding-box length as the GLSL shader', () => {
      expect(tslShaderSource).toContain('0.0288')
      expect(tslShaderSource).toMatch(/length\(u\.scale\)/)
      // Degenerate-box guard mirroring the GLSL max(length(...), 0.0).
      expect(tslShaderSource).toMatch(/max\(length\(u\.scale\)/)
      expect(tslShaderSource).toMatch(/float\(0\.0288\)\.mul\(boxSize\)/)

      // Both back-ends share the literal coefficient.
      const glslFactor = glslShaderSource.match(/0\.0288/)
      const tslFactor = tslShaderSource.match(/0\.0288/)
      expect(glslFactor).not.toBeNull()
      expect(tslFactor).not.toBeNull()
      expect(tslFactor?.[0]).toBe(glslFactor?.[0])
    })

    it('drives animation from the instance time uniform, not the global TSL clock', () => {
      // The global `time` node import must be gone...
      expect(tslShaderSource).not.toMatch(/^\s*time,?\s*$/m)
      // ...and the sampler must read the per-instance uniform instead.
      expect(tslShaderSource).toContain('uniforms.seed.add(uniforms.time)')
    })

    it('keeps a writable time uniform that starts at zero', () => {
      const u = createFireUniforms({ fireTex: new Texture() }) as any
      expect(u.time.value).toBe(0)
      u.time.value = 42
      expect(u.time.value).toBe(42)
    })
  })
})
