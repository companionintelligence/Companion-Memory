import { expect, test } from './fixtures/authenticated';

// Authenticated. Tagged @llm because sending a message requires a model to be
// available (Ollama or an LLM mock). The default CI E2E run excludes @llm; run
// locally against a stack with a model, or wire an LLM stub, to exercise it.
//
// Selectors below were read from the current ChatPage/ChatInput source, not
// guessed: the empty-thread placeholder is set by ChatPage
// (`inputPlaceholder`), and the composer's submit button has NO accessible
// name (a bare Send/Square icon, no aria-label, no text) — ChatInput's own
// unit tests submit via the textarea's Enter handler for the same reason, so
// this spec does the same rather than asserting on a button name that does
// not exist in the DOM.

test('@llm new chat: sending a message shows the user bubble', async ({ page }) => {
  await page.goto('/chat');

  const input = page.getByPlaceholder(/Ask about Memory, Plan, Forecast, Brief/);
  await expect(input).toBeVisible();

  await input.fill('Hello there');
  await input.press('Enter');

  // The user's message should render immediately, before any model response.
  await expect(page.getByText('Hello there')).toBeVisible();
});
