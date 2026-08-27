import { expect, test } from './fixtures/authenticated';

// Authenticated. The theme is persisted to localStorage under ThemeProvider's
// real `storageKey` — 'vite-ui-theme' (App.tsx: `<ThemeProvider storageKey="vite-ui-theme">`),
// not 'ci-ui-theme' — and re-applied on load. A clean reload-persistence check
// that needs no LLM or external service.

test('persists the chosen theme across a reload', async ({ page }) => {
  await page.goto('/plan');

  await page.evaluate(() => localStorage.setItem('vite-ui-theme', 'dark'));
  await page.reload();

  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(await page.evaluate(() => localStorage.getItem('vite-ui-theme'))).toBe('dark');
});

test('the settings page is reachable', async ({ page }) => {
  await page.goto('/settings');

  // Stays on settings (not bounced to /login) when authenticated.
  await expect(page).toHaveURL(/\/settings/);
});
