import { useMemo } from "react";
import { useStore } from "zustand";
import { getConsoleStore } from "./console-store";

// React and the DOM shell subscribe to the same vanilla store. A form key
// includes the account, so an in-flight save can only update its original form.
export function useConsoleSlice<T extends object>(
  key: string,
  initial: () => T,
) {
  const store = getConsoleStore();
  // initial supplies defaults only; existing account drafts remain in the store.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Recreate defaults only when the account-scoped key changes.
  const defaults = useMemo(initial, [key]);
  const value =
    useStore(store, (state) => state.slices[key] as T | undefined) ?? defaults;
  function setField<K extends keyof T>(
    field: K,
    next: T[K] | ((previous: T[K]) => T[K]),
  ) {
    const previous =
      (store.getState().slices[key] as T | undefined) ?? defaults;
    const updated =
      typeof next === "function"
        ? (next as (previous: T[K]) => T[K])(previous[field])
        : next;
    store.getState().actions.patchSlice(key, { ...previous, [field]: updated });
  }
  return [value, setField] as const;
}
