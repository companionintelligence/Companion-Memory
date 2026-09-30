import type { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { LIVE_EVENT_SQL } from '../CalendarEventService';
import { KnownPlacesService } from '../KnownPlacesService';
import type { PlaceService } from '../PlaceService';

/**
 * `buildKnownPlaces` — the frequency + coordinate-cluster heuristic that
 * infers Home/Work from raw event history, with NO test file until now.
 *
 * This is exactly the kind of logic the audit calls out: thresholds,
 * frequency cutoffs and tie-breaking between candidate clusters that silently
 * MISCLASSIFY rather than crash when they drift. Nothing here touches
 * Postgres — `buildKnownPlaces` is a pure aggregation over whatever
 * `dataSource.query` hands back, so `query` is mocked to return fixed rows
 * (the same convention `ObjectObservationService.spec.ts` uses for a raw-SQL
 * service), and the assertions are entirely about the clustering/ranking/
 * classification that runs after the read.
 */

const USER = '00000000-0000-0000-0000-0000000000aa';
const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

/** A Wednesday (2026-08-19) so weekday-9-to-5 fixtures need no day-of-week gymnastics. */
const WEEKDAY_WORK_HOUR = '2026-08-19T10:00:00.000Z'; // Wed, 10:00 UTC — work-hours signal
const WEEKDAY_NIGHT_HOUR = '2026-08-19T22:00:00.000Z'; // Wed, 22:00 UTC — night signal
const WEEKEND_WORK_HOUR = '2026-08-15T10:00:00.000Z'; // Sat, 10:00 UTC — neither signal

interface RawRow {
  event_id?: string | null;
  title?: string | null;
  location_entity_id: string | null;
  location_name: string | null;
  lat: number;
  lng: number;
  start_time: string;
  timezone?: string | null;
}

function row(overrides: Partial<RawRow> = {}): RawRow {
  return {
    location_entity_id: null,
    location_name: 'Coffee Shop',
    lat: 40.7128,
    lng: -74.006,
    start_time: WEEKEND_WORK_HOUR,
    ...overrides,
  };
}

const DAY_MS = 86_400_000;

/** `iso` moved by a whole number of days, keeping its UTC time of day. */
function plusDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString();
}

/**
 * One row a week for `weeks` weeks, each at `start_time`'s time of week. A
 * place needs its night (or office-hours) signal in three different weeks
 * before it can be Home (or Work), so a fixture that should be tagged is
 * spread out this way.
 */
function weekly(weeks: number, overrides: Partial<RawRow> & { start_time: string }): RawRow[] {
  return Array.from({ length: weeks }, (_, week) =>
    row({ ...overrides, start_time: plusDays(overrides.start_time, week * 7) }),
  );
}

function makeService(rows: RawRow[]) {
  const query = jest.fn<Promise<RawRow[]>, [string, unknown[]?]>().mockResolvedValue(rows);
  const dataSource = { query } as unknown as DataSource;
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;
  const placeService = {} as PlaceService;

  return { service: new KnownPlacesService(dataSource, logger, placeService), query };
}

