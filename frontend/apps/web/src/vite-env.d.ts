/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Google Maps JS API key (must have Billing + the Directions API enabled).
   * Optional — when unset, the memory map's route layer is disabled and no
   * Google Maps requests are made.
   */
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;

  /**
   * Sentry DSN for browser error reporting. Optional — when unset no Sentry
   * code initialises and the bundle makes no request to Sentry. See
   * `src/lib/telemetry.ts` and docs/operations/error-reporting.md.
   */
  readonly VITE_SENTRY_DSN?: string;

  /** Release identifier reported alongside errors, e.g. `ci-server-web@2026.8.1`. */
  readonly VITE_SENTRY_RELEASE?: string;

  /** Environment label for Sentry (falls back to Vite's `MODE`). */
  readonly VITE_CI_SERVER_ENVIRONMENT?: string;

  /**
   * Origin of the hosted, reviewer-facing demo Memory Server, e.g.
   * `https://demo.ci.computer`. Optional and **https-only** — when unset (or set to a
   * non-https value) the in-app "Try the demo" affordance does not render at all. Set
   * by the iOS/Android `build:web` scripts so store builds always carry it; a
   * self-hoster's own web build has no demo button. See `src/lib/demoServer.ts`.
   */
  readonly VITE_DEMO_SERVER_URL?: string;

  /**
   * Which CI-Portal the native Portal flows target: `production` selects
   * `hub.ci.computer`, anything else falls back to the **development** Portal at
   * `hub.companionintelligence.com` (see `pages/DeviceConnectPage/portal-client.ts`).
   *
   * The iOS/Android `build:web` scripts pin this to `production`, because the default
   * is the dev Portal and a store build that keeps it sends an App Review / Play
   * reviewer to a Portal that does not hold the demo account. `VITE_CI_CLOUD_URL`
   * still overrides both when an explicit origin is needed.
   */
  readonly VITE_CI_HUB_ENVIRONMENT?: string;

  /** Explicit CI-Portal origin; overrides `VITE_CI_HUB_ENVIRONMENT` when set. */
  readonly VITE_CI_CLOUD_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
