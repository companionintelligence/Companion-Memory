import { type Page } from '@playwright/test';
import { expect, test } from './fixtures/authenticated';

// Authenticated (the chromium project inherits the auth project's storageState).
//
// /memory/things is the physical-things browse: search, a duplicate-review card
// driven by `itemDuplicates`, and a detail page per owned object carrying its
// codes. These specs walk the path a person actually takes — find a thing, open
// it, claim a code on it, and resolve a duplicate — against the seeded stack.
//
// Every step is skipped rather than failed when the seed has no data for it: an
// an empty Things list is a legitimate state of the seeded database, and asserting
// on rows that were never seeded would make this spec a seed test rather than a
// UI test.

const SEARCH_PLACEHOLDER = 'Search things by name, brand, model or category...';

const CARDS = '[class*="cursor-pointer"]';

/**
 * How many thing cards the browse ended up with, once it has actually finished
 * loading.
 *
 * `locator.count()` does NOT auto-wait — called straight after `goto` it
 * returns 0 while the first paint is still in flight, which made
 * `test.skip(count === 0)` fire on a slow render regardless of what the seed
 * holds, silently no-opping the specs below. So wait for the page's own count
 * ("N things", read off `items.totalCount`) to be on screen first, and when it
 * is non-zero wait for a card to actually appear before counting.
 */
async function countThingCards(page: Page): Promise<number> {
  const count = page.getByText(/^\d+ things$/);
  await expect(count).toBeVisible({ timeout: 15_000 });

  const total = Number((await count.innerText()).replace(/\D/g, ''));

  if (total === 0) {
    return 0;
  }

  const cards = page.locator(CARDS, { hasText: /Thing/ });
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });

  return cards.count();
}

test('things browse loads and searching narrows it server-side', async ({ page }) => {
  await page.goto('/memory/things');

  const search = page.getByPlaceholder(SEARCH_PLACEHOLDER);
  await expect(search).toBeVisible();

  // "N things" — the page's own count, read straight off `items.totalCount`.
  const count = page.getByText(/^\d+ things$/);
  await expect(count).toBeVisible();

  const total = Number((await count.innerText()).replace(/\D/g, ''));

  test.skip(total === 0, 'No things in the seeded database.');

  const cards = page.locator(CARDS, { hasText: /Thing/ });
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });

  // A query that cannot match anything must come back empty from the SERVER,
  // not be silently ignored — the empty state proves the arg reached `items`.
  await search.fill('zzz-no-such-thing-zzz');
  await expect(page.getByText('No things found')).toBeVisible({ timeout: 15_000 });

  await search.fill('');
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });
});

test('opening a thing from the browse reaches its detail page', async ({ page }) => {
  await page.goto('/memory/things');

  const cardCount = await countThingCards(page);
  test.skip(cardCount === 0, 'No things in the seeded database.');

  const cards = page.locator(CARDS, { hasText: /Thing/ });

  await cards.first().click();

  await expect(page).toHaveURL(/\/items\//);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText('Codes')).toBeVisible();
});

test('a code can be claimed on a thing and shows up in its list', async ({ page }) => {
  await page.goto('/memory/things');

  const cardCount = await countThingCards(page);
  test.skip(cardCount === 0, 'No things in the seeded database.');

  const cards = page.locator(CARDS, { hasText: /Thing/ });

  await cards.first().click();
  await expect(page).toHaveURL(/\/items\//);

  // A SERIAL rather than a GTIN: serials are free-form, so a unique run-scoped
  // value cannot collide with a seeded barcode and trip the merge offer.
  const serial = `E2E-${Date.now()}`;

  await page.getByLabel('Code type').click();
  await page.getByRole('option', { name: 'Serial number' }).click();

  await page.getByLabel('Code value').fill(serial);
  await page.getByRole('button', { name: 'Add code' }).click();

  await expect(page.getByText(serial)).toBeVisible({ timeout: 15_000 });

  // And it can be taken off again, leaving the thing as it was found.
  await page.getByRole('button', { name: `Remove ${serial}` }).click();
  await expect(page.getByText(serial)).toBeHidden({ timeout: 15_000 });
});

test('a duplicate group can be merged from the review card', async ({ page }) => {
  await page.goto('/memory/things');

  await expect(page.getByPlaceholder(SEARCH_PLACEHOLDER)).toBeVisible();

  const duplicateCard = page.getByText('Possible duplicates');
  const hasDuplicates = await duplicateCard.isVisible().catch(() => false);

  test.skip(!hasDuplicates, 'The seeded database has no duplicate things to merge.');

  const mergeButton = page.getByRole('button', { name: 'Merge into one thing' }).first();
  await mergeButton.click();

  // The merge is behind a confirm — clicking the card button alone must not write.
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('cannot be undone');

  await dialog.getByRole('button', { name: 'Merge into one thing' }).click();

  await expect(dialog).toBeHidden({ timeout: 20_000 });
});

test('receipts list and detail are reachable from the memory hub', async ({ page }) => {
  await page.goto('/memory/receipts');

  await expect(page.getByPlaceholder('Search by merchant...')).toBeVisible();

  const count = page.getByText(/^\d+ receipts$/);
  await expect(count).toBeVisible();

  const total = Number((await count.innerText()).replace(/\D/g, ''));

  test.skip(total === 0, 'No receipts in the seeded database.');

  await page
    .locator('button', { hasText: /lines?$/ })
    .first()
    .click();

  await expect(page).toHaveURL(/\/receipts\//);
  await expect(page.getByText('Totals')).toBeVisible();
});
