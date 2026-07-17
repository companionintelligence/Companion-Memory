import { expect, test } from '@playwright/test';

// Authenticated. On /memory the global search box writes the `?search` param
// live (debounced) so results filter in place.

test('typing in search drives the ?search URL param', async ({ page }) => {
  await page.goto('/memory');

  await page.getByPlaceholder('Search', { exact: true }).fill('coffee');

  await expect(page).toHaveURL(/search=coffee/);
});

test('clearing the search removes the ?search param', async ({ page }) => {
  await page.goto('/memory?search=coffee');

  const box = page.getByPlaceholder('Search', { exact: true });
  await expect(box).toHaveValue('coffee');
  await box.fill('');

  await expect(page).not.toHaveURL(/search=/);
});

test('an entity-type filter is reflected in the URL', async ({ page }) => {
  // The toolbar writes excluded types to the URL; assert the param round-trips
  // and the page stays on the memory explorer.
  await page.goto('/memory?excludedEntityTypes=Person,Place');

  await expect(page).toHaveURL(/excludedEntityTypes=Person/);
  await expect(page.getByLabel('List view')).toBeVisible();
});
