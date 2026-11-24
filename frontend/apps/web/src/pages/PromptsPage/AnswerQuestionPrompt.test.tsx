import { setApiKey } from '@ci/common';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnswerQuestionPrompt } from './AnswerQuestionPrompt';

// The real `useSessionAuth` runs on top of this: the prompt has to behave the same for
// a web JWT session and for the native shell, whose only credential is an API key.
const h = vi.hoisted(() => ({
  auth: { authToken: 'test-token' as string | null, authenticated: true, expired: false },
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => [h.auth, {}] }));

function jsonResponse(body: unknown, status = 200) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The headers a stubbed `fetch` call went out with, as a plain object. */
function headersOf(init: RequestInit | undefined): Record<string, string> {
  return { ...(init?.headers as Record<string, string> | undefined) };
}

beforeEach(() => {
  h.auth.authToken = 'test-token';
  h.auth.authenticated = true;
  h.auth.expired = false;
});

afterEach(() => {
  setApiKey(null);
  vi.unstubAllGlobals();
});

/**
 * `findOneUnanswered` deterministically hands back the front of the queue
 * every time. "Skip" used to only set local `dismissed` state and unmount the
 * card — nothing told the server, so the identical question was back on the
 * next reload. It now calls `POST /questions/unanswered/skip` (moving the row
 * to the back) before refetching, so the follow-up GET can return something
 * different.
 */
describe('AnswerQuestionPrompt — Skip', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('tells the server to skip the current presentation, then asks for another', async () => {
    const calls: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url}`);

        if (url.endsWith('/questions/unanswered/skip')) {
          expect(JSON.parse(String(init?.body))).toEqual({ presentationId: 'fq-1' });

          return Promise.resolve(jsonResponse(null, 204));
        }

        // First GET returns the question with its presentationId; the GET
        // that follows the skip returns a different one, proving the round
        // trip actually changed something rather than looping on the same row.
        const alreadySkipped = calls.filter((c) => c.includes('/skip')).length > 0;

        return Promise.resolve(
          jsonResponse(
            alreadySkipped
              ? { id: 'q2', text: 'A different question', presentationId: 'fq-2' }
              : { id: 'q1', text: 'The first question', presentationId: 'fq-1' },
          ),
        );
      }),
    );

    render(<AnswerQuestionPrompt />);

    expect(await screen.findByText('The first question')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /skip/i }));

    await waitFor(() => expect(screen.getByText('A different question')).toBeInTheDocument());
    expect(calls.some((c) => c.startsWith('POST') && c.includes('/questions/unanswered/skip'))).toBe(true);
  });
});

/**
 * ═══ THE PROMPT CARD SPUN FOREVER ON THE PHONE ═══
 *
 * `authToken` is the web JWT, which is null in the Capacitor app: the phone's
 * durable credential is a keystore API key. The card returned before it
 * fetched, and `fetchingQuestion` starts true — so "Loading reflection…" never
 * went away. `GET /questions/unanswered` is `JwtOrApiKeyAuthGuard`, so the key
 * is a credential the server already takes.
 */
describe('AnswerQuestionPrompt — native shell (API key, no web JWT)', () => {
  beforeEach(() => {
    h.auth.authToken = null;
    setApiKey('device-key');
  });

  it('loads the question with the device key and no bearer', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ id: 'q1', text: 'What is your shoe size?', presentationId: 'fq-1' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<AnswerQuestionPrompt />);

    expect(await screen.findByText('What is your shoe size?')).toBeInTheDocument();
    expect(screen.queryByText('Loading reflection...')).not.toBeInTheDocument();

    const init = (fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>)[0][1];
    expect(headersOf(init)['x-api-key']).toBe('device-key');
    expect(headersOf(init)).not.toHaveProperty('Authorization');
  });

  it('submits an answer with the device key and no bearer', async () => {
    const calls: Array<{ method: string; url: string; headers: Record<string, string> }> = [];

    // The first GET hands back a question; the refetch after the answer finds none left.
    let served = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ method: init?.method ?? 'GET', url: String(input), headers: headersOf(init) });

        if (init?.method === 'POST') {
          return Promise.resolve(jsonResponse({ id: 'a1' }, 201));
        }

        if (!served) {
          served = true;

          return Promise.resolve(jsonResponse({ id: 'q1', text: 'What is your shoe size?' }));
        }

        return Promise.resolve(jsonResponse(null, 204));
      }),
    );

    render(<AnswerQuestionPrompt />);

    await screen.findByText('What is your shoe size?');
    fireEvent.change(screen.getByPlaceholderText('Enter your answer...'), { target: { value: '43' } });
    fireEvent.click(screen.getByRole('button', { name: /submit answer/i }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));

    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toContain('/api/answers');
    expect(post.headers['x-api-key']).toBe('device-key');
    expect(post.headers).not.toHaveProperty('Authorization');
  });

  it('still sends the bearer on the web, where there is a JWT', async () => {
    h.auth.authToken = 'jwt-abc';
    setApiKey(null);

    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ id: 'q1', text: 'A web question' })));
    vi.stubGlobal('fetch', fetchMock);

    render(<AnswerQuestionPrompt />);

    expect(await screen.findByText('A web question')).toBeInTheDocument();

    const init = (fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>)[0][1];
    expect(headersOf(init).Authorization).toBe('Bearer jwt-abc');
  });
});
