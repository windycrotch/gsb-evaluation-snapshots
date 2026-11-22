import { BufferAttribute, BufferGeometry, Color, Vector3 } from 'three'
import {
  add,
  attribute,
  cameraPosition,
  cross,
  div,
  mul,
  mx_noise_vec3,
  normalize,
  positionLocal,
  positionWorld,
  sub,
  time,
  uniform,
  vec3,
  vertexIndex,
} from 'three/tsl'

export type GrassVariation = { min: number; max: number }

/**
 * Parameters baked into the grass geometry. Changing any of these requires
 * generating a new geometry, because the blade distribution lives in the
 * vertex attributes.
 */
export type GrassBladeParams = {
  colorA: string
  colorB: string
  colorSamples: number
  bladesPerPoint: number
  clusterRadius: number
  heightVariation: GrassVariation
  widthVariation: GrassVariation
  baseDarkness: number
}

/**
 * Parameters living in the vertex shader. Changing any of these only updates
 * uniforms, so the blade distribution and the geometry stay untouched.
 */
export type GrassWindParams = {
  windSpeed: number
  windSize: number
  windDisplacement: number
  upBias: number
}

export const defaultGrassBladeParams: GrassBladeParams = {
  colorA: '#3a0',
  colorB: '#180',
  colorSamples: 4,
  bladesPerPoint: 30,
  clusterRadius: 0.5,
  heightVariation: { min: 0.3, max: 0.7 },
  widthVariation: { min: 0.1, max: 0.2 },
  baseDarkness: 0.7,
}

export const defaultGrassWindParams: GrassWindParams = {
  windSpeed: 0.8,
  windSize: 1.5,
  windDisplacement: 0.4,
  upBias: 1.5,
}

export const defaultGrassSeed = 0

/** Raised when the source grid cannot be used to build grass geometry. */
export class GrassGeometryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GrassGeometryError'
  }
}

/**
 * Small, fast, deterministic PRNG (mulberry32). Seeding keeps a given set of
 * blade parameters reproducible, and since wind parameters never reach the
 * generator, a wind tweak can never shift the distribution.
 */
