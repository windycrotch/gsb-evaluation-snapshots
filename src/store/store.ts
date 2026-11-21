import { useRef, useSyncExternalStore } from 'react';

/** Tiny observable store. State objects are treated as immutable. */
export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  patch(p: Partial<T>): void;
  subscribe: (fn: () => void) => () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  return {
    get: () => state,
    set(next) {
      const v = typeof next === 'function' ? next(state) : next;
      if (v === state) return;
      state = v;
      emit();
    },
    patch(p) {
      let changed = false;
      for (const k in p) if (!Object.is((state as Record<string, unknown>)[k], (p as Record<string, unknown>)[k])) changed = true;
      if (!changed) return;
      state = { ...state, ...p };
      emit();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** Subscribes a component to a slice of the store. The selected value is cached while it is equal (default: identity). */
export function useStore<T, S>(store: Store<T>, selector: (s: T) => S, equals: (a: S, b: S) => boolean = Object.is): S {
  const cache = useRef<{ state: T; value: S } | null>(null);
  const getSnapshot = (): S => {
    const state = store.get();
    const c = cache.current;
    if (c && c.state === state) return c.value;
    const value = selector(state);
    if (c && equals(c.value, value)) {
      cache.current = { state, value: c.value };
      return c.value;
    }
    cache.current = { state, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
