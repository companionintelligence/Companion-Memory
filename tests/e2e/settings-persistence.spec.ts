import { expect, test } from '@playwright/test';

// Authenticated. The theme is persisted to localStorage ('ci-ui-theme') by the
// ThemeProvider and re-applied on load — a clean reload-persistence check that
// needs no LLM or external service.

test('persists the chosen theme across a reload', async ({ page }) => {
  await page.goto('/feed');

  await page.evaluate(() => localStorage.setItem('ci-ui-theme', 'dark'));
  await page.reload();

  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(await page.evaluate(() => localStorage.getItem('ci-ui-theme'))).toBe('dark');
});

test('the settings page is reachable', async ({ page }) => {
  await page.goto('/settings');

  // Stays on settings (not bounced to /login) when authenticated.
  await expect(page).toHaveURL(/\/settings/);
});
