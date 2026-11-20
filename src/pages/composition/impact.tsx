import Page from '@/components/Page'
import { createImpactTimeline } from '@/lib/impactTimeline'
import { defaultImpactUniforms, impact } from '@/shaders'
import type { ImpactUniforms } from '@/shaders/impact'
import { useFrame } from '@react-three/fiber'
import { button, folder, useControls } from 'leva'
import type { ButtonInput } from 'leva/dist/declarations/src/types'
import { useMemo, useRef } from 'react'
import { Vector4 } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'

type Preset = { name: string; uniforms: ImpactUniforms }

const impactPresets: Preset[] = [
  {
    name: 'Smash',
    uniforms: {
      ...defaultImpactUniforms,
      circleColor: new Vector4(1, 0.1, 0, 1),
      vesicaColor: new Vector4(1, 0.6, 0, 1),
      vesicaCount: 6,
      duration: 0.5,
      circleSizeStart: 0,
      circleSizeEnd: 0.6,
      circleThickness: 0.13,
    },
  },
  {
    name: 'Void Blast',
    uniforms: {
      ...defaultImpactUniforms,
      circleColor: new Vector4(0, 0, 0, 0.9),
      vesicaColor: new Vector4(0.1, 0, 1, 1),
      vesicaCount: 6,
      circleSizeStart: 1,
      circleSizeEnd: 0.2,
      circleThickness: 0.18,
      duration: 0.7,
    },
  },
  {
    name: 'Cherry Blossom',
    uniforms: {
      ...defaultImpactUniforms,
      circleColor: new Vector4(1, 0.8, 1, 1),
      vesicaColor: new Vector4(1, 0.4, 1, 1),
      vesicaCount: 10,
      circleSizeStart: 0.2,
      circleSizeEnd: 0.6,
      circleThickness: 0.1,
      duration: 0.7,
    },
  },
  {
    name: 'Default',
    uniforms: {
      ...defaultImpactUniforms,
      circleColor: defaultImpactUniforms.circleColor.clone(),
      vesicaColor: defaultImpactUniforms.vesicaColor.clone(),
    },
  },
]

const defaultUniforms = impactPresets[0].uniforms

const ImpactMaterial = () => {
  const materialRef = useRef<MeshBasicNodeMaterial>(null)

  // Single source of truth for the timeline. The Leva panel and the shader
  // uniforms are both views of this state; nothing else owns time.
  const timeline = useMemo(() => createImpactTimeline({ duration: defaultUniforms.duration }), [])
  // True while the user is interacting with the time slider, so our own
  // write-backs don't get mistaken for user input (or overwrite it).
  const editingTime = useRef(false)

  const [{ circleColor, vesicaColor, vesicaCount, circleSizeStart, circleSizeEnd, circleThickness }, setControls] =
    useControls(() => {
      const presets: Record<string, ButtonInput> = Object.fromEntries(
        impactPresets.map(preset => [
          preset.name,
          button(() => {
            // Atomic switch: reset time, adopt the new duration and reseed in
            // one go, so no frame can advance with the old duration.
            timeline.applyPreset({ duration: preset.uniforms.duration })
            const { seed, aspect, time, ...rest } = preset.uniforms
            setControls({
              ...rest,
              circleColor: {
                r: preset.uniforms.circleColor.x * 255,
                g: preset.uniforms.circleColor.y * 255,
                b: preset.uniforms.circleColor.z * 255,
                a: preset.uniforms.circleColor.w,
              },
              vesicaColor: {
                r: preset.uniforms.vesicaColor.x * 255,
                g: preset.uniforms.vesicaColor.y * 255,
                b: preset.uniforms.vesicaColor.z * 255,
                a: preset.uniforms.vesicaColor.w,
              },
              autoplay: true,
              time: 0,
            })
          }),
        ]),
      )

      return {
        Animation: folder({
          time: {
            value: 0,
            min: 0,
            max: 1,
            step: 0.01,
            transient: false,
            onEditStart: () => {
              editingTime.current = true
            },
            onEditEnd: () => {
              editingTime.current = false
            },
            onChange: (time: number) => {
              if (!editingTime.current) return // our own write-back, not a user edit
              timeline.scrub(time)
              setControls({ autoplay: false })
            },
          },
          duration: {
            value: defaultUniforms.duration,
            min: 0,
            max: 3,
            step: 0.1,
            transient: false,
            onChange: (duration: number) => timeline.setDuration(duration),
          },
          autoplay: {
            value: true,
            transient: false,
            onChange: (playing: boolean) => {
              // Resuming at the end of the timeline restarts from 0 with a
              // fresh seed; reflect that restart in the panel.
              if (timeline.setPlaying(playing)) setControls({ time: 0 })
            },
          },
        }),
        Uniforms: folder({
          circleColor: {
            value: {
              r: defaultUniforms.circleColor.x * 255,
              g: defaultUniforms.circleColor.y * 255,
              b: defaultUniforms.circleColor.z * 255,
              a: defaultUniforms.circleColor.w,
            },
          },
          vesicaColor: {
            value: {
              r: defaultUniforms.vesicaColor.x * 255,
              g: defaultUniforms.vesicaColor.y * 255,
              b: defaultUniforms.vesicaColor.z * 255,
              a: defaultUniforms.vesicaColor.w,
            },
          },
          circleSizeStart: { value: defaultUniforms.circleSizeStart, min: 0, max: 1, step: 0.01 },
          circleSizeEnd: { value: defaultUniforms.circleSizeEnd, min: 0, max: 1, step: 0.01 },
          circleThickness: { value: defaultUniforms.circleThickness, min: 0, max: 1, step: 0.01 },
          vesicaCount: {
            value: defaultUniforms.vesicaCount,
            min: 0,
            max: 15,
            step: 1,
          },
        }),
        Presets: folder(presets),
      }
    })

  const { uniforms, nodes } = useMemo(() => impact({ duration: defaultUniforms.duration }), [])

  useFrame((_, delta) => {
    // Auto-advance is the only path that writes time back to the panel,
    // and never while the user is dragging the slider.
    const time = timeline.advance(delta)
    if (time !== null && !editingTime.current) setControls({ time })

    // The timeline owns time, duration and seed; uniforms just follow it.
    uniforms.time.value = timeline.state.time
    uniforms.duration.value = timeline.state.duration
    uniforms.seed.value = timeline.state.seed
  })

  uniforms.circleColor.value.x = circleColor.r / 255
  uniforms.circleColor.value.y = circleColor.g / 255
  uniforms.circleColor.value.z = circleColor.b / 255
  uniforms.circleColor.value.w = circleColor.a
  uniforms.vesicaColor.value.x = vesicaColor.r / 255
  uniforms.vesicaColor.value.y = vesicaColor.g / 255
  uniforms.vesicaColor.value.z = vesicaColor.b / 255
  uniforms.vesicaColor.value.w = vesicaColor.a
  uniforms.circleSizeStart.value = circleSizeStart
  uniforms.circleSizeEnd.value = circleSizeEnd
  uniforms.circleThickness.value = circleThickness
  uniforms.vesicaCount.value = vesicaCount

  return <meshBasicNodeMaterial ref={materialRef} {...nodes} transparent />
}

const ImpactPage = () => (
  <Page title="Impact" levaProps={{ theme: { sizes: { rootWidth: '310px' } } }} is2D>
    <ImpactMaterial />
  </Page>
)

export default ImpactPage
