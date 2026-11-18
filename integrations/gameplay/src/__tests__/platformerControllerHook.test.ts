// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { renderHook } from '@testing-library/react'
import { ECSWorld, EventBus, AssetManager, createEngineStats } from '@xip/core'
import type { ScriptComponent } from '@xip/core'
import { EngineContext } from '@xip/context'
import type { EngineState } from '@xip/context'
import { createRigidBody } from '@xip/physics'
import type { RigidBodyComponent } from '@xip/physics'
import type { InputManager } from '@xip/input'
import type { PlatformerControllerOptions } from '../hooks/usePlatformerController'
import { usePlatformerController } from '../hooks/usePlatformerController'

/**
 * Mounts the REAL usePlatformerController hook through EngineContext and
 * drives the Script component's update function directly — no logic is
 * replicated here.
 */

const DT = 1 / 60
const JUMP_FORCE = -500

interface MockPad {
  axes: number[]
  buttons: Array<{ pressed: boolean }>
}

/** Minimal controllable InputManager stand-in (only the methods scripts use). */
class MockInput implements Pick<InputManager, 'isDown' | 'isPressed' | 'isReleased'> {
  private down = new Set<string>()
  private pressed = new Set<string>()
  private released = new Set<string>()

  isDown(key: string): boolean {
    return this.down.has(key)
  }

  isPressed(key: string): boolean {
    return this.pressed.has(key)
  }

  isReleased(key: string): boolean {
    return this.released.has(key)
  }

  /** Fresh press edge for one frame. */
  press(key: string): void {
    if (!this.down.has(key)) this.pressed.add(key)
    this.down.add(key)
  }

  /** Key stays physically held (no new press edge). */
  hold(key: string): void {
    this.down.add(key)
  }

  /** Physical release between frames (held state gone, no edge this frame). */
  clear(key: string): void {
    this.down.delete(key)
    this.pressed.delete(key)
  }

  release(key: string): void {
    if (this.down.has(key)) this.released.add(key)
    this.down.delete(key)
    this.pressed.delete(key)
  }

  /** Called at the end of every driven frame to clear one-frame edges. */
  flush(): void {
    this.pressed.clear()
    this.released.clear()
  }
}

function makeEngine(input: MockInput): EngineState {
  const ecs = new ECSWorld()
  const stats = createEngineStats()
  return {
    ecs,
    events: new EventBus(),
    assets: new AssetManager(),
    input: input as unknown as InputManager,
    loop: { start() {}, stop() {}, pause() {}, resume() {} } as never,
    canvas: document.createElement('canvas'),
    entityIds: new Map(),
    systemTimings: new Map(),
    postProcessStack: { add() {}, remove() {}, apply() {}, clear() {} },
    stats,
    getStats: () => stats,
  }
}

let pads: (MockPad | null)[]
let originalGetGamepads: Navigator['getGamepads'] | undefined

function makePad(): MockPad {
  return {
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false })),
  }
}

interface Harness {
  engine: EngineState
  entityId: number
  rb: RigidBodyComponent
  input: MockInput
  tick: (dt?: number) => void
}

function setup(opts: PlatformerControllerOptions = {}, onGround = true): Harness {
  const input = new MockInput()
  const engine = makeEngine(input)
  const entityId = engine.ecs.createEntity()
  const rb = createRigidBody({ onGround })
  engine.ecs.addComponent(entityId, rb)

  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(EngineContext.Provider, { value: engine }, children)
  renderHook(() => usePlatformerController(entityId, opts), { wrapper })

  const tick = (dt: number = DT): void => {
    const script = engine.ecs.getComponent<ScriptComponent>(entityId, 'Script')
    if (!script) throw new Error('hook did not register a Script component')
    script.update(entityId, engine.ecs, engine.input, dt)
    input.flush()
  }

  return { engine, entityId, rb, input, tick }
}

beforeEach(() => {
  pads = [null, null, null, null]
  originalGetGamepads = navigator.getGamepads
  Object.assign(navigator, {
    getGamepads: () => pads as unknown as (Gamepad | null)[],
  })
})

afterEach(() => {
  if (originalGetGamepads) Object.assign(navigator, { getGamepads: originalGetGamepads })
  else delete (navigator as unknown as { getGamepads?: unknown }).getGamepads
})

