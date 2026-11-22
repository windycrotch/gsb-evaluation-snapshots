import Page from '@/components/Page'
import { useGrassGeometry, type GrassGeometryStatus } from '@/lib/useGrassGeometry'
import {
  createGrassPositionNode,
  createGrassWindUniforms,
  defaultGrassBladeParams,
  defaultGrassSeed,
  defaultGrassWindParams,
  resolveGrassBladeParams,
} from '@/shaders/grass/grass'
import { useGLTF } from '@react-three/drei'
import { folder, useControls } from 'leva'
import { useEffect, useMemo, useState } from 'react'
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Mesh } from 'three'

const terrainSrc = new URL('../shaders/grass/terrain.glb', import.meta.url).href

type Nodes = {
  grass: Mesh
  terrain: Mesh
}

type GrassStatusState = {
  status: GrassGeometryStatus
  progress: number
  error: string | null
  retry?: () => void
}

/** A grid missing its `normal` attribute, used to exercise the failed-rebuild path. */
const createGridWithoutNormals = () => {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 1], 3))
  return geometry
}

const statusMessage = ({ status, error }: GrassStatusState) => {
  switch (status) {
    case 'pending':
      return 'Waiting for parameters to settle…'
    case 'building':
      return 'Growing grass…'
    case 'error':
      return error ?? 'Could not rebuild the grass. Showing the last valid geometry.'
    default:
      return ''
  }
}

const GrassStatusOverlay = (state: GrassStatusState) => {
  const { status, progress, retry } = state
  const visible = status === 'pending' || status === 'building' || status === 'error'

  return (
    <div
      aria-live="polite"
      data-grass-status={status}
      className={`fixed bottom-12 left-3 z-50 max-w-sm rounded-md px-3 py-2 text-sm text-white transition-opacity duration-200 ${
        visible ? 'opacity-100' : 'opacity-0'
      } ${status === 'error' ? 'bg-red-700/90' : 'pointer-events-none bg-black/70'}`}
    >
      {statusMessage(state)}
      {status === 'building' && (
        <div className="mt-1 h-1 w-40 overflow-hidden rounded bg-white/30">
          <div
            className="h-full bg-white transition-[width] duration-100"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      )}
      {status === 'error' && retry && (
        <button className="mt-2 rounded bg-white/20 px-2 py-1 text-xs hover:bg-white/30" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  )
}

const GrassScene = ({ onStatusChange }: { onStatusChange: (state: GrassStatusState) => void }) => {
  const { grass: grassGrid, terrain } = useGLTF(terrainSrc).nodes as Nodes

  const {
    windSpeed,
    windSize,
    windDisplacement,
    upBias,
    bladesPerPoint,
    clusterRadius,
    heightMin,
    heightMax,
    widthMin,
    widthMax,
    colorSamples,
    baseDarkness,
    colorA,
    colorB,
    seed,
    brokenGrid,
  } = useControls({
    Wind: folder({
      windSpeed: { value: defaultGrassWindParams.windSpeed, min: 0, max: 5, step: 0.01 },
      windSize: { value: defaultGrassWindParams.windSize, min: 0.1, max: 10, step: 0.01 },
      windDisplacement: { value: defaultGrassWindParams.windDisplacement, min: 0, max: 2, step: 0.01 },
      upBias: { value: defaultGrassWindParams.upBias, min: 0, max: 5, step: 0.01 },
    }),
    Blades: folder({
      bladesPerPoint: { value: defaultGrassBladeParams.bladesPerPoint, min: 0, max: 60, step: 1 },
      clusterRadius: { value: defaultGrassBladeParams.clusterRadius, min: 0, max: 2, step: 0.01 },
      heightMin: { value: defaultGrassBladeParams.heightVariation.min, min: 0, max: 2, step: 0.01 },
      heightMax: { value: defaultGrassBladeParams.heightVariation.max, min: 0, max: 2, step: 0.01 },
      widthMin: { value: defaultGrassBladeParams.widthVariation.min, min: 0, max: 1, step: 0.005 },
      widthMax: { value: defaultGrassBladeParams.widthVariation.max, min: 0, max: 1, step: 0.005 },
      colorSamples: { value: defaultGrassBladeParams.colorSamples, min: 1, max: 16, step: 1 },
      baseDarkness: { value: defaultGrassBladeParams.baseDarkness, min: 0, max: 1, step: 0.01 },
      colorA: defaultGrassBladeParams.colorA,
      colorB: defaultGrassBladeParams.colorB,
      seed: { value: defaultGrassSeed, min: 0, max: 999, step: 1 },
    }),
    Debug: folder({
      brokenGrid: { value: false, label: 'Break grid' },
    }),
  })

  // Wind lives entirely in TSL uniforms: changing these values only touches the
  // shader side, so the blade distribution and geometry stay untouched.
  const windUniforms = useMemo(() => createGrassWindUniforms(), [])
  const positionNode = useMemo(() => createGrassPositionNode(windUniforms), [windUniforms])

  useEffect(() => {
    windUniforms.windSpeed.value = windSpeed
    windUniforms.windSize.value = Math.max(1e-4, windSize)
    windUniforms.windDisplacement.value = windDisplacement
    windUniforms.upBias.value = upBias
  }, [windUniforms, windSpeed, windSize, windDisplacement, upBias])

  // Only baked-in blade parameters are part of this object, so its serialized
  // key changes if and only if one of them changes.
  const bladeParams = useMemo(
    () =>
      resolveGrassBladeParams({
        bladesPerPoint,
        clusterRadius,
        heightVariation: { min: heightMin, max: heightMax },
        widthVariation: { min: widthMin, max: widthMax },
        colorSamples,
        baseDarkness,
        colorA,
        colorB,
      }),
    [bladesPerPoint, clusterRadius, heightMin, heightMax, widthMin, widthMax, colorSamples, baseDarkness, colorA, colorB],
  )

  const brokenGeometry = useMemo(() => (brokenGrid ? createGridWithoutNormals() : null), [brokenGrid])

  useEffect(() => {
    return () => {
      brokenGeometry?.dispose()
    }
  }, [brokenGeometry])

  const { geometry, status, progress, error, retry } = useGrassGeometry({
    sourceGeometry: brokenGeometry ?? grassGrid.geometry,
    bladeParams,
    seed,
  })

  useEffect(() => {
    onStatusChange({ status, progress, error, retry })
  }, [onStatusChange, status, progress, error, retry])

  return (
    <>
      <group scale={0.3}>
        <mesh geometry={terrain.geometry}>
          <meshLambertMaterial color="#000" side={DoubleSide} />
        </mesh>
        {geometry && (
          <mesh geometry={geometry}>
            <meshLambertNodeMaterial positionNode={positionNode} vertexColors />
          </mesh>
        )}
        <mesh geometry={terrain.geometry} position-y={0}>
          <meshLambertMaterial color="#69f" wireframe />
        </mesh>
        <mesh geometry={grassGrid.geometry} position-y={-0.05}>
          <meshLambertMaterial color="#f33" wireframe />
        </mesh>
      </group>
      <directionalLight position={[0, 10, -3]} intensity={3} />
    </>
  )
}

const GrassPage = () => {
  // Status lives outside the canvas so it can be rendered as DOM.
  const [status, setStatus] = useState<GrassStatusState>({ status: 'idle', progress: 0, error: null })

  return (
    <>
      <Page title="Grass">
        <GrassScene onStatusChange={setStatus} />
      </Page>
      <GrassStatusOverlay {...status} />
    </>
  )
}

export default GrassPage
