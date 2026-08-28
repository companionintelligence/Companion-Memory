import { expect, test } from '@playwright/test';

// Runs in the `auth` project (logged-out: storageState is cleared) — a fresh
// account has to actually be created to reach onboarding, which needs a
// logged-out context the same way auth.spec.ts's login test does.
//
// The seeded John Smith user is already onboarded, so exercising onboarding
// needs a fresh, un-onboarded account. This drives the real flow:
//   1. Sign up a unique throwaway user via /signup (ENABLE_REQUIRE_SIGNUP_CODES
//      is false by default, so no invite code is needed).
//   2. Land on /onboarding and skip through the wizard (every step but the
//      last has a Skip button — OnboardingPage.tsx / constants.ts).
//   3. Finish on the last step and assert the redirect to the onboarded home
//      (appHomePath: /plan when planning.page is on, else /calendar).
//
// A unique email per run (timestamp + random suffix) is the "per-run signup
// helper" the old stub said did not exist yet — email/password are simple
// enough not to warrant a separate fixture module.

test('completes onboarding for a new user', async ({ page }) => {
  const unique = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `e2e-onboarding-${unique}@example.com`;
  const password = 'E2ePassw0rd!';
  const name = `E2E Onboarding ${unique}`;

  await page.goto('/signup');

  // Exact match: PasswordInput's "Show password" toggle button carries an
  // aria-label containing the substring "password", which a non-exact
  // getByLabel('Password') also matches (Playwright's default is
  // case-insensitive substring), making the locator ambiguous.
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign up' }).click();

  // A brand-new, un-onboarded account lands on /onboarding.
  await expect(page).toHaveURL(/\/onboarding/, { timeout: 15_000 });

  // Walk the wizard: every step but the last carries a "Skip" button. Bound
  // the loop well above the current step count so a future step added to the
  // wizard does not strand the test, but still terminate if something is
  // stuck (e.g. Skip stops advancing).
  const skipButton = page.getByRole('button', { name: 'Skip' });
  const finishButton = page.getByRole('button', { name: 'Run my first sync and finish' });

  // Wait for the wizard's controls to mount before the loop starts. Step 1
  // animates its heading in, so an immediate `isVisible()` can miss the footer
  // and break the loop on iteration 0 — which then reads as "the wizard is
  // broken" when nothing is wrong.
  await expect(skipButton.or(finishButton).first()).toBeVisible({ timeout: 15_000 });

  for (let i = 0; i < 20; i++) {
    if (await finishButton.isVisible().catch(() => false)) {
      break;
    }

    if ((await skipButton.count()) === 0) {
      break;
    }

    // The source step ("Connect a source") is a long, inner-scrolling panel and
    // its footer sits below the fold, so Skip is present but not in view.
    // Test on presence, scroll it in, then click — `isVisible()` alone would
    // abandon the walk on a step that is working.
    await skipButton.scrollIntoViewIfNeeded().catch(() => {});
    await skipButton.click();

    // Each step swaps the panel; let the next one settle before re-querying,
    // otherwise the click can land on the outgoing step's detached footer.
    await page.waitForTimeout(300);
  }

  await expect(finishButton).toBeVisible({ timeout: 10_000 });
  await finishButton.click();

  // onboard() flips user.onboarded, and OnboardingPage redirects away once it
  // does — to /plan (planning.page on) or /calendar (off).
  await expect(page).toHaveURL(/\/(plan|calendar)/, { timeout: 20_000 });
});
