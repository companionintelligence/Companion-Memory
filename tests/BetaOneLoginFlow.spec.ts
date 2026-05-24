import { test, expect } from '@playwright/test';

// Configure the Playwright Test timeout to 100 seconds, ensuring that longer
// tests conclude before Checkly's browser check timeout of 240 seconds. The
// default Playwright Test timeout is set at 30 seconds.
test.setTimeout(100000);

// Set the action timeout to 10 seconds to quickly identify failing actions. By
// default Playwright Test has no timeout for actions (e.g. clicking an
// element).
test.use({ actionTimeout: 10000 });

test('Login to beta-1.companionintel.com', async ({ page }, testInfo) => {
  const response = await page.goto(process.env.URL || 'https://beta-1.companionintel.com');

  await page.screenshot({ path: testInfo.outputPath('splash.jpg') });

  if (response == null) {
    throw new Error('No response received from the server');
  }

  expect(response.status(), 'Should navigate to base URL with a successful status code').toBeLessThan(400);

  await page.getByRole('link', { name: 'Log In' }).click();

  await page.screenshot({ path: testInfo.outputPath('login.jpg') });

  await page.getByRole('textbox', { name: 'Email' }).click();
  await page.getByRole('textbox', { name: 'Email' }).fill(process.env.AUTH_DEFAULT_USER_EMAIL || '');

  await page.getByRole('textbox', { name: 'Password' }).click();
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.AUTH_DEFAULT_USER_PASSWORD || '');

  await page.getByRole('button', { name: 'Log in' }).click();

  await expect(page.getByText('Feed')).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath('home.jpg') });
});