describe('usePlatformerController (real hook)', () => {
  describe('jump cooldown vs. buffering', () => {
    it('blocks a second jump pressed inside the cooldown, then fires the buffered press once it ends', () => {
      const h = setup({ jumpCooldown: 0.18, jumpBuffer: 0.08 })

      // Frame 1: grounded jump executes immediately.
      h.input.press('Space')
      h.tick()
      expect(h.rb.vy).toBe(JUMP_FORCE)

      // Still grounded, press again every frame while the cooldown runs:
      // the cooldown must block every execution, but the press must keep
      // buffering instead of being dropped.
      let blockedTicks = 0
      for (let i = 0; i < 10; i++) {
        h.rb.vy = 0 // simulate the physics step settling the body
        h.input.clear('Space') // key physically up between frames
        h.input.press('Space') // fresh press edge this frame
        h.tick()
        blockedTicks += 1
        expect(h.rb.vy).toBe(0) // nothing re-triggered
      }
      expect(blockedTicks).toBe(10)

      // Cooldown ends on the 11th frame; the buffered jump fires even
      // though the latest press edge happened during the cooldown.
      h.rb.vy = 0
      h.input.clear('Space')
      h.input.press('Space')
      h.tick()
      expect(h.rb.vy).toBe(JUMP_FORCE)
    })

    it('keeps the buffer alive while the jump key is held through the cooldown', () => {
      const h = setup({ jumpCooldown: 0.05, jumpBuffer: 0.1 })

      h.input.press('Space')
      h.tick()
      expect(h.rb.vy).toBe(JUMP_FORCE)

      // Hold the key (no fresh edges) for longer than the cooldown. Holding
      // must not decay the buffered jump.
      for (let i = 0; i < 6; i++) {
        h.rb.vy = 0
        h.input.hold('Space')
        h.tick()
        expect(h.rb.vy).toBe(0)
      }

      // Cooldown expired while held: a fresh press edge refills the buffer
      // (which never decayed) and the jump executes on the same frame.
      h.rb.vy = 0
      h.input.clear('Space')
      h.input.press('Space')
      h.tick()
      expect(h.rb.vy).toBe(JUMP_FORCE)
    })

    it('drains the buffer by dt only while the jump key is released', () => {
      const h = setup({ jumpCooldown: 0.1, jumpBuffer: 0.03 })

      // First grounded jump.
      h.input.press('Space')
      h.tick()
      expect(h.rb.vy).toBe(JUMP_FORCE)

      // A second press lands inside the cooldown and gets buffered; release
      // the key immediately afterwards.
      h.input.press('Space')
      h.tick()
      h.input.release('Space')

      // With the key up, the 0.03s buffer drains completely (3 frames at DT).
      for (let i = 0; i < 3; i++) h.tick()

      // Once the cooldown expires there is no buffered jump left to fire:
      // vy stays exactly at the value the first jump set.
      for (let i = 0; i < 5; i++) h.tick()
      expect(h.rb.vy).toBe(JUMP_FORCE)
    })
  })

  describe('maxJumps', () => {
    it('allows the second air jump with maxJumps=2 and blocks a third', () => {
      const h = setup({ jumpCooldown: 0.05, maxJumps: 2 })

      // Jump 1: from the ground.
      h.input.press('Space')
      h.tick()
      expect(h.rb.vy).toBe(JUMP_FORCE)
      h.rb.onGround = false

      // Wait out the cooldown.
      for (let i = 0; i < 5; i++) h.tick()

      // Jump 2: double jump in the air.
      h.input.press('Space')
      h.tick()
      expect(h.rb.vy).toBe(JUMP_FORCE)

      // Wait out the cooldown again.
      for (let i = 0; i < 5; i++) h.tick()

      // Jump 3: no jumps left → blocked, velocity untouched.
      h.rb.vy = -200
      h.input.press('Space')
      h.tick()
      expect(h.rb.vy).toBe(-200)
    })

    it('restores the full jump count and coyote timer on the landing frame', () => {
      const h = setup({ jumpCooldown: 0.1, maxJumps: 2, coyoteTime: 0.1 })

      // Use both jumps: one from the ground, one in the air.
      h.input.press('Space')
      h.tick()
      expect(h.rb.vy).toBe(JUMP_FORCE)
      h.rb.onGround = false

      for (let i = 0; i < 7; i++) h.tick()
      h.input.clear('Space')
      h.input.press('Space')
      h.tick()
      expect(h.rb.vy).toBe(JUMP_FORCE)

      // Both jumps are now spent; a third press immediately (cooldown still
      // active) is blocked, and stays blocked even after the cooldown ends
      // because no jumps remain.
      h.rb.vy = -200
      h.input.clear('Space')
      h.input.press('Space')
      h.tick()
      expect(h.rb.vy).toBe(-200)
      for (let i = 0; i < 8; i++) {
        h.rb.vy = -200
        h.input.clear('Space')
        h.input.press('Space')
        h.tick()
        expect(h.rb.vy).toBe(-200)
      }
      // Release it so the stale buffer drains while we wait to land.
      h.input.clear('Space')
      for (let i = 0; i < 3; i++) h.tick()

      // Land: the landing-frame tick resets jumpsLeft to maxJumps and the
      // coyote timer back to coyoteTime.
      h.rb.onGround = true
      h.rb.vy = 0
      h.tick()

      // Walk off the platform without pressing anything. The reset coyote
      // window keeps a jump available immediately after leaving the ground.
      h.rb.onGround = false
      h.rb.vy = 0
      h.input.clear('Space')
      h.input.press('Space')
      h.tick()
      expect(h.rb.vy).toBe(JUMP_FORCE) // coyote jump from the reset timer

      // Jumps were fully reset, so the air double jump works again too.
      for (let i = 0; i < 5; i++) h.tick()
      h.input.clear('Space')
      h.input.press('Space')
      h.tick()
      expect(h.rb.vy).toBe(JUMP_FORCE)

      // And the restored budget is still exactly two: a third is blocked.
      for (let i = 0; i < 5; i++) h.tick()
      h.rb.vy = -200
      h.input.clear('Space')
      h.input.press('Space')
      h.tick()
      expect(h.rb.vy).toBe(-200)
    })
  })

  describe('gamepad', () => {
    it('ignores stick movement inside the dead zone and moves only past it', () => {
      const h = setup({ speed: 200, gamepadDeadZone: 0.2 })
      pads[0] = makePad()

      // Within the dead zone (exactly on the boundary counts as inside):
      // no horizontal velocity is produced.
      pads[0].axes[0] = 0.19
      h.tick()
      expect(h.rb.vx).toBe(0)

      pads[0].axes[0] = -0.2
      h.tick()
      expect(h.rb.vx).toBe(0)

      // Past the dead zone in each direction.
      pads[0].axes[0] = -0.21
      h.tick()
      expect(h.rb.vx).toBe(-200)

      pads[0].axes[0] = 0.5
      h.tick()
      expect(h.rb.vx).toBe(200)

      // Neutral again → air/ground friction decays velocity.
      pads[0].axes[0] = 0
      h.tick()
      expect(h.rb.vx).toBeCloseTo(120)
    })

    it('treats the gamepad A button press edge like a keyboard isPressed jump', () => {
      const h = setup({ jumpCooldown: 0.05 })
      pads[0] = makePad()

      // A pressed this frame → rising edge → jump.
      pads[0].buttons[0].pressed = true
      h.tick()
      expect(h.rb.vy).toBe(JUMP_FORCE)

      // A held on subsequent frames produces no new edge (and cooldown blocks).
      h.rb.vy = 0
      h.tick()
      expect(h.rb.vy).toBe(0)

      // Release, then press again after the cooldown → new edge → jump.
      pads[0].buttons[0].pressed = false
      for (let i = 0; i < 5; i++) h.tick()
      pads[0].buttons[0].pressed = true
      h.tick()
      expect(h.rb.vy).toBe(JUMP_FORCE)
    })

    it('ignores the gamepad completely when gamepadIndex is -1', () => {
      const h = setup({ speed: 200, gamepadIndex: -1 })
      pads[0] = makePad()
      pads[0].axes[0] = 1
      pads[0].buttons[0].pressed = true

      h.tick()
      expect(h.rb.vx).toBe(0)
      expect(h.rb.vy).toBe(0)

      // Repeated frames must never react either.
      h.tick()
      expect(h.rb.vx).toBe(0)
      expect(h.rb.vy).toBe(0)
    })
  })

  describe('variable jump height damping', () => {
    it('applies extra upward damping only while airborne after releasing jump, with no residue on landing', () => {
      const h = setup()

      h.input.press('Space')
      h.tick()
      expect(h.rb.vy).toBe(JUMP_FORCE)
      h.rb.onGround = false

      // While the key is held, rising velocity is not damped.
      h.input.hold('Space')
      const heldVy = h.rb.vy
      h.tick()
      expect(h.rb.vy).toBe(heldVy)

      // Release while rising fast (vy < -120): damping pulls vy upward by 800*dt.
      h.input.release('Space')
      const risingVy = h.rb.vy
      h.tick()
      expect(h.rb.vy).toBeCloseTo(risingVy + 800 * DT)

      // Once the body lands, the damping must not linger even if some
      // residual upward velocity remains.
      h.rb.onGround = true
      h.rb.vy = -300
      h.tick()
      expect(h.rb.vy).toBe(-300)
    })
  })
})
