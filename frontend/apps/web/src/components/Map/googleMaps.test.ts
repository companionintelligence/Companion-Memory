import { setApiKey } from '@ci/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetGoogleMapsKeyForTests, resolveGoogleMapsApiKey } from './googleMaps';

const webSession = { ready: true, headers: { Authorization: 'Bearer jwt-abc' } };
// The native shell: signed in by a device API key, so there is no bearer to send.
const nativeSession = { ready: true, headers: {} };
const signedOut = { ready: false, headers: {} };

// A real Response: the lookup may read the body as text or as JSON.
const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function setFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  );
  vi.stubGlobal('fetch', mock);

  return mock;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  resetGoogleMapsKeyForTests();
});

afterEach(() => {
  setApiKey(null);
  globalThis.fetch = realFetch;
});

describe('resolveGoogleMapsApiKey', () => {
  it('asks the server with the session headers, trims the key, and remembers it', async () => {
    const fetchMock = setFetch(() => ok({ configured: true, apiKey: '  maps-key  ' }));

    await expect(resolveGoogleMapsApiKey(webSession)).resolves.toBe('maps-key');
    await expect(resolveGoogleMapsApiKey(webSession)).resolves.toBe('maps-key');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer jwt-abc',
    });
  });

  it('asks with the device key alone on the native shell', async () => {
    setApiKey('device-key');
    const fetchMock = setFetch(() => ok({ configured: true, apiKey: 'maps-key' }));

    await expect(resolveGoogleMapsApiKey(nativeSession)).resolves.toBe('maps-key');

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('device-key');
    expect(headers).not.toHaveProperty('Authorization');
  });

  it('shares one in-flight lookup between callers that arrive together', async () => {
    const fetchMock = setFetch(() => ok({ configured: true, apiKey: 'maps-key' }));

    const [first, second] = await Promise.all([
      resolveGoogleMapsApiKey(webSession),
      resolveGoogleMapsApiKey(webSession),
    ]);

    expect(first).toBe('maps-key');
    expect(second).toBe('maps-key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends nothing for a session that is not signed in', async () => {
    const fetchMock = setFetch(() => ok({ configured: true, apiKey: 'maps-key' }));

    await expect(resolveGoogleMapsApiKey(signedOut)).resolves.toBeNull();
    await expect(resolveGoogleMapsApiKey(null)).resolves.toBeNull();
    await expect(resolveGoogleMapsApiKey()).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is null when the server says no key is configured', async () => {
    setFetch(() => ok({ configured: false }));

    await expect(resolveGoogleMapsApiKey(webSession)).resolves.toBeNull();
  });

  it('is null, not a throw, when the request fails — and asks again next time', async () => {
    const fetchMock = setFetch(() => new Response('', { status: 500, statusText: 'Server Error' }));

    await expect(resolveGoogleMapsApiKey(webSession)).resolves.toBeNull();

    fetchMock.mockImplementation(() => Promise.resolve(ok({ configured: true, apiKey: 'maps-key' })));

    await expect(resolveGoogleMapsApiKey(webSession)).resolves.toBe('maps-key');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
