import { setApiKey } from '@ci/common';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useFeedQuestionService } from './useFeedQuestionService';

// The real `useSessionAuth` runs on top of this, so the hook is exercised for a web JWT
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubApi(question: unknown = { id: 'q1', text: 'What is your shoe size?', presentationId: 'fq-1' }) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: String(input),
        headers: { ...(init?.headers as Record<string, string> | undefined) },
      });

      if (init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: 'a1' }, 201));
      }

      return Promise.resolve(jsonResponse(question, question == null ? 204 : 200));
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

describe('useFeedQuestionService', () => {
  it('loads the unanswered question with the bearer on the web', async () => {
    stubApi();

    const { result } = renderHook(() => useFeedQuestionService());

    await waitFor(() => expect(result.current[0].question?.text).toBe('What is your shoe size?'));
    expect(calls[0].url).toContain('/api/questions/unanswered');
    expect(calls[0].headers.Authorization).toBe('Bearer jwt-abc');
  });

  /**
   * ═══ THE FEED NEVER ASKED A REFLECTION QUESTION ON THE PHONE ═══
   *
   * `authToken` is the web JWT, null in the Capacitor app — whose durable credential is a
   * keystore API key. The hook cleared the question and returned before asking, so the feed's
   * question card never appeared and answering was a silent no-op. Both routes are
   * `JwtOrApiKeyAuthGuard`.
   */
  describe('native shell (API key, no web JWT)', () => {
    beforeEach(() => {
      h.auth.authToken = null;
      setApiKey('device-key');
    });

    it('loads the unanswered question with the device key and no bearer', async () => {
      stubApi();

      const { result } = renderHook(() => useFeedQuestionService());

      await waitFor(() => expect(result.current[0].question?.text).toBe('What is your shoe size?'));

      expect(calls[0].headers['x-api-key']).toBe('device-key');
      expect(calls[0].headers).not.toHaveProperty('Authorization');
    });

    it('submits an answer with the device key and no bearer', async () => {
      stubApi();

      const { result } = renderHook(() => useFeedQuestionService());
      await waitFor(() => expect(result.current[0].question).not.toBeNull());

      let saved = false;
      await act(async () => {
        saved = await result.current[1].submitAnswer({ questionId: 'q1', text: '43' });
      });

      expect(saved).toBe(true);

      const post = calls.find((call) => call.method === 'POST')!;
      expect(post.url).toContain('/api/answers');
      expect(post.headers['x-api-key']).toBe('device-key');
      expect(post.headers).not.toHaveProperty('Authorization');
    });

    it('asks nothing while the session is not signed in', async () => {
      h.auth.authenticated = false;
      stubApi();

      const { result } = renderHook(() => useFeedQuestionService());

      await waitFor(() => expect(result.current[0].loading).toBe(false));
      expect(result.current[0].question).toBeNull();
      expect(calls).toHaveLength(0);
    });
  });
});
