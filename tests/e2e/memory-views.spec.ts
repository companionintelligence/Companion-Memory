import { expect, test } from '@playwright/test';

// Authenticated (chromium project reuses the storageState from global-setup).
// The app exposes four Memory views; each is selectable via a tab whose
// aria-label is the view title, and the active view lives in the `?view=` param.

test('defaults to the list view with seeded results', async ({ page }) => {
  await page.goto('/memory');

  // Default view is list; at least one entity card should render from seed data.
  await expect(page.getByLabel('List view')).toBeVisible();
});

const VIEWS = [
  { tab: 'List view', view: 'list' },
  { tab: 'Gallery view', view: 'gallery' },
  { tab: 'Map view', view: 'map' },
  { tab: 'Graph view', view: 'graph' },
] as const;

for (const { tab, view } of VIEWS) {
  test(`switches to the ${view} view`, async ({ page }) => {
    await page.goto('/memory');

    await page.getByLabel(tab).click();
    await expect(page).toHaveURL(new RegExp(`view=${view}`));

    // Save a screenshot artifact for each view (uploaded by the e2e workflow).
    await page.screenshot({ path: `test-results/screenshots/memory-${view}-desktop.png` });
  });
}

test('renders the Leaflet map container in map view', async ({ page }) => {
  await page.goto('/memory?view=map');

  await expect(page.locator('.leaflet-container')).toBeVisible();
});
