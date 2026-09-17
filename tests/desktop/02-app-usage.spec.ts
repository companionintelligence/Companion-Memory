import { expect, signIn, signInAsTestAccount, test, TEST_ACCOUNT } from './fixtures/appliance';

/**
 * Using the appliance as a signed-in account: the surfaces a new user reaches
 * once onboarding is behind them.
 *
 * Assertions stay at the level of "this screen loaded and rendered its own
 * chrome" rather than asserting on content, because a freshly installed
 * appliance has an empty database — every list here is legitimately empty, and
 * a test that demanded rows would only pass on someone's imported machine.
 * What is worth checking is that an empty appliance does not error, hang, or
 * bounce the user back to the login page.
 */

/**
 * Finish onboarding over the API — the UI path is covered by tests/e2e.
 *
 * Takes the access token rather than relying on the session cookie: these
 * routes authenticate off the bearer token the app holds in memory, so a
 * cookie-only request is a 401.
 */
async function completeOnboarding(
  context: Parameters<typeof signIn>[0],
  baseURL: string,
  accessToken: string,
): Promise<void> {
  const { cookies } = await context.storageState();
  const csrf = cookies.find((cookie) => cookie.name === 'csrfToken')?.value;

  const response = await context.request.post(`${baseURL}/api/onboarding/onboard`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    data: {},
  });

  if (!response.ok()) {
    throw new Error(`Completing onboarding failed (${response.status()}): ${await response.text()}`);
  }
}

test.describe('desktop app usage', () => {
  test('an onboarded account lands in the app rather than back at the splash', async ({
    page,
    context,
    baseURL,
    request,
  }) => {
    const accessToken = await signInAsTestAccount(context, baseURL!, request);
    await completeOnboarding(context, baseURL!, accessToken);

    await page.goto('/');

    await expect(page).not.toHaveURL(/\/(login|signup|onboarding)/);
    // The app shell, not the marketing splash.
    await expect(page.getByRole('link', { name: /get started/i })).toHaveCount(0);
    await expect(page.getByRole('navigation').first()).toBeVisible();
  });

  test('the main surfaces load on an appliance with no data yet', async ({
    page,
    context,
    baseURL,
    request,
  }) => {
    const accessToken = await signInAsTestAccount(context, baseURL!, request);
    await completeOnboarding(context, baseURL!, accessToken);

    // Each of these is reachable from the rail; an empty database must render
    // an empty state, not an error boundary or a redirect to login.
    for (const path of ['/memory', '/settings']) {
      await page.goto(path);

      await expect(page).toHaveURL(new RegExp(path));
      await expect(page).not.toHaveURL(/\/login/);
      await expect(page.locator('body')).not.toContainText(/something went wrong|unexpected error/i);
      await expect(page.getByRole('navigation').first()).toBeVisible();
    }
  });

  test('signing out returns to the splash, and the account can sign back in', async ({
    page,
    context,
    baseURL,
    request,
  }) => {
    const accessToken = await signInAsTestAccount(context, baseURL!, request);
    await completeOnboarding(context, baseURL!, accessToken);

    // Signing out through the API rather than hunting the menu item: what this
    // test is about is that the session ends and the credential still works
    // afterwards, not where the button lives.
    const { cookies } = await context.storageState();
    const csrf = cookies.find((cookie) => cookie.name === 'csrfToken')?.value;
    await context.request.post(`${baseURL}/api/authenticate/logout`, {
      headers: csrf ? { 'X-CSRF-Token': csrf } : {},
    });

    await page.goto('/');
    await expect(page.getByRole('link', { name: /get started/i })).toBeVisible();

    // The account outlives the session — a sign-out must not strand someone on
    // an appliance whose signup gate has since closed behind them.
    await signIn(context, baseURL!, TEST_ACCOUNT);
    await page.goto('/');
    await expect(page.getByRole('link', { name: /get started/i })).toHaveCount(0);
  });
});
