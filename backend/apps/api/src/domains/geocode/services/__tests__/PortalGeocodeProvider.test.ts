jest.mock('@ci/configuration', () => {
  const actual = jest.requireActual('@ci/configuration').default;

  return {
    __esModule: true,
    default: {
      ...actual,
      // Trailing slash on purpose: the provider must normalize it away rather
      // than build https://portal.test//api/geocode.
      geocoding: { ...actual.geocoding, provider: 'portal', portalBaseUrl: 'https://portal.test/' },
      ciPortal: { ...actual.ciPortal, apiKey: 'device-key-123' },
    },
  };
});

import config from '@ci/configuration';

import { NON_RETRYABLE_STATUSES, RETRYABLE_STATUSES } from '../GeocodeService';
import { PortalGeocodeProvider } from '../PortalGeocodeProvider';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeProvider() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new PortalGeocodeProvider(makeLogger() as any);
}

interface MockResponseInit {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  /** Force response.json() to reject, as a non-JSON body would. */
  unparseable?: boolean;
}

function mockResponse(body: unknown, init: MockResponseInit = {}) {
  const { ok = true, status = 200, headers = {}, unparseable = false } = init;

  return {
    ok,
    status,
    statusText: 'mock',
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => {
      if (unparseable) {
        throw new SyntaxError('Unexpected token < in JSON');
      }

      return body;
    },
  };
}

type MockResponse = ReturnType<typeof mockResponse>;

/** The subset of RequestInit the provider actually sends. */
interface MockRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

type FetchMock = jest.Mock<Promise<MockResponse>, [string, MockRequestInit]>;

