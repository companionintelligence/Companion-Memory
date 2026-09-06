import { expect, signUp, test, testAccount } from './fixtures/appliance';

/**
 * The path a person who just installed the desktop app is on: the splash the
 * Tauri shell redirects into, the account they have to create because the
 * appliance has none, and the app they land in afterwards.
 *
 * Every one of these assertions covers a place this flow was actually broken —
 * signup was impossible on a fresh appliance (no code could exist and none
 * could be minted), and the splash's only call to action pointed at a login
 * page a brand-new user could not use.
 */
test.describe('desktop first-run', () => {
  test('the splash offers a way in for someone with no account', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: /supercharge your ai/i })).toBeVisible();
    await expect(page.getByText(/companion memory/i).first()).toBeVisible();

    // The primary action has to lead somewhere a new user can finish. It used
    // to go to /login, which on an appliance with no accounts is a dead end.
    const getStarted = page.getByRole('link', { name: /get started/i });
    await expect(getStarted).toBeVisible();

    await getStarted.click();
    await expect(page).toHaveURL(/\/signup/);
  });

  test('the first account can be created without a signup code', async ({ page }) => {
    const account = testAccount('form');

    await page.goto('/signup');

    // The code field is the thing that made a fresh appliance unusable: the flag
    // ships on, the table starts empty, and nothing mints one. On an unclaimed
    // box the server reports it is not required and the field is not rendered.
    await expect(page.getByLabel(/name/i)).toBeVisible();
    await expect(page.getByLabel(/signup code/i)).toHaveCount(0);

    await page.getByLabel(/name/i).fill(account.name);
    await page.getByLabel(/email/i).fill(account.email);
    await page.getByLabel(/^password$/i).fill(account.password);
    await page.getByRole('button', { name: /sign up|create account/i }).click();

    // Straight into onboarding — a new account is not onboarded yet, and
    // RequireOnboarded sends it there.
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 60_000 });
  });

  test('a signed-in account reaches the app and stays signed in across a reload', async ({
    page,
    context,
    baseURL,
  }) => {
    const account = testAccount('session');
    await signUp(context, baseURL!, account);

    await page.goto('/');

    // Signed in, the splash is not what you get — RedirectKnownUser sends an
    // un-onboarded account to onboarding and an onboarded one to the app.
    await expect(page).not.toHaveURL(/\/(login|signup)$/);
    await expect(page.getByRole('link', { name: /get started/i })).toHaveCount(0);

    // The reload is the part worth asserting: the app refreshes its session on
    // load, and a broken rotation shows up here as a bounce back to /login.
    await page.reload();
    await expect(page).not.toHaveURL(/\/login/);
  });
});
