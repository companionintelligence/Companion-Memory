import { expect, test } from '@playwright/test';

// Runs in the `auth` project (logged-out: storageState is cleared).

test('logs in with the seeded user and lands in the app', async ({ page }) => {
  await page.goto('/');

  // The splash's sign-in affordance is "I already have an account", sitting
  // under the primary "Get Started" (SplashPage.tsx). It was a "Log In" link
  // before the FTUE hero rebuild; this spec kept the old name and so timed out
  // on a splash page that was working — and because the `auth` project is a
  // dependency of the `chromium` and `mobile` projects, that one stale selector
  // took the other 39 specs down as "did not run".
  await page.getByRole('link', { name: 'I already have an account' }).click();

  // The login card is OIDC-first: "Sign in with Companion account" is the
  // primary path, and the email/password form is collapsed behind a link
  // (LoginPage.tsx's `showPasswordForm`). Assert the primary path is present,
  // then reveal the credential form this test actually drives — a spec that
  // went straight for the Email box would fail on a page that is working.
  await expect(page.getByRole('link', { name: 'Sign in with Companion account' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with email instead' }).click();

  await page
    .getByRole('textbox', { name: 'Email' })
    .fill(process.env.AUTH_DEFAULT_USER_EMAIL || 'jsmith@example.com');
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.AUTH_DEFAULT_USER_PASSWORD || '');
  await page.getByRole('button', { name: 'Log in' }).click();

  // Onboarded user → the app home, which `appHomePath` defines as /plan when
  // `planning.page` is on and /calendar when it is off. (/feed was the old home
  // before the nav refactor; asserting it here made a working login look broken.)
  // Un-onboarded would go to /onboarding instead.
  await expect(page).toHaveURL(/\/(plan|calendar|onboarding)/);
});

test('redirects to /login when visiting a protected route logged-out', async ({ page }) => {
  await page.goto('/memory/events');

  await expect(page).toHaveURL(/\/login/);
});
