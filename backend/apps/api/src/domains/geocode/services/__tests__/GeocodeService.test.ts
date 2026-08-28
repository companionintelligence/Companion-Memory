import { createHash } from 'node:crypto';

import config from '@ci/configuration';

import type { GeocodeCacheEntity } from '../../entities/GeocodeCacheEntity';
import type { GeocodeProvider, GeocodeProviderResult } from '../GeocodeProvider';
import {
  confidenceForLocationType,
  GeocodeService,
  LOW_CONFIDENCE_THRESHOLD,
  NON_RETRYABLE_STATUSES,
  RateLimiter,
  RETRYABLE_STATUSES,
  VIRTUAL_STATUS,
} from '../GeocodeService';

/**
 * Minimal in-memory stand-ins for the TypeORM repository and the provider. The
 * provider is ALWAYS mocked — these tests never hit the network / real Google.
 */
function makeCacheRepo(seed?: Partial<GeocodeCacheEntity>) {
  const row = seed ? ({ hitCount: 1, ...seed } as GeocodeCacheEntity) : null;

  return {
    findOne: jest.fn(async () => row),
    increment: jest.fn(async () => ({ affected: 1 })),
    query: jest.fn(async () => []),
  };
}

function makeProvider(result: GeocodeProviderResult | Error): jest.Mocked<GeocodeProvider> {
  const respond = async () => {
    if (result instanceof Error) {
      throw result;
    }

    return result;
  };

  return {
    geocode: jest.fn<Promise<GeocodeProviderResult>, [string]>(respond),
    reverseGeocode: jest.fn<Promise<GeocodeProviderResult>, [number, number]>(respond),
  };
}

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeService(repo: ReturnType<typeof makeCacheRepo>, provider: jest.Mocked<GeocodeProvider>) {
  const logger = makeLogger();

  return new GeocodeService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repo as any,
    provider,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );
}

const ROOFTOP_OK: GeocodeProviderResult = {
  status: 'OK',
  lat: 37.422,
  lng: -122.084,
  normalizedAddress: '1600 Amphitheatre Pkwy, Mountain View, CA',
  placeId: 'place-123',
  locationType: 'ROOFTOP',
  partialMatch: false,
  components: {},
};

describe('GeocodeService.canonicalize / hashQuery', () => {
  it('collapses punctuation, case and whitespace to one canonical key', () => {
    expect(GeocodeService.canonicalize('  123 Main St. ')).toBe('123 main st');
    expect(GeocodeService.canonicalize('123  MAIN  st')).toBe('123 main st');
    // Same canonical form -> same hash (single cache row).
    expect(GeocodeService.hashQuery('123 Main St.')).toBe(GeocodeService.hashQuery('123  main  st'));
  });
});

describe('GeocodeService.toPoint axis guard', () => {
  it('emits [lng, lat] order for a valid pair', () => {
    expect(GeocodeService.toPoint(37.4, -122.1)).toEqual({ type: 'Point', coordinates: [-122.1, 37.4] });
  });

  it('throws when latitude is out of [-90, 90] (likely a lat/lng swap)', () => {
    expect(() => GeocodeService.toPoint(122.1, 37.4)).toThrow(/Invalid latitude/);
  });

  it('throws when longitude is out of [-180, 180]', () => {
    expect(() => GeocodeService.toPoint(10, 200)).toThrow(/Invalid longitude/);
  });
});

describe('confidenceForLocationType', () => {
  it('maps Google location_type to a precision-derived confidence', () => {
    expect(confidenceForLocationType('ROOFTOP')).toBe(0.95);
    expect(confidenceForLocationType('RANGE_INTERPOLATED')).toBe(0.95);
    expect(confidenceForLocationType('GEOMETRIC_CENTER')).toBe(0.8);
    expect(confidenceForLocationType('APPROXIMATE')).toBe(LOW_CONFIDENCE_THRESHOLD);
    // Unknown precision is conservative venue-grade, never the default 1.0.
    expect(confidenceForLocationType('SOMETHING_NEW')).toBe(0.8);
    expect(confidenceForLocationType(null)).toBe(0.8);
  });
});

