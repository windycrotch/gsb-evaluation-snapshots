import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { useTimeout } from '../../src/composables/useTimeout'

describe('useTimeout', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs a pending callback after the delay', () => {
    const scope = effectScope()
    scope.run(() => {
      const { set } = useTimeout()
      const cb = vi.fn()
      set(cb, 1000)
      vi.advanceTimersByTime(999)
      expect(cb).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(cb).toHaveBeenCalledTimes(1)
    })
    scope.stop()
  })

  it('clears a specific timer before it fires', () => {
    const scope = effectScope()
    scope.run(() => {
      const { set, clear } = useTimeout()
      const cb = vi.fn()
      const timer = set(cb, 500)
      clear(timer)
      vi.advanceTimersByTime(1000)
      expect(cb).not.toHaveBeenCalled()
    })
    scope.stop()
  })

  it('cancels every pending timer when the scope is disposed', () => {
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    const scope = effectScope()
    scope.run(() => {
      const { set } = useTimeout()
      set(cb1, 300)
      set(cb2, 700)
    })
    scope.stop()
    vi.advanceTimersByTime(2000)
    expect(cb1).not.toHaveBeenCalled()
    expect(cb2).not.toHaveBeenCalled()
  })

  it('re-creating a timer cancels the previous one', () => {
    const scope = effectScope()
    scope.run(() => {
      const { set, clear } = useTimeout()
      const first = vi.fn()
      const second = vi.fn()
      const t1 = set(first, 300)
      clear(t1)
      set(second, 300)
      vi.advanceTimersByTime(400)
      expect(first).not.toHaveBeenCalled()
      expect(second).toHaveBeenCalledTimes(1)
    })
    scope.stop()
  })

  it('never fires into a ref after unmount (component-style usage)', () => {
    const visible = ref(true)
    const scope = effectScope()
    scope.run(() => {
      const { set } = useTimeout()
      set(() => {
        visible.value = false
      }, 3000)
    })
    scope.stop()
    vi.advanceTimersByTime(5000)
    expect(visible.value).toBe(true)
  })
})
