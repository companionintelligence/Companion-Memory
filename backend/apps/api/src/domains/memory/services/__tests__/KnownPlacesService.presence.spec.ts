import type { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import {
  type KnownPlaceCandidate,
  KNOWN_PLACE_PRESENCE_SQL,
  KnownPlacesService,
} from '../KnownPlacesService';
import type { PlaceService } from '../PlaceService';

/**
 * Measured presence in `buildKnownPlaces`: how `ci.position` day and night
 * counts join the event clusters, rank them, and pick Home, and that they
 * leave the event rules' own picks alone. `dataSource.query` is mocked (as in
 * KnownPlacesService.buildKnownPlaces.spec.ts) and routed by the table each
 * statement reads. The SQL itself runs against Postgres in
 * KnownPlacesService.presence.integration.spec.ts.
 *
 * The event rows carry no timezone, so the user's clock is UTC here.
 */

const USER = '00000000-0000-0000-0000-0000000000aa';
const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

/** Three Wednesdays, each in a different Monday-based week. */
const WEDNESDAYS = ['2026-08-05', '2026-08-12', '2026-08-19'];
const WEEKEND_HOUR = '2026-08-15T10:00:00.000Z'; // Sat, neither signal

function at(date: string, time: string): string {
  return `${date}T${time}:00.000Z`;
}

/** Grid cells as the SQL returns them: floor(coordinate * 100 + 0.5). */
const HOME_CELL = { latCell: 3566, lngCell: 13975 };
const HOME = { lat: 35.66, lng: 139.75 };
/** Where the event rule finds a night routine of its own. */
const NIGHTSPOT = { lat: 34.69, lng: 135.5 };

interface EventRow {
  event_id?: string | null;
  title?: string | null;
  location_entity_id: string | null;
  location_name: string | null;
  lat: number;
  lng: number;
  start_time: string;
  timezone?: string | null;
}

function eventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    location_entity_id: null,
    location_name: null,
    lat: 40.7128,
    lng: -74.006,
    start_time: WEEKEND_HOUR,
    ...overrides,
  };
}

/** Night events on the three WEDNESDAYS: a routine the event rule would make Home. */
function nightRoutine(overrides: Partial<EventRow> = {}): EventRow[] {
  return WEDNESDAYS.map((date) => eventRow({ ...NIGHTSPOT, start_time: at(date, '22:00'), ...overrides }));
}

/**
 * A row of KNOWN_PLACE_PRESENCE_SQL, typed as node-postgres hands it back
 * (counts arrive as strings). Unless told otherwise, each night falls in a
 * week of its own.
 */
function presenceRow(
  cell: { latCell: number; lngCell: number },
  counts: { days: number; nights: number; nightWeeks?: number; lat?: number; lng?: number },
): Record<string, unknown> {
  return {
    lat_cell: cell.latCell,
    lng_cell: cell.lngCell,
    days: String(counts.days),
    nights: String(counts.nights),
    night_weeks: String(counts.nightWeeks ?? counts.nights),
    lat: counts.lat ?? (cell.latCell + 0.1) / 100,
    lng: counts.lng ?? (cell.lngCell + 0.1) / 100,
  };
}

function makeService(
  options: {
    events?: EventRow[];
    presence?: Array<Record<string, unknown>>;
    /** Distinct days with any fix; stamped on every presence row, as the SQL does. */
    totalDays?: number;
    /** ci.users.timezone, read only when the user has no located events. */
    timezone?: string | null;
  } = {},
) {
  const events = options.events ?? [];
  const presence = (options.presence ?? []).map((row) => ({
    ...row,
    total_days: String(options.totalDays ?? 100),
  }));
  const query = jest.fn(async (sql: string): Promise<unknown[]> => {
    if (sql.includes('ci.position')) {
      return presence;
    }

    if (sql.includes('FROM ci.events')) {
      return events;
    }

    if (sql.includes('FROM ci.users')) {
      return [{ timezone: options.timezone ?? null }];
    }

    throw new Error(`unexpected query: ${sql}`);
  });
  const dataSource = { query } as unknown as DataSource;
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;

  return { service: new KnownPlacesService(dataSource, logger, {} as PlaceService), query };
}

