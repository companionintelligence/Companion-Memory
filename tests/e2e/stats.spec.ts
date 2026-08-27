import { type Page } from '@playwright/test';
import { expect, test } from './fixtures/authenticated';

// Authenticated. /stats (StatsPage.tsx) had a real production bug: the
// spending chart read `metadata.Amount` while an importer wrote `Total`, so
// the chart was silently empty for anyone with that data. This spec asserts
// the panels that seed data actually backs render real numbers — not just
// that the page doesn't crash — which is the gap the fix closed: "renders"
// and "renders zeros because the query is wrong" both count as "not
// crashing".
//
// Seed data (backend/apps/api/scripts/seed-database) has no receipts and no
// events with `metadata.Amount`/purchase types, so the Spending panel's own
// content is asserted separately and more loosely — it is expected to show
// its defined empty state here, not garbage — while the totals, entity
// breakdown and date range (which DO have backing seed data: hundreds of
// seeded events and entities) get the real assertions.
//
// Two selector traps found by checking the live DOM/a11y tree rather than
// guessing from JSX alone:
//  - shadcn's Card.Title renders a plain `<div data-slot="card-title">`, not
//    a semantic heading — `getByRole('heading', ...)` never matches it. Cards
//    are scoped via `[data-slot="card"]` + hasText instead.
//  - The range ToggleGroup DOES render `role="radio"` per item (Radix's
//    single-select ToggleGroup primitive), confirmed in the live a11y tree —
//    not a plain button.
//  - StatTile labels are visually uppercased via a Tailwind `uppercase`
//    class; Playwright's `innerText()` reflects the CSS-transformed text
//    ("EVENTS", not "Events"), so label lookups are case-insensitive.

async function pageText(page: Page): Promise<string> {
  return page.locator('body').innerText();
}

function numberAfter(text: string, label: string): number {
  const match = new RegExp(`${label}\\s*\\n?\\s*([\\d,]+)`, 'i').exec(text);

  if (!match) {
    throw new Error(`Could not find a number after "${label}" in the page text`);
  }

  return Number(match[1].replace(/,/g, ''));
}

function card(page: Page, text: string) {
  return page.locator('[data-slot="card"]', { hasText: text });
}

test('key stats panels render with real data', async ({ page }) => {
  await page.goto('/stats');

  await expect(page.getByRole('heading', { name: 'Life stats' })).toBeVisible({ timeout: 15_000 });
  // Wait for the skeleton to clear — the totals grid only exists once real data lands.
  await expect(page.getByText('Timeline entries')).toBeVisible({ timeout: 15_000 });

  const text = await pageText(page);

  // Totals tiles, backed by the seeded events / entities.
  expect(numberAfter(text, 'Events')).toBeGreaterThan(0);
  expect(numberAfter(text, 'Entities')).toBeGreaterThan(0);

  // Date range renders real ISO dates, not an em-dash placeholder.
  expect(/\d{4}-\d{2}-\d{2}/.test(text)).toBe(true);

  // "Entities by type" is populated from the same seeded entities — its own
  // empty-state copy must not appear.
  const entitiesByType = card(page, 'Entities by type');
  await expect(entitiesByType).toBeVisible();
  await expect(entitiesByType.getByText('No data yet.')).toHaveCount(0);

  // The Spending panel has no backing seed data — assert it renders its own
  // defined empty state (proof the query ran and returned cleanly) rather
  // than being blank, stuck loading, or crashed.
  const spendCard = card(page, 'Spending');
  await expect(spendCard).toBeVisible();
  await expect(spendCard.getByText(/No parseable payment amounts|\$/)).toBeVisible();
});

test('changing the stats range keeps the page on real data', async ({ page }) => {
  await page.goto('/stats');

  await expect(page.getByRole('heading', { name: 'Life stats' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Timeline entries')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('radio', { name: 'All time' }).click();

  await expect(page.getByRole('heading', { name: 'Life stats' })).toBeVisible();
  await expect(page.getByText('Timeline entries')).toBeVisible();

  const text = await pageText(page);
  expect(numberAfter(text, 'Events')).toBeGreaterThan(0);
});
