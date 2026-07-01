import { expect, test } from '@playwright/test';

// Authenticated. Tagged @llm because sending a message requires a model to be
// available (Ollama or an LLM mock). The default CI E2E run excludes @llm; run
// locally against a stack with a model, or wire an LLM stub, to exercise it.

test('@llm new chat: sending a message shows the user bubble', async ({ page }) => {
  await page.goto('/chat');

  const input = page.getByPlaceholder('Start a new conversation...');
  await expect(input).toBeVisible();

  await input.fill('Hello there');
  await page.getByRole('button', { name: 'Send' }).click();

  // The user's message should render immediately, before any model response.
  await expect(page.getByText('Hello there')).toBeVisible();
});
