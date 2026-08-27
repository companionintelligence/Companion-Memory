import { expect, test } from './fixtures/authenticated';

// Authenticated. The map view scopes results to located events; an explicit
// `?bbox=minLon,minLat,maxLon,maxLat` narrows them to a geographic window.
//
// The seeded places (backend/apps/api/scripts/seed-database/data/places.ts)
// sit around Laguna Beach, CA — longitude ~-117.7 to -117.9, latitude
// ~33.5 to 33.65. A bbox covering that region should show pins; a bbox over
// open ocean with nothing in it should show none — that contrast is the real
// "bbox narrows results" assertion the old version of this spec never made.

const REAL_BBOX = '-117.95,33.45,-117.65,33.70'; // covers the seeded Laguna Beach places
const EMPTY_BBOX = '-160,0,-159,1'; // mid-Pacific open ocean — no seeded data there

function markerLocator(page: import('@playwright/test').Page) {
  // Leaflet stamps every marker (single pin or cluster bubble) with this class
  // regardless of the custom divIcon className layered on top of it.
  return page.locator('.leaflet-marker-icon');
}

test('map view renders the Leaflet container', async ({ page }) => {
  await page.goto('/memory?view=map');

  await expect(page.locator('.leaflet-container')).toBeVisible();
});

test('a bbox param is preserved and the map still renders', async ({ page }) => {
  await page.goto(`/memory?view=map&bbox=${REAL_BBOX}`);

  await expect(page).toHaveURL(/bbox=/);
  await expect(page.locator('.leaflet-container')).toBeVisible();
});

test('a bbox over real data shows pins; a bbox over empty ocean shows none', async ({ page }) => {
  await page.goto(`/memory?view=map&bbox=${REAL_BBOX}`);
  await expect(page.locator('.leaflet-container')).toBeVisible();

  const withData = markerLocator(page);
  await expect(withData.first()).toBeVisible();
  const realCount = await withData.count();
  expect(realCount).toBeGreaterThan(0);

  await page.goto(`/memory?view=map&bbox=${EMPTY_BBOX}`);
  await expect(page.locator('.leaflet-container')).toBeVisible();

  // No sentinel to wait on for "confirmed empty" — give the query a moment to
  // land, then assert the marker layer is genuinely empty, not just not yet
  // rendered.
  await page.waitForTimeout(1000);
  await expect(markerLocator(page)).toHaveCount(0);
});
