'use client'

import { useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { useStore } from '@/lib/store'
import { Image } from '../image'
import { Model } from '../model'
import type { MediaHandle } from '../textured-plane'
import { Video } from '../video'
import { createCaptureController } from './capture-controller'

const PLACEHOLDER = '/placeholder/3.jpg'

export function Content() {
  const file = useStore((state) => state.file)
  const registerActions = useStore((state) => state.registerActions)
  const setRecording = useStore((state) => state.setRecording)

  const isVideo = file?.type.includes('video/') ?? false
  const isModel = useMemo(() => {
    const name = file?.name.toLowerCase() ?? ''
    return name.endsWith('.glb') || name.endsWith('.gltf')
  }, [file])
  const isImage = Boolean(file) && !isVideo && !isModel

  const src = useMemo(
    () => (file ? URL.createObjectURL(file) : PLACEHOLDER),
    [file]
  )
  useEffect(() => {
    return () => {
      if (file) URL.revokeObjectURL(src)
    }
  }, [src, file])

  const size = useThree((state) => state.size)
  const gl = useThree((state) => state.gl)
  const setSize = useThree((state) => state.setSize)

  const assetRef = useRef<MediaHandle>(null)
  const mountedRef = useRef(true)
  const sizeRef = useRef(size)
  sizeRef.current = size

  // The capture controller holds all recorder/stream/export state. It is a
  // plain object (no side effects on creation), so it is safe to build lazily
  // and reuse for the component's whole lifetime.
  const controllerRef = useRef<ReturnType<
    typeof createCaptureController
  > | null>(null)
  if (!controllerRef.current) {
    controllerRef.current = createCaptureController({
      canvas: gl.domElement,
      getSize: () => sizeRef.current,
      setSize,
      getAssetSize: () => assetRef.current?.size,
      onRecordingChange: setRecording,
      isMounted: () => mountedRef.current,
    })
  }

  useEffect(() => {
    mountedRef.current = true
    const controller = controllerRef.current
    if (!controller) return

    // Stable wrappers: the DOM panel calls these via the store, and they
    // always delegate to the live controller regardless of re-renders.
    registerActions({
      exportImage: () => controller.exportImage(),
      startRecording: () => controller.startRecording(),
      stopRecording: () => controller.stopRecording(),
    })

    return () => {
      mountedRef.current = false
      // Stop any active MediaRecorder, release capture tracks and revoke
      // the pending download object URL.
      controller.dispose()
      if (useStore.getState().recording) setRecording(false)
    }
  }, [registerActions, setRecording])

  return (
    <>
      {(isImage || !file) && (
        <Image src={src} scale={[size.width, size.height, 0]} ref={assetRef} />
      )}
      {isVideo && (
        <Video src={src} scale={[size.width, size.height, 0]} ref={assetRef} />
      )}
      {isModel && <Model src={src} />}
    </>
  )
}
