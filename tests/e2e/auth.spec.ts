import { expect, test } from '@playwright/test';

// Runs in the `auth` project (logged-out: storageState is cleared).

test('logs in with the seeded user and lands in the app', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('link', { name: 'Log In' }).click();

  await page
    .getByRole('textbox', { name: 'Email' })
    .fill(process.env.AUTH_DEFAULT_USER_EMAIL || 'jsmith@example.com');
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.AUTH_DEFAULT_USER_PASSWORD || '');
  await page.getByRole('button', { name: 'Log in' }).click();

  // Onboarded user → redirected to the feed (un-onboarded would go to /onboarding).
  await expect(page).toHaveURL(/\/(feed|onboarding)/);
});

test('redirects to /login when visiting a protected route logged-out', async ({ page }) => {
  await page.goto('/memory');

  await expect(page).toHaveURL(/\/login/);
});
