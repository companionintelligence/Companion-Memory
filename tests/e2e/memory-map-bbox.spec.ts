import { expect, test } from '@playwright/test';

// Authenticated. The map view scopes results to located events; an explicit
// `?bbox=minLon,minLat,maxLon,maxLat` narrows them to a geographic window.

test('map view renders the Leaflet container', async ({ page }) => {
  await page.goto('/memory?view=map');

  await expect(page.locator('.leaflet-container')).toBeVisible();
});

test('a bbox param is preserved and the map still renders', async ({ page }) => {
  // A wide box around Southern California (seed places have coordinates there).
  const bbox = '-118.7,33.6,-118.0,34.2';
  await page.goto(`/memory?view=map&bbox=${bbox}`);

  await expect(page).toHaveURL(/bbox=/);
  await expect(page.locator('.leaflet-container')).toBeVisible();
});
