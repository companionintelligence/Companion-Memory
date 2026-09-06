import { test as base, type APIRequestContext, type BrowserContext } from '@playwright/test';

/**
 * Helpers for driving the desktop appliance as a real first-time user.
 *
 * The distinction that matters against this stack: there is no seeded account.
 * `tests/e2e` signs in as `jsmith@example.com`, which exists because that suite
 * migrates and seeds its own database. A downloaded desktop app has an empty
 * one, so every spec here has to *create* the account it uses — which is also
 * the flow most worth testing, since it is the one a new user is on.
 */

/** Whether the desktop stack is actually up, so specs can skip instead of fail. */
export async function applianceIsUp(request: APIRequestContext, baseURL: string): Promise<boolean> {
  try {
    const response = await request.get(`${baseURL}/api/health`, { timeout: 5_000 });

    return response.ok();
  } catch {
    return false;
  }
}

/**
 * A unique account per run.
 *
 * Reusing one address would pass on a fresh appliance and fail on the second
 * run with "Email already in use" — the specs would then only work against a
 * database nobody had touched, which is precisely the fragility this suite
 * exists to avoid.
 */
export function testAccount(label: string) {
  const unique = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

  return {
    name: `Desktop Test ${label}`,
    email: `desktop-e2e-${label}-${unique}@example.com`,
    password: 'desktop-e2e-password-1',
  };
}

async function csrfToken(context: BrowserContext, baseURL: string): Promise<string> {
  await context.request.get(`${baseURL}/api/authenticate/csrf`);
  const { cookies } = await context.storageState();
  const token = cookies.find((cookie) => cookie.name === 'csrfToken')?.value;

  if (!token) {
    throw new Error('No csrfToken cookie after /api/authenticate/csrf');
  }

  return token;
}

/** Create an account over the API and leave the context signed in as it. */
export async function signUp(
  context: BrowserContext,
  baseURL: string,
  account: ReturnType<typeof testAccount>,
): Promise<void> {
  const token = await csrfToken(context, baseURL);
  const response = await context.request.post(`${baseURL}/api/signup`, {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    data: { name: account.name, email: account.email, password: account.password },
  });

  if (!response.ok()) {
    throw new Error(`Signup failed (${response.status()}): ${await response.text()}`);
  }
}

/** Sign in an existing account — the same two calls the web app makes. */
export async function signIn(
  context: BrowserContext,
  baseURL: string,
  account: { email: string; password: string },
): Promise<void> {
  const token = await csrfToken(context, baseURL);
  const response = await context.request.post(`${baseURL}/api/authenticate`, {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    data: { username: account.email, password: account.password },
  });

  if (!response.ok()) {
    throw new Error(`Sign-in failed (${response.status()}): ${await response.text()}`);
  }
}

/**
 * `test`, but every spec skips when the appliance is not running.
 *
 * Sessions bind to ip + user_agent and rotate on refresh, so — exactly as in
 * `tests/e2e/fixtures/authenticated.ts` — credentials are minted inside each
 * test's own context rather than shared through a state file.
 */
export const test = base.extend<{ appliance: void }>({
  appliance: [
    async ({ request, baseURL }, use, testInfo) => {
      if (!(await applianceIsUp(request, baseURL!))) {
        testInfo.skip(
          true,
          `No desktop appliance answering at ${baseURL}. Start the desktop app (or ` +
            `\`yarn workspace @ci/fe-desktop dev\`) and re-run.`,
        );
      }

      await use();
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
