import {
  apiFetch,
  apiKeyHeaders,
  deviceAccessTokensActive,
  deviceKeyId,
  deviceOwnerStamp,
  ensureFreshDeviceAccessToken,
  fetchJson,
  getApiKey,
  onDeviceKeyRevoked,
  outboxOwnerStamp,
  refreshDeviceAccessToken,
  setApiKey,
  startDeviceAccessTokens,
  stopDeviceAccessTokens,
  streamingFetch,
  type DeviceAccessTokenResult,
} from '@ci/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The page side of the device access tokens (`@ci/common`'s `apiAuth.ts`): the phone and desktop
 * apps' native side keeps the key and hands out short-lived tokens, and the page keeps one fresh,
 * keeps the sign-in through an outage, reports a key Memory refused, and sends a request again
 * once when its token was refused.
 */

const MINUTE = 60_000;

function ok(token: string, expiresInMs = 5 * MINUTE): DeviceAccessTokenResult {
  return {
    status: 'ok',
    token,
    expiresAt: Date.now() + expiresInMs,
    keyId: 'key-1',
    ownerStamp: 'https://memory.example.com stamp:key',
  };
}

const unreachable: DeviceAccessTokenResult = {
  status: 'unreachable',
  token: null,
  expiresAt: null,
  keyId: 'key-1',
  ownerStamp: 'https://memory.example.com stamp:key',
};

/** A native side that answers from `answers` in turn (the last one again once they run out). */
function nativeSide(...answers: DeviceAccessTokenResult[]) {
  let next = 0;

  return vi.fn(async (_options: { refresh: boolean }) => {
    const answer = answers[Math.min(next, answers.length - 1)];

    next += 1;

    return { ...answer };
  });
}

/** Lets the timers and the promises they start run. */
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

let clock = Date.UTC(2026, 10, 27, 12);

beforeEach(() => {
  // A fresh hour each test, so the forced-refresh spacing of the one before never carries over.
  clock += 3_600_000;
  vi.useFakeTimers({ now: clock });
});

