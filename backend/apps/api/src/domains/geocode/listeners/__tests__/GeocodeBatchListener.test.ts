import { VIRTUAL_STATUS } from '../../services/GeocodeService';
import type { GeocodeOutcome, ReverseGeocodeOutcome } from '../../services/GeocodeService';
import { GeocodeBatchListener } from '../GeocodeBatchListener';

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
 * outcome (provider never touched), and capture CalendarEventService.update calls.
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

  const placeCalls: Array<{ userId: string; name: string; lat: number; lng: number }> = [];
  const placeService = {
    // Returns a deterministic id derived from the geocode key so tests can
    // assert on which Place an event was linked to. created=true on the first
    // call for a key, false thereafter.
    findOrCreateForGeocode: jest.fn(
      async (ctx: { userId: string }, input: { name: string; lat: number; lng: number }) => {
        placeCalls.push({ userId: ctx.userId, ...input });

        const key = `place:${ctx.userId}:${input.name.trim().toLowerCase()}:${input.lat.toFixed(3)}:${input.lng.toFixed(3)}`;

        return { id: key, created: true };
      },
    ),
  };

  const logger = makeLogger();

  const listener = new GeocodeBatchListener(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dataSource as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    geocodeService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    placeService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return {
    listener,
    builder,
    geocodeService,
    eventService,
    placeService,
    geocodeCalls,
    reverseCalls,
    updates,
    placeCalls,
    logger,
  };
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

// The RateLimiter (QPS throttle) unit tests moved to GeocodeService.test.ts
// alongside the class, which now lives in GeocodeService and is shared by
// every caller — see "GeocodeService rate limiter" there.

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
    expect(joined).toContain("COALESCE(event.metadata->>'location_source', '') <> 'estimated'");
  });

  it('an explicit eventIds set skips the name filter but still refuses estimated coordinates', async () => {
    const { listener, builder } = makeListener(
      [],
      () => okOutcome(),
      () => okReverse('x'),
    );

    await listener.handleBatch({ userId: USER, direction: 'reverse', eventIds: ['e1', 'e2'] });

    const joined = builder.clauses.join(' | ');
    expect(joined).toContain('event_id IN (:...eventIds)');
    expect(joined).not.toContain('location_name IS NULL');
    expect(joined).toContain("COALESCE(event.metadata->>'location_source', '') <> 'estimated'");
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

describe('GeocodeBatchListener Place linking', () => {
  const okReverse = (placeName: string): ReverseGeocodeOutcome => ({
    status: 'OK',
    placeName,
    cached: false,
    retryable: false,
  });

  it('forward path links the event to a Place created from (name, geocoded coords)', async () => {
    const rows = [{ event_id: 'e1', location_name: '1600 Amphitheatre Pkwy' }];
    const { listener, placeService, placeCalls, updates } = makeListener(rows, () => okOutcome());

    await listener.handleBatch({ userId: USER });

    expect(placeService.findOrCreateForGeocode).toHaveBeenCalledTimes(1);
    // The PostGIS Point is [lng, lat]; the listener must unpack it as (lat, lng).
    expect(placeCalls[0]).toEqual({
      userId: USER,
      name: '1600 Amphitheatre Pkwy',
      lat: 37.4,
      lng: -122.1,
      placeId: null,
      components: null,
      bounds: null,
    });
    expect(updates[0].data.location_entity_id).toBe(`place:${USER}:1600 amphitheatre pkwy:37.400:-122.100`);
  });

  it('reverse path links the event to a Place created from (placeName, candidate coords)', async () => {
    const rows = [{ event_id: 'e1', lat: 37.4143, lng: -122.0774 }];
    const { listener, placeCalls, updates } = makeListener(
      rows,
      () => okOutcome(),
      () => okReverse('1401 N Shoreline Blvd, Mountain View, CA'),
    );

    await listener.handleBatch({ userId: USER, direction: 'reverse' });

    expect(placeCalls[0]).toEqual({
      userId: USER,
      name: '1401 N Shoreline Blvd, Mountain View, CA',
      lat: 37.4143,
      lng: -122.0774,
      placeId: null,
      components: null,
      bounds: null,
    });
    // The name + entity-id are written in the same CalendarEventService.update payload
    // so the index update is atomic.
    expect(updates[0].data.location_name).toBe('1401 N Shoreline Blvd, Mountain View, CA');
    expect(updates[0].data.location_entity_id).toBe(
      `place:${USER}:1401 n shoreline blvd, mountain view, ca:37.414:-122.077`,
    );
  });

  it('two events resolving to the same key link to the same Place id', async () => {
    // Two coordinate-only events whose reverse-geocodes round to the same key
    // (within 110 m, same name) MUST land on a single Place — the whole point
    // of the find-or-create flow.
    const rows = [
      { event_id: 'a', lat: 37.4141, lng: -122.0772 },
      { event_id: 'b', lat: 37.4144, lng: -122.0774 },
    ];
    const { listener, updates } = makeListener(
      rows,
      () => okOutcome(),
      () => okReverse('1401 N Shoreline Blvd, Mountain View, CA'),
    );

    await listener.handleBatch({ userId: USER, direction: 'reverse' });

    const nameWrites = updates.filter((u) => u.data.location_name !== undefined);
    expect(nameWrites).toHaveLength(2);
    expect(nameWrites[0].data.location_entity_id).toBe(nameWrites[1].data.location_entity_id);
  });

  it('a Place-write error does not block the coord/name update — falls through without location_entity_id', async () => {
    // Resilience: PlaceService.findOrCreateForGeocode failure is logged and
    // swallowed; the geocoded coord/name still gets persisted so progress
    // isn't lost behind a flaky graph write.
    const rows = [{ event_id: 'e1', lat: 37.4, lng: -122.1 }];
    const { listener, placeService, updates } = makeListener(
      rows,
      () => okOutcome(),
      () => okReverse('Mountain View, CA'),
    );

    placeService.findOrCreateForGeocode.mockRejectedValueOnce(new Error('boom'));

    await listener.handleBatch({ userId: USER, direction: 'reverse' });

    expect(updates[0].data.location_name).toBe('Mountain View, CA');
    expect(updates[0].data.location_entity_id).toBeUndefined();
  });
});

function retryableOutcome(): GeocodeOutcome {
  return { status: 'OVER_QUERY_LIMIT', point: null, confidence: null, cached: false, retryable: true };
}

function retryableReverse(): ReverseGeocodeOutcome {
  return { status: 'OVER_QUERY_LIMIT', placeName: null, cached: false, retryable: true };
}

/**
 * Every test elsewhere in this file supplies a single-shot outcome function,
 * so geocodeWithRetry/reverseGeocodeWithRetry's backoff loop never actually
 * loops. These tests script a call-counting outcome so the retry body runs
 * for real, and use fake timers so the real BACKOFF_MS delays (500/1500/4000ms
 * — up to 6s across 3 retries) don't make the suite slow.
 */
describe('GeocodeBatchListener retry loop (geocodeWithRetry)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('retries a transient failure and succeeds once the provider recovers, busting the cache on every retry', async () => {
    const rows = [{ event_id: 'e1', location_name: 'Cafe X' }];
    let calls = 0;
    const { listener, geocodeCalls, updates } = makeListener(rows, () => {
      calls += 1;

      return calls <= 2 ? retryableOutcome() : okOutcome();
    });

    const run = listener.handleBatch({ userId: USER });
    await jest.runAllTimersAsync();
    await run;

    // First call honors the caller's bustCache; both retries force bustCache:true.
    expect(geocodeCalls.map((c) => c.bustCache)).toEqual([false, true, true]);
    expect(geocodeCalls).toHaveLength(3);
    expect(updates[0]?.data.location_coordinates).toBeDefined();
  });

  it('exhausts the full backoff schedule and gives up (leaves the event unresolved) when the provider never recovers', async () => {
    const rows = [{ event_id: 'e1', location_name: 'Cafe X' }];
    const { listener, geocodeCalls, updates, logger } = makeListener(rows, () => retryableOutcome());

    const run = listener.handleBatch({ userId: USER });
    await jest.runAllTimersAsync();
    await run;

    // 1 initial attempt + 3 backoff retries (BACKOFF_MS has 3 entries) = 4 total calls.
    expect(geocodeCalls).toHaveLength(4);
    expect(updates).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      'Geocode exhausted retries for location',
      expect.objectContaining({ location: 'Cafe X' }),
    );
  });

  it('waits the documented backoff schedule (500ms, 1500ms, 4000ms) between attempts', async () => {
    const rows = [{ event_id: 'e1', location_name: 'Cafe X' }];
    let calls = 0;
    const { listener, geocodeCalls } = makeListener(rows, () => {
      calls += 1;

      return calls <= 3 ? retryableOutcome() : okOutcome();
    });

    const run = listener.handleBatch({ userId: USER });

    await jest.advanceTimersByTimeAsync(0);
    expect(geocodeCalls).toHaveLength(1); // initial attempt, no wait yet

    await jest.advanceTimersByTimeAsync(500);
    expect(geocodeCalls).toHaveLength(2); // after the first backoff step

    await jest.advanceTimersByTimeAsync(1500);
    expect(geocodeCalls).toHaveLength(3); // after the second backoff step

    await jest.advanceTimersByTimeAsync(4000);
    expect(geocodeCalls).toHaveLength(4); // after the third backoff step — now succeeds

    await run;
  });
});

