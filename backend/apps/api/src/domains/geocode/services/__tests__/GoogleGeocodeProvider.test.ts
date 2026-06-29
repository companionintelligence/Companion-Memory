jest.mock('@ci/configuration', () => {
  const actual = jest.requireActual('@ci/configuration').default;

  return {
    __esModule: true,
    default: {
      ...actual,
      geocoding: { ...actual.geocoding, apiKey: 'test-key' },
    },
  };
});

import config from '@ci/configuration';

import { GoogleGeocodeProvider } from '../GoogleGeocodeProvider';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/** Build a fetch mock returning a JSON body with the given HTTP `ok`/status. */
function mockFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const { ok = true, status = 200 } = init;
  const fn = jest.fn<
    Promise<{ ok: boolean; status: number; statusText: string; json: () => Promise<unknown> }>,
    [string]
  >(async () => ({
    ok,
    status,
    statusText: 'mock',
    json: async () => body,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = fn;

  return fn;
}

function makeProvider() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new GoogleGeocodeProvider(makeLogger() as any);
}

const OK_BODY = {
  status: 'OK',
  results: [
    {
      formatted_address: '1600 Amphitheatre Pkwy, Mountain View, CA 94043',
      place_id: 'place-1',
      partial_match: false,
      geometry: { location: { lat: 37.422, lng: -122.084 }, location_type: 'ROOFTOP' },
      address_components: [{ a: 1 }],
    },
  ],
};

describe('GoogleGeocodeProvider status -> outcome mapping', () => {
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (global as any).fetch;
    jest.clearAllMocks();
  });

  it('maps OK (HTTP 200) to a full result with coordinates and location_type', async () => {
    const fetchFn = mockFetch(OK_BODY);
    const result = await makeProvider().geocode('1600 Amphitheatre Pkwy');

    expect(result.status).toBe('OK');
    expect(result.lat).toBe(37.422);
    expect(result.lng).toBe(-122.084);
    expect(result.locationType).toBe('ROOFTOP');
    expect(result.placeId).toBe('place-1');
    expect(result.normalizedAddress).toContain('Amphitheatre');
    // The address is encoded into the URL and the key is appended.
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain('address=1600%20Amphitheatre%20Pkwy');
    expect(url).toContain('key=test-key');
  });

  it('maps ZERO_RESULTS (HTTP 200) to a non-OK status, no throw', async () => {
    mockFetch({ status: 'ZERO_RESULTS', results: [] });
    const result = await makeProvider().geocode('asdf');

    expect(result.status).toBe('ZERO_RESULTS');
    expect(result.lat).toBeUndefined();
  });

  it('maps OVER_QUERY_LIMIT (HTTP 200) to its status verbatim (caller retries)', async () => {
    mockFetch({ status: 'OVER_QUERY_LIMIT', error_message: 'quota' });
    const result = await makeProvider().geocode('1 Infinite Loop');

    expect(result.status).toBe('OVER_QUERY_LIMIT');
    expect(result.errorMessage).toBe('quota');
  });

  it('maps REQUEST_DENIED (HTTP 200) to its status verbatim (non-retryable)', async () => {
    mockFetch({ status: 'REQUEST_DENIED', error_message: 'bad key' });
    const result = await makeProvider().geocode('1 Infinite Loop');

    expect(result.status).toBe('REQUEST_DENIED');
    expect(result.errorMessage).toBe('bad key');
  });

  it('maps a non-2xx HTTP response to UNKNOWN_ERROR (transient transport failure)', async () => {
    mockFetch({}, { ok: false, status: 502 });
    const result = await makeProvider().geocode('somewhere');

    expect(result.status).toBe('UNKNOWN_ERROR');
    expect(result.errorMessage).toBe('HTTP 502');
  });

  it('treats a fetch reject (timeout/abort) as a thrown transport error', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn(async () => {
      throw new Error('The operation was aborted');
    });

    await expect(makeProvider().geocode('somewhere')).rejects.toThrow(/aborted/);
  });

  it('falls back to ZERO_RESULTS when an OK body has a result without numeric coords', async () => {
    mockFetch({
      status: 'OK',
      results: [{ formatted_address: 'x', geometry: { location: {} } }],
    });
    const result = await makeProvider().geocode('weird');

    expect(result.status).toBe('ZERO_RESULTS');
    expect(result.errorMessage).toContain('missing coordinates');
  });
});

describe('GoogleGeocodeProvider reverseGeocode', () => {
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (global as any).fetch;
    jest.clearAllMocks();
  });

  it('maps OK to a place name and queries the same endpoint with latlng=', async () => {
    const fetchFn = mockFetch(OK_BODY);
    const result = await makeProvider().reverseGeocode(37.422, -122.084);

    expect(result.status).toBe('OK');
    expect(result.normalizedAddress).toContain('Amphitheatre');
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain('latlng=37.422,-122.084');
    expect(url).not.toContain('address=');
    expect(url).toContain('key=test-key');
  });

  it('falls back to ZERO_RESULTS when the result carries no formatted_address', async () => {
    mockFetch({ status: 'OK', results: [{ geometry: { location: { lat: 1, lng: 2 } } }] });
    const result = await makeProvider().reverseGeocode(1, 2);

    expect(result.status).toBe('ZERO_RESULTS');
    expect(result.errorMessage).toContain('formatted_address');
  });

  it('maps ZERO_RESULTS (HTTP 200) verbatim without throwing', async () => {
    mockFetch({ status: 'ZERO_RESULTS', results: [] });
    const result = await makeProvider().reverseGeocode(0.1, 0.1);

    expect(result.status).toBe('ZERO_RESULTS');
    expect(result.normalizedAddress).toBeUndefined();
  });
});

describe('GoogleGeocodeProvider without an API key', () => {
  it('returns REQUEST_DENIED without making a network call', async () => {
    // The provider reads config.geocoding.apiKey at construction; clear it just
    // for this case so the no-key branch runs, then restore.
    const original = config.geocoding.apiKey;
    config.geocoding.apiKey = undefined;

    const fetchFn = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = fetchFn;

    try {
      const result = await makeProvider().geocode('1600 Amphitheatre Pkwy');

      expect(result.status).toBe('REQUEST_DENIED');
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      config.geocoding.apiKey = original;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (global as any).fetch;
    }
  });
});