afterEach(() => {
  stopDeviceAccessTokens();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('device access tokens: keeping one fresh', () => {
  it('sends the token it was handed, never anything else, and asks again a minute before it expires', async () => {
    const source = nativeSide(ok('token-1'), ok('token-2'));

    const first = await startDeviceAccessTokens(source);

    expect(first.status).toBe('ok');
    expect(getApiKey()).toBe('token-1');
    expect(apiKeyHeaders()).toEqual({ 'x-api-key': 'token-1' });
    expect(deviceAccessTokensActive()).toBe(true);
    expect(deviceKeyId()).toBe('key-1');
    expect(deviceOwnerStamp()).toBe('https://memory.example.com stamp:key');

    await advance(4 * MINUTE - 1_000);
    expect(source).toHaveBeenCalledTimes(1);

    await advance(2_000);
    expect(source).toHaveBeenCalledTimes(2);
    expect(source).toHaveBeenLastCalledWith({ refresh: false });
    expect(getApiKey()).toBe('token-2');
  });

  it('stays signed in while Memory cannot be reached, asking again less and less often', async () => {
    const source = nativeSide(unreachable);

    await startDeviceAccessTokens(source);

    expect(getApiKey()).toBeNull();
    expect(deviceKeyId()).toBe('key-1');
    expect(deviceOwnerStamp()).toBe('https://memory.example.com stamp:key');

    await advance(15_000);
    expect(source).toHaveBeenCalledTimes(2);
    await advance(15_000);
    expect(source).toHaveBeenCalledTimes(2);
    await advance(15_000);
    expect(source).toHaveBeenCalledTimes(3);
  });

  it('keeps a token that has not expired yet while Memory cannot be reached', async () => {
    const source = nativeSide(ok('token-1'), unreachable);

    await startDeviceAccessTokens(source);
    await advance(4 * MINUTE + 1_000);

    expect(source).toHaveBeenCalledTimes(2);
    expect(getApiKey()).toBe('token-1');

    // Once it has expired there is nothing to send, still signed in.
    await advance(2 * MINUTE);
    expect(getApiKey()).toBeNull();
    expect(deviceKeyId()).toBe('key-1');
  });

  it('a native side that rejects reads as Memory not answering', async () => {
    const source = vi.fn(async () => {
      throw new Error('bridge gone');
    });

    const first = await startDeviceAccessTokens(source);

    expect(first.status).toBe('unreachable');
    expect(getApiKey()).toBeNull();
    expect(deviceAccessTokensActive()).toBe(true);
  });

  it('reports a key Memory refused, with its id, and sends nothing', async () => {
    const revoked = vi.fn();
    const stop = onDeviceKeyRevoked(revoked);
    const source = nativeSide(ok('token-1'), { ...unreachable, status: 'revoked' });

    try {
      await startDeviceAccessTokens(source);
      await advance(4 * MINUTE + 1_000);

      expect(revoked).toHaveBeenCalledWith('key-1');
      expect(getApiKey()).toBeNull();

      // Nothing more is asked about a refused key.
      await advance(30 * MINUTE);
      expect(source).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it('sends a key the native side could not trade (a Memory from before tokens) and asks again later', async () => {
    const source = nativeSide({ ...unreachable, status: 'legacy', token: 'the-key' });

    await startDeviceAccessTokens(source);

    expect(getApiKey()).toBe('the-key');
    await advance(29 * MINUTE);
    expect(source).toHaveBeenCalledTimes(1);
    await advance(2 * MINUTE);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('stop forgets everything, and an answer to the stopped session is dropped', async () => {
    let answer: (result: DeviceAccessTokenResult) => void = () => {};

    const source = vi.fn(
      () =>
        new Promise<DeviceAccessTokenResult>((resolve) => {
          answer = resolve;
        }),
    );

    const started = startDeviceAccessTokens(source);
    stopDeviceAccessTokens();
    answer(ok('late-token'));
    await started;

    expect(getApiKey()).toBeNull();
    expect(deviceAccessTokensActive()).toBe(false);
    expect(deviceKeyId()).toBeNull();
    expect(deviceOwnerStamp()).toBeNull();
  });

  it('setApiKey(null) stops the tokens too', async () => {
    await startDeviceAccessTokens(nativeSide(ok('token-1')));

    setApiKey(null);

    expect(deviceAccessTokensActive()).toBe(false);
    expect(getApiKey()).toBeNull();
  });

  it('coming back into view asks only when the token is about to run out', async () => {
    const source = nativeSide(ok('token-1'), ok('token-2'));

    await startDeviceAccessTokens(source);
    ensureFreshDeviceAccessToken();
    expect(source).toHaveBeenCalledTimes(1);

    // Timers did not run while the phone slept: the token is now nearly gone.
    vi.setSystemTime(Date.now() + 4.5 * MINUTE);
    ensureFreshDeviceAccessToken();
    await advance(0);

    expect(source).toHaveBeenCalledTimes(2);
    expect(getApiKey()).toBe('token-2');
  });
});

describe('device access tokens: a token Memory refused', () => {
  it('asks the native side once for a burst of refusals, and hands back the new token', async () => {
    const source = nativeSide(ok('token-1'), ok('token-2'));

    await startDeviceAccessTokens(source);
    const [a, b] = await Promise.all([
      refreshDeviceAccessToken('token-1'),
      refreshDeviceAccessToken('token-1'),
    ]);

    expect(a).toBe('token-2');
    expect(b).toBe('token-2');
    expect(source).toHaveBeenCalledTimes(2);
    expect(source).toHaveBeenLastCalledWith({ refresh: true });
  });

  it('hands back a newer token without asking when one already came', async () => {
    const source = nativeSide(ok('token-1'));

    await startDeviceAccessTokens(source);

    await expect(refreshDeviceAccessToken('an-older-token')).resolves.toBe('token-1');
    expect(source).toHaveBeenCalledTimes(1);
  });

  it('gives up when the native side has nothing new, and does not ask again within ten seconds', async () => {
    const source = nativeSide(ok('token-1'), ok('token-1'), ok('token-2'));

    await startDeviceAccessTokens(source);

    await expect(refreshDeviceAccessToken('token-1')).resolves.toBeNull();
    await expect(refreshDeviceAccessToken('token-1')).resolves.toBeNull();
    expect(source).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + 11_000);
    await expect(refreshDeviceAccessToken('token-1')).resolves.toBe('token-2');
  });

  it('has nothing to retry with when no tokens are running', async () => {
    setApiKey('typed-in-key');

    await expect(refreshDeviceAccessToken('typed-in-key')).resolves.toBeNull();
  });
});

describe('requests sent again once with a new token after a 401', () => {
  function refusingFirst(body: unknown = { ok: true }) {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const key = (init?.headers as Record<string, string> | undefined)?.['x-api-key'];

      return key === 'token-2'
        ? new Response(JSON.stringify(body), { status: 200 })
        : new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
    });

    vi.stubGlobal('fetch', fetchMock);

    return fetchMock;
  }

  const keysSent = (fetchMock: ReturnType<typeof refusingFirst>) =>
    fetchMock.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string> | undefined)?.['x-api-key'],
    );

  it('fetchJson', async () => {
    await startDeviceAccessTokens(nativeSide(ok('token-1'), ok('token-2')));
    const fetchMock = refusingFirst({ id: 'me' });

    await expect(fetchJson('/api/users/me', { method: 'POST', body: '{"a":1}' })).resolves.toEqual({
      id: 'me',
    });
    expect(keysSent(fetchMock)).toEqual(['token-1', 'token-2']);
    // The same request, body and all.
    expect(fetchMock.mock.calls[1][1]?.body).toBe('{"a":1}');
  });

  it('apiFetch (Apollo)', async () => {
    await startDeviceAccessTokens(nativeSide(ok('token-1'), ok('token-2')));
    const fetchMock = refusingFirst();

    const response = await apiFetch('/api/graphql', {
      method: 'POST',
      headers: { 'x-api-key': getApiKey() ?? '' },
      body: '{"query":"{ me { id } }"}',
    });

    expect(response.status).toBe(200);
    expect(keysSent(fetchMock)).toEqual(['token-1', 'token-2']);
  });

  it('streamingFetch (chat)', async () => {
    await startDeviceAccessTokens(nativeSide(ok('token-1'), ok('token-2')));
    const fetchMock = refusingFirst();

    const response = await streamingFetch('/api/llm/generate', { method: 'POST', body: '{}' });

    expect(response.status).toBe(200);
    expect(keysSent(fetchMock)).toEqual(['token-1', 'token-2']);
  });

  it('not for a body that cannot be sent twice', async () => {
    await startDeviceAccessTokens(nativeSide(ok('token-1'), ok('token-2')));
    const fetchMock = refusingFirst();
    const form = new FormData();
    form.append('file', new Blob(['x']), 'x.txt');

    const response = await apiFetch('/api/files/upload', {
      method: 'POST',
      headers: { 'x-api-key': 'token-1' },
      body: form,
    });

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('not when the caller gave up on the request', async () => {
    await startDeviceAccessTokens(nativeSide(ok('token-1'), ok('token-2')));
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();

      return new Response('{}', { status: 401 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await apiFetch('/api/graphql', {
      method: 'POST',
      headers: { 'x-api-key': 'token-1' },
      body: '{}',
      signal: controller.signal,
    });

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('not when no tokens are running', async () => {
    setApiKey('typed-in-key');
    const fetchMock = refusingFirst();

    await expect(fetchJson('/api/users/me')).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('not twice: a second 401 is the answer', async () => {
    await startDeviceAccessTokens(nativeSide(ok('token-1'), ok('token-3')));
    const fetchMock = refusingFirst();

    await expect(fetchJson('/api/users/me')).rejects.toMatchObject({ status: 401 });
    expect(keysSent(fetchMock)).toEqual(['token-1', 'token-3']);
  });
});

describe('the outbox owner stamp while tokens are running', () => {
  it("is the native side's stamp for the key, not anything computed from the token", async () => {
    await startDeviceAccessTokens(nativeSide(ok('token-1')));

    expect(outboxOwnerStamp()).toBe('https://memory.example.com stamp:key');
  });

  it('stays the same when the token changes, so queued captures keep their owner', async () => {
    const source = nativeSide(ok('token-1'), ok('token-2'));

    await startDeviceAccessTokens(source);
    const before = outboxOwnerStamp();
    await advance(4 * MINUTE + 1_000);

    expect(getApiKey()).toBe('token-2');
    expect(outboxOwnerStamp()).toBe(before);
  });

  it('is computed from the key, as before, when the native side gives none (a shell from before tokens)', async () => {
    await startDeviceAccessTokens(
      nativeSide({ status: 'legacy', token: 'the-key', expiresAt: null, keyId: null, ownerStamp: null }),
    );

    expect(outboxOwnerStamp()).toMatch(/^same-origin [0-9a-f]{14}$/);
  });
});
