import { setApiKey } from '@ci/common';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextPromptCard } from './ContextPromptCard';

// The real `useSessionAuth` runs on top of this, so the card is exercised for a web JWT
// session and for the native shell, whose only credential is an API key.
const h = vi.hoisted(() => ({
  auth: { authToken: 'jwt-abc' as string | null, authenticated: true, expired: false },
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => [h.auth, {}] }));

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
}

const calls: Call[] = [];

const prompt = {
  id: 'p1',
  selector: { type: 'one_line', prompt: 'What did you have for lunch?' },
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

      const body = init?.method === 'POST' ? undefined : prompt;

      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => (body ? JSON.stringify(body) : ''),
      } as Response);
    }),
  );
}

beforeEach(() => {
  calls.length = 0;
  h.auth.authToken = 'jwt-abc';
  h.auth.authenticated = true;
  h.auth.expired = false;
});

afterEach(() => {
  setApiKey(null);
  vi.unstubAllGlobals();
});

describe('ContextPromptCard', () => {
  it('shows the pending prompt, fetched with the bearer on the web', async () => {
    stubApi();

    render(<ContextPromptCard />);

    expect(await screen.findByText('What did you have for lunch?')).toBeInTheDocument();
    expect(calls[0].url).toContain('/api/context-prompts/pending');
    expect(calls[0].headers.Authorization).toBe('Bearer jwt-abc');
  });

  /**
   * ═══ THE FEED NEVER SHOWED A CONTEXT PROMPT ON THE PHONE ═══
   *
   * `authToken` is the web JWT, null in the Capacitor app — whose durable credential is a
   * keystore API key. The card returned before fetching, so nothing was ever asked and a prompt
   * could never be answered or skipped. `/context-prompts/*` is `JwtOrApiKeyAuthGuard`.
   */
  describe('native shell (API key, no web JWT)', () => {
    beforeEach(() => {
      h.auth.authToken = null;
      setApiKey('device-key');
    });

    it('shows the pending prompt, fetched with the device key and no bearer', async () => {
      stubApi();

      render(<ContextPromptCard />);

      expect(await screen.findByText('What did you have for lunch?')).toBeInTheDocument();
      expect(calls[0].headers['x-api-key']).toBe('device-key');
      expect(calls[0].headers).not.toHaveProperty('Authorization');
    });

    it('skips the prompt with the device key and no bearer', async () => {
      stubApi();

      render(<ContextPromptCard />);
      await screen.findByText('What did you have for lunch?');

      fireEvent.click(screen.getByRole('button', { name: /skip/i }));

      await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));

      const post = calls.find((call) => call.method === 'POST')!;
      expect(post.url).toContain('/api/context-prompts/p1/skip');
      expect(post.headers['x-api-key']).toBe('device-key');
      expect(post.headers).not.toHaveProperty('Authorization');
    });
  });
});