function presenceCall(query: jest.Mock): [string, unknown[]] {
  const calls = query.mock.calls.filter(([sql]) => String(sql).includes('ci.position'));
  expect(calls).toHaveLength(1);

  return calls[0] as [string, unknown[]];
}

function homes(candidates: KnownPlaceCandidate[]): KnownPlaceCandidate[] {
  return candidates.filter((candidate) => candidate.kind === 'home');
}

describe('KnownPlacesService.buildKnownPlaces — measured presence', () => {
  it('reads the newest fixes under the cap, on the user clock, after the event read', async () => {
    const { service, query } = makeService({ events: [eventRow({ timezone: 'America/Los_Angeles' })] });

    await service.buildKnownPlaces(CONTEXT);

    const [sql, params] = presenceCall(query);
    expect(sql).toBe(KNOWN_PLACE_PRESENCE_SQL);
    // user, clock, max accuracy (m), fix cap, cells per degree, night 21:00–06:00, cell cap
    expect(params).toEqual([USER, 'America/Los_Angeles', 100, 200_000, 100, 21, 6, 200]);
    // The cap bounds the read itself: the LIMIT sits on the time-ordered scan,
    // before anything is grouped. A LIMIT after the aggregate would bound only
    // what comes back.
    const recent = sql.slice(sql.indexOf('WITH recent AS'), sql.indexOf('), visits AS'));
    expect(recent).toMatch(/ORDER BY pos\.time DESC\s+LIMIT \$4::int/);
    expect(recent).not.toMatch(/GROUP BY|count\(|avg\(/);
    expect(recent).toContain('pos.user_id = $1::uuid');
    // Weeks are Monday-based, as the event rule's weekOf counts them.
    expect(sql).toContain("count(DISTINCT date_trunc('week', visits.night::timestamp)) AS night_weeks");
    // Events stay the first statement; the estimate-exclusion spec reads calls[0].
    expect(String(query.mock.calls[0][0])).toContain('FROM ci.events');
  });

  it('reads the clock from ci.users for a user with no located events, and falls back to UTC', async () => {
    const paris = makeService({ timezone: 'Europe/Paris' });
    await paris.service.buildKnownPlaces(CONTEXT);
    expect(presenceCall(paris.query)[1][1]).toBe('Europe/Paris');

    const bogus = makeService({ timezone: 'Not/AZone' });
    await bogus.service.buildKnownPlaces(CONTEXT);
    expect(presenceCall(bogus.query)[1][1]).toBe('UTC');

    const unset = makeService({ timezone: null });
    await unset.service.buildKnownPlaces(CONTEXT);
    expect(presenceCall(unset.query)[1][1]).toBe('UTC');
  });

  it('surfaces a place from presence alone, for a user with no located events', async () => {
    const { service } = makeService({
      presence: [presenceRow(HOME_CELL, { days: 12, nights: 4, ...HOME })],
      totalDays: 40,
    });

    const candidates = await service.buildKnownPlaces(CONTEXT);

    expect(candidates).toEqual([
      {
        locationId: null,
        label: 'Unknown place',
        kind: 'home',
        lat: HOME.lat,
        lng: HOME.lng,
        eventCount: 0,
        sampleEvents: [],
        // 0.4 + 12 / 40
        confidence: 0.7,
        presenceDays: 12,
        presenceNights: 4,
      },
    ]);
  });

  it('returns nothing when there are neither located events nor fixes', async () => {
    const { service } = makeService();

    expect(await service.buildKnownPlaces(CONTEXT)).toEqual([]);
  });

  it('joins presence to the grid candidate of its cell, never to a Location in the cell', async () => {
    // On the reference corpus the biggest cluster in the home cell was a
    // Location that 12 estimated calendar events had been pinned to. Presence
    // says the user was in the cell, not at that Location.
    const events = [
      ...Array.from({ length: 12 }, () =>
        eventRow({
          location_entity_id: 'loc-station',
          location_name: 'Station',
          lat: 35.6612,
          lng: 139.7489,
        }),
      ),
      eventRow({ location_name: 'Home street', ...HOME }),
      eventRow({ location_name: null, lat: 35.6588, lng: 139.7511 }),
    ];
    const { service } = makeService({
      events,
      presence: [presenceRow(HOME_CELL, { days: 172, nights: 12, nightWeeks: 11 })],
      totalDays: 555,
    });

    const candidates = await service.buildKnownPlaces(CONTEXT);

    // No second candidate for the cell: presence joined the one the unlinked events built.
    expect(candidates).toHaveLength(2);
    expect(candidates.find((candidate) => candidate.locationId === null)).toMatchObject({
      label: 'Home street',
      kind: 'home',
      eventCount: 2,
      presenceDays: 172,
      presenceNights: 12,
    });
    expect(candidates.find((candidate) => candidate.locationId === 'loc-station')).toMatchObject({
      kind: 'other',
      eventCount: 12,
      presenceDays: 0,
      presenceNights: 0,
    });
  });

  it('puts an event in the cell the SQL computes for the same coordinate, at half-way values too', async () => {
    // 139.765 is where Postgres' round(x::numeric, 2) (139.77) parts ways with
    // JavaScript. Both sides now take floor(x * 100 + 0.5): 13976.
    const { service } = makeService({
      events: [eventRow({ lat: 35.67, lng: 139.765, location_name: 'Corner' })],
      presence: [presenceRow({ latCell: 3567, lngCell: 13976 }, { days: 3, nights: 0 })],
    });

    const candidates = await service.buildKnownPlaces(CONTEXT);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ label: 'Corner', eventCount: 1, presenceDays: 3 });
  });

  it("names Home from presence over the event rule's own night routine", async () => {
    const withoutPresence = makeService({ events: nightRoutine() });
    expect(homes(await withoutPresence.service.buildKnownPlaces(CONTEXT))).toEqual([
      expect.objectContaining({ eventCount: 3, presenceDays: 0 }),
    ]);

    const { service } = makeService({
      events: nightRoutine(),
      presence: [presenceRow(HOME_CELL, { days: 9, nights: 3, nightWeeks: 3 })],
    });

    const candidates = await service.buildKnownPlaces(CONTEXT);

    expect(homes(candidates)).toEqual([expect.objectContaining({ presenceDays: 9, eventCount: 0 })]);
    expect(candidates.find((candidate) => candidate.eventCount === 3)?.kind).toBe('other');
  });

  it('ranks Home by presence days, breaks a tie by nights, and needs nights in three different weeks', async () => {
    const { service } = makeService({
      presence: [
        // The most days and plenty of nights, but every night in two weeks: a stay.
        presenceRow({ latCell: 3567, lngCell: 13969 }, { days: 200, nights: 9, nightWeeks: 2 }),
        // The most nights, on few days.
        presenceRow({ latCell: 3568, lngCell: 13977 }, { days: 36, nights: 15, nightWeeks: 8 }),
        presenceRow(HOME_CELL, { days: 172, nights: 12, nightWeeks: 11 }),
        presenceRow({ latCell: 3567, lngCell: 13975 }, { days: 172, nights: 11, nightWeeks: 10 }),
      ],
      totalDays: 555,
    });

    const candidates = await service.buildKnownPlaces(CONTEXT);

    expect(homes(candidates)).toEqual([expect.objectContaining({ presenceDays: 172, presenceNights: 12 })]);
  });

  it.each([
    ['nights in two weeks', false, { days: 60, nights: 10, nightWeeks: 2 }],
    ['no nights at all', false, { days: 90, nights: 0, nightWeeks: 0 }],
    ['nights in three weeks', true, { days: 3, nights: 3, nightWeeks: 3 }],
  ])('with %s of presence, presence names Home: %s', async (_label, presenceWins, counts) => {
    const { service } = makeService({
      events: nightRoutine({ location_entity_id: 'loc-night' }),
      presence: [presenceRow(HOME_CELL, counts)],
    });

    const candidates = await service.buildKnownPlaces(CONTEXT);

    expect(homes(candidates)).toEqual([
      presenceWins
        ? expect.objectContaining({ presenceDays: counts.days, locationId: null })
        : expect.objectContaining({ locationId: 'loc-night' }),
    ]);
  });

  it("keeps Work the event rule's pick when presence pushes it out of the top 50", async () => {
    const events = [
      // The event rule's Work: weekday mornings in three different weeks.
      ...WEDNESDAYS.map((date) => eventRow({ lat: 35.68, lng: 139.7, start_time: at(date, '10:00') })),
      // One weekday 9–5 event in a cell with plenty of GPS: a high rank, no routine.
      eventRow({ lat: 35.67, lng: 139.69, start_time: at(WEDNESDAYS[2], '11:00') }),
    ];
    const presence = [
      presenceRow(HOME_CELL, { days: 172, nights: 12 }),
      presenceRow({ latCell: 3567, lngCell: 13969 }, { days: 150, nights: 8 }),
      // Sixty more cells of GPS, each out-ranking three events.
      ...Array.from({ length: 60 }, (_, index) =>
        presenceRow({ latCell: 4000 + index, lngCell: -10000 }, { days: 10 + index, nights: 0 }),
      ),
    ];
    const { service } = makeService({ events, presence, totalDays: 555 });

    const candidates = await service.buildKnownPlaces(CONTEXT);

    expect(candidates).toHaveLength(50);
    expect(candidates.filter((candidate) => candidate.kind === 'work')).toEqual([
      expect.objectContaining({ eventCount: 3, presenceDays: 0 }),
    ]);
    // Kept, and in rank order: it takes the last place.
    expect(candidates[49]).toMatchObject({ kind: 'work', eventCount: 3 });
    expect(candidates.find((candidate) => candidate.presenceDays === 150)?.kind).toBe('other');
    expect(homes(candidates)).toEqual([expect.objectContaining({ presenceDays: 172 })]);
  });

  it('keeps a presence Home in the list when clusters with many events outrank it', async () => {
    const events = Array.from({ length: 60 }, (_, cluster) =>
      Array.from({ length: 30 }, () => eventRow({ location_entity_id: `loc-${cluster}` })),
    ).flat();
    const { service } = makeService({ events, presence: [presenceRow(HOME_CELL, { days: 20, nights: 5 })] });

    const candidates = await service.buildKnownPlaces(CONTEXT);

    expect(candidates).toHaveLength(50);
    expect(candidates[49]).toMatchObject({ kind: 'home', presenceDays: 20, eventCount: 0 });
    expect(homes(candidates)).toHaveLength(1);
  });

  it('ranks by events plus presence days and pools both into the confidence', async () => {
    const events = [
      ...Array.from({ length: 12 }, () => eventRow({ location_entity_id: 'loc-busy' })),
      ...Array.from({ length: 3 }, () => eventRow({ ...HOME })),
    ];
    const { service } = makeService({
      events,
      presence: [presenceRow(HOME_CELL, { days: 10, nights: 0 })],
      totalDays: 30,
    });

    const candidates = await service.buildKnownPlaces(CONTEXT);

    // 3 events + 10 days = 13 outranks 12 events; the pool is 15 events + 30 days.
    expect(candidates.map((candidate) => [candidate.locationId, candidate.confidence])).toEqual([
      [null, Number((0.4 + 13 / 45).toFixed(3))],
      ['loc-busy', Number((0.4 + 12 / 45).toFixed(3))],
    ]);
  });

  it('skips a presence row it cannot read rather than inventing a cell', async () => {
    const { service } = makeService({
      presence: [
        { ...presenceRow(HOME_CELL, { days: 9, nights: 3 }), lat_cell: null },
        { ...presenceRow({ latCell: 3566, lngCell: 13976 }, { days: 9, nights: 3 }), night_weeks: null },
        presenceRow({ latCell: 3568, lngCell: 13977 }, { days: 0, nights: 0 }),
        presenceRow({ latCell: 3567, lngCell: 13969 }, { days: 8, nights: 2 }),
      ],
    });

    const candidates = await service.buildKnownPlaces(CONTEXT);

    expect(candidates.map((candidate) => candidate.presenceDays)).toEqual([8]);
  });
});
