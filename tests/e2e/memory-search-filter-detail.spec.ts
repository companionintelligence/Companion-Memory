import { expect, test } from './fixtures/authenticated';

// Authenticated. On /memory the global search box writes the `?search` param
// live (debounced) so results filter in place. ExplorerToolbar's real search
// input has placeholder "Search memory…" (not "Search") — read from the
// current ExplorerToolbar.tsx source (`MemorySearchField`).

test('typing in search drives the ?search URL param', async ({ page }) => {
  await page.goto('/memory/events');

  await page.getByPlaceholder('Search memory…').fill('coffee');

  await expect(page).toHaveURL(/search=coffee/);
});

test('clearing the search removes the ?search param', async ({ page }) => {
  await page.goto('/memory?search=coffee');

  const box = page.getByPlaceholder('Search memory…');
  await expect(box).toHaveValue('coffee');
  await box.fill('');

  await expect(page).not.toHaveURL(/search=/);
});

test('an entity-type filter is reflected in the URL', async ({ page }) => {
  // The toolbar writes excluded types to the URL; assert the param round-trips
  // and the page stays on the memory explorer.
  await page.goto('/memory?excludedEntityTypes=Person,Place');

  await expect(page).toHaveURL(/excludedEntityTypes=Person/);
  await expect(page.getByRole('button', { name: 'List view' })).toBeVisible();
});

// The "detail" half this filename promises: clicking a result row opens the
// shared EntityDetailScaffold drawer (a Radix Sheet/Dialog) with that row's
// title, and closing it returns to the list. Every ListView row (EntityRow)
// is a `role="button"` div with no other role="button" elements competing for
// it on this page (nav/header controls render real semantic <button>s without
// an explicit role), so the first list result is a reliable, content-agnostic
// target regardless of which entity types the seed data happens to contain.
test('opens the entity detail drawer from a result tile and can close it', async ({ page }) => {
  await page.goto('/memory/events');

  const firstRow = page.locator('[role="button"]').first();
  await expect(firstRow).toBeVisible();
  const rowTitle = (await firstRow.textContent())?.trim();

  await firstRow.click();

  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();

  // The drawer's heading (Sheet.Title) carries the same entity title the row
  // showed — proof the drawer opened for the row that was clicked, not just
  // that some dialog appeared.
  if (rowTitle) {
    await expect(drawer).toContainText(rowTitle.slice(0, 20));
  }

  // Radix Sheet closes on Escape; the drawer should unmount/hide.
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
});
