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

  it('resets physics when a skeletal animation loops', () => {
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

    manager.update(2.1, { physics: false })
    expect(events).toEqual(['reset', 'update', 'reset'])
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

  it('stops audio at every loop end and replays it at the delay time of the next loop', () => {
    let playing = false
    const play = vi.fn(() => {
      playing = true
    })
    const stop = vi.fn(() => {
      playing = false
    })
    const audio = {
      buffer: { duration: 1.5 },
      get isPlaying() {
        return playing
      },
      play,
      stop,
      type: 'Audio',
    } as unknown as import('three').Audio
    const manager = new MMDAnimationManager({ duration: 2 })

    manager.add(audio, { delayTime: 0.5 })

    for (let round = 1; round <= 3; round++) {
      manager.update(0.25)
      expect(play).toHaveBeenCalledTimes(round - 1)

      manager.update(0.25)
      expect(play).toHaveBeenCalledTimes(round)
      expect(playing).toBe(true)

      manager.update(1.5)
      expect(stop).toHaveBeenCalledTimes(round)
      expect(playing).toBe(false)
    }
  })

  it.each([
    ['a zero-length buffer', { duration: 0 }],
    ['a non-finite buffer duration', { duration: Number.NaN }],
    ['no buffer', undefined],
  ])('starts audio without a usable buffer duration (%s)', (_, buffer) => {
    for (const managerOptions of [{}, { duration: 2 }]) {
      let playing = false
      const play = vi.fn(() => {
        playing = true
      })
      const stop = vi.fn(() => {
        playing = false
      })
      const audio = {
        buffer,
        get isPlaying() {
          return playing
        },
        play,
        stop,
        type: 'Audio',
      } as unknown as import('three').Audio
      const manager = new MMDAnimationManager(managerOptions)
      const delayTime = managerOptions.duration == null ? 1 : 0.5

      manager.add(audio, { delayTime })
      // Overshoot the delay: an unusable buffer duration must not gate playback.
      manager.update(delayTime + 0.25)
      expect(play).toHaveBeenCalledOnce()
      expect(playing).toBe(true)

      if (managerOptions.duration == null)
        continue

      // The next loop stops it at the loop end and plays it again after the delay.
      manager.update(managerOptions.duration)
      expect(stop).toHaveBeenCalledOnce()
      expect(play).toHaveBeenCalledTimes(2)
    }
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects an invalid manager duration (%s)',
    (duration) => {
      expect(() => new MMDAnimationManager({ duration })).toThrow(RangeError)
    },
  )

  it('rejects a duplicate MMD without changing its registration or animation', () => {
    const mmd = createMmd('duplicate')
    const other = createMmd('other')
    const animation = createClip('duplicate animation')
    const physicsUpdate = vi.fn()
    mmd.setPhysics(() => ({
      createHelper: <T>() => undefined as T,
      update: physicsUpdate,
    }))
    const manager = new MMDAnimationManager()

    manager.add(mmd, { animation })
    manager.add(other, { animation: createClip('other animation') })
    manager.update(0.5)
    expect(mmd.mesh.position.x).toBeCloseTo(0.5)
    expect(other.mesh.position.x).toBeCloseTo(0.5)
    expect(physicsUpdate).toHaveBeenCalledOnce()

    expect(() => manager.add(mmd, { animation: createClip('second animation') }))
      .toThrow('MMDAnimationManager: MMD has already been added.')

    // Rejection happens before any mutation of the existing registration.
    expect(mmd.mesh.position.x).toBeCloseTo(0.5)
    expect(other.mesh.position.x).toBeCloseTo(0.5)
    expect(physicsUpdate).toHaveBeenCalledOnce()

    // A normal update still advances each registered model exactly once.
    manager.update(0.25)
    expect(mmd.mesh.position.x).toBeCloseTo(0.75)
    expect(other.mesh.position.x).toBeCloseTo(0.75)
    expect(physicsUpdate).toHaveBeenCalledTimes(2)
    expect(physicsUpdate).toHaveBeenLastCalledWith(0.25)
  })

  it('ignores removal of an unregistered MMD and keeps registered models running', () => {
    const registered = createMmd('registered')
    const unregistered = createMmd('unregistered')
    const manager = new MMDAnimationManager()

    manager.add(registered, { animation: createClip('registered animation') })

    expect(() => manager.remove(unregistered)).not.toThrow()
    expect(manager.remove(unregistered)).toBe(manager)

    manager.update(0.25)
    expect(registered.mesh.position.x).toBeCloseTo(0.25)
    expect(unregistered.mesh.position.x).toBe(0)
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
})
