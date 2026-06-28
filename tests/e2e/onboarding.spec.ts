import { test } from '@playwright/test';

// Optional / not yet enabled. The seeded John Smith user is already onboarded,
// so exercising onboarding needs a fresh, un-onboarded account. Intended flow:
//   1. Sign up a unique throwaway user via /signup (requires signup codes off —
//      ENABLE_REQUIRE_SIGNUP_CODES defaults to false).
//   2. Land on /onboarding, complete the wizard.
//   3. Assert redirect to /feed.
// Marked fixme so it documents the coverage gap without flaking CI. Remove the
// fixme and implement once a per-run signup helper is in place.
test.fixme('completes onboarding for a new user', async ({ page }) => {
  await page.goto('/signup');
});
