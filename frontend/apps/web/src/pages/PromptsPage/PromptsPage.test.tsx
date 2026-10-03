import { setApiKey } from '@ci/common';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { PromptsPage } from './PromptsPage';

// The real `useSessionAuth` runs on top of this: the page has to work for a web JWT
// session and for the native shell, whose only credential is an API key.
const h = vi.hoisted(() => ({
  auth: { authToken: 'jwt-abc' as string | null, authenticated: true, expired: false },
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => [h.auth, {}] }));

// The prompt card and the catalogue have their own tests and their own requests.
vi.mock('./AnswerQuestionPrompt', () => ({ AnswerQuestionPrompt: () => null }));
vi.mock('./ReflectionCatalogue', () => ({ ReflectionCatalogue: () => null }));

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
}

const calls: Call[] = [];

// Restore `fetch` alone: `vi.unstubAllGlobals()` would also drop the ResizeObserver stub from the
// shared test setup, which the edit dialog's Radix primitives need.
const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const answer = {
  id: 'a1',
  answer: 'Peanuts',
  ragAnswer: '',
  answerSource: 'user_input',
  question: { id: 'q1', text: 'What foods are you allergic to?' },
};

function stubApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: String(input),
        headers: { ...(init?.headers as Record<string, string> | undefined) },
      });

      if (init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ...answer, answer: 'Peanuts and shellfish' }));
      }

      return Promise.resolve(jsonResponse([answer]));
    }),
  );
}

async function openAnswersTab() {
  // Radix tabs activate on mousedown, not click.
  fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Your answers' }), { button: 0 });
}

beforeEach(() => {
  calls.length = 0;
  h.auth.authToken = 'jwt-abc';
  h.auth.authenticated = true;
  h.auth.expired = false;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  setApiKey(null);
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('PromptsPage — Your answers', () => {
  it('lists the answers with the bearer on the web', async () => {
    stubApi();

    renderWithProviders(<PromptsPage />);
    await openAnswersTab();

    expect(await screen.findByText('What foods are you allergic to?')).toBeInTheDocument();
    expect(calls[0].url).toContain('/api/answers');
    expect(calls[0].headers.Authorization).toBe('Bearer jwt-abc');
  });

  /**
   * ═══ "AUTHENTICATION TOKEN NOT FOUND" ON THE PHONE ═══
   *
   * `authToken` is the web JWT, null in the Capacitor app — whose durable credential is a
   * keystore API key. The page threw before it asked, so "Your answers" showed a red error
   * that Try Again could never clear. `GET /answers` is `JwtOrApiKeyAuthGuard`.
   */
  describe('native shell (API key, no web JWT)', () => {
    beforeEach(() => {
      h.auth.authToken = null;
      setApiKey('device-key');
    });

    it('lists the answers with the device key and no bearer', async () => {
      stubApi();

      renderWithProviders(<PromptsPage />);
      await openAnswersTab();

      expect(await screen.findByText('What foods are you allergic to?')).toBeInTheDocument();
      expect(screen.queryByText('Authentication token not found')).not.toBeInTheDocument();
      expect(screen.queryByText('Error loading reflections')).not.toBeInTheDocument();

      expect(calls[0].url).toContain('/api/answers');
      expect(calls[0].headers['x-api-key']).toBe('device-key');
      expect(calls[0].headers).not.toHaveProperty('Authorization');
    });

    it('saves an edited answer with the device key and no bearer', async () => {
      stubApi();

      renderWithProviders(<PromptsPage />);
      await openAnswersTab();

      await screen.findByText('What foods are you allergic to?');
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

      const textarea = await screen.findByLabelText('Answer');
      fireEvent.change(textarea, { target: { value: 'Peanuts and shellfish' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));

      const patch = calls.find((call) => call.method === 'PATCH')!;
      expect(patch.url).toContain('/api/answers/a1');
      expect(patch.headers['x-api-key']).toBe('device-key');
      expect(patch.headers).not.toHaveProperty('Authorization');
    });
  });
});
