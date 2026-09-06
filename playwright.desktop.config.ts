import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against the DESKTOP APPLIANCE — the stack the Tauri app brings up, at the
 * gateway it redirects into (`http://127.0.0.1:8642`).
 *
 * Separate from `playwright.e2e.config.ts`, which boots its own API + Vite dev
 * server against a seeded database. This one deliberately does neither: the
 * point is to exercise what a person who downloaded the app actually gets — the
 * published images, an empty database, and no seeded account to borrow. That is
 * the configuration the first-run bugs lived in, and the one no test covered.
 *
 * There is no `webServer` block because the stack is not this config's to start:
 * it belongs to the desktop app (or `yarn dev` in frontend/apps/desktop). When
 * nothing is listening on 8642 every spec skips itself with a message saying so,
 * rather than failing a suite for an environment that was never up.
 */
const baseURL = process.env.DESKTOP_E2E_BASE_URL || 'http://127.0.0.1:8642';

export default defineConfig({
  testDir: './tests/desktop',
  outputDir: './test-results-desktop',
  // One appliance, one database, and specs that create accounts in it.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Generous: this runs against real containers, and the first request after a
  // cold start can wait on the API's own warm-up.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }],
});
