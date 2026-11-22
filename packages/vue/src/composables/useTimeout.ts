import { onScopeDispose } from 'vue'

/**
 * setTimeout whose pending callbacks are cleared automatically when the
 * owning effect scope / component is torn down, so a timer can never fire
 * into an unmounted component and write state after disposal.
 */
export function useTimeout() {
  const timers = new Set<ReturnType<typeof setTimeout>>()

  function set(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      timers.delete(timer)
      callback()
    }, ms)
    timers.add(timer)
    return timer
  }

  function clear(timer: ReturnType<typeof setTimeout> | null) {
    if (timer === null) return
    clearTimeout(timer)
    timers.delete(timer)
  }

  onScopeDispose(() => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  })

  return { set, clear }
}
