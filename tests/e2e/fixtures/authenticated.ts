import { test as base, type BrowserContext } from '@playwright/test';

/**
 * A freshly-authenticated browser context for every test.
 *
 * ─── WHY NOT A SHARED `storageState` FILE ───────────────────────────────────
 *
 * The API rotates the session token on `/api/authenticate/refresh` — which the
 * app calls on load — and only honours the pre-rotation token for
 * `auth.session.refreshGracePeriod`, which is **30 seconds**
 * (`backend/apps/api/config/default.json`). A static `storageState` therefore
 * hands every spec the *same* pre-rotation cookie, and once the grace window on
 * that rotation has passed the API answers `401 Invalid session`, the app
 * bounces to /login, and the spec fails on an assertion about page content that
 * has nothing to do with what broke.
 *
 * Sessions are additionally bound to `ip + user_agent`
 * (`AuthService.validateSession` matches on all three), so the session has to be
 * minted by a context carrying the same device profile as the test that uses it
 * — which is exactly what this fixture does, since `contextOptions` already
 * carries the project's device.
 *
 * Logging in is two HTTP calls against an already-running server, so paying it
 * per test costs milliseconds and removes a whole class of order-dependent
 * failure.
 */

export async function loginContext(context: BrowserContext, baseURL: string): Promise<void> {
  const email = process.env.AUTH_DEFAULT_USER_EMAIL || 'jsmith@example.com';
  const password = process.env.AUTH_DEFAULT_USER_PASSWORD;

  if (!password) {
    throw new Error('AUTH_DEFAULT_USER_PASSWORD must be set for E2E (matches the seeded user).');
  }

  await context.request.get(`${baseURL}/api/authenticate/csrf`);
  const { cookies } = await context.storageState();
  const csrf = cookies.find((c) => c.name === 'csrfToken')?.value;

  if (!csrf) {
    throw new Error('E2E login failed: csrfToken cookie was not set by /api/authenticate/csrf');
  }

  const res = await context.request.post(`${baseURL}/api/authenticate`, {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    data: { username: email, password },
  });

  if (!res.ok()) {
    throw new Error(`E2E login failed (${res.status()}): ${await res.text()}`);
  }
}

/**
 * Drop-in replacement for `@playwright/test`'s `test` that starts every test
 * signed in as the seeded user. Specs that must start signed *out*
 * (auth.spec.ts, onboarding.spec.ts) keep importing `@playwright/test`.
 */
export const test = base.extend<{ context: BrowserContext }>({
  context: async ({ browser, contextOptions, baseURL }, use) => {
    const context = await browser.newContext(contextOptions);

    await loginContext(context, baseURL ?? 'http://localhost:5173');
    await use(context);
    await context.close();
  },
});

export { expect } from '@playwright/test';
export type { Page } from '@playwright/test';
