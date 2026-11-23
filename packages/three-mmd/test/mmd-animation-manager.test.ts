import { PmxObject } from 'babylon-mmd/esm/Loader/Parser/pmxObject'
import {
  AnimationClip,
  Bone,
  BufferGeometry,
  MeshBasicMaterial,
  NumberKeyframeTrack,
  PerspectiveCamera,
  Skeleton,
  SkinnedMesh,
  Vector3,
  VectorKeyframeTrack,
} from 'three'
import { describe, expect, it, vi } from 'vitest'

import { MMD, MMDAnimationManager } from '../src'

const createMmd = (name: string) => {
  const bone = new Bone()
  bone.name = name

  const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial())
  mesh.add(bone)
  mesh.bind(new Skeleton([bone]))

  const pmx: PmxObject = {
    bones: [{
      appendTransform: undefined,
      axisLimit: undefined,
      englishName: name,
      externalParentTransform: undefined,
      flag: 0,
      ik: undefined,
      localVector: undefined,
      name,
      parentBoneIndex: -1,
      position: [0, 0, 0],
      tailPosition: [0, 0, 0],
      transformOrder: 0,
    }],
    displayFrames: [],
    header: {
      additionalVec4Count: 0,
      boneIndexSize: 4,
      comment: '',
      encoding: PmxObject.Header.Encoding.Utf8,
      englishComment: '',
      englishModelName: '',
      materialIndexSize: 4,
      modelName: name,
      morphIndexSize: 4,
      rigidBodyIndexSize: 4,
      signature: 'PMX',
      textureIndexSize: 4,
      version: 2,
      vertexIndexSize: 4,
    },
    indices: new Uint8Array(),
    joints: [],
    materials: [],
    morphs: [],
    rigidBodies: [],
    softBodies: [],
    textures: [],
    vertices: [],
  }

  return new MMD(pmx, mesh)
}

const createClip = (name: string) =>
  new AnimationClip(name, 1, [new VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 1, 0, 0])])

const createSkeletalClip = (name: string, duration: number) =>
  new AnimationClip(name, duration, [
    new VectorKeyframeTrack('.bones[0].position', [0, duration], [0, 0, 0, 1, 0, 0]),
  ])

const createAudio = (bufferDuration?: number) => {
  let playing = false
  const play = vi.fn(() => {
    playing = true
  })
  const stop = vi.fn(() => {
    playing = false
  })
  const audio = {
    buffer: bufferDuration == null ? undefined : { duration: bufferDuration },
    get isPlaying() {
      return playing
    },
    play,
    stop,
    type: 'Audio',
  } as unknown as import('three').Audio
  return { audio, play, stop }
}

const createIkMmd = (name: string) => {
  const ikBone = new Bone()
  ikBone.name = `${name}-ik`
  const linkBone = new Bone()
  linkBone.name = `${name}-link`
  const targetBone = new Bone()
  targetBone.name = `${name}-target`
  linkBone.add(targetBone)

  const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial())
  mesh.add(ikBone, linkBone)
  mesh.bind(new Skeleton([ikBone, linkBone, targetBone]))

  const bone = (
    boneName: string,
    parentBoneIndex: number,
    position: [number, number, number],
    ik?: PmxObject['bones'][number]['ik'],
  ): PmxObject['bones'][number] => ({
    appendTransform: undefined,
    axisLimit: undefined,
    englishName: boneName,
    externalParentTransform: undefined,
    flag: ik === undefined ? 0 : PmxObject.Bone.Flag.IsIkEnabled,
    ik,
    localVector: undefined,
    name: boneName,
    parentBoneIndex,
    position,
    tailPosition: [0, 0, 0],
    transformOrder: 0,
  })

  const pmx: PmxObject = {
    bones: [
      bone(`${name}-ik`, -1, [0, 0, 0], {
        iteration: 1,
        links: [{ limitation: undefined, target: 1 }],
        rotationConstraint: Math.PI,
        target: 2,
      }),
      bone(`${name}-link`, -1, [0, 0, 0]),
      bone(`${name}-target`, 1, [1, 0, 0]),
    ],
    displayFrames: [],
    header: {
      additionalVec4Count: 0,
      boneIndexSize: 4,
      comment: '',
      encoding: PmxObject.Header.Encoding.Utf8,
      englishComment: '',
      englishModelName: '',
      materialIndexSize: 4,
      modelName: name,
      morphIndexSize: 4,
      rigidBodyIndexSize: 4,
      signature: 'PMX',
      textureIndexSize: 4,
      version: 2,
      vertexIndexSize: 4,
    },
    indices: new Uint8Array(),
    joints: [],
    materials: [],
    morphs: [],
    rigidBodies: [],
    softBodies: [],
    textures: [],
    vertices: [],
  }

  return new MMD(pmx, mesh)
}