describe('KnownPlacesService.buildKnownPlaces', () => {
  it('returns nothing for a user with no geolocated events', async () => {
    const { service } = makeService([]);

    expect(await service.buildKnownPlaces(CONTEXT)).toEqual([]);
  });

  it('clusters by Location entity id when present, ignoring coordinate drift between events', async () => {
    // Same Location, GPS-jitter-different coordinates each time — must still
    // collapse to ONE candidate because the id anchor takes priority over the
    // coordinate grid.
    const { service } = makeService([
      row({ location_entity_id: 'loc-1', lat: 40.7128, lng: -74.006 }),
      row({ location_entity_id: 'loc-1', lat: 40.71284, lng: -74.00598 }),
    ]);

    const candidates = await service.buildKnownPlaces(CONTEXT);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ locationId: 'loc-1', eventCount: 2 });
  });

  it('falls back to a snapped coordinate grid when there is no Location entity id', async () => {
    const { service } = makeService([
      // Same grid cell at 2-decimal precision (~1.1km) — one cluster.
      row({ lat: 40.7128, lng: -74.006 }),
      row({ lat: 40.71279, lng: -74.00601 }),
      // A different cell entirely — a separate cluster.
      row({ lat: 34.0522, lng: -118.2437 }),
    ]);

    const candidates = await service.buildKnownPlaces(CONTEXT);

    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.eventCount).sort()).toEqual([1, 2]);
  });

  it('skips a row with non-finite coordinates rather than crashing or corrupting a cluster', async () => {
    const { service } = makeService([
      row({ location_entity_id: 'loc-1', lat: Number.NaN, lng: -74.006 }),
      row({ location_entity_id: 'loc-1', lat: 40.7128, lng: -74.006 }),
    ]);

    const candidates = await service.buildKnownPlaces(CONTEXT);

    expect(candidates).toHaveLength(1);
    // Only the valid row counted — the NaN row must not inflate eventCount or
    // pull the centroid toward NaN.
    expect(candidates[0].eventCount).toBe(1);
    expect(Number.isFinite(candidates[0].lat)).toBe(true);
    expect(Number.isFinite(candidates[0].lng)).toBe(true);
  });

  it('labels a cluster with its MOST FREQUENT location_name, not the first or last seen', async () => {
    const { service } = makeService([
      row({ location_entity_id: 'loc-1', location_name: 'Corner Cafe' }),
      row({ location_entity_id: 'loc-1', location_name: 'Home Cafe' }),
      row({ location_entity_id: 'loc-1', location_name: 'Home Cafe' }),
    ]);

    const [candidate] = await service.buildKnownPlaces(CONTEXT);

    expect(candidate.label).toBe('Home Cafe');
  });

  it('averages coordinates to the cluster centroid', async () => {
    const { service } = makeService([
      row({ location_entity_id: 'loc-1', lat: 40.0, lng: -74.0 }),
      row({ location_entity_id: 'loc-1', lat: 42.0, lng: -76.0 }),
    ]);

    const [candidate] = await service.buildKnownPlaces(CONTEXT);

    expect(candidate.lat).toBeCloseTo(41.0, 6);
    expect(candidate.lng).toBeCloseTo(-75.0, 6);
  });

  it('orders candidates by event count, most-supported cluster first', async () => {
    const { service } = makeService([
      row({ location_entity_id: 'loc-rare' }),
      row({ location_entity_id: 'loc-common' }),
      row({ location_entity_id: 'loc-common' }),
      row({ location_entity_id: 'loc-common' }),
    ]);

    const candidates = await service.buildKnownPlaces(CONTEXT);

    expect(candidates.map((c) => c.locationId)).toEqual(['loc-common', 'loc-rare']);
  });

  it('computes confidence from event-count support, capped at 0.9', async () => {
    // 1 of 2 total events → support 0.5 → 0.4 + 0.5 = 0.9 (already at the cap).
    const { service } = makeService([
      row({ location_entity_id: 'loc-1' }),
      row({ location_entity_id: 'loc-2' }),
    ]);

    const candidates = await service.buildKnownPlaces(CONTEXT);

    for (const candidate of candidates) {
      expect(candidate.confidence).toBeLessThanOrEqual(0.9);
      expect(candidate.confidence).toBeGreaterThanOrEqual(0.4);
    }
  });

  it('tags a place with nights in three weeks as home, and one with office hours in three as work', async () => {
    const { service } = makeService([
      // Cluster A: a night-time event in each of three weeks → home. Distinct
      // coordinates from cluster B — id-anchored candidates resolve by
      // locationId regardless of centroid, but keeping these distinct avoids
      // conflating this test with the colliding-centroid case covered below.
      ...weekly(3, {
        location_entity_id: 'loc-home',
        lat: 40.7128,
        lng: -74.006,
        start_time: WEEKDAY_NIGHT_HOUR,
      }),
      // Cluster B: a weekday work-hours event in each of three weeks → work.
      ...weekly(3, {
        location_entity_id: 'loc-work',
        lat: 34.0522,
        lng: -118.2437,
        start_time: WEEKDAY_WORK_HOUR,
      }),
    ]);

    const candidates = await service.buildKnownPlaces(CONTEXT);
    const byId = new Map(candidates.map((c) => [c.locationId, c.kind]));

    expect(byId.get('loc-home')).toBe('home');
    expect(byId.get('loc-work')).toBe('work');
  });

  it("buckets night/work hours on the user's wall clock, not UTC", async () => {
    // 06:00 UTC on a Thursday is 23:00 Wednesday in Los Angeles: a night event
    // locally, but neither night nor work-hours in UTC. 17:00 UTC Wednesday is
    // 10:00 local: work hours locally, outside 9-17 in UTC.
    const LA_NIGHT = '2026-08-20T06:00:00.000Z';
    const LA_WORK = '2026-08-19T17:00:00.000Z';
    const { service } = makeService([
      ...weekly(3, {
        location_entity_id: 'loc-home',
        lat: 34.07,
        lng: -118.47,
        start_time: LA_NIGHT,
        timezone: 'America/Los_Angeles',
      }),
      ...weekly(3, {
        location_entity_id: 'loc-work',
        lat: 33.68,
        lng: -117.82,
        start_time: LA_WORK,
        timezone: 'America/Los_Angeles',
      }),
    ]);

    const candidates = await service.buildKnownPlaces(CONTEXT);
    const byId = new Map(candidates.map((c) => [c.locationId, c.kind]));

    expect(byId.get('loc-home')).toBe('home');
    expect(byId.get('loc-work')).toBe('work');
  });

  it('falls back to UTC when the stored timezone is missing or unknown', async () => {
    const { service } = makeService([
      ...weekly(3, { location_entity_id: 'loc-a', start_time: WEEKDAY_NIGHT_HOUR, timezone: 'Not/AZone' }),
      ...weekly(3, {
        location_entity_id: 'loc-b',
        lat: 1,
        lng: 1,
        start_time: WEEKDAY_WORK_HOUR,
        timezone: 'Not/AZone',
      }),
    ]);

    const candidates = await service.buildKnownPlaces(CONTEXT);
    const byId = new Map(candidates.map((c) => [c.locationId, c.kind]));

    expect(byId.get('loc-a')).toBe('home');
    expect(byId.get('loc-b')).toBe('work');
  });

  it('leaves a cluster with neither signal as "other"', async () => {
    const { service } = makeService([
      row({ location_entity_id: 'loc-weekend', start_time: WEEKEND_WORK_HOUR }),
      row({ location_entity_id: 'loc-weekend', start_time: WEEKEND_WORK_HOUR }),
    ]);

    const [candidate] = await service.buildKnownPlaces(CONTEXT);

    expect(candidate.kind).toBe('other');
  });

  it('does NOT also tag the home cluster as work when it is the single strongest for both signals', async () => {
    // loc-mixed is the ONLY cluster with any night or work-hours events at
    // all, so it is the global best on both axes — but assignPrimaryKinds
    // only promotes a second cluster to "work" when the two winners differ.
    // A caller relying on "the best-work cluster is always tagged work" would
    // be surprised here, which is exactly why this needs to be pinned rather
    // than left to find out in production.
    const { service } = makeService([
      ...weekly(3, {
        location_entity_id: 'loc-mixed',
        lat: 40.7128,
        lng: -74.006,
        start_time: WEEKDAY_NIGHT_HOUR,
      }),
      ...weekly(3, {
        location_entity_id: 'loc-mixed',
        lat: 40.7128,
        lng: -74.006,
        start_time: WEEKDAY_WORK_HOUR,
      }),
      // A second cluster with real support but NEITHER signal — must not be
      // promoted to "work" merely for being the runner-up. Distinct
      // coordinates from loc-mixed (see the home/work test above for why).
      ...weekly(3, {
        location_entity_id: 'loc-other',
        lat: 34.0522,
        lng: -118.2437,
        start_time: WEEKEND_WORK_HOUR,
      }),
    ]);

    const candidates = await service.buildKnownPlaces(CONTEXT);
    const byId = new Map(candidates.map((c) => [c.locationId, c.kind]));

    expect(byId.get('loc-mixed')).toBe('home');
    expect(byId.get('loc-other')).toBe('other');
  });

  it('keeps home/work signals separate for two id-anchored clusters that share a centroid', async () => {
    // Regression test: assignPrimaryKinds' cluster lookup used to fall back to
    // a coordinate-centroid match even for id-anchored candidates, so two
    // DISTINCT Location entities recorded at the exact same lat/lng (or whose
    // averaged centroids collapsed within the 1e-6 tolerance) would resolve to
    // whichever cluster happened to be first in Map insertion order — silently
    // attributing both clusters' signals to one physical place. Id-anchored
    // candidates must resolve by locationId alone, never by centroid.
    const SHARED_LAT = 40.7128;
    const SHARED_LNG = -74.006;

    const { service } = makeService([
      // loc-home: entirely night-time events, but shares its centroid with loc-work.
      ...weekly(3, {
        location_entity_id: 'loc-home',
        lat: SHARED_LAT,
        lng: SHARED_LNG,
        start_time: WEEKDAY_NIGHT_HOUR,
      }),
      // loc-work: entirely weekday work-hours events, identical centroid to loc-home.
      ...weekly(3, {
        location_entity_id: 'loc-work',
        lat: SHARED_LAT,
        lng: SHARED_LNG,
        start_time: WEEKDAY_WORK_HOUR,
      }),
    ]);

    const candidates = await service.buildKnownPlaces(CONTEXT);
    const byId = new Map(candidates.map((c) => [c.locationId, c.kind]));

    expect(candidates).toHaveLength(2);
    expect(byId.get('loc-home')).toBe('home');
    expect(byId.get('loc-work')).toBe('work');
  });

  describe('Home and Work need evidence that recurs over weeks', () => {
    const kindsById = (candidates: Array<{ locationId: string | null; kind: string }>) =>
      new Map(candidates.map((c) => [c.locationId, c.kind]));

    it('does not let one late-night event outrank a home with nights in three weeks', async () => {
      // The defect this rule replaced: tagging by night SHARE crowned a single
      // 23:00 event (share 1.0) over a real home at 0.75.
      const { service } = makeService([
        // Home: a night in each of three weeks, plus a daytime visit. 3 of 4 at night.
        ...weekly(3, { location_entity_id: 'loc-home', start_time: WEEKDAY_NIGHT_HOUR }),
        row({ location_entity_id: 'loc-home', start_time: WEEKEND_WORK_HOUR }),
        // Elsewhere: one pickup at 23:00.
        row({
          location_entity_id: 'loc-pickup',
          lat: 37.78,
          lng: -122.4,
          start_time: '2026-08-21T23:00:00.000Z',
        }),
      ]);

      const kinds = kindsById(await service.buildKnownPlaces(CONTEXT));

      expect(kinds.get('loc-home')).toBe('home');
      expect(kinds.get('loc-pickup')).toBe('other');
    });

    it('tags nothing when no place recurs across three weeks, as on the reference corpus', async () => {
      // The reference corpus in miniature: its old Home was one late pickup in
      // another city, and its old Work two pickups at an airport, in two
      // different weeks. Two nights of one trip complete it.
      const { service } = makeService([
        row({
          location_entity_id: 'loc-pickup',
          lat: 37.78,
          lng: -122.4,
          start_time: '2026-08-21T23:00:00.000Z',
        }),
        row({ location_entity_id: 'loc-airport', lat: 33.68, lng: -117.86, start_time: WEEKDAY_WORK_HOUR }),
        row({
          location_entity_id: 'loc-airport',
          lat: 33.68,
          lng: -117.86,
          start_time: plusDays(WEEKDAY_WORK_HOUR, 9),
        }),
        row({ location_entity_id: 'loc-trip', lat: 42.36, lng: -71.09, start_time: WEEKDAY_NIGHT_HOUR }),
        row({
          location_entity_id: 'loc-trip',
          lat: 42.36,
          lng: -71.09,
          start_time: plusDays(WEEKDAY_NIGHT_HOUR, 1),
        }),
      ]);

      const candidates = await service.buildKnownPlaces(CONTEXT);

      expect(candidates).toHaveLength(3);
      expect(candidates.map((c) => c.kind)).toEqual(['other', 'other', 'other']);
    });

    it.each([
      ['home', WEEKDAY_NIGHT_HOUR],
      ['work', WEEKDAY_WORK_HOUR],
    ] as const)('needs a third week before tagging a place %s', async (kind, startTime) => {
      const { service: twoWeeks } = makeService(
        weekly(2, { location_entity_id: 'loc-1', start_time: startTime }),
      );
      const { service: threeWeeks } = makeService(
        weekly(3, { location_entity_id: 'loc-1', start_time: startTime }),
      );

      expect((await twoWeeks.buildKnownPlaces(CONTEXT))[0].kind).toBe('other');
      expect((await threeWeeks.buildKnownPlaces(CONTEXT))[0].kind).toBe(kind);
    });

    it('treats a trip as one burst, however many nights it lasts', async () => {
      const { service } = makeService([
        // A hotel: six nights running from Monday, two events a night, all in one week.
        ...[0, 1, 2, 3, 4, 5].flatMap((night) => [
          row({
            location_entity_id: 'loc-hotel',
            lat: 1,
            lng: 1,
            start_time: plusDays('2026-08-17T21:30:00.000Z', night),
          }),
          row({
            location_entity_id: 'loc-hotel',
            lat: 1,
            lng: 1,
            start_time: plusDays('2026-08-17T23:30:00.000Z', night),
          }),
        ]),
        ...weekly(3, { location_entity_id: 'loc-home', start_time: WEEKDAY_NIGHT_HOUR }),
      ]);

      const kinds = kindsById(await service.buildKnownPlaces(CONTEXT));

      expect(kinds.get('loc-home')).toBe('home');
      expect(kinds.get('loc-hotel')).toBe('other');
    });

    it('does not make a week-long business trip Work, however many weekdays it fills', async () => {
      const { service } = makeService([
        // A conference: every weekday of one week, twice a day.
        ...[0, 1, 2, 3, 4].flatMap((day) => [
          row({
            location_entity_id: 'loc-conference',
            lat: 1,
            lng: 1,
            start_time: plusDays('2026-08-17T10:00:00.000Z', day),
          }),
          row({
            location_entity_id: 'loc-conference',
            lat: 1,
            lng: 1,
            start_time: plusDays('2026-08-17T14:00:00.000Z', day),
          }),
        ]),
        ...weekly(3, { location_entity_id: 'loc-office', start_time: WEEKDAY_WORK_HOUR }),
      ]);

      const kinds = kindsById(await service.buildKnownPlaces(CONTEXT));

      expect(kinds.get('loc-office')).toBe('work');
      expect(kinds.get('loc-conference')).toBe('other');
    });

    it('ranks qualifying places by nights, not by the share of their events at night', async () => {
      const { service } = makeService([
        // Home: nights in five weeks, and ten weekend daytime events besides. A third at night.
        ...weekly(5, { location_entity_id: 'loc-home', start_time: WEEKDAY_NIGHT_HOUR }),
        ...weekly(5, { location_entity_id: 'loc-home', start_time: WEEKEND_WORK_HOUR }),
        ...weekly(5, { location_entity_id: 'loc-home', start_time: plusDays(WEEKEND_WORK_HOUR, 1) }),
        // A weekly night out: three weeks, every event at night.
        ...weekly(3, {
          location_entity_id: 'loc-bar',
          lat: 1,
          lng: 1,
          start_time: '2026-08-21T22:30:00.000Z',
        }),
      ]);

      const kinds = kindsById(await service.buildKnownPlaces(CONTEXT));

      expect(kinds.get('loc-home')).toBe('home');
      expect(kinds.get('loc-bar')).toBe('other');
    });

    it('counts a busy evening as one night', async () => {
      const { service } = makeService([
        // Three nights in three weeks, four events each night: twelve night events.
        ...['22:00', '22:30', '23:00', '23:30'].flatMap((time) =>
          weekly(3, {
            location_entity_id: 'loc-party',
            lat: 1,
            lng: 1,
            start_time: `2026-08-21T${time}:00.000Z`,
          }),
        ),
        // Four nights in four weeks, one event each.
        ...weekly(4, { location_entity_id: 'loc-home', start_time: WEEKDAY_NIGHT_HOUR }),
      ]);

      const kinds = kindsById(await service.buildKnownPlaces(CONTEXT));

      expect(kinds.get('loc-home')).toBe('home');
      expect(kinds.get('loc-party')).toBe('other');
    });

    it('counts an after-midnight event toward the evening before when it counts weeks', async () => {
      // 2026-08-16 is a Sunday. Sunday 23:30 and Monday 00:30 are one Sunday
      // night, so these three events are two nights in two weeks. Keyed by
      // their calendar dates they would span three weeks, and read as Home.
      const sundayNights = [
        '2026-08-16T23:30:00.000Z',
        '2026-08-17T00:30:00.000Z',
        '2026-08-24T00:30:00.000Z',
      ].map((start_time) => row({ location_entity_id: 'loc-home', start_time }));
      const { service: twoWeeks } = makeService(sundayNights);
      const { service: threeWeeks } = makeService([
        ...sundayNights,
        row({ location_entity_id: 'loc-home', start_time: '2026-08-31T00:30:00.000Z' }),
      ]);

      expect((await twoWeeks.buildKnownPlaces(CONTEXT))[0].kind).toBe('other');
      expect((await threeWeeks.buildKnownPlaces(CONTEXT))[0].kind).toBe('home');
    });
  });

  it('queries only this user’s geolocated events, scoped by user_id in the WHERE clause', async () => {
    const { service, query } = makeService([]);

    await service.buildKnownPlaces(CONTEXT);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain('event.user_id = $1');
    expect(sql).toContain('event.location_coordinates IS NOT NULL');
    expect(sql).toContain('entity.name');
    expect(sql).toContain("entity.entity_type = 'Event'");
    expect(sql).toContain('event.event_id');
    expect(params?.[0]).toBe(USER);
  });

  it('leaves temporal estimates out of the read, including ones the legacy reverse leg relabelled', async () => {
    // The filtering is SQL, so what it does is proven against Postgres in
    // KnownPlacesService.integration.spec.ts. This pins the tokens, which are
    // copies of the estimator's (see LOCATION_SOURCE_ESTIMATED): a drift
    // there turns the filter off, and nothing else would notice.
    const { service, query } = makeService([]);

    await service.buildKnownPlaces(CONTEXT);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain("COALESCE(event.metadata->>'location_source', '') <> $2");
    expect(sql).toContain("COALESCE(event.inference_sources->>'method', '') = $4");
    expect(params?.slice(0, 4)).toEqual([USER, 'estimated', 'reverse_geocoded', 'temporal_nn']);
  });

  it('leaves deleted, predicted and did-not-happen events out of the read', async () => {
    // Also proven against Postgres in KnownPlacesService.integration.spec.ts.
    // The status test is the calendar's own LIVE_EVENT_SQL rather than a copy,
    // because DEAD_EVENT_STATUSES is shared precisely so its copies cannot
    // drift apart. The reservation key IS a copy (see
    // RESERVATION_CANCELED_KEY), so it is pinned here.
    const { service, query } = makeService([]);

    await service.buildKnownPlaces(CONTEXT);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain('event.is_deleted IS NOT TRUE');
    expect(sql).toContain('event.is_predicted IS NOT TRUE');
    expect(sql).toContain(LIVE_EVENT_SQL);
    expect(sql).toContain("COALESCE(event.metadata->>$5, '') <> 'true'");
    expect(params[4]).toBe('Canceled');
  });

  it('keeps the newest event titles so an unnamed cluster can be recognized', async () => {
    const { service } = makeService([
      row({
        location_name: null,
        event_id: 'evt-old',
        title: 'Older coffee',
        start_time: '2026-08-15T10:00:00.000Z',
      }),
      row({
        location_name: null,
        event_id: 'evt-new',
        title: 'Morning run',
        start_time: '2026-08-19T10:00:00.000Z',
      }),
    ]);

    const [candidate] = await service.buildKnownPlaces(CONTEXT);

    expect(candidate.label).toBe('Unknown place');
    expect(candidate.eventCount).toBe(2);
    expect(candidate.sampleEvents.map((event) => event.title)).toEqual(['Morning run', 'Older coffee']);
  });
});