describe('GeocodeBatchListener retry loop (reverseGeocodeWithRetry)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('retries a transient reverse-geocode failure and succeeds once the provider recovers', async () => {
    const rows = [{ event_id: 'e1', lat: 37.4, lng: -122.1 }];
    let calls = 0;
    const { listener, reverseCalls, updates } = makeListener(
      rows,
      () => okOutcome(),
      () => {
        calls += 1;

        return calls <= 2
          ? retryableReverse()
          : { status: 'OK', placeName: 'Mountain View, CA', cached: false, retryable: false };
      },
    );

    const run = listener.handleBatch({ userId: USER, direction: 'reverse' });
    await jest.runAllTimersAsync();
    await run;

    expect(reverseCalls.map((c) => c.bustCache)).toEqual([false, true, true]);
    expect(updates[0]?.data.location_name).toBe('Mountain View, CA');
  });

  it('exhausts retries and leaves the event unresolved when reverse-geocoding never recovers', async () => {
    const rows = [{ event_id: 'e1', lat: 37.4, lng: -122.1 }];
    const { listener, reverseCalls, updates, logger } = makeListener(
      rows,
      () => okOutcome(),
      () => retryableReverse(),
    );

    const run = listener.handleBatch({ userId: USER, direction: 'reverse' });
    await jest.runAllTimersAsync();
    await run;

    expect(reverseCalls).toHaveLength(4);
    expect(updates).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      'Reverse-geocode exhausted retries',
      expect.objectContaining({ lat: 37.4, lng: -122.1 }),
    );
  });
});
