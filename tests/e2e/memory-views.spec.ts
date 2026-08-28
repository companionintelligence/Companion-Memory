import { expect, test } from './fixtures/authenticated';

// Authenticated (chromium project reuses the storageState from global-setup).
//
// DesktopMemoryPage.tsx does NOT have a breadcrumb-dropdown view switcher —
// it renders always-visible tab buttons in the `nav-views` header portal
// (List / Map / Timeline / Gallery / Graph), each with an `aria-label` from the
// MEMORY_VIEW_* i18n strings ("List view", "Map view", "Timeline view",
// "Gallery view", "Graph view") and `aria-pressed` reflecting whether it is the active tab.
// The active view lives in the `?view=` param.

test('defaults to the list view with seeded results', async ({ page }) => {
  await page.goto('/memory/events');

  // Default view is list; the header nav-views tab names the active view.
  const listTab = page.getByRole('button', { name: 'List view' });
  await expect(listTab).toBeVisible();
  await expect(listTab).toHaveAttribute('aria-pressed', 'true');
});

const VIEWS = [
  { label: 'Map', view: 'map' },
  { label: 'Timeline', view: 'timeline' },
  { label: 'Gallery', view: 'gallery' },
  { label: 'Graph', view: 'graph' },
] as const;

for (const { label, view } of VIEWS) {
  test(`switches to the ${view} view`, async ({ page }) => {
    await page.goto('/memory/events');

    await page.getByRole('button', { name: `${label} view` }).click();
    await expect(page).toHaveURL(new RegExp(`view=${view}`));
    await expect(page.getByRole('button', { name: `${label} view` })).toHaveAttribute('aria-pressed', 'true');

    // Save a screenshot artifact for each view (uploaded by the e2e workflow).
    await page.screenshot({ path: `test-results/screenshots/memory-${view}-desktop.png` });
  });
}

test('renders the Leaflet map container in map view', async ({ page }) => {
  await page.goto('/memory?view=map');

  await expect(page.locator('.leaflet-container')).toBeVisible();
});
