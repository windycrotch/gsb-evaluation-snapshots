import { CanvasTexture, NearestFilter, type Texture, Vector2 } from 'three'
import {
  type Ditherer,
  type DithererName,
  type DitheringMode,
  ORDERED_DITHERERS,
} from '@/webgl/utils/ordered-ditherers'
import type { DitheringEffect } from './effect'

export interface BuiltMatrixTexture {
  texture: Texture
  size: Vector2
}

/**
 * Renders an ordered ditherer's threshold matrix into a nearest-filtered GPU
 * texture. Kept separate from the lifecycle manager so the dispose sequencing
 * can be unit-tested with an injected factory.
 */
export function buildOrderedMatrixTexture(
  mode: DithererName
): BuiltMatrixTexture {
  const ditherer: Ditherer = ORDERED_DITHERERS[mode]

  const buffer = document.createElement('canvas')
  buffer.width = ditherer.x
  buffer.height = ditherer.y
  const context = buffer.getContext('2d')
  if (!context) {
    throw new Error('2D canvas context unavailable for matrix texture')
  }

  const image = context.createImageData(ditherer.x, ditherer.y)
  const buffer32 = new Uint32Array(image.data.buffer)
  for (let i = 0; i < buffer32.length; i++) {
    const value = (ditherer.matrix[i] ?? 0) / ditherer.max
    const channel = Math.floor(value * 255)
    buffer32[i] = (255 << 24) | (channel << 16) | (channel << 8) | channel
  }
  context.putImageData(image, 0, 0)

  const texture = new CanvasTexture(buffer)
  texture.minFilter = NearestFilter
  texture.magFilter = NearestFilter
  texture.flipY = false

  return { texture, size: new Vector2(ditherer.x, ditherer.y) }
}

export interface MatrixTextureManager {
  /** Binds the matrix for `mode`, always releasing the previous texture. */
  setMode: (mode: DitheringMode) => void
  /** Releases the currently bound texture (component/effect teardown). */
  dispose: () => void
}

/**
 * Owns the single matrix texture bound to a {@link DitheringEffect}. Every mode
 * change — including RANDOM and repeated switches within one frame — first
 * disposes the texture currently on the GPU, so a stale matrix can never be
 * reused or leaked.
 */
export function createMatrixTextureManager(
  effect: DitheringEffect,
  buildTexture: (
    mode: DithererName
  ) => BuiltMatrixTexture = buildOrderedMatrixTexture
): MatrixTextureManager {
  let current: Texture | null = null

  const release = () => {
    if (current) {
      current.dispose()
      current = null
    }
  }

  return {
    setMode(mode) {
      // Release first, unconditionally: this is what makes back-to-back mode
      // switches safe and prevents leaks.
      release()

      if (mode === 'RANDOM') {
        effect.random = true
        effect.matrixTexture = null
        return
      }

      effect.random = false
      const { texture, size } = buildTexture(mode)
      current = texture
      effect.matrixTexture = texture
      effect.matrixTextureSize = size
    },
    dispose() {
      release()
      // Detach from the effect so no subsequent render can sample a texture
      // that has been released.
      effect.matrixTexture = null
    },
  }
}
