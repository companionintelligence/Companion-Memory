import {
  clearMemorySignInEnded,
  fetchJson,
  FetchJsonError,
  flushOutbox,
  memorySignInEnded,
  setApiBaseUrl,
  setApiKey,
} from '@ci/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A phone signed in with a key Memory no longer takes (revoked, or lost when Memory was restored from
 * an older backup). Through a Hub, every request was turned away to the Hub's sign-in page, which the
 * app read as JSON ("invalid JSON"), and queued captures kept spending their attempts. These pin what
 * happens now: the page never reaches a caller, Memory is asked once whether the key still works, and
 * only its answer ends the sign-in, which stops the outbox without touching what is queued.
 */

const MEMORY = 'https://memory.example.com';
const HUB_SIGN_IN = 'https://hub.example.com/sso?redirect=https%3A%2F%2Fmemory.example.com%2Fapi%2Fgraphql';
const KEY = 'a'.repeat(64);

type NativeAnswer = { status: number; data?: unknown; headers?: Record<string, string>; url?: string };

/** A phone whose CapacitorHttp answers with `answer(url, options)`. */
function phone(answer: (url: string, options: { headers?: Record<string, string> }) => NativeAnswer) {
  const request = vi.fn(async (options: { url: string; headers?: Record<string, string> }) =>
    answer(options.url, options),
  );

  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    Plugins: { CapacitorHttp: { request } },
  };

  return request;
}

const signInPage = (): NativeAnswer => ({
  status: 200,
  data: '<!doctype html><title>Sign in</title>',
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
  url: HUB_SIGN_IN,
});

/** Each test starts past the previous one's 30 s gap between checks. */
let clock = Date.parse('2026-11-27T20:00:00Z');

beforeEach(() => {
  clock += 60_000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  setApiBaseUrl(MEMORY);
  setApiKey(KEY);
  clearMemorySignInEnded();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setApiBaseUrl('');
  setApiKey(null);
  clearMemorySignInEnded();
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

/** Let the background check Memory is asked settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a request turned away to a sign-in page', () => {
  it('reaches the caller as a 401 saying the sign-in ended, never as the page read as JSON', async () => {
    phone((url) => (url.endsWith('/api/keys/check') ? { status: 204 } : signInPage()));

    const error = await fetchJson('/api/graphql', { method: 'POST', body: '{}' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FetchJsonError);
    expect((error as FetchJsonError).status).toBe(401);
    expect((error as FetchJsonError).message).toContain('MEMORY_SIGN_IN_ENDED');
  });

  it('counts a web page from Memory’s own API as the same, redirect or not', async () => {
    phone((url) =>
      url.endsWith('/api/keys/check')
        ? { status: 204 }
        : { status: 200, data: '<html></html>', headers: { 'Content-Type': 'text/html' } },
    );

    await expect(fetchJson('/api/llm/models')).rejects.toMatchObject({ status: 401 });
  });

  it('passes a JSON answer through untouched', async () => {
    phone(() => ({ status: 200, data: { ok: true }, headers: { 'Content-Type': 'application/json' } }));

    await expect(fetchJson('/api/llm/models')).resolves.toEqual({ ok: true });
    await settle();
    expect(memorySignInEnded()).toBe(false);
  });
});

describe('ending the sign-in', () => {
  it('only once Memory itself refuses the key', async () => {
    const request = phone((url) => (url.endsWith('/api/keys/check') ? { status: 401 } : signInPage()));

    await fetchJson('/api/graphql', { method: 'POST', body: '{}' }).catch(() => undefined);
    await settle();

    expect(memorySignInEnded()).toBe(true);
    const check = request.mock.calls.find(([options]) => options.url === `${MEMORY}/api/keys/check`);
    expect(check?.[0].headers).toMatchObject({ 'x-api-key': KEY });
  });

  it('also when the check itself is turned away to the sign-in page', async () => {
    phone(() => signInPage());

    await fetchJson('/api/graphql', { method: 'POST', body: '{}' }).catch(() => undefined);
    await settle();

    expect(memorySignInEnded()).toBe(true);
  });

  it('not when Memory says the key still works: one refusal proves nothing about the key', async () => {
    phone((url) =>
      url.endsWith('/api/keys/check')
        ? { status: 204 }
        : { status: 401, data: { message: 'REAUTH_REQUIRED' } },
    );

    await fetchJson('/api/account/password', { method: 'POST', body: '{}' }).catch(() => undefined);
    await settle();

    expect(memorySignInEnded()).toBe(false);
  });

  it('not when Memory cannot be asked, which says nothing about the key', async () => {
    phone((url) => {
      if (url.endsWith('/api/keys/check')) {
        throw new Error('The network connection was lost.');
      }

      return { status: 401 };
    });

    await fetchJson('/api/graphql', { method: 'POST', body: '{}' }).catch(() => undefined);
    await settle();

    expect(memorySignInEnded()).toBe(false);
  });

  it('not for a request that carried no device key (a web session, or signing in)', async () => {
    setApiKey(null);
    const request = phone(() => signInPage());

    await fetchJson('/api/graphql', { method: 'POST', body: '{}' }).catch(() => undefined);
    await settle();

    expect(memorySignInEnded()).toBe(false);
    expect(request.mock.calls.some(([options]) => options.url.endsWith('/api/keys/check'))).toBe(false);
  });

  it('asks Memory once for a burst of refusals', async () => {
    const request = phone((url) => (url.endsWith('/api/keys/check') ? { status: 204 } : { status: 401 }));

    await Promise.all(
      [1, 2, 3, 4].map(() =>
        fetchJson('/api/graphql', { method: 'POST', body: '{}' }).catch(() => undefined),
      ),
    );
    await settle();

    expect(request.mock.calls.filter(([options]) => options.url.endsWith('/api/keys/check'))).toHaveLength(1);
  });
});

describe('the outbox while the sign-in has ended', () => {
  it('does not drain: nothing queued is read, sent or marked', async () => {
    phone(() => signInPage());
    await fetchJson('/api/graphql', { method: 'POST', body: '{}' }).catch(() => undefined);
    await settle();
    expect(memorySignInEnded()).toBe(true);

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const before = (
      window as unknown as {
        Capacitor: { Plugins: { CapacitorHttp: { request: ReturnType<typeof vi.fn> } } };
      }
    ).Capacitor.Plugins.CapacitorHttp.request.mock.calls.length;

    const summary = await flushOutbox();

    expect(summary).toMatchObject({ attempted: 0, failed: 0, succeeded: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      (
        window as unknown as {
          Capacitor: { Plugins: { CapacitorHttp: { request: ReturnType<typeof vi.fn> } } };
        }
      ).Capacitor.Plugins.CapacitorHttp.request.mock.calls.length,
    ).toBe(before);
  });
});
