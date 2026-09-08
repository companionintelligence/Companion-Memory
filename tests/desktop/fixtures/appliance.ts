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
 * The appliance's test account — one fixed identity, not one per spec.
 *
 * An appliance only ever lets a *first* account be created: the signup gate
 * closes the moment one exists, and nothing in the product can mint a code to
 * open it again. A unique address per spec therefore passes exactly once, on a
 * database nobody has touched, and fails for every spec after it and every
 * re-run — which is what the first version of this suite did.
 *
 * So the suite claims the appliance once and signs in from then on. That is
 * also what a desktop appliance actually is: a single-user box.
 */
export const TEST_ACCOUNT = {
  name: process.env.DESKTOP_E2E_NAME || 'Desktop E2E',
  email: process.env.DESKTOP_E2E_EMAIL || 'desktop-e2e@example.com',
  password: process.env.DESKTOP_E2E_PASSWORD || 'desktop-e2e-password-1',
};

/** Whether this appliance still has no account on it. */
export async function isUnclaimed(request: APIRequestContext, baseURL: string): Promise<boolean> {
  try {
    const response = await request.get(`${baseURL}/api/signup/requirements`, { timeout: 5_000 });

    if (!response.ok()) {
      // Older images have no such route; they always demanded a code, which is
      // the bug this endpoint was added to fix.
      return false;
    }

    return ((await response.json()) as { codeRequired?: boolean }).codeRequired === false;
  } catch {
    return false;
  }
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
  account: typeof TEST_ACCOUNT,
): Promise<string> {
  const token = await csrfToken(context, baseURL);
  const response = await context.request.post(`${baseURL}/api/signup`, {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    data: { name: account.name, email: account.email, password: account.password },
  });

  if (!response.ok()) {
    throw new Error(`Signup failed (${response.status()}): ${await response.text()}`);
  }

  return ((await response.json()) as { accessToken: string }).accessToken;
}

/** Sign in an existing account — the same two calls the web app makes. */
export async function signIn(
  context: BrowserContext,
  baseURL: string,
  account: { email: string; password: string },
): Promise<string> {
  const token = await csrfToken(context, baseURL);
  const response = await context.request.post(`${baseURL}/api/authenticate`, {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    data: { username: account.email, password: account.password },
  });

  if (!response.ok()) {
    throw new Error(`Sign-in failed (${response.status()}): ${await response.text()}`);
  }

  return ((await response.json()) as { accessToken: string }).accessToken;
}

/**
 * Sign in as the test account, claiming the appliance first if nobody has.
 *
 * Idempotent by design: the first spec to run on a fresh appliance creates the
 * account, every spec after it — and every later run — signs in to the same one.
 */
export async function signInAsTestAccount(
  context: BrowserContext,
  baseURL: string,
  request: APIRequestContext,
): Promise<string> {
  try {
    return await signIn(context, baseURL, TEST_ACCOUNT);
  } catch {
    // Not created yet, or the password no longer matches — fall through.
  }

  if (!(await isUnclaimed(request, baseURL))) {
    throw new Error(
      `Cannot sign in as ${TEST_ACCOUNT.email} and this appliance is already claimed by another ` +
        `account, so a new one cannot be created. Point DESKTOP_E2E_BASE_URL at a fresh appliance, ` +
        `or set DESKTOP_E2E_EMAIL/DESKTOP_E2E_PASSWORD to an account that exists on this one.\n\n` +
        `To actually empty an appliance, note that \`docker compose down -v\` is NOT enough: ` +
        `db-data and object-data declare an explicit \`name:\` in docker-compose.production.yml, ` +
        `so Compose treats them as externally named and leaves them behind. Remove them by hand:\n` +
        `  docker compose -p <project> --profile production down --remove-orphans\n` +
        `  docker volume rm <project>-production-db-data <project>-production-object-data`,
    );
  }

  return signUp(context, baseURL, TEST_ACCOUNT);
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
