import { setApiKey } from '@ci/common/src/utils/apiAuth';
import { setApiBaseUrl } from '@ci/common/src/utils/apiBase';
import { apiFetch, fetchJson, streamingFetch } from '@ci/common/src/utils/fetchJson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function stubFetch(body: unknown = {}) {
  const fetchMock = vi.fn(
    async (): Promise<Response> =>
      ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify(body),
      }) as unknown as Response,
  );

  vi.stubGlobal('fetch', fetchMock);

  return fetchMock;
}

// The mock's recorded args are untyped; read (input, init) via a cast.
function callArgs(mock: ReturnType<typeof stubFetch>, index = 0): [RequestInfo, RequestInit | undefined] {
  return mock.mock.calls[index] as unknown as [RequestInfo, RequestInit | undefined];
}

describe('fetchJson — base URL resolution', () => {
  beforeEach(() => {
    setApiBaseUrl('');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setApiBaseUrl('');
  });

  it('keeps relative paths same-origin when no base is configured', async () => {
    const fetchMock = stubFetch();

    await fetchJson('/api/x');

    expect(fetchMock).toHaveBeenCalledWith('/api/x', expect.any(Object));
  });

  it('resolves relative paths against the configured origin', async () => {
    setApiBaseUrl('https://ci.example.com');
    const fetchMock = stubFetch();

    await fetchJson('/api/x');

    expect(fetchMock).toHaveBeenCalledWith('https://ci.example.com/api/x', expect.any(Object));
  });

  it('passes a non-string RequestInfo through untouched', async () => {
    setApiBaseUrl('https://ci.example.com');
    const fetchMock = stubFetch();
    const request = { url: 'preconstructed' } as unknown as Request;

    await fetchJson(request);

    expect(fetchMock).toHaveBeenCalledWith(request, expect.any(Object));
  });

  it('parses and returns the JSON body', async () => {
    stubFetch({ hello: 'world' });

    const data = await fetchJson<{ hello: string }>('/api/x');

    expect(data).toEqual({ hello: 'world' });
  });
});

describe('fetchJson — native API key injection', () => {
  beforeEach(() => {
    setApiBaseUrl('');
    setApiKey(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setApiBaseUrl('');
    setApiKey(null);
  });

  it('adds no x-api-key header when no key is set (web)', async () => {
    const fetchMock = stubFetch();

    await fetchJson('/api/x', { headers: { 'Content-Type': 'application/json' } });

    expect(callArgs(fetchMock)[1]?.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('injects x-api-key into request headers when a key is set (native)', async () => {
    setApiKey('key-123');
    const fetchMock = stubFetch();

    await fetchJson('/api/x', { headers: { 'Content-Type': 'application/json' } });

    expect(callArgs(fetchMock)[1]?.headers).toEqual({
      'x-api-key': 'key-123',
      'Content-Type': 'application/json',
    });
  });
});

describe('fetchJson — native CapacitorHttp', () => {
  beforeEach(() => {
    setApiBaseUrl('');
    setApiKey(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setApiBaseUrl('');
    setApiKey(null);
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it('uses CapacitorHttp instead of fetch inside the native shell', async () => {
    const fetchMock = stubFetch();
    const request = vi.fn(async () => ({ status: 200, data: { ok: true } }));

    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { CapacitorHttp: { request } },
    };

    setApiBaseUrl('https://memory.example.com');
    const data = await fetchJson<{ ok: boolean }>('/api/authenticate/oidc/native/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'otc-1' }),
    });

    expect(data).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://memory.example.com/api/authenticate/oidc/native/exchange',
        method: 'POST',
        data: { code: 'otc-1' },
      }),
    );
  });

  it('apiFetch sends GraphQL through CapacitorHttp against the live origin', async () => {
    const fetchMock = stubFetch();
    const request = vi.fn(async () => ({ status: 200, data: { data: { me: { id: 'u1' } } } }));

    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { CapacitorHttp: { request } },
    };

    setApiBaseUrl('https://memory.example.com');
    const res = await apiFetch('https://memory.example.com/api/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ me { id } }' }),
    });

    expect(res.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://memory.example.com/api/graphql',
        method: 'POST',
      }),
    );
  });

  it('refuses to send a relative path through CapacitorHttp (iOS "unsupported URL")', async () => {
    const fetchMock = stubFetch();
    const request = vi.fn(async () => ({ status: 200, data: {} }));

    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { CapacitorHttp: { request } },
    };

    await expect(fetchJson('/api/keys')).rejects.toThrow(/absolute http/i);
    expect(request).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rewrites CapacitorHttp "unsupported URL" to include the request URL', async () => {
    stubFetch();
    const request = vi.fn(async () => {
      throw new Error('unsupported URL');
    });

    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { CapacitorHttp: { request } },
    };

    await expect(fetchJson('https://memory.example.com/api/health')).rejects.toThrow(
      /Could not request https:\/\/memory\.example\.com\/api\/health/i,
    );
  });

  it('falls back to fetch when CapacitorHttp is missing', async () => {
    const fetchMock = stubFetch();

    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {},
    };

    await fetchJson('/api/x');

    expect(fetchMock).toHaveBeenCalled();
  });

  it('sends FormData through fetch so multipart keeps its boundary', async () => {
    const fetchMock = stubFetch();
    const request = vi.fn(async () => ({ status: 200, data: [] }));

    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { CapacitorHttp: { request } },
    };

    const body = new FormData();
    body.append('files', new File(['a'], 'a.jpg', { type: 'image/jpeg' }));

    await fetchJson('/api/files/upload', { method: 'POST', body });

    expect(request).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
    expect(callArgs(fetchMock)[1]?.body).toBe(body);
  });
});

describe('streamingFetch', () => {
  beforeEach(() => {
    setApiBaseUrl('');
    setApiKey(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setApiBaseUrl('');
    setApiKey(null);
    delete (window as unknown as { Capacitor?: unknown; __ciUnpatchedFetch?: unknown }).Capacitor;
    delete (window as unknown as { __ciUnpatchedFetch?: unknown }).__ciUnpatchedFetch;
  });

  it('uses window.fetch on web and attaches the API key when set', async () => {
    setApiKey('key-123');
    const fetchMock = stubFetch();

    await streamingFetch('/api/llm/generate', { method: 'POST', body: '{}' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/llm/generate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'key-123' }),
      }),
    );
  });

  it('falls back to a binary CapacitorHttp request when the webview fetch fails', async () => {
    const fetchMock = stubFetch();
    const bytes = new Uint8Array([0, 0, 0, 5, 104, 101, 108, 108, 111]);
    const request = vi.fn(async () => ({
      status: 200,
      data: btoa(String.fromCharCode(...bytes)),
      headers: { 'X-Thread-Id': 't-1' },
    }));

    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { CapacitorHttp: { request } },
    };

    setApiBaseUrl('https://memory.example.com');
    (window as unknown as { __ciUnpatchedFetch?: typeof fetch }).__ciUnpatchedFetch = (() =>
      Promise.reject(new TypeError('Load failed'))) as typeof fetch;

    const res = await streamingFetch('/api/llm/generate', { method: 'POST', body: '{}' });

    expect(res.ok).toBe(true);
    expect(res.headers.get('X-Thread-Id')).toBe('t-1');
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://memory.example.com/api/llm/generate',
        responseType: 'arraybuffer',
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual(Array.from(bytes));
  });
});
