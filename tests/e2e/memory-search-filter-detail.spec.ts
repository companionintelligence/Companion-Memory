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
// is a `role="button"` div, but it is NOT the only explicit role="button" on
// this page: the header's ConnectionModeIndicator ("Connected" pill; see
// ConnectionModeIndicator.tsx) renders a `<Badge role="button">` too, and it
// sits earlier in the DOM than the results list. An unscoped
// `[role="button"]` locator matches that pill first — its click handler just
// re-runs the connection health check, so the click "succeeds" but no drawer
// ever opens. Scope to ListView's results container (`data-list-scroll`,
// shared by every list-like view) so `.first()` reliably lands on a real
// result row regardless of which entity types the seed data contains.
test('opens the entity detail drawer from a result tile and can close it', async ({ page }) => {
  await page.goto('/memory/events');

  // Wait for the results CONTAINER before the first row. ListView renders the
  // scroll container as soon as the page mounts but its rows only after the
  // explorer query resolves, so asserting straight on a row races the query
  // rather than the render. Under the full suite (four workers against one
  // API) that race is lost often enough to show up as a flake — this exact
  // test is the `1 flaky` in CI, and it fails in a loaded local full run while
  // passing every time in isolation.
  await expect(page.locator('[data-list-scroll]')).toBeVisible({ timeout: 15_000 });

  const firstRow = page.locator('[data-list-scroll] [role="button"]').first();
  await expect(firstRow).toBeVisible({ timeout: 15_000 });
  // EntityRow's title div is tagged `entity-row-title` specifically so this
  // can read the title alone — the row's plain textContent runs the title
  // and subtitle divs together with no separator (e.g. "Pizza NightHomemade
  // pizza night."), which is not a substring of anything the drawer renders.
  const rowTitle = (await firstRow.getByTestId('entity-row-title').textContent())?.trim();

  await firstRow.click();

  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();

  // The drawer's heading (Sheet.Title, rendered as an <h2 data-slot="sheet-title">)
  // carries the same entity title the row showed — proof the drawer opened
  // for the row that was clicked, not just that some dialog appeared. The
  // details body renders its own <h2> section headings ("Location",
  // "Connections", …), so scope to the sheet's own title slot rather than
  // `getByRole('heading')`, which resolves to all of them.
  if (rowTitle) {
    await expect(drawer.locator('[data-slot="sheet-title"]')).toHaveText(rowTitle);
  }

  // Radix Sheet closes on Escape; the drawer should unmount/hide.
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
});
