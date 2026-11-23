'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { EffectComposer, EffectPass, RenderPass } from 'postprocessing'
import { useEffect, useMemo } from 'react'
import { HalfFloatType } from 'three'
import { useDitheringEffect } from './effects/dithering'

export function PostProcessing() {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera)
  const dpr = useThree((state) => state.viewport.dpr)
  // The source of truth for the drawing buffer size — updated by R3F itself,
  // including the temporary resize performed during PNG export. Tracking this
  // (instead of the window size) keeps the composer's buffers in sync even when
  // the canvas and the window have different dimensions.
  const size = useThree((state) => state.size)

  const isWebgl2 = gl.capabilities.isWebGL2
  const maxSamples = gl.capabilities.maxSamples
  const needsAA = dpr < 2

  const composer = useMemo(
    () =>
      new EffectComposer(gl, {
        multisampling: isWebgl2 && needsAA ? maxSamples : 0,
        frameBufferType: HalfFloatType,
      }),
    [gl, needsAA, isWebgl2, maxSamples]
  )

  const renderPass = useMemo(
    () => new RenderPass(scene, camera),
    [scene, camera]
  )

  const ditheringEffect = useDitheringEffect()
  const ditheringPass = useMemo(
    () => new EffectPass(camera, ditheringEffect),
    [camera, ditheringEffect]
  )

  useEffect(() => {
    composer.addPass(renderPass)
    composer.addPass(ditheringPass)

    return () => {
      // Release every GPU resource this pipeline owns when the canvas
      // unmounts: composer frame buffers, pass materials, and effect shaders.
      composer.removePass(renderPass)
      composer.removePass(ditheringPass)
      renderPass.dispose()
      ditheringPass.dispose()
      composer.dispose()
    }
  }, [composer, renderPass, ditheringPass])

  useEffect(() => {
    if (size.width && size.height) composer.setSize(size.width, size.height)
  }, [composer, size.width, size.height])

  useFrame((_, deltaTime) => {
    composer.render(deltaTime)
  }, 1)

  return null
}
