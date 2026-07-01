import { expect, test } from '@playwright/test';

// Runs in the `mobile` project (Pixel 5 viewport, authenticated). At this width
// MemoryPage renders MobileMemoryPage via ResponsiveLoader. Assertions stay on
// stable signals (URL, view tabs, container) and each test saves a screenshot
// artifact (uploaded by .github/workflows/e2e.yml).

test('feed renders on mobile', async ({ page }) => {
  await page.goto('/feed');

  await expect(page).toHaveURL(/\/feed/);
  await page.screenshot({ path: 'test-results/screenshots/feed-mobile.png', fullPage: true });
});

test('memory list view renders on mobile', async ({ page }) => {
  await page.goto('/memory');

  await expect(page.getByLabel('List view')).toBeVisible();
  await page.screenshot({ path: 'test-results/screenshots/memory-list-mobile.png', fullPage: true });
});

test('memory map view renders on mobile', async ({ page }) => {
  await page.goto('/memory?view=map');

  await expect(page).toHaveURL(/view=map/);
  await expect(page.locator('.leaflet-container')).toBeVisible();
  await page.screenshot({ path: 'test-results/screenshots/memory-map-mobile.png' });
});