describe('GeocodeService.geocode', () => {
  it('returns ZERO_RESULTS for empty/blank input without calling the provider', async () => {
    const repo = makeCacheRepo();
    const provider = makeProvider(ROOFTOP_OK);
    const service = makeService(repo, provider);

    const out = await service.geocode('   ');

    expect(out.status).toBe('ZERO_RESULTS');
    expect(out.point).toBeNull();
    expect(provider.geocode).not.toHaveBeenCalled();
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('skips the provider for a denylisted virtual location', async () => {
    const repo = makeCacheRepo();
    const provider = makeProvider(ROOFTOP_OK);
    const service = makeService(repo, provider);

    const out = await service.geocode('https://zoom.us/j/123');

    expect(out.status).toBe(VIRTUAL_STATUS);
    expect(out.point).toBeNull();
    expect(provider.geocode).not.toHaveBeenCalled();
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('serves an OK cache hit WITHOUT re-billing the provider, and bumps hit_count', async () => {
    const repo = makeCacheRepo({
      queryHash: 'h',
      status: 'OK',
      lat: 37.4,
      lng: -122.1,
      locationType: 'ROOFTOP',
      normalizedAddress: 'cached addr',
    });
    const provider = makeProvider(ROOFTOP_OK);
    const service = makeService(repo, provider);

    const out = await service.geocode('1600 Amphitheatre Pkwy');

    expect(out.cached).toBe(true);
    expect(out.status).toBe('OK');
    expect(out.confidence).toBe(0.95);
    expect(out.point).toEqual({ type: 'Point', coordinates: [-122.1, 37.4] });
    expect(provider.geocode).not.toHaveBeenCalled(); // no re-bill
    expect(repo.increment).toHaveBeenCalledWith({ queryHash: expect.any(String) }, 'hitCount', 1);
    expect(repo.query).not.toHaveBeenCalled(); // cache not rewritten on a hit
  });

  it('serves a negative cache hit (ZERO_RESULTS) without re-billing', async () => {
    const repo = makeCacheRepo({ queryHash: 'h', status: 'ZERO_RESULTS', lat: null, lng: null });
    const provider = makeProvider(ROOFTOP_OK);
    const service = makeService(repo, provider);

    const out = await service.geocode('nowhere at all');

    expect(out.cached).toBe(true);
    expect(out.status).toBe('ZERO_RESULTS');
    expect(out.point).toBeNull();
    expect(out.retryable).toBe(false);
    expect(provider.geocode).not.toHaveBeenCalled();
  });

  it('writes a fresh OK result to the cache and flags lowConfidence only for APPROXIMATE', async () => {
    const repo = makeCacheRepo();
    const provider = makeProvider(ROOFTOP_OK);
    const service = makeService(repo, provider);

    const precise = await service.geocode('1600 Amphitheatre Pkwy');
    expect(precise.status).toBe('OK');
    expect(precise.confidence).toBe(0.95);
    expect(precise.lowConfidence).toBe(false);
    expect(repo.query).toHaveBeenCalledTimes(1); // cache write

    const approxRepo = makeCacheRepo();
    const approxProvider = makeProvider({ ...ROOFTOP_OK, locationType: 'APPROXIMATE' });
    const approxService = makeService(approxRepo, approxProvider);

    const coarse = await approxService.geocode('springfield');
    expect(coarse.status).toBe('OK');
    expect(coarse.confidence).toBe(LOW_CONFIDENCE_THRESHOLD);
    expect(coarse.lowConfidence).toBe(true);
  });

  it('caches negative results (ZERO_RESULTS) so they are never re-billed', async () => {
    const repo = makeCacheRepo();
    const provider = makeProvider({ status: 'ZERO_RESULTS' });
    const service = makeService(repo, provider);

    const out = await service.geocode('asdkjfhaskjdfh');

    expect(out.status).toBe('ZERO_RESULTS');
    expect(out.retryable).toBe(false);
    expect(repo.query).toHaveBeenCalledTimes(1); // negative cache write
    expect(NON_RETRYABLE_STATUSES.has(out.status)).toBe(true);
  });

  it('does NOT cache a retryable provider status (OVER_QUERY_LIMIT)', async () => {
    const repo = makeCacheRepo();
    const provider = makeProvider({ status: 'OVER_QUERY_LIMIT' });
    const service = makeService(repo, provider);

    const out = await service.geocode('1 Infinite Loop');

    expect(out.status).toBe('OVER_QUERY_LIMIT');
    expect(out.retryable).toBe(true);
    expect(RETRYABLE_STATUSES.has(out.status)).toBe(true);
    expect(repo.query).not.toHaveBeenCalled(); // not cached — next attempt may succeed
  });

  it('treats a provider transport throw as retryable and does NOT cache', async () => {
    const repo = makeCacheRepo();
    const provider = makeProvider(new Error('socket timeout'));
    const service = makeService(repo, provider);

    const out = await service.geocode('1 Infinite Loop');

    expect(out.status).toBe('UNKNOWN_ERROR');
    expect(out.retryable).toBe(true);
    expect(out.cached).toBe(false);
    expect(repo.query).not.toHaveBeenCalled();
  });

  it('bustCache skips the cache read and forces a fresh provider call', async () => {
    const repo = makeCacheRepo({ queryHash: 'h', status: 'ZERO_RESULTS', lat: null, lng: null });
    const provider = makeProvider(ROOFTOP_OK);
    const service = makeService(repo, provider);

    const out = await service.geocode('123 main st', { bustCache: true });

    expect(repo.findOne).not.toHaveBeenCalled(); // cache read skipped
    expect(provider.geocode).toHaveBeenCalledTimes(1); // provider re-queried
    expect(out.status).toBe('OK');
    expect(repo.query).toHaveBeenCalledTimes(1); // overwrites the negative row
  });

  it('honors the virtual denylist even with bustCache set', async () => {
    const repo = makeCacheRepo();
    const provider = makeProvider(ROOFTOP_OK);
    const service = makeService(repo, provider);

    const out = await service.geocode('zoom', { bustCache: true });

    expect(out.status).toBe(VIRTUAL_STATUS);
    expect(provider.geocode).not.toHaveBeenCalled();
  });
});

describe('GeocodeService.reverseGeocode', () => {
  it('calls the provider on a cache miss and returns the resolved place name', async () => {
    const repo = makeCacheRepo();
    const provider = makeProvider(ROOFTOP_OK);

    const outcome = await makeService(repo, provider).reverseGeocode(37.422, -122.084);

    expect(provider.reverseGeocode).toHaveBeenCalledWith(37.422, -122.084);
    expect(outcome.status).toBe('OK');
    expect(outcome.placeName).toBe(ROOFTOP_OK.normalizedAddress);
    expect(outcome.cached).toBe(false);
    expect(repo.query).toHaveBeenCalled(); // result written to the shared cache
  });

  it('serves a cached reverse result without calling the provider', async () => {
    const repo = makeCacheRepo({
      status: 'OK',
      normalizedAddress: 'Cached Place, City',
    } as Partial<GeocodeCacheEntity>);
    const provider = makeProvider(ROOFTOP_OK);

    const outcome = await makeService(repo, provider).reverseGeocode(40, -73);

    expect(provider.reverseGeocode).not.toHaveBeenCalled();
    expect(outcome.cached).toBe(true);
    expect(outcome.placeName).toBe('Cached Place, City');
  });

  it('rejects non-finite coordinates without a provider call', async () => {
    const repo = makeCacheRepo();
    const provider = makeProvider(ROOFTOP_OK);

    const outcome = await makeService(repo, provider).reverseGeocode(Number.NaN, 10);

    expect(provider.reverseGeocode).not.toHaveBeenCalled();
    expect(outcome.status).toBe('INVALID_REQUEST');
    expect(outcome.placeName).toBeNull();
  });

  it('marks a transient provider status retryable and does not cache it', async () => {
    const repo = makeCacheRepo();
    const provider = makeProvider({ status: 'OVER_QUERY_LIMIT' });

    const outcome = await makeService(repo, provider).reverseGeocode(1, 2);

    expect(outcome.retryable).toBe(true);
    expect(outcome.placeName).toBeNull();
    expect(repo.query).not.toHaveBeenCalled();
  });

  it('hashes the structured key directly (NOT via hashQuery) so the coordinate signs survive', async () => {
    const repo = makeCacheRepo();
    const provider = makeProvider(ROOFTOP_OK);

    await makeService(repo, provider).reverseGeocode(37.422, -122.084);

    // The key is sha256 of the raw `reverse:lat,lng` string, not the canonicalized
    // form (which would strip the '-', '.' and ',').
    const expectedHash = createHash('sha256').update('reverse:37.4220,-122.0840').digest('hex');
    expect(repo.findOne).toHaveBeenCalledWith({ where: { queryHash: expectedHash } });
  });

  it('exposes that key as a STATIC, and looks up exactly what the static computes', async () => {
    // The contract `promote.place_position` depends on: it reads these cache
    // rows by primary key for their address components, and computes the key
    // with `GeocodeService.hashReverseQuery` rather than re-deriving it. A
    // second copy of the expression would be a silent cache miss on the day one
    // of them changes — which reads as "this place has no hierarchy", not as a
    // bug. So the writer and the reader must be provably the same function.
    const repo = makeCacheRepo();

    await makeService(repo, makeProvider(ROOFTOP_OK)).reverseGeocode(37.422, -122.084);

    expect(GeocodeService.reverseCacheKey(37.422, -122.084)).toBe('reverse:37.4220,-122.0840');
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { queryHash: GeocodeService.hashReverseQuery(37.422, -122.084) },
    });
  });

  it('gives all four coordinate quadrants distinct cache keys (no sign collapse)', async () => {
    const hashFor = async (lat: number, lng: number): Promise<string> => {
      const repo = makeCacheRepo();
      await makeService(repo, makeProvider(ROOFTOP_OK)).reverseGeocode(lat, lng);
      const arg = (repo.findOne.mock.calls[0] as unknown[])[0] as { where: { queryHash: string } };

      return arg.where.queryHash;
    };

    const hashes = new Set([
      await hashFor(37.42, -122.08), // California (NW)
      await hashFor(-37.42, 122.08), // near Australia (SE) — would collide under canonicalize
      await hashFor(37.42, 122.08), // NE
      await hashFor(-37.42, -122.08), // SW
    ]);

    expect(hashes.size).toBe(4);
  });
});

describe('RateLimiter (QPS throttle)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('lets the first acquire through immediately, then spaces the rest by 1000/qps ms', async () => {
    const limiter = new RateLimiter(10); // 100ms min interval

    await limiter.acquire(); // first is immediate

    let secondResolved = false;
    const second = limiter.acquire().then(() => {
      secondResolved = true;
    });

    // Not yet — must wait ~100ms.
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    await jest.advanceTimersByTimeAsync(100);
    await second;
    expect(secondResolved).toBe(true);
  });

  it('is a no-op when qps is non-positive (unthrottled)', async () => {
    const limiter = new RateLimiter(0);
    // Resolves without any timer advance.
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });
});

