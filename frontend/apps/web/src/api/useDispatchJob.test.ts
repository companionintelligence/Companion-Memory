import { setApiKey } from '@ci/common';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDispatchJob, steerDispatchJob, useDispatchJob } from './useDispatchJob';

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

const job = { id: 'job-1', threadId: 'thread-1', taskId: null, status: 'running', result: null };

function stubApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: String(input),
        headers: { ...(init?.headers as Record<string, string> | undefined) },
      });

      const url = String(input);
      const body = init?.method === 'POST' || url.includes('/steer') ? job : { job };

      return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(body) } as Response);
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

describe('dispatch jobs on the web', () => {
  it('create and steer carry the bearer', async () => {
    stubApi();

    await createDispatchJob('jwt-abc', { sourceKind: 'Task', sourceId: 't1', title: 'Book the dentist' });
    await steerDispatchJob('jwt-abc', 'job-1', { action: 'halt' });

    expect(calls[0].headers.Authorization).toBe('Bearer jwt-abc');
    expect(calls[1].headers.Authorization).toBe('Bearer jwt-abc');
  });

  it('the status hook loads the job for a thread with the bearer', async () => {
    stubApi();

    const { result } = renderHook(() => useDispatchJob('thread-1', true));

    await waitFor(() => expect(result.current.job?.id).toBe('job-1'));
    expect(calls[0].url).toContain('/api/v1/agent/jobs?threadId=thread-1');
    expect(calls[0].headers.Authorization).toBe('Bearer jwt-abc');
  });
});

/**
 * ═══ DISPATCH NEEDED A WEB JWT THE PHONE NEVER HAS ═══
 *
 * The Capacitor app authenticates with a keystore API key `fetchJson` attaches as `x-api-key`;
 * `authToken` is null there. `create` and `steer` sent `Bearer null` (harmless, but a malformed
 * header), and the status hook returned before asking, so a dispatch thread opened on the phone
 * never showed its job. `/v1/agent/jobs` is `JwtOrApiKeyAuthGuard` with `memory` scope and
 * `write`/`read` capability, which an unscoped device key meets.
 */
describe('dispatch jobs on the native shell (API key, no web JWT)', () => {
  beforeEach(() => {
    h.auth.authToken = null;
    setApiKey('device-key');
  });

  it('create and steer carry the device key and no bearer', async () => {
    stubApi();

    await createDispatchJob(null, { sourceKind: 'Task', sourceId: 't1', title: 'Book the dentist' });
    await steerDispatchJob(null, 'job-1', { action: 'halt' });

    for (const call of calls) {
      expect(call.headers['x-api-key']).toBe('device-key');
      expect(call.headers).not.toHaveProperty('Authorization');
    }
  });

  it('the status hook loads the job for a thread with the device key and no bearer', async () => {
    stubApi();

    const { result } = renderHook(() => useDispatchJob('thread-1', true));

    await waitFor(() => expect(result.current.job?.id).toBe('job-1'));
    expect(calls[0].headers['x-api-key']).toBe('device-key');
    expect(calls[0].headers).not.toHaveProperty('Authorization');
  });

  it('asks nothing while the session is not signed in', async () => {
    h.auth.authenticated = false;
    stubApi();

    const { result } = renderHook(() => useDispatchJob('thread-1', true));

    // Give the mount effect a chance to run before asserting that it asked nothing.
    await waitFor(() => expect(result.current.job).toBeNull());
    expect(calls).toHaveLength(0);
  });
});
