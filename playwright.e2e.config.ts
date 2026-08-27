import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '.env'), quiet: true });

// Local FULL-STACK E2E: drives the real frontend against the real backend +
// Postgres (seeded). Separate from the root playwright.config.ts, which only
// runs the external Checkly smoke test against a deployed URL.
//
// The stack is booted by `webServer` below — the API and Vite dev server run as
// plain node processes (no Caddy/Overmind needed); Vite's built-in `/api` proxy
// bridges to the API exactly like production. A Postgres with the right
// extensions must already be migrated + seeded (see .github/workflows/e2e.yml
// and the `make migrate` / seed steps).
const WEB_PORT = Number(process.env.E2E_WEB_PORT) || 5173;
const API_PORT = Number(process.env.E2E_API_PORT) || 3030;
const baseURL = process.env.E2E_BASE_URL || `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  // One seeded DB shared across specs → keep execution serial & deterministic.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['github'], ['list']]
    : [['html', { open: 'never' }], ['list']],
  // No globalSetup and no shared storageState. Authenticated specs import
  // `test` from `tests/e2e/fixtures/authenticated.ts`, which signs in inside
  // each test's own context.
  //
  // A shared state file cannot work against this API: sessions are bound to
  // `ip + user_agent` AND the token rotates on the `/api/authenticate/refresh`
  // the app makes on load, with only a 30s grace window
  // (`auth.session.refreshGracePeriod`). One file replayed across a four-minute
  // serial suite goes stale partway through, and the specs that follow fail on
  // page assertions while the real cause is a 401 nobody sees. See that
  // fixture's header.
  use: {
    baseURL,
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      // onboarding.spec.ts joins auth.spec.ts here: it signs up a brand-new
      // account, which needs the same logged-out starting state (an
      // already-authenticated session would just bounce /signup).
      name: 'auth',
      testMatch: /(auth|onboarding)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      testIgnore: /(auth|mobile|onboarding)\.spec\.ts/,
      dependencies: ['auth'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Mobile-viewport pass: runs the mobile-specific specs on a Pixel 5.
      name: 'mobile',
      testMatch: /mobile\.spec\.ts/,
      dependencies: ['auth'],
      use: { ...devices['Pixel 5'] },
    },
  ],
  webServer: [
    {
      command: 'yarn workspace @ci/be-api dev',
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        PORT: String(API_PORT),
        // `require.signup.codes` defaults to TRUE (backend/apps/api/config/default.json),
        // and `.env.default` — which e2e.yml copies verbatim — leaves
        // ENABLE_REQUIRE_SIGNUP_CODES commented out, so that default applies.
        // onboarding.spec.ts creates a throwaway account to reach the wizard;
        // without this it is rejected with "Must provide a valid signup code"
        // and never leaves /signup. Pin the flag here rather than relying on a
        // product default that is free to change.
        ENABLE_REQUIRE_SIGNUP_CODES: 'false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'yarn workspace @ci/fe-web dev',
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { WEB_PORT: String(WEB_PORT), API_PROXY_TARGET: `http://localhost:${API_PORT}` },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
