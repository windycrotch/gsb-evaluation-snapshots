import { proxy } from "valtio";

export interface DecalFallbackState {
  // true when the logo decal failed to load and the default logo is shown
  logo: boolean;
  // true when the full decal failed to load and the default texture is shown
  full: boolean;
}

// Runtime-only decal fallback status.
// Deliberately kept out of the persisted store in ./index.ts:
// it is never written to localStorage and is recomputed from the
// actual texture load results on every page load.
export const decalFallbackState = proxy<DecalFallbackState>({
  logo: false,
  full: false,
});
