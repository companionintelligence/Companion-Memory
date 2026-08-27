import { expect, test } from './fixtures/authenticated';

// Runs in the `mobile` project (Pixel 5 viewport, authenticated). At this width
// MemoryPage renders MobileMemoryPage via ResponsiveLoader. Assertions stay on
// stable signals (URL, view tabs, container) and each test saves a screenshot
// artifact (uploaded by .github/workflows/e2e.yml).

test('brief redirects to calendar on mobile', async ({ page }) => {
  // The brief now lives inside Calendar (App.tsx's RedirectToCalendar) — /brief
  // is a legacy address that lands on /calendar, not a page of its own.
  await page.goto('/brief');

  await expect(page).toHaveURL(/\/calendar/);
  await page.screenshot({ path: 'test-results/screenshots/brief-mobile.png', fullPage: true });
});

test('memory list view renders on mobile', async ({ page }) => {
  await page.goto('/memory/events');

  // MobileMemoryPage uses a Radix Tabs list (role="tab"), not the desktop
  // header's aria-labelled view buttons — "List view" is a desktop-only label.
  const listTab = page.getByRole('tab', { name: 'List' });
  await expect(listTab).toBeVisible();
  await expect(listTab).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: 'test-results/screenshots/memory-list-mobile.png', fullPage: true });
});

test('memory map view renders on mobile', async ({ page }) => {
  await page.goto('/memory?view=map');

  await expect(page).toHaveURL(/view=map/);
  await expect(page.locator('.leaflet-container')).toBeVisible();
  await page.screenshot({ path: 'test-results/screenshots/memory-map-mobile.png' });
});
