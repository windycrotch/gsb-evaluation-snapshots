import type { MMDAnimationUserData, MMDPropertyTrackData } from '../src/utils/build-animation'

import { PmxObject } from 'babylon-mmd/esm/Loader/Parser/pmxObject'
import {
  AnimationClip,
  AnimationMixer,
  Bone,
  BufferGeometry,
  LoopOnce,
  MeshBasicMaterial,
  Skeleton,
  SkinnedMesh,
  VectorKeyframeTrack,
} from 'three'
import { describe, expect, it, vi } from 'vitest'

import { MMD, MMDAnimationManager } from '../src'

type IkMetadata = NonNullable<PmxObject['bones'][number]['ik']>

const createBoneMetadata = (
  name: string,
  parentBoneIndex = -1,
  position: [number, number, number] = [0, 0, 0],
  ik?: IkMetadata,
) => ({
  appendTransform: undefined,
  axisLimit: undefined,
  englishName: name,
  externalParentTransform: undefined,
  flag: ik === undefined ? 0 : PmxObject.Bone.Flag.IsIkEnabled,
  ik,
  localVector: undefined,
  name,
  parentBoneIndex,
  position,
  tailPosition: [0, 0, 0] as [number, number, number],
  transformOrder: 0,
})

const createIkMmd = (modelName = 'loop-model') => {
  const ikBone = new Bone()
  const linkBone = new Bone()
  const targetBone = new Bone()
  ikBone.name = 'ik'
  linkBone.name = 'link'
  targetBone.name = 'target'
  linkBone.add(targetBone)
  const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial())
  mesh.add(ikBone, linkBone)
  mesh.bind(new Skeleton([ikBone, linkBone, targetBone]))

  const pmx: PmxObject = {
    bones: [
      createBoneMetadata('ik', -1, [0, 0, 0], {
        iteration: 1,
        links: [{ limitation: undefined, target: 1 }],
        rotationConstraint: Math.PI,
        target: 2,
      }),
      createBoneMetadata('link'),
      createBoneMetadata('target', 1, [1, 0, 0]),
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
      modelName,
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

interface FakePhysics {
  events: string[]
  reset: () => void
  update: (delta: number) => void
}

const attachFakePhysics = (mmd: MMD, label: string): FakePhysics => {
  const events: string[] = []
  const physics: FakePhysics = {
    events,
    reset: () => events.push(`${label}:reset`),
    update: (delta: number) => events.push(`${label}:update:${delta}`),
  }
  mmd.setPhysics(() => ({
    createHelper: <T>() => undefined as T,
    reset: physics.reset,
    update: physics.update,
  }))
  return physics
}

/**
 * Minimal VMD-style clip: one skeletal track (so the loop counts as a skeletal
 * loop) plus a property track in userData, as produced by buildAnimation.
 */
const createLoopClip = (
  name: string,
  duration: number,
  propertyTrack: MMDPropertyTrackData,
) => {
  const clip = new AnimationClip(name, duration, [
    new VectorKeyframeTrack('.bones[ik].position', [0, duration], [0, 0, 0, 1, 0, 0]),
  ])
  ;(clip.userData as MMDAnimationUserData).propertyTrack = propertyTrack
  return clip
}

describe('mMDAnimationManager loop wraparound', () => {
  it('keeps IK state and physics reset consistent across multiple loop rounds', () => {
    const mmd = createIkMmd()
    const physics = attachFakePhysics(mmd, 'mmd')
    const manager = new MMDAnimationManager()
    // 31 frames at 30fps: IK on at frame 0, off at frame 30.
    const duration = 31 / 30
    manager.add(mmd, {
      animation: createLoopClip('loop', duration, {
        frameNumbers: [0, 30],
        ikBoneNames: ['ik'],
        ikStates: [[true, false]],
      }),
    })

    // Mirrors the mixer's time keeping so deltas can target specific frames.
    let actionTime = 0
    const step = (delta: number) => {
      manager.update(delta, { grant: false })
      actionTime += delta
      if (actionTime >= duration)
        actionTime -= duration * Math.floor(actionTime / duration)
    }

    for (let round = 1; round <= 3; round++) {
      step(1.01 - actionTime) // land at t = 1.01 -> frame 30.3 -> IK off
      expect(mmd.ikSolver.isEnabled(0)).toBe(false)
      expect(physics.events.filter(event => event.endsWith('reset'))).toHaveLength(round - 1)

      step(0.5) // crosses the boundary: wraps to ~0.4767 -> frame 14.3 -> IK on
      expect(mmd.ikSolver.isEnabled(0)).toBe(true)
      expect(physics.events.filter(event => event.endsWith('reset'))).toHaveLength(round)
    }

    // Every wrap produced exactly one reset, each immediately followed by a
    // physics update in the same frame.
    const resetCount = physics.events.filter(event => event.endsWith('reset')).length
    expect(resetCount).toBe(3)
    for (let i = 0; i < physics.events.length; i++) {
      if (physics.events[i].endsWith('reset'))
        expect(physics.events[i + 1]).toMatch(/:update:/)
    }
  })

  it('samples the property track from the wrapped action time within the wrap frame', () => {
    const mmd = createIkMmd()
    const resetIkStates: boolean[] = []
    const events: string[] = []
    mmd.setPhysics(() => ({
      createHelper: <T>() => undefined as T,
      reset: () => {
        // IK state must already reflect the wrapped frame when physics resets.
        resetIkStates.push(mmd.ikSolver.isEnabled(0))
        events.push('reset')
      },
      update: (delta: number) => events.push(`update:${delta}`),
    }))
    const manager = new MMDAnimationManager()
    // Key 0 (frames 0-14) and the last key (frame 30) disagree, so sampling
    // with a stale pre-wrap time (frame > 30 -> last key -> off) is
    // distinguishable from sampling the wrapped time (frame < 15 -> on).
    manager.add(mmd, {
      animation: createLoopClip('loop', 31 / 30, {
        frameNumbers: [0, 15, 30],
        ikBoneNames: ['ik'],
        ikStates: [[true, false, false]],
      }),
    })

    manager.update(0.5, { grant: false }) // t = 0.5 -> frame 15 -> off
    expect(mmd.ikSolver.isEnabled(0)).toBe(false)
    manager.update(0.5, { grant: false }) // t = 1.0 -> frame 30 -> off
    expect(mmd.ikSolver.isEnabled(0)).toBe(false)

    // Crosses the loop boundary: wraps to ~0.4667 -> frame 14 -> key 0 -> on.
    manager.update(0.5, { grant: false })
    expect(mmd.ikSolver.isEnabled(0)).toBe(true)
    expect(events).toEqual(['update:0.5', 'update:0.5', 'reset', 'update:0.5'])
    expect(resetIkStates).toEqual([true])

    manager.update(0.5, { grant: false }) // t = ~0.9667 -> frame 29 -> key 15 -> off
    expect(mmd.ikSolver.isEnabled(0)).toBe(false)

    // t = 1.4667 -> wraps to ~0.4334 -> frame 13 -> key 0 -> on again.
    manager.update(0.5, { grant: false })
    expect(mmd.ikSolver.isEnabled(0)).toBe(true)
    expect(events).toEqual([
      'update:0.5',
      'update:0.5',
      'reset',
      'update:0.5',
      'update:0.5',
      'reset',
      'update:0.5',
    ])
    expect(resetIkStates).toEqual([true, true])

    manager.update(0.2, { grant: false }) // t = ~0.6334 -> frame 19 -> key 15 -> off
    expect(mmd.ikSolver.isEnabled(0)).toBe(false)
  })

  it('resets physics in the wrap frame and still advances physics.update by the full delta', () => {
    const mmd = createIkMmd()
    const events: string[] = []
    mmd.setPhysics(() => ({
      createHelper: <T>() => undefined as T,
      reset: () => events.push('reset'),
      update: (delta: number) => events.push(`update:${delta}`),
    }))
    const manager = new MMDAnimationManager()
    manager.add(mmd, {
      animation: createLoopClip('loop', 1, {
        frameNumbers: [0],
        ikBoneNames: ['ik'],
        ikStates: [[true]],
      }),
    })

    manager.update(0.6, { grant: false })
    expect(events).toEqual(['update:0.6'])

    manager.update(0.6, { grant: false }) // wraps at t = 1.0
    expect(events).toEqual(['update:0.6', 'reset', 'update:0.6'])
  })

  it('restores IK and resets physics when the model is removed mid-loop', () => {
    const mmd = createIkMmd()
    const reset = vi.fn()
    const update = vi.fn()
    mmd.setPhysics(() => ({
      createHelper: <T>() => undefined as T,
      reset,
      update,
    }))
    const manager = new MMDAnimationManager()
    manager.add(mmd, {
      animation: createLoopClip('loop', 1, {
        frameNumbers: [0],
        ikBoneNames: ['ik'],
        ikStates: [[false]],
      }),
    })

    manager.update(0.25, { grant: false })
    expect(mmd.ikSolver.isEnabled(0)).toBe(false)
    expect(update).toHaveBeenCalledOnce()

    manager.remove(mmd)

    // IK returns to the state from before the animation took control...
    expect(mmd.ikSolver.isEnabled(0)).toBe(true)
    // ...and physics is reset so no velocity from the last round lingers.
    expect(reset).toHaveBeenCalledOnce()

    // The removed model is no longer driven at all.
    manager.update(0.25, { grant: false })
    expect(update).toHaveBeenCalledOnce()
    expect(reset).toHaveBeenCalledOnce()
  })

  it('restores IK and resets physics for every model on dispose', () => {
    const first = createIkMmd('first')
    const second = createIkMmd('second')
    const firstReset = vi.fn()
    const secondReset = vi.fn()
    first.setPhysics(() => ({ createHelper: <T>() => undefined as T, reset: firstReset, update: () => {} }))
    second.setPhysics(() => ({ createHelper: <T>() => undefined as T, reset: secondReset, update: () => {} }))
    const manager = new MMDAnimationManager()
    const clip = (name: string) => createLoopClip(name, 1, {
      frameNumbers: [0],
      ikBoneNames: ['ik'],
      ikStates: [[false]],
    })
    manager.add(first, { animation: clip('first') })
    manager.add(second, { animation: clip('second') })

    manager.update(0.25, { grant: false })
    expect(first.ikSolver.isEnabled(0)).toBe(false)
    expect(second.ikSolver.isEnabled(0)).toBe(false)

    manager.dispose()

    expect(first.ikSolver.isEnabled(0)).toBe(true)
    expect(second.ikSolver.isEnabled(0)).toBe(true)
    expect(firstReset).toHaveBeenCalledOnce()
    expect(secondReset).toHaveBeenCalledOnce()
  })

  it('keeps two models with interleaved loop points independent', () => {
    const first = createIkMmd('first')
    const second = createIkMmd('second')
    const firstPhysics = attachFakePhysics(first, 'first')
    const secondPhysics = attachFakePhysics(second, 'second')
    const manager = new MMDAnimationManager()

    // first loops every 1s with IK forced off; second loops every 31/30s,
    // IK on at frame 0 and off at frame 30.
    manager.add(first, {
      animation: createLoopClip('first', 1, {
        frameNumbers: [0],
        ikBoneNames: ['ik'],
        ikStates: [[false]],
      }),
    })
    manager.add(second, {
      animation: createLoopClip('second', 31 / 30, {
        frameNumbers: [0, 30],
        ikBoneNames: ['ik'],
        ikStates: [[true, false]],
      }),
    })

    manager.update(1, { grant: false })
    // first wrapped (t = 1.0 -> 0): reset, IK re-sampled to off.
    // second is at t = 1.0 -> frame 30: off, no wrap yet.
    expect(firstPhysics.events).toEqual(['first:reset', 'first:update:1'])
    expect(secondPhysics.events).toEqual(['second:update:1'])
    expect(first.ikSolver.isEnabled(0)).toBe(false)
    expect(second.ikSolver.isEnabled(0)).toBe(false)

    manager.update(0.5, { grant: false })
    // first is mid-loop (t = 0.5): untouched. second wraps -> reset, IK back on.
    expect(firstPhysics.events).toEqual(['first:reset', 'first:update:1', 'first:update:0.5'])
    expect(secondPhysics.events).toEqual(['second:update:1', 'second:reset', 'second:update:0.5'])
    expect(first.ikSolver.isEnabled(0)).toBe(false)
    expect(second.ikSolver.isEnabled(0)).toBe(true)

    manager.update(0.5, { grant: false })
    // first wraps again; second mid-loop keeps its own state.
    expect(firstPhysics.events.filter(event => event.endsWith('reset'))).toHaveLength(2)
    expect(secondPhysics.events.filter(event => event.endsWith('reset'))).toHaveLength(1)
    expect(first.ikSolver.isEnabled(0)).toBe(false)
    expect(second.ikSolver.isEnabled(0)).toBe(true)
  })

  it('keeps non-looping actions on the existing path: IK restored after finish, no physics reset', () => {
    const mmd = createIkMmd()
    const physics = attachFakePhysics(mmd, 'mmd')
    const clip = createLoopClip('once', 1, {
      frameNumbers: [0],
      ikBoneNames: ['ik'],
      ikStates: [[false]],
    })
    const mixer = new AnimationMixer(mmd.mesh)
    const action = mixer.clipAction(clip)
    action.setLoop(LoopOnce, 1)
    action.play()

    mmd.updateWithMixer(0.5, mixer, { grant: false })
    expect(mmd.ikSolver.isEnabled(0)).toBe(false)

    mmd.updateWithMixer(1, mixer, { grant: false })
    // The finished action no longer controls IK, and no loop reset happens.
    expect(mmd.ikSolver.isEnabled(0)).toBe(true)
    expect(physics.events).toEqual(['mmd:update:0.5', 'mmd:update:1'])
  })

  it('keeps manager-driven playback without a configured duration on the existing path', () => {
    const mmd = createIkMmd()
    const physics = attachFakePhysics(mmd, 'mmd')
    const manager = new MMDAnimationManager()
    manager.add(mmd, {
      animation: createLoopClip('loop', 2, {
        frameNumbers: [0, 30],
        ikBoneNames: ['ik'],
        ikStates: [[true, false]],
      }),
    })

    manager.update(0.5, { grant: false }) // t = 0.5 -> frame 15 -> on
    expect(mmd.ikSolver.isEnabled(0)).toBe(true)
    expect(physics.events).toEqual(['mmd:update:0.5'])

    manager.update(0.5, { grant: false }) // t = 1.0 -> frame 30 -> off
    expect(mmd.ikSolver.isEnabled(0)).toBe(false)
    expect(physics.events).toEqual(['mmd:update:0.5', 'mmd:update:0.5'])
  })

  it('samples the property track after wrapping at the configured duration', () => {
    const mmd = createIkMmd()
    const physics = attachFakePhysics(mmd, 'mmd')
    const manager = new MMDAnimationManager({ duration: 2 })
    const sourceClip = createLoopClip('loop', 31 / 30, {
      frameNumbers: [0, 30],
      ikBoneNames: ['ik'],
      ikStates: [[true, false]],
    })
    manager.add(mmd, { animation: sourceClip })

    manager.update(1.5, { grant: false }) // t = 1.5 -> frame 45 -> key 30 -> off
    expect(mmd.ikSolver.isEnabled(0)).toBe(false)
    expect(physics.events).toEqual(['mmd:update:1.5'])

    manager.update(0.5, { grant: false }) // wraps at t = 2.0 -> frame 0 -> on
    expect(mmd.ikSolver.isEnabled(0)).toBe(true)
    expect(physics.events).toEqual(['mmd:update:1.5', 'mmd:reset', 'mmd:update:0.5'])

    manager.update(1, { grant: false }) // t = 1.0 -> frame 30 -> off
    expect(mmd.ikSolver.isEnabled(0)).toBe(false)

    manager.update(1, { grant: false }) // wraps again -> on
    expect(mmd.ikSolver.isEnabled(0)).toBe(true)
    expect(physics.events.filter(event => event.endsWith('reset'))).toHaveLength(2)

    // The caller's clip is never mutated by the duration override.
    expect(sourceClip.duration).toBeCloseTo(31 / 30)
  })
})