export const createSeededRandom = (seed: number) => {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const resolveGrassBladeParams = (
  params: Partial<GrassBladeParams> = {},
  defaults: GrassBladeParams = defaultGrassBladeParams,
): GrassBladeParams => {
  const heightMin = params.heightVariation?.min ?? defaults.heightVariation.min
  const heightMax = params.heightVariation?.max ?? defaults.heightVariation.max
  const widthMin = params.widthVariation?.min ?? defaults.widthVariation.min
  const widthMax = params.widthVariation?.max ?? defaults.widthVariation.max

  return {
    colorA: params.colorA ?? defaults.colorA,
    colorB: params.colorB ?? defaults.colorB,
    colorSamples: Math.max(1, Math.round(params.colorSamples ?? defaults.colorSamples)),
    bladesPerPoint: Math.max(0, Math.round(params.bladesPerPoint ?? defaults.bladesPerPoint)),
    clusterRadius: Math.max(0, params.clusterRadius ?? defaults.clusterRadius),
    heightVariation: { min: Math.min(heightMin, heightMax), max: Math.max(heightMin, heightMax) },
    widthVariation: { min: Math.min(widthMin, widthMax), max: Math.max(widthMin, widthMax) },
    baseDarkness: params.baseDarkness ?? defaults.baseDarkness,
  }
}

export const resolveGrassWindParams = (
  params: Partial<GrassWindParams> = {},
  defaults: GrassWindParams = defaultGrassWindParams,
): GrassWindParams => ({
  windSpeed: params.windSpeed ?? defaults.windSpeed,
  // A zero noise scale would divide by zero in the shader.
  windSize: Math.max(1e-4, params.windSize ?? defaults.windSize),
  windDisplacement: params.windDisplacement ?? defaults.windDisplacement,
  upBias: params.upBias ?? defaults.upBias,
})

const getNow = () => {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance
  return typeof perf?.now === 'function' ? perf.now() : Date.now()
}

type GrassGeometryBuilderOptions = GrassBladeParams & {
  geometry: BufferGeometry
  seed: number
}

type BladeBuffers = {
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  heights: Float32Array
  widths: Float32Array
  indices: Uint32Array
}

export type GrassGeometryBuilder = {
  /** Total number of blades this build will generate. */
  readonly totalBlades: number
  /** Progress in the [0, 1] range. */
  readonly progress: number
  readonly cancelled: boolean
  readonly finished: boolean
  /**
   * Generates blades for at most `budgetMs` milliseconds.
   * Returns `true` once the build is finished (or cancelled).
   */
  step: (budgetMs?: number) => boolean
  /**
   * Takes ownership of the finished geometry. Returns `null` when the build is
   * not finished yet or was cancelled. Once taken, `cancel()` no longer
   * disposes it, and releasing it becomes the caller's responsibility.
   */
  takeGeometry: () => BufferGeometry | null
  /**
   * Aborts the build and disposes the geometry it owns. Safe to call at any
   * time, and safe to call more than once.
   */
  cancel: () => void
}

const readGrid = (source: BufferGeometry) => {
  const positionAttribute = source.getAttribute('position')
  const normalAttribute = source.getAttribute('normal')

  if (!positionAttribute) {
    throw new GrassGeometryError('The input grid has no "position" attribute, so grass cannot be generated.')
  }

  if (!normalAttribute) {
    throw new GrassGeometryError('The input grid has no "normal" attribute, so grass cannot be generated.')
  }

  if (positionAttribute.itemSize < 3) {
    throw new GrassGeometryError('The input grid "position" attribute must have 3 components per vertex.')
  }

  if (normalAttribute.itemSize < 3) {
    throw new GrassGeometryError('The input grid "normal" attribute must have 3 components per vertex.')
  }

  if (normalAttribute.count < positionAttribute.count) {
    throw new GrassGeometryError(
      `The input grid "normal" attribute has ${normalAttribute.count} entries but "position" has ${positionAttribute.count}.`,
    )
  }

  const count = positionAttribute.count
  const positions = new Float32Array(count * 3)
  const normals = new Float32Array(count * 3)

  for (let i = 0; i < count; i++) {
    positions[i * 3 + 0] = positionAttribute.getX(i)
    positions[i * 3 + 1] = positionAttribute.getY(i)
    positions[i * 3 + 2] = positionAttribute.getZ(i)

    normals[i * 3 + 0] = normalAttribute.getX(i)
    normals[i * 3 + 1] = normalAttribute.getY(i)
    normals[i * 3 + 2] = normalAttribute.getZ(i)
  }

  return { count, positions, normals }
}

/**
 * Builds grass geometry incrementally so a rebuild can be spread over several
 * frames and cancelled at any time. All randomness comes from the seed, which
 * makes a given (blade params, seed) pair fully deterministic, including
 * across differently chunked builds.
 */
export const createGrassGeometryBuilder = (options: GrassGeometryBuilderOptions): GrassGeometryBuilder => {
  const { count: pointCount, positions: pointPositions, normals: pointNormals } = readGrid(options.geometry)

  const { bladesPerPoint, clusterRadius, heightVariation, widthVariation, baseDarkness } = options

  const totalBlades = pointCount * bladesPerPoint
  const vertexCount = totalBlades * 3

  const random = createSeededRandom(options.seed)

  const colorAVec = new Color(options.colorA)
  const colorBVec = new Color(options.colorB)
  const sampleCount = Math.max(1, Math.round(options.colorSamples))
  const colorSamples: Color[] = []

  for (let i = 0; i < sampleCount; i++) {
    const lerpValue = sampleCount > 1 ? i / (sampleCount - 1) : 0
    colorSamples.push(colorAVec.clone().lerp(colorBVec, lerpValue))
  }

  const tmpTerrainNormal = new Vector3()
  const tmpReference = new Vector3()
  const tmpTangent1 = new Vector3()
  const tmpTangent2 = new Vector3()
  const tmpOffset = new Vector3()
  const tmpOffsetComponent1 = new Vector3()
  const tmpOffsetComponent2 = new Vector3()

  const { min: minHeight, max: maxHeight } = heightVariation
  const { min: minWidth, max: maxWidth } = widthVariation
  const heightRange = maxHeight - minHeight
  const widthRange = maxWidth - minWidth
  const heightReference = maxHeight === 0 ? 1 : maxHeight
  const baseBrightness = 1 - baseDarkness
  const twoPi = 2 * Math.PI

  // Buffers (and the geometry that wraps them) are allocated lazily so a build
  // that is cancelled before its first step never pays for the typed arrays.
  const allocateBuffers = (): BladeBuffers => ({
    positions: new Float32Array(vertexCount * 3),
    normals: new Float32Array(vertexCount * 3),
    colors: new Float32Array(vertexCount * 3),
    heights: new Float32Array(vertexCount),
    widths: new Float32Array(vertexCount),
    indices: new Uint32Array(vertexCount),
  })

  let buffers: BladeBuffers | null = null
  let builtGeometry: BufferGeometry | null = null
  let bladeIndex = 0
  let cancelled = false
  let isFinished = false

  const writeBlade = (state: BladeBuffers, index: number) => {
    const pointIndex = bladesPerPoint === 0 ? 0 : Math.floor(index / bladesPerPoint)
    const bladeInPoint = bladesPerPoint === 0 ? 0 : index % bladesPerPoint

    const centerX = pointPositions[pointIndex * 3 + 0] as number
    const centerY = pointPositions[pointIndex * 3 + 1] as number
    const centerZ = pointPositions[pointIndex * 3 + 2] as number

    tmpTerrainNormal.set(
      pointNormals[pointIndex * 3 + 0] as number,
      pointNormals[pointIndex * 3 + 1] as number,
      pointNormals[pointIndex * 3 + 2] as number,
    )

    const vertexOffset = index * 9 // 3 vertices * 3 components
    const attributeOffset = index * 3
    const indexOffset = index * 3

    // The order and the number of random values consumed here must stay stable:
    // this is what makes seeded output reproducible across chunked builds.
    const randomHeight = minHeight + random() * heightRange
    const randomWidth = minWidth + random() * widthRange
    const colorSampleIndex = Math.floor(random() * sampleCount)
    const bladeColor = colorSamples[colorSampleIndex] as Color

    let worldX = centerX
    let worldY = centerY
    let worldZ = centerZ

    if (bladeInPoint !== 0) {
      // Position surrounding blades on the terrain's normal plane.
      const angle = random() * twoPi
      // Square root keeps the distribution uniform in a disk.
      const distance = Math.sqrt(random()) * clusterRadius

      const terrainUp = tmpTerrainNormal
      tmpReference.set(Math.abs(terrainUp.y) < 0.9 ? 0 : 1, Math.abs(terrainUp.y) < 0.9 ? 1 : 0, 0)
      tmpTangent1.crossVectors(terrainUp, tmpReference).normalize()
      tmpTangent2.crossVectors(terrainUp, tmpTangent1).normalize()

      const offsetX = Math.cos(angle) * distance
      const offsetZ = Math.sin(angle) * distance

      tmpOffsetComponent1.copy(tmpTangent1).multiplyScalar(offsetX)
      tmpOffsetComponent2.copy(tmpTangent2).multiplyScalar(offsetZ)
      tmpOffset.copy(tmpOffsetComponent1).add(tmpOffsetComponent2)

      worldX += tmpOffset.x
      worldY += tmpOffset.y
      worldZ += tmpOffset.z
    }

    const tipBrightness = 1 - baseDarkness + (randomHeight / heightReference) * baseDarkness

    for (let k = 0; k < 3; k++) {
      const offset = vertexOffset + k * 3

      state.positions[offset + 0] = worldX
      state.positions[offset + 1] = worldY
      state.positions[offset + 2] = worldZ

      state.normals[offset + 0] = tmpTerrainNormal.x
      state.normals[offset + 1] = tmpTerrainNormal.y
      state.normals[offset + 2] = tmpTerrainNormal.z

      const brightness = k === 1 ? tipBrightness : baseBrightness

      state.colors[offset + 0] = bladeColor.r * brightness
      state.colors[offset + 1] = bladeColor.g * brightness
      state.colors[offset + 2] = bladeColor.b * brightness

      state.heights[attributeOffset + k] = randomHeight
      state.widths[attributeOffset + k] = randomWidth
    }

    state.indices[indexOffset + 0] = indexOffset + 0
    state.indices[indexOffset + 1] = indexOffset + 2
    state.indices[indexOffset + 2] = indexOffset + 1
  }

  const chunkSize = 64

  const finish = (state: BladeBuffers) => {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(state.positions, 3))
    geometry.setAttribute('normal', new BufferAttribute(state.normals, 3))
    geometry.setAttribute('color', new BufferAttribute(state.colors, 3))
    geometry.setAttribute('bladeHeight', new BufferAttribute(state.heights, 1))
    geometry.setAttribute('bladeWidth', new BufferAttribute(state.widths, 1))
    geometry.setIndex(new BufferAttribute(state.indices, 1))
    builtGeometry = geometry
    buffers = null
    isFinished = true
  }

  return {
    totalBlades,
    get progress() {
      if (cancelled || isFinished) return 1
      if (totalBlades === 0) return 1
      return bladeIndex / totalBlades
    },
    get cancelled() {
      return cancelled
    },
    get finished() {
      return isFinished || cancelled
    },
    step(budgetMs = 8) {
      if (cancelled || isFinished) return true

      if (!buffers) {
        if (totalBlades === 0) {
          finish(allocateBuffers())
          return true
        }

        buffers = allocateBuffers()
      }

      const state = buffers
      const start = getNow()
      const unlimited = budgetMs === Number.POSITIVE_INFINITY

      while (bladeIndex < totalBlades) {
        const chunkEnd = Math.min(totalBlades, bladeIndex + chunkSize)

        while (bladeIndex < chunkEnd) {
          writeBlade(state, bladeIndex)
          bladeIndex++
        }

        if (unlimited) continue

        if (getNow() - start >= budgetMs) break
      }

      if (bladeIndex < totalBlades) return false

      finish(state)

      return true
    },
    takeGeometry() {
      const result = builtGeometry
      builtGeometry = null
      isFinished = true
      return result
    },    cancel() {
      if (cancelled) return

      cancelled = true
      buffers = null
      builtGeometry?.dispose()
      builtGeometry = null
    },
  }
}

