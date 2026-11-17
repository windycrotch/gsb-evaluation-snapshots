/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Cloudflare Web Analytics token; set only for production builds. */
  readonly VITE_CF_BEACON_TOKEN?: string;
}
