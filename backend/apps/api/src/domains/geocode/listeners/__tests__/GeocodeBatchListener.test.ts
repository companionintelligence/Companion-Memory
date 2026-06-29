import { VIRTUAL_STATUS } from '../../services/GeocodeService';
import type { GeocodeOutcome, ReverseGeocodeOutcome } from '../../services/GeocodeService';
import { GeocodeBatchListener, RateLimiter } from '../GeocodeBatchListener';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/**
 * A QueryBuilder spy that records every where/andWhere clause so a test can
 * assert on the candidate filter, and returns the seeded rows from getRawMany.
 */
function makeQueryBuilder(rows: Array<Record<string, unknown>>) {
  const clauses: string[] = [];
  const qb: Record<string, jest.Mock> = {};
  const chain = () => qb;
  qb.select = jest.fn(chain);
  qb.addSelect = jest.fn(chain);
  qb.where = jest.fn((c: string) => {
    clauses.push(c);

    return qb;
  });
  qb.andWhere = jest.fn((c: string) => {
    clauses.push(c);

    return qb;
  });
  qb.orderBy = jest.fn(chain);
  qb.limit = jest.fn(chain);
  qb.getRawMany = jest.fn(async () => rows);

  return { qb, clauses };
}

function makeDataSource(builder: ReturnType<typeof makeQueryBuilder>) {
  return {
    getRepository: jest.fn(() => ({ createQueryBuilder: jest.fn(() => builder.qb) })),
  };
}

/**
 * Build a listener with a geocodeService whose `geocode` returns a scripted
 * outcome (provider never touched), and capture EventService.update calls.
 */
function makeListener(
  rows: Array<Record<string, unknown>>,
  outcomeFor: (location: string) => GeocodeOutcome,
  reverseOutcomeFor?: (lat: number, lng: number) => ReverseGeocodeOutcome,
) {
  const builder = makeQueryBuilder(rows);
  const dataSource = makeDataSource(builder);

  const geocodeCalls: Array<{ location: string; bustCache: boolean }> = [];
  const reverseCalls: Array<{ lat: number; lng: number; bustCache: boolean }> = [];
  const geocodeService = {
    geocode: jest.fn(async (location: string, options?: { bustCache?: boolean }) => {
      geocodeCalls.push({ location, bustCache: options?.bustCache ?? false });

      return outcomeFor(location);
    }),
    reverseGeocode: jest.fn(async (lat: number, lng: number, options?: { bustCache?: boolean }) => {
      reverseCalls.push({ lat, lng, bustCache: options?.bustCache ?? false });

      return (
        reverseOutcomeFor?.(lat, lng) ?? {
          status: 'ZERO_RESULTS',
          placeName: null,
          cached: false,
          retryable: false,
        }
      );
    }),
  };

  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const eventService = {
    update: jest.fn(async (_ctx: unknown, id: string, data: Record<string, unknown>) => {
      updates.push({ id, data });

      return null;
    }),
    findById: jest.fn(async (_ctx: unknown, id: string) => ({ id, metadata: {} })),
  };

  const listener = new GeocodeBatchListener(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dataSource as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    geocodeService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    makeLogger() as any,
  );

  return { listener, builder, geocodeService, eventService, geocodeCalls, reverseCalls, updates };
}

function okOutcome(lowConfidence = false): GeocodeOutcome {
  return {
    status: 'OK',
    point: { type: 'Point', coordinates: [-122.1, 37.4] },
    confidence: lowConfidence ? 0.4 : 0.95,
    cached: false,
    retryable: false,
    lowConfidence,
  };
}

const USER = '00000000-0000-0000-0000-0000000000aa';

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

describe('GeocodeBatchListener.handleBatch', () => {
  it('writes coordinates + confidence for an OK candidate, no extra tag for a precise hit', async () => {
    const rows = [{ event_id: 'e1', location_name: '1600 Amphitheatre Pkwy' }];
    const { listener, eventService, updates } = makeListener(rows, () => okOutcome(false));

    await listener.handleBatch({ userId: USER });

    expect(eventService.update).toHaveBeenCalledTimes(1);
    expect(updates[0].data.location_coordinates).toEqual({ type: 'Point', coordinates: [-122.1, 37.4] });
    expect(updates[0].data.confidence_score).toBe(0.95);
  });

  it('tags an APPROXIMATE (low-confidence) hit with metadata.location_source = approximate', async () => {
    const rows = [{ event_id: 'e1', location_name: 'springfield' }];
    const { listener, eventService, updates } = makeListener(rows, () => okOutcome(true));

    await listener.handleBatch({ userId: USER });

    // One write for coordinates, one for the approximate tag.
    expect(eventService.update).toHaveBeenCalledTimes(2);
    expect(updates[0].data.confidence_score).toBe(0.4);
    expect(updates[1].data.metadata).toMatchObject({ location_source: 'approximate' });
  });

  it('tags a virtual outcome and never writes coordinates', async () => {
    const rows = [{ event_id: 'e1', location_name: 'zoom' }];
    const virtual: GeocodeOutcome = {
      status: VIRTUAL_STATUS,
      point: null,
      confidence: null,
      cached: false,
      retryable: false,
    };
    const { listener, eventService, updates } = makeListener(rows, () => virtual);

    await listener.handleBatch({ userId: USER });

    expect(eventService.update).toHaveBeenCalledTimes(1);
    expect(updates[0].data.metadata).toMatchObject({ location_source: 'virtual' });
    expect(updates[0].data.location_coordinates).toBeUndefined();
  });
});

