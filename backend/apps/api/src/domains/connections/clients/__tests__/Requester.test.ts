import { Requester, RequesterTimeoutError, RequesterTransportError } from '../Requester';

type FetchMock = jest.Mock<Promise<Response>, [string | URL | Request, RequestInit?]>;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  });
}

describe('Requester', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('issues a GET and parses JSON by content-type', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    const requester = new Requester();
    const response = await requester.request({ method: 'GET', url: 'https://api.example.com/users' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(response.headers['content-type']).toContain('application/json');
    expect(typeof response.durationMs).toBe('number');
  });

  it('sorts query parameters deterministically', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    const requester = new Requester();

    await requester.request({
      method: 'GET',
      url: 'https://api.example.com/search',
      query: { z: '1', a: '2', m: ['c', 'a', 'b'] },
    });

    const [calledUrl] = fetchMock.mock.calls[0];

    expect(String(calledUrl)).toBe('https://api.example.com/search?a=2&m=a&m=b&m=c&z=1');
  });

  it('serializes object bodies as JSON', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    const requester = new Requester();

    await requester.request({
      method: 'POST',
      url: 'https://api.example.com/create',
      body: { name: 'x' },
    });

    const [, init] = fetchMock.mock.calls[0];

    expect(init?.body).toBe('{"name":"x"}');
  });

  it('returns non-2xx responses without throwing', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } }),
    );

    const requester = new Requester();
    const response = await requester.request({ method: 'GET', url: 'https://api.example.com/missing' });

    expect(response.status).toBe(404);
    expect(response.body).toBe('nope');
  });

  it('wraps transport failures as RequesterTransportError', async () => {
    const cause = new Error('ENETDOWN');

    fetchMock.mockRejectedValueOnce(cause);

    const requester = new Requester();

    await expect(
      requester.request({ method: 'GET', url: 'https://api.example.com/x' }),
    ).rejects.toBeInstanceOf(RequesterTransportError);
  });

  it('deduplicates concurrent identical requests', async () => {
    let resolveFetch: ((r: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });

    fetchMock.mockReturnValueOnce(pending);

    const requester = new Requester();
    const a = requester.request({ method: 'GET', url: 'https://api.example.com/u', query: { id: '1' } });
    const b = requester.request({ method: 'GET', url: 'https://api.example.com/u', query: { id: '1' } });

    resolveFetch!(jsonResponse({ id: 1 }));

    const [resA, resB] = await Promise.all([a, b]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resA).toBe(resB);
  });

  it('does not dedup requests with different auth identities', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}));

    const requester = new Requester();

    await Promise.all([
      requester.request({ method: 'GET', url: 'https://api.example.com/me', authIdentity: 'user-a' }),
      requester.request({ method: 'GET', url: 'https://api.example.com/me', authIdentity: 'user-b' }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts a hung request with RequesterTimeoutError once the deadline passes', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );

    const requester = new Requester({ timeoutMs: 20 });
    const promise = requester.request({ method: 'GET', url: 'https://api.example.com/slow' });

    await expect(promise).rejects.toBeInstanceOf(RequesterTimeoutError);
    await expect(promise).rejects.toBeInstanceOf(RequesterTransportError);
  });

  it('passes an abort signal to fetch', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    const requester = new Requester();

    await requester.request({ method: 'GET', url: 'https://api.example.com/x' });

    const [, init] = fetchMock.mock.calls[0];

    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not dedup requests with different bodies', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}));

    const requester = new Requester();

    await Promise.all([
      requester.request({ method: 'POST', url: 'https://api.example.com/x', body: { a: 1 } }),
      requester.request({ method: 'POST', url: 'https://api.example.com/x', body: { a: 2 } }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
