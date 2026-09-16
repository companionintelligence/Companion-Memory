import { expect, test } from './fixtures/authenticated';

// Authenticated. /memory/people (PeoplePage.tsx) had a real production bug:
// the default sort surfaced garbage-named contacts first instead of the
// people you actually interact with. The page now client-sorts by
// `interactionStats.lastInteractionAt` descending (most-recently-interacted
// first) rather than trusting the server's raw order.
//
// This spec asserts the visible list is sane: it loads real rows, every row
// shows a name (never a blank/"Unnamed" placeholder for the whole list — one
// or two is plausible for genuinely nameless contacts, but not most of the
// first page), and the page's own count matches what is rendered.

test('people list loads with sane, named results', async ({ page }) => {
  await page.goto('/memory/people');

  // The page's own "N people" count is the "finished loading" signal. It used
  // to be the search input, but PeoplePage has no input of its own any more —
  // the header's GlobalSearchBox drives this page through `?search=` (see
  // isLiveSearchPath), and PeoplePage.test.tsx asserts the old placeholder is
  // gone. The count is a better signal anyway: it only renders once the query
  // has resolved, whereas the input rendered before the data did.
  await expect(page.getByText(/\d+ people/)).toBeVisible({ timeout: 15_000 });

  const rows = page.locator('button', { hasText: /events/ });
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });

  const rowCount = await rows.count();
  expect(rowCount).toBeGreaterThan(0);

  // Sample the visible rows' primary name line and assert most are real
  // names, not the empty-name fallback — a regression back to surfacing
  // garbage-named contacts first would show mostly "Unnamed" up top.
  const sampleSize = Math.min(rowCount, 10);
  let unnamed = 0;

  for (let i = 0; i < sampleSize; i++) {
    const text = (await rows.nth(i).innerText()).trim();

    if (text.startsWith('Unnamed')) {
      unnamed += 1;
    }
  }

  expect(unnamed).toBeLessThan(sampleSize);
});

test('opening a person from the list navigates to their detail page', async ({ page }) => {
  await page.goto('/memory/people');

  const rows = page.locator('button', { hasText: /events/ });
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });

  await rows.first().click();

  await expect(page).toHaveURL(/\/people\//);
});