/** Install a fetch mock that replays `responses` in order, repeating the last one. */
function mockFetch(responses: MockResponse[]): FetchMock {
  let call = 0;
  const fn = jest.fn<Promise<MockResponse>, [string, MockRequestInit]>(
    async () => responses[Math.min(call++, responses.length - 1)],
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = fn;

  return fn;
}

/** Install a fetch mock that always rejects, as a dropped connection does. */
function mockFetchReject(message: string): FetchMock {
  const fn = jest.fn<Promise<MockResponse>, [string, MockRequestInit]>(async () => {
    throw new Error(message);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = fn;

  return fn;
}

/** Body of the Nth fetch call, parsed. */
function bodyOf(fetchFn: FetchMock, call = 0): Record<string, unknown> {
  return JSON.parse(fetchFn.mock.calls[call][1].body);
}

function okItem(overrides: Record<string, unknown> = {}) {
  return {
    query: '1600 amphitheatre pkwy',
    cached: false,
    status: 'OK',
    lat: 37.422,
    lng: -122.084,
    normalizedAddress: '1600 Amphitheatre Pkwy, Mountain View, CA 94043',
    placeId: 'place-1',
    locationType: 'ROOFTOP',
    partialMatch: false,
    components: { address_components: [{ a: 1 }] },
    ...overrides,
  };
}

function batchBody(results: unknown[]) {
  return {
    results,
    stats: { total: results.length, unique: results.length, cached: 0, fetched: results.length },
  };
}

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (global as any).fetch;
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe('PortalGeocodeProvider transport', () => {
  it('POSTs a forward query to Portal with the device key and maps the result', async () => {
    const fetchFn = mockFetch([mockResponse(batchBody([okItem()]))]);
    const result = await makeProvider().geocode('  1600 Amphitheatre Pkwy  ');

    // One config value produces the URL, and the trailing slash is normalized.
    expect(fetchFn.mock.calls[0][0]).toBe('https://portal.test/api/geocode');

    const init = fetchFn.mock.calls[0][1];
    expect(init.method).toBe('POST');
    // Portal's deviceAuthMiddleware authenticates on this header alone.
    expect(init.headers['x-device-key']).toBe('device-key-123');
    expect(bodyOf(fetchFn)).toEqual({ queries: ['1600 Amphitheatre Pkwy'] });

    expect(result).toMatchObject({
      status: 'OK',
      lat: 37.422,
      lng: -122.084,
      placeId: 'place-1',
      locationType: 'ROOFTOP',
    });
    expect(result.normalizedAddress).toContain('Amphitheatre');
  });

  it('POSTs a reverse point to the reverse endpoint and returns the resolved name', async () => {
    const fetchFn = mockFetch([
      mockResponse(
        batchBody([okItem({ query: '37.4220,-122.0840', normalizedAddress: 'Mountain View, CA' })]),
      ),
    ]);
    const result = await makeProvider().reverseGeocode(37.422, -122.084);

    expect(fetchFn.mock.calls[0][0]).toBe('https://portal.test/api/geocode/reverse');
    expect(bodyOf(fetchFn)).toEqual({ points: [{ lat: 37.422, lng: -122.084 }] });
    expect(result.status).toBe('OK');
    expect(result.normalizedAddress).toBe('Mountain View, CA');
  });

  it('never sends a request when the base URL is unset, and reports a transient failure', async () => {
    // The provider reads config at construction; clear the URL just for this
    // case so the unconfigured branch runs, then restore.
    const original = config.geocoding.portalBaseUrl;
    config.geocoding.portalBaseUrl = '';
    const fetchFn = mockFetch([mockResponse(batchBody([okItem()]))]);

    try {
      const result = await makeProvider().geocode('anywhere');

      expect(fetchFn).not.toHaveBeenCalled();
      // Missing config is a deployment state that gets fixed — it must not
      // become a cached negative for every address seen in the meantime.
      expect(RETRYABLE_STATUSES.has(result.status)).toBe(true);
    } finally {
      config.geocoding.portalBaseUrl = original;
    }
  });
});

describe('PortalGeocodeProvider batching', () => {
  it('resolves a whole page in one request, index-aligned with the input', async () => {
    const fetchFn = mockFetch([
      mockResponse(
        batchBody([
          okItem({ normalizedAddress: 'first' }),
          { query: 'nope', cached: false, status: 'ZERO_RESULTS' },
          okItem({ normalizedAddress: 'third', lat: 1, lng: 2 }),
        ]),
      ),
    ]);

    const results = await makeProvider().geocodeBatch(['a', 'b', 'c']);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchFn)).toEqual({ queries: ['a', 'b', 'c'] });
    expect(results.map((r) => r.status)).toEqual(['OK', 'ZERO_RESULTS', 'OK']);
    expect(results[2].lat).toBe(1);
  });

  it("splits a page larger than Portal's per-request ceiling into chunks of 100", async () => {
    const addresses = Array.from({ length: 150 }, (_unused, i) => `address ${i}`);
    const fetchFn = jest.fn<Promise<MockResponse>, [string, MockRequestInit]>(async (_url, init) => {
      const { queries } = JSON.parse(init.body) as { queries: string[] };

      return mockResponse(batchBody(queries.map((query) => okItem({ normalizedAddress: query }))));
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = fetchFn;

    const results = await makeProvider().geocodeBatch(addresses);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const sizes = fetchFn.mock.calls
      .map((call) => (JSON.parse(call[1].body) as { queries: string[] }).queries.length)
      .sort((a, b) => b - a);
    expect(sizes).toEqual([100, 50]);
    expect(results).toHaveLength(150);
    // Alignment survives the split.
    expect(results[0].normalizedAddress).toBe('address 0');
    expect(results[149].normalizedAddress).toBe('address 149');
  });

  it('answers locally-invalid items without spending a batch slot on them', async () => {
    const fetchFn = mockFetch([mockResponse(batchBody([okItem(), okItem()]))]);
    const results = await makeProvider().geocodeBatch(['a', '   ', 'x'.repeat(600), 'b']);

    // Only the two real addresses crossed the wire — an oversized string would
    // otherwise 400 the whole request and cost its batch-mates their answers.
    expect(bodyOf(fetchFn)).toEqual({ queries: ['a', 'b'] });
    expect(results.map((r) => r.status)).toEqual(['OK', 'INVALID_REQUEST', 'INVALID_REQUEST', 'OK']);
    // An empty/absurd query is a fact about the input, so a permanent negative
    // is correct here — the opposite of the transport failures below.
    expect(NON_RETRYABLE_STATUSES.has(results[1].status)).toBe(true);
  });

  it('rejects an out-of-range point locally instead of letting it 400 the batch', async () => {
    const fetchFn = mockFetch([mockResponse(batchBody([okItem({ normalizedAddress: 'Somewhere' })]))]);
    const results = await makeProvider().reverseGeocodeBatch([
      { lat: 122.08, lng: 37.42 }, // transposed
      { lat: 37.42, lng: -122.08 },
      { lat: Number.NaN, lng: 0 },
    ]);

    expect(bodyOf(fetchFn)).toEqual({ points: [{ lat: 37.42, lng: -122.08 }] });
    expect(results.map((r) => r.status)).toEqual(['INVALID_REQUEST', 'OK', 'INVALID_REQUEST']);
    expect(results[0].errorMessage).toContain('transposed');
  });
});

describe('PortalGeocodeProvider status mapping', () => {
  it.each(['ZERO_RESULTS', 'REQUEST_DENIED', 'INVALID_REQUEST', 'OVER_QUERY_LIMIT'])(
    'passes %s through verbatim without throwing',
    async (status) => {
      mockFetch([mockResponse(batchBody([{ query: 'q', cached: false, status, errorMessage: 'why' }]))]);
      const result = await makeProvider().geocode('somewhere');

      expect(result.status).toBe(status);
      expect(result.errorMessage).toBe('why');
      expect(result.lat).toBeUndefined();
    },
  );

  it('downgrades an OK that carries no coordinates to a transient, not ZERO_RESULTS', async () => {
    // GeocodeService writes its cache row before it checks for coordinates, so
    // an empty OK would persist as a cached success resolving to nothing.
    mockFetch([mockResponse(batchBody([{ query: 'q', cached: false, status: 'OK' }]))]);
    const result = await makeProvider().geocode('somewhere');

    expect(RETRYABLE_STATUSES.has(result.status)).toBe(true);
    expect(result.errorMessage).toContain('without coordinates');
  });

  it('downgrades a reverse OK that carries no address to a transient', async () => {
    mockFetch([
      mockResponse(batchBody([{ query: '1.0000,2.0000', cached: false, status: 'OK', lat: 1, lng: 2 }])),
    ]);
    const result = await makeProvider().reverseGeocode(1, 2);

    expect(RETRYABLE_STATUSES.has(result.status)).toBe(true);
    expect(result.errorMessage).toContain('without a resolved address');
  });

  it('fills missing slots with a transient when Portal returns a short array', async () => {
    mockFetch([mockResponse(batchBody([okItem()]))]);
    const results = await makeProvider().geocodeBatch(['a', 'b', 'c']);

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe('OK');
    expect(RETRYABLE_STATUSES.has(results[1].status)).toBe(true);
    expect(RETRYABLE_STATUSES.has(results[2].status)).toBe(true);
  });
});

describe('PortalGeocodeProvider transient failures are never cacheable negatives', () => {
  /**
   * The regression these guard: an outage that resolves to ZERO_RESULTS (or to
   * an OK with no coordinates) gets written into ci.geocode_cache, and the
   * backfill's candidate query never revisits a cached row — so a few minutes
   * of downtime silently becomes a permanently unresolvable address.
   */
  function expectUncacheableFailure(result: { status: string; lat?: number; lng?: number }) {
    expect(RETRYABLE_STATUSES.has(result.status)).toBe(true);
    expect(NON_RETRYABLE_STATUSES.has(result.status)).toBe(false);
    expect(result.status).not.toBe('OK');
    expect(result.lat).toBeUndefined();
    expect(result.lng).toBeUndefined();
  }

  it('retries an HTTP 500 and then reports a transient failure', async () => {
    jest.useFakeTimers();
    const fetchFn = mockFetch([mockResponse({}, { ok: false, status: 500 })]);

    const pending = makeProvider().geocode('somewhere');
    await jest.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    // Initial attempt + the two backoff retries.
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expectUncacheableFailure(result);
    expect(result.errorMessage).toBe('HTTP 500');
  });

  it('retries a dropped connection and then reports a transient failure', async () => {
    jest.useFakeTimers();
    const fetchFn = mockFetchReject('socket hang up');

    const pending = makeProvider().geocode('somewhere');
    await jest.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expectUncacheableFailure(result);
    expect(result.errorMessage).toBe('socket hang up');
  });

  it('applies the same treatment to reverse geocoding', async () => {
    jest.useFakeTimers();
    mockFetchReject('ECONNRESET');

    const pending = makeProvider().reverseGeocode(37.42, -122.08);
    await jest.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expectUncacheableFailure(result);
    expect(result.normalizedAddress).toBeUndefined();
  });

  it('treats a 200 with an unparseable body as transient, not as an answer', async () => {
    jest.useFakeTimers();
    const fetchFn = mockFetch([mockResponse(null, { unparseable: true })]);

    const pending = makeProvider().geocode('somewhere');
    await jest.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expectUncacheableFailure(result);
  });

  it('does not retry a 401, and reports it as transient rather than REQUEST_DENIED', async () => {
    // A bad device key is a fact about OUR credentials, never about the address.
    // Retrying cannot fix it, but negative-caching it would poison every address
    // touched before the key is corrected.
    const fetchFn = mockFetch([mockResponse({ error: 'Unauthorized' }, { ok: false, status: 401 })]);
    const result = await makeProvider().geocode('somewhere');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expectUncacheableFailure(result);
  });

  it('honours Retry-After on a 429 and succeeds on the retry', async () => {
    jest.useFakeTimers();
    const fetchFn = mockFetch([
      mockResponse({}, { ok: false, status: 429, headers: { 'retry-after': '2' } }),
      mockResponse(batchBody([okItem()])),
    ]);

    const pending = makeProvider().geocode('somewhere');

    // Well past the 500ms default backoff, but short of the server's 2s.
    await jest.advanceTimersByTimeAsync(600);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('OK');
  });

  it('recovers when a transient failure is followed by a good response', async () => {
    jest.useFakeTimers();
    const fetchFn = mockFetch([
      mockResponse({}, { ok: false, status: 503 }),
      mockResponse(batchBody([okItem()])),
    ]);

    const pending = makeProvider().geocode('somewhere');
    await jest.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('OK');
    expect(result.lat).toBe(37.422);
  });
});