describe('GeocodeBatchListener candidate selection', () => {
  it('default mode filters NULL coordinates AND excludes already-virtual rows', async () => {
    const { listener, builder } = makeListener([], () => okOutcome());

    await listener.handleBatch({ userId: USER, retryNull: false });

    const joined = builder.clauses.join(' | ');
    expect(joined).toContain('location_coordinates IS NULL');
    expect(joined).toContain('location_source');
    expect(joined).toContain("<> 'virtual'");
  });

  it('retryNull mode keeps the NULL filter but DROPS the virtual exclusion', async () => {
    const { listener, builder } = makeListener([], () => okOutcome());

    await listener.handleBatch({ userId: USER, retryNull: true });

    const joined = builder.clauses.join(' | ');
    expect(joined).toContain('location_coordinates IS NULL');
    expect(joined).not.toContain("<> 'virtual'");
  });

  it('an explicit eventIds set overrides the coordinate/virtual filters', async () => {
    const { listener, builder } = makeListener([], () => okOutcome());

    await listener.handleBatch({ userId: USER, eventIds: ['e1', 'e2'] });

    const joined = builder.clauses.join(' | ');
    expect(joined).toContain('event_id IN (:...eventIds)');
    expect(joined).not.toContain('location_coordinates IS NULL');
  });

  it('passes bustCache=false on a normal run and bustCache=true under retryNull', async () => {
    const rows = [{ event_id: 'e1', location_name: '123 main st' }];

    const normal = makeListener(rows, () => okOutcome());
    await normal.listener.handleBatch({ userId: USER, retryNull: false });
    expect(normal.geocodeCalls[0].bustCache).toBe(false);

    const retry = makeListener(rows, () => okOutcome());
    await retry.listener.handleBatch({ userId: USER, retryNull: true });
    expect(retry.geocodeCalls[0].bustCache).toBe(true);
  });
});

describe('GeocodeBatchListener reverse direction', () => {
  const okReverse = (placeName: string): ReverseGeocodeOutcome => ({
    status: 'OK',
    placeName,
    cached: false,
    retryable: false,
  });

  it('writes location_name + a reverse_geocoded tag for a coordinate-only event', async () => {
    const rows = [{ event_id: 'e1', lat: 37.4, lng: -122.1 }];
    const { listener, eventService, updates, reverseCalls } = makeListener(
      rows,
      () => okOutcome(),
      () => okReverse('Mountain View, CA'),
    );

    await listener.handleBatch({ userId: USER, direction: 'reverse' });

    expect(reverseCalls[0]).toMatchObject({ lat: 37.4, lng: -122.1 });
    // One write for the name, one for the provenance tag.
    expect(eventService.update).toHaveBeenCalledTimes(2);
    expect(updates[0].data.location_name).toBe('Mountain View, CA');
    expect(updates[1].data.metadata).toMatchObject({ location_source: 'reverse_geocoded' });
    // Reverse must never touch coordinates.
    expect(updates[0].data.location_coordinates).toBeUndefined();
  });

  it('selects coordinate-bearing events that lack a name (the inverse of the forward filter)', async () => {
    const { listener, builder } = makeListener(
      [],
      () => okOutcome(),
      () => okReverse('x'),
    );

    await listener.handleBatch({ userId: USER, direction: 'reverse' });

    const joined = builder.clauses.join(' | ');
    expect(joined).toContain('location_coordinates IS NOT NULL');
    expect(joined).toContain('location_name IS NULL');
  });

  it('coerces numeric-string coordinates from the driver before calling the provider', async () => {
    const rows = [{ event_id: 'e1', lat: '40.7128', lng: '-74.0060' }];
    const { listener, reverseCalls } = makeListener(
      rows,
      () => okOutcome(),
      () => okReverse('New York, NY'),
    );

    await listener.handleBatch({ userId: USER, direction: 'reverse' });

    expect(reverseCalls[0].lat).toBe(40.7128);
    expect(reverseCalls[0].lng).toBe(-74.006);
  });

  it('writes nothing when reverse geocoding finds no place name', async () => {
    const rows = [{ event_id: 'e1', lat: 0.1, lng: 0.1 }];
    const { listener, eventService } = makeListener(
      rows,
      () => okOutcome(),
      () => ({
        status: 'ZERO_RESULTS',
        placeName: null,
        cached: false,
        retryable: false,
      }),
    );

    await listener.handleBatch({ userId: USER, direction: 'reverse' });

    expect(eventService.update).not.toHaveBeenCalled();
  });
});