export const createGrassGeometry = (options: GrassGeometryBuilderOptions) => {
  const builder = createGrassGeometryBuilder(options)

  builder.step(Number.POSITIVE_INFINITY)

  const geometry = builder.takeGeometry()

  if (!geometry) {
    throw new GrassGeometryError('Grass geometry generation was cancelled before it could complete.')
  }

  return geometry
}

export const createGrassWindUniforms = (params: Partial<GrassWindParams> = {}) => {
  const wind = resolveGrassWindParams(params)

  return {
    windSpeed: uniform(wind.windSpeed),
    windSize: uniform(wind.windSize),
    windDisplacement: uniform(wind.windDisplacement),
    upBias: uniform(wind.upBias),
  }
}

export type GrassWindUniforms = ReturnType<typeof createGrassWindUniforms>

/**
 * Builds the vertex position node once. Wind parameters are TSL uniforms, so
 * updating their `.value` only touches the shader side: no geometry rebuild,
 * no material recompilation, and no change to the blade distribution.
 */
export const createGrassPositionNode = (wind: GrassWindUniforms) => {
  const bladeHeight = attribute('bladeHeight')
  const bladeWidth = attribute('bladeWidth')

  // Vertex 0: left base, Vertex 1: top center, Vertex 2: right base
  // This is a workaround because mod(int(vertexIndex), 3) doesn't work
  const vertIdx = vertexIndex.sub(mul(vertexIndex.div(3).toInt(), 3))

  // Calculate billboard direction (from grass to camera) for blade orientation
  const worldPos = positionWorld
  const toCameraDir = normalize(sub(cameraPosition, worldPos))

  // Create billboard right vector (perpendicular to camera direction in XZ plane)
  const up = vec3(0, 1, 0)
  const right = normalize(cross(up, toCameraDir))

  // Pure 3D billboarding for top-down views
  const billboardUp = normalize(cross(toCameraDir, right))
  // Add a small upward bias to prevent edge-on blades at mid-height angles
  const biasedUp = normalize(add(billboardUp, mul(vec3(0, 1, 0), wind.upBias)))
  const topCenter = mul(biasedUp, bladeHeight)

  // Define local positions for the triangle vertices (billboarded)
  const leftBase = mul(right, mul(bladeWidth, -0.5))
  const rightBase = mul(right, mul(bladeWidth, 0.5))

  // Wind animation applied to the top vertex
  const windNoise = mx_noise_vec3(add(div(worldPos, wind.windSize), mul(time, wind.windSpeed)))
  const finalWindOffset = mul(windNoise, vec3(wind.windDisplacement, 0, wind.windDisplacement))

  // Select position based on vertex index with billboard transformation
  const localOffset = vertIdx
    .equal(0)
    .select(leftBase, vertIdx.equal(1).select(add(topCenter, finalWindOffset), rightBase))

  return add(positionLocal, localOffset)
}

export type GrassOptions = Partial<GrassBladeParams> &
  Partial<GrassWindParams> & {
    geometry: BufferGeometry
    seed?: number
  }

export const grass = (options: GrassOptions) => {
  const windUniforms = createGrassWindUniforms(options)
  const positionNode = createGrassPositionNode(windUniforms)

  const geometry = createGrassGeometry({
    geometry: options.geometry,
    seed: options.seed ?? defaultGrassSeed,
    ...resolveGrassBladeParams(options),
  })

  return { positionNode, geometry, windUniforms }
}