const createIkClip = (ikBoneName: string, states: boolean[]) => {
  const clip = new AnimationClip(`${ikBoneName} property`, 1, [])
  clip.userData = {
    propertyTrack: {
      frameNumbers: states.map((_, index) => index * 15),
      ikBoneNames: [ikBoneName],
      ikStates: [states],
    },
  }
  return clip
}

const createCameraClip = () =>
  new AnimationClip('camera animation', 1, [
    new VectorKeyframeTrack('target.position', [0, 1], [0, 0, -1, 1, 2, -3]),
    new NumberKeyframeTrack('.fov', [0, 1], [30, 60]),
  ])

describe('mMDAnimationManager', () => {
  it('advances every registered MMD through its mixer and MMD update', () => {
    const first = createMmd('first')
    const second = createMmd('second')
    const firstPhysicsUpdate = vi.fn()
    const secondPhysicsUpdate = vi.fn()
    const firstPhysics = {
      createHelper: <T>() => undefined as T,
      update: firstPhysicsUpdate,
    }
    const secondPhysics = {
      createHelper: <T>() => undefined as T,
      update: secondPhysicsUpdate,
    }
    first.setPhysics(() => firstPhysics)
    second.setPhysics(() => secondPhysics)
    const manager = new MMDAnimationManager()

    manager.add(first, { animation: createClip('first animation') })
    manager.add(second, { animation: createClip('second animation') })
    manager.update(0.25)

    expect(first.mesh.position.x).toBeCloseTo(0.25)
    expect(second.mesh.position.x).toBeCloseTo(0.25)
    expect(firstPhysicsUpdate).toHaveBeenCalledOnce()
    expect(firstPhysicsUpdate).toHaveBeenCalledWith(0.25)
    expect(secondPhysicsUpdate).toHaveBeenCalledOnce()
    expect(secondPhysicsUpdate).toHaveBeenCalledWith(0.25)
  })

  it('resets physics when a skeletal animation loops, unless physics is disabled', () => {
    const mmd = createMmd('physics-loop')
    const events: string[] = []
    const resetPositions: number[] = []
    const physics = {
      createHelper: <T>() => undefined as T,
      reset: () => {
        resetPositions.push(mmd.mesh.skeleton.bones[0].position.x)
        events.push('reset')
      },
      update: () => events.push('update'),
    }
    mmd.setPhysics(() => physics)
    const manager = new MMDAnimationManager({ duration: 2 })

    manager.add(mmd, {
      animation: new AnimationClip('skeletal animation', 1, [
        new VectorKeyframeTrack('.bones[0].position', [0, 1], [0, 0, 0, 1, 0, 0]),
      ]),
    })
    manager.update(2.1)

    expect(events).toEqual(['reset', 'update'])
    expect(resetPositions[0]).toBeCloseTo(0.1)

    // With physics off a skeletal loop must neither reset nor step physics.
    manager.update(2.1, { physics: false })
    expect(events).toEqual(['reset', 'update'])

    // The suppressed loop must not leak into a later physics-enabled frame.
    manager.update(0.1)
    expect(events).toEqual(['reset', 'update', 'update'])
  })

  it('passes MMD update options to every registered model', () => {
    const mmd = createMmd('options')
    const physicsUpdate = vi.fn()
    const physics = {
      createHelper: <T>() => undefined as T,
      update: physicsUpdate,
    }
    mmd.setPhysics(() => physics)
    const manager = new MMDAnimationManager()

    manager.add(mmd)
    manager.update(0.25, { physics: false })
    expect(physicsUpdate).not.toHaveBeenCalled()

    manager.update(0.25)
    expect(physicsUpdate).toHaveBeenCalledOnce()
    expect(physicsUpdate).toHaveBeenCalledWith(0.25)
  })

  it('syncs registered animation clips to the configured duration without changing the source clip', () => {
    const mmd = createMmd('duration')
    const animation = createClip('duration animation')
    const manager = new MMDAnimationManager({ duration: 2 })

    manager.add(mmd, { animation })
    manager.update(1.5)
    expect(mmd.mesh.position.x).toBeCloseTo(1)
    expect(animation.duration).toBe(1)

    manager.update(0.5)
    expect(mmd.mesh.position.x).toBeCloseTo(0)
  })

  it('updates the registered MMD camera and its target after animation', () => {
    const camera = new PerspectiveCamera(30, 1, 0.1, 100)
    const manager = new MMDAnimationManager()

    manager.add(camera, { animation: createCameraClip() })
    manager.update(0.5)

    expect(camera.fov).toBe(45)
    expect(camera.children).toHaveLength(1)
    expect(camera.children[0]).toMatchObject({ name: 'target' })
    expect(camera.children[0].position.toArray()).toEqual([0.5, 1, -2])
    const direction = camera.getWorldDirection(new Vector3())
    expect(direction.x).toBeCloseTo(0.21821789, 6)
    expect(direction.y).toBeCloseTo(0.43643578, 6)
    expect(direction.z).toBeCloseTo(-0.87287156, 6)
  })

  it('does not update or attach a target to a camera without animation', () => {
    const camera = new PerspectiveCamera()
    camera.position.set(1, 2, 3)
    camera.rotation.set(0.1, 0.2, 0.3)
    const position = camera.position.clone()
    const quaternion = camera.quaternion.clone()
    const manager = new MMDAnimationManager()

    manager.add(camera)
    manager.update(1)

    expect(camera.position.equals(position)).toBe(true)
    expect(camera.quaternion.equals(quaternion)).toBe(true)
    expect(camera.children).toHaveLength(0)

    manager.remove(camera)
    expect(() => manager.add(new PerspectiveCamera())).not.toThrow()
  })

  it('starts delayed audio once and stops audio it started when removed', () => {
    let playing = false
    const play = vi.fn(() => {
      playing = true
    })
    const stop = vi.fn(() => {
      playing = false
    })
    const audio = {
      get isPlaying() {
        return playing
      },
      play,
      stop,
      type: 'Audio',
    } as unknown as import('three').Audio
    const manager = new MMDAnimationManager()

    manager.add(audio, { delayTime: 1 })
    manager.update(0.5)
    expect(play).not.toHaveBeenCalled()

    manager.update(0.5)
    manager.update(1)
    expect(play).toHaveBeenCalledOnce()

    manager.remove(audio)
    expect(stop).toHaveBeenCalledOnce()
  })

  it('restarts audio after each configured duration and delay', () => {
    let playing = false
    const play = vi.fn(() => {
      playing = true
    })
    const stop = vi.fn(() => {
      playing = false
    })
    const audio = {
      get isPlaying() {
        return playing
      },
      play,
      stop,
      type: 'Audio',
    } as unknown as import('three').Audio
    const manager = new MMDAnimationManager({ duration: 2 })

    manager.add(audio, { delayTime: 0.5 })
    manager.update(0.5)
    expect(play).toHaveBeenCalledOnce()

    manager.update(1.5)
    expect(stop).toHaveBeenCalledOnce()
    expect(play).toHaveBeenCalledOnce()

    manager.update(0.5)
    expect(play).toHaveBeenCalledTimes(2)
  })

  it('does not start audio in the trailing silence of a global loop', () => {
    let playing = false
    const play = vi.fn(() => {
      playing = true
    })
    const stop = vi.fn(() => {
      playing = false
    })
    const audio = {
      buffer: { duration: 3 },
      get isPlaying() {
        return playing
      },
      play,
      stop,
      type: 'Audio',
    } as unknown as import('three').Audio
    const manager = new MMDAnimationManager({ duration: 10 })

    manager.add(audio, { delayTime: 2 })
    manager.update(6)
    expect(play).not.toHaveBeenCalled()

    manager.update(10)
    expect(play).not.toHaveBeenCalled()

    manager.update(6)
    expect(play).toHaveBeenCalledOnce()
  })

  it('does not reset physics when only a morph track loops', () => {
    const mmd = createMmd('morph-loop')
    const reset = vi.fn()
    const update = vi.fn()
    mmd.setPhysics(() => ({
      createHelper: <T>() => undefined as T,
      reset,
      update,
    }))
    const manager = new MMDAnimationManager()

    manager.add(mmd, {
      animation: new AnimationClip('morph animation', 0.5, [
        new NumberKeyframeTrack('.morphTargetInfluences[0]', [0, 0.5], [0, 1]),
      ]),
    })
    manager.update(0.6)

    expect(update).toHaveBeenCalledOnce()
    expect(reset).not.toHaveBeenCalled()
  })

  it('applies IK property tracks before physics within the same frame', () => {
    const mmd = createIkMmd('ordered')
    const events: string[] = []
    mmd.setPhysics(() => ({
      createHelper: <T>() => undefined as T,
      reset: () => events.push('physics:reset'),
      update: () => events.push(`physics:update:ik=${mmd.ikSolver.isEnabled(0)}`),
    }))
    const manager = new MMDAnimationManager()

    manager.add(mmd, { animation: createIkClip('ordered-ik', [false]) })
    manager.update(0.5)

    // The property track is applied before physics integrates the frame.
    expect(events).toEqual(['physics:update:ik=false'])
  })

  it('removes one model without affecting other registered objects', () => {
    const first = createMmd('first')
    const second = createMmd('second')
    const camera = new PerspectiveCamera()
    const manager = new MMDAnimationManager()

    manager.add(first)
    manager.add(second, { animation: createClip('second animation') })
    manager.add(camera)
    manager.remove(first)
    second.mesh.position.x = 0
    manager.update(0.25)

    expect(first.mesh.position.x).toBe(0)
    expect(second.mesh.position.x).toBeCloseTo(0.25)

    manager.dispose()
    expect(camera.children).toHaveLength(0)
  })

  it('only resets the physics of the models whose own skeleton looped', () => {
    const first = createMmd('first')
    const second = createMmd('second')
    const events: string[] = []
    const createPhysics = (label: string) => ({
      createHelper: <T>() => undefined as T,
      reset: () => events.push(`${label}:reset`),
      update: () => events.push(`${label}:update`),
    })
    first.setPhysics(() => createPhysics('first'))
    second.setPhysics(() => createPhysics('second'))
    const manager = new MMDAnimationManager()

    // Different clip lengths: only `second` wraps on the second frame.
    manager.add(first, { animation: createSkeletalClip('first animation', 1) })
    manager.add(second, { animation: createSkeletalClip('second animation', 0.6) })

    manager.update(0.4)
    expect(events).toEqual(['first:update', 'second:update'])

    events.length = 0
    manager.update(0.4)
    expect(events).toEqual(['first:update', 'second:reset', 'second:update'])
  })

  it('does not reset or update physics for any model when physics is disabled', () => {
    const first = createMmd('first')
    const second = createMmd('second')
    const reset = vi.fn()
    const update = vi.fn()
    const physics = {
      createHelper: <T>() => undefined as T,
      reset,
      update,
    }
    first.setPhysics(() => physics)
    second.setPhysics(() => physics)
    const manager = new MMDAnimationManager()

    manager.add(first, { animation: createSkeletalClip('first animation', 5) })
    manager.add(second, { animation: createSkeletalClip('second animation', 0.5) })

    manager.update(1, { physics: false })
    expect(reset).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()

    // The next physics-enabled frame still integrates, but only the clip that
    // wraps on that frame resets.
    manager.update(1)
    expect(update).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenCalledWith(1)
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('keeps audio and model updates in a fixed order within one update', () => {
    const mmd = createMmd('order')
    const events: string[] = []
    const physics = {
      createHelper: <T>() => undefined as T,
      reset: () => events.push('physics:reset'),
      update: () => events.push('physics:update'),
    }
    mmd.setPhysics(() => physics)
    const { audio, play } = createAudio()
    vi.mocked(play).mockImplementation(() => {
      events.push('audio:play')
    })
    const manager = new MMDAnimationManager()

    manager.add(mmd, { animation: createSkeletalClip('order animation', 0.5) })
    manager.add(audio)

    manager.update(0.6)
    expect(events).toEqual(['audio:play', 'physics:reset', 'physics:update'])
  })

  it('stops audio once and restarts it once when one delta crosses several loops', () => {
    const { audio, play, stop } = createAudio()
    const manager = new MMDAnimationManager({ duration: 2 })

    manager.add(audio, { delayTime: 0.5 })
    manager.update(1)
    expect(play).toHaveBeenCalledTimes(1)
    expect(audio.isPlaying).toBe(true)

    // From 1s, +6.6s crosses three loop boundaries and lands at 1.6s, inside
    // the play window: the manager must stop at the cut and restart only once.
    play.mockClear()
    stop.mockClear()
    manager.update(6.6)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(play).toHaveBeenCalledTimes(1)
    expect(audio.isPlaying).toBe(true)

    // From 1.6s, +6.8s wraps to 0.4s, before the delay: stop once, no restart.
    play.mockClear()
    stop.mockClear()
    manager.update(6.8)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(play).not.toHaveBeenCalled()
    expect(audio.isPlaying).toBe(false)
  })

  it('does not start audio before the delay after a backwards scrub', () => {
    const { audio, play } = createAudio()
    const manager = new MMDAnimationManager({ duration: 4 })

    manager.add(audio, { delayTime: 1 })
    manager.update(1.5)
    expect(play).toHaveBeenCalledOnce()

    // Scrubbing back below the delay must release the manager-owned playback.
    manager.update(-1)
    expect(audio.isPlaying).toBe(false)

    manager.update(0.1)
    expect(play).toHaveBeenCalledOnce()

    manager.update(0.5)
    expect(play).toHaveBeenCalledTimes(2)
  })

  it('stops the model from advancing and restores its IK switches after removal', () => {
    const mmd = createIkMmd('removed')
    // Pre-existing user state: the IK is disabled before it is animated on.
    mmd.ikSolver.setEnabled(0, false)
    const manager = new MMDAnimationManager()

    manager.add(mmd, { animation: createIkClip('removed-ik', [true]) })
    manager.update(0.1, { physics: false })
    expect(mmd.ikSolver.isEnabled(0)).toBe(true)

    const bone = mmd.mesh.skeleton.bones[1]
    const matrixBefore = bone.matrix.clone()
    manager.remove(mmd)
    expect(mmd.ikSolver.isEnabled(0)).toBe(false)

    // The removed model is no longer advanced by the manager.
    manager.update(0.5, { physics: false })
    expect(bone.matrix.equals(matrixBefore)).toBe(true)
  })

  it('restores each model IK state to its own pre-add value on dispose', () => {
    const first = createIkMmd('first')
    const second = createIkMmd('second')
    second.ikSolver.setEnabled(0, false)
    const manager = new MMDAnimationManager()

    manager.add(first, { animation: createIkClip('first-ik', [false]) })
    manager.add(second, { animation: createIkClip('second-ik', [true]) })
    manager.update(0.1, { physics: false })
    expect(first.ikSolver.isEnabled(0)).toBe(false)
    expect(second.ikSolver.isEnabled(0)).toBe(true)

    manager.dispose()

    expect(first.ikSolver.isEnabled(0)).toBe(true)
    expect(second.ikSolver.isEnabled(0)).toBe(false)
  })

  it('does not leak listeners or audio state when objects are re-added after dispose', () => {
    const first = createMmd('first')
    const manager = new MMDAnimationManager({ duration: 1 })
    const { audio, play } = createAudio()
    manager.add(first, { animation: createSkeletalClip('first animation', 1) })
    manager.add(audio, { delayTime: 0.2 })
    manager.update(0.3)
    expect(play).toHaveBeenCalledTimes(1)

    manager.dispose()

    // A brand-new model and audio must start from a clean slate.
    const second = createMmd('second')
    const reset = vi.fn()
    second.setPhysics(() => ({
      createHelper: <T>() => undefined as T,
      reset,
      update: () => {},
    }))
    const replacement = createAudio()
    manager.add(second, { animation: createSkeletalClip('second animation', 1) })
    manager.add(replacement.audio, { delayTime: 0.2 })
    manager.update(0.1)
    expect(replacement.play).not.toHaveBeenCalled()

    manager.update(0.2)
    expect(replacement.play).toHaveBeenCalledTimes(1)

    // A leftover loop listener would fire the reset more than once per wrap.
    manager.update(1)
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('keeps single-model manager behavior as the baseline', () => {
    const mmd = createMmd('baseline')
    const physicsUpdate = vi.fn()
    mmd.setPhysics(() => ({
      createHelper: <T>() => undefined as T,
      update: physicsUpdate,
    }))
    const manager = new MMDAnimationManager({ duration: 2 })
    const animation = createClip('baseline animation')

    manager.add(mmd, { animation })
    manager.update(1.5)
    expect(mmd.mesh.position.x).toBeCloseTo(1)
    expect(physicsUpdate).toHaveBeenCalledWith(1.5)

    manager.update(0.5)
    expect(mmd.mesh.position.x).toBeCloseTo(0)
    expect(animation.duration).toBe(1)
  })
})