/**
 * The bug this whole cluster fixes: `GeocodeBatchListener` and `GeocodeStage`
 * each used to construct their OWN throttle, so the appliance-wide rate seen
 * by the provider was the SUM of both, not the configured budget. The fix
 * moves the one `RateLimiter` instance onto `GeocodeService` itself — a Nest
 * singleton both callers inject — so every `geocode`/`reverseGeocode` call,
 * from whichever caller, waits on the same clock.
 *
 * This does not mock GeocodeService or its rate limiter: it drives two
 * independent "callers" (standing in for the listener's forward sweep and the
 * stage's reverse sweep) concurrently against ONE real service instance, the
 * way NestJS DI actually hands the same singleton to both, and asserts on the
 * real spacing between real provider calls.
 */
describe('GeocodeService rate limiter — shared across independent callers', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('never lets the combined call rate from two concurrent callers exceed rateLimitPerSecond', async () => {
    const minIntervalMs = 1000 / config.geocoding.rateLimitPerSecond;

    const callTimestamps: number[] = [];
    const provider: jest.Mocked<GeocodeProvider> = {
      geocode: jest.fn<Promise<GeocodeProviderResult>, [string]>(async () => {
        callTimestamps.push(Date.now());

        return ROOFTOP_OK;
      }),
      reverseGeocode: jest.fn<Promise<GeocodeProviderResult>, [number, number]>(async () => {
        callTimestamps.push(Date.now());

        return ROOFTOP_OK;
      }),
    };

    // ONE service instance, exactly as the Nest DI container would hand out a
    // singleton to both GeocodeBatchListener and GeocodeStage.
    const service = makeService(makeCacheRepo(), provider);

    // Caller A: distinct addresses, so every call is a cache miss that reaches
    // the provider — stands in for GeocodeBatchListener's forward sweep.
    const callerA = Promise.all(Array.from({ length: 4 }, (_unused, i) => service.geocode(`Address ${i}`)));
    // Caller B: distinct coordinates, running AT THE SAME TIME — stands in for
    // GeocodeStage's reverse sweep, or a second concurrent slice.
    const callerB = Promise.all(Array.from({ length: 4 }, (_unused, i) => service.reverseGeocode(i, i)));

    await jest.runAllTimersAsync();
    await Promise.all([callerA, callerB]);

    // All 8 calls (4 from each caller) landed on the provider.
    expect(callTimestamps).toHaveLength(8);

    // The property under test: no two provider calls, from EITHER caller, ever
    // land closer together than the shared budget allows. Without the fix each
    // caller's own throttle only spaces out ITS OWN calls, so this fails —
    // caller A and caller B's first calls both land at t=0.
    const sorted = [...callTimestamps].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(minIntervalMs);
    }
  });
});
