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
  globalSetup: require.resolve('./tests/e2e/global-setup.ts'),
  use: {
    baseURL,
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
    // Authenticated state captured once by global-setup; the `auth` project
    // overrides this to start logged-out.
    storageState: 'playwright/.auth/user.json',
  },
  projects: [
    {
      name: 'auth',
      testMatch: /auth\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], storageState: undefined },
    },
    {
      name: 'chromium',
      testIgnore: /(auth|mobile)\.spec\.ts/,
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
      env: { PORT: String(API_PORT) },
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
