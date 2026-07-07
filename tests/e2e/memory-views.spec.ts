import { expect, test } from '@playwright/test';

// Authenticated (chromium project reuses the storageState from global-setup).
// The app exposes four Memory views behind the breadcrumb dropdown: the last
// crumb names the active view and opens an icon grid (mirroring the header
// plus-button's Add panel); the active view lives in the `?view=` param.

test('defaults to the list view with seeded results', async ({ page }) => {
  await page.goto('/memory');

  // Default view is list; the breadcrumb view switcher names the active view.
  await expect(page.getByLabel('List view')).toBeVisible();
});

const VIEWS = [
  { label: 'List', view: 'list' },
  { label: 'Gallery', view: 'gallery' },
  { label: 'Map', view: 'map' },
  { label: 'Graph', view: 'graph' },
] as const;

for (const { label, view } of VIEWS) {
  test(`switches to the ${view} view`, async ({ page }) => {
    await page.goto('/memory');

    // Open the breadcrumb view switcher, then pick the view from its grid.
    await page.getByRole('button', { name: 'change view' }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`view=${view}`));

    // Save a screenshot artifact for each view (uploaded by the e2e workflow).
    await page.screenshot({ path: `test-results/screenshots/memory-${view}-desktop.png` });
  });
}

test('renders the Leaflet map container in map view', async ({ page }) => {
  await page.goto('/memory?view=map');

  await expect(page.locator('.leaflet-container')).toBeVisible();
});
