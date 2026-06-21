/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Google Maps JS API key (must have Billing + the Directions API enabled).
   * Optional — when unset, the memory map's route layer is disabled and no
   * Google Maps requests are made.
   */
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
