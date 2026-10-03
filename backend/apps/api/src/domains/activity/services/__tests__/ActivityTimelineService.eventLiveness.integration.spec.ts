import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { BaseEntity, CalendarEventService, EventBaseEntity, EventEntity } from '@ci/domains/memory';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import {
  EVENT_LIFECYCLE_CASES,
  EVENT_STATUSES,
  HAPPENED,
  eventStatusVocabulary,
  insertEvent,
  type EventLifecycle,
} from '../../../__tests__/support/eventLifecycleFixtures';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ActivityRollupService } from '../ActivityRollupService';
import { ActivityTimelineService } from '../ActivityTimelineService';
import type { ActivityTimelineFilters } from '../activityTimelineTypes';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE EVENTS THE ACTIVITY HEATMAP COUNTS ARE THE EVENTS THE LIST SHOWS. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The heatmap beside the Memory list says how many rows the list holds for each
 * day, and a drag across it sets the list's date range. For events it reads two
 * ways: the rollup (`CalendarEventService.aggregateHourlyActivity`) when no
 * filter is on, and `getFilteredEventDailyCounts` when the What / Who / Where /
 * How filters are. The second had no liveness clause at all, so a deleted event
 * counted on its day, and only while a filter was on.
 *
 * THE RULE, AND WHAT IT LEAVES COUNTED. The list's reader
 * (`CalendarEventService.applyEventFilters`, shared by its rows, its
 * `totalCount` and the map pins) drops only tombstoned events. A cancelled,
 * no-show, skipped or predicted event, and a Takeout reservation cancelled in
 * its metadata, are rows the list shows, so they stay in a day's count. The
 * place readers' `EVENT_HAPPENED_SQL` answers a different question (where the
 * user was) and would have the rail count fewer events than the list it sits
 * beside. This spec pins that both ways: deleted is out, and every other case
 * in the shared lifecycle table is in.
 *
 * WHAT IT RUNS, none of which a stubbed `query` can show:
 *
 *  1. each case in the shared lifecycle table, alone on its own day, under every
 *     filter the query takes and under none (the rollup);
 *  2. the heatmap against the list's own reader, day by day, so that the two
 *     cannot drift apart without this failing;
 *  3. one day with a filter that keeps every event and with no filter at all, so
 *     that a day cannot show two counts;
 *  4. what the query had no test for: the user, the local-day window, and each
 *     of the type, connector, who and where filters.
 *
 * The rollup rows are the real aggregator's output, written for the spec's own
 * users only: `refreshAll()` would rewrite every user's rows for every source.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database, or run `make test-db ARGS=ActivityTimelineService.eventLiveness`.
 * Every fixture belongs to a synthetic user and is deleted in `afterAll`.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(
    `[activity/ActivityTimelineService.eventLiveness.integration] SKIPPED — ${availability.reason}`,
  );
}

jest.setTimeout(60_000);

/**
 * Every day below is in January, when Los Angeles is on standard time (UTC-8)
 * and no daylight-saving change is near, so a local hour is a fixed UTC hour.
 * The service takes the user's zone from `UserService`, stubbed to this.
 */
const ZONE = 'America/Los_Angeles';
const UTC_OFFSET_HOURS = 8;

/** The instant at `hour:minute` local time on `day` January `year`, in epoch ms. */
const atLocal = (year: number, day: number, hour: number, minute = 0): number =>
  Date.UTC(year, 0, day, hour + UTC_OFFSET_HOURS, minute);

/** `yyyy-MM-dd`, the shape the service takes and returns. A day past 31 rolls into February. */
const isoDay = (year: number, day: number): string =>
  new Date(Date.UTC(year, 0, day)).toISOString().slice(0, 10);

/** The span of one local day, closed at both ends as the list's `startTime` / `endTime` are. */
const localDay = (year: number, day: number): { startTime: Date; endTime: Date } => ({
  startTime: new Date(atLocal(year, day, 0)),
  endTime: new Date(atLocal(year, day + 1, 0) - 1),
});

/** One case per day, in 2019. Each day also holds a live decoy and a stranger's event. */
const LIFECYCLE_YEAR = 2019;
const LIFECYCLE_DAYS = EVENT_LIFECYCLE_CASES.map((_, index) => 8 + index);
const LIFECYCLE_WINDOW = {
  start: isoDay(LIFECYCLE_YEAR, LIFECYCLE_DAYS[0]),
  end: isoDay(LIFECYCLE_YEAR, LIFECYCLE_DAYS[LIFECYCLE_DAYS.length - 1]),
};

/** One local day with events on both sides of each of its edges, in 2018. */
const EDGE_YEAR = 2018;
const EDGE_DAY = 15;

/** One day mixing live, called-off, predicted and deleted events, in 2017. */
const MIXED_YEAR = 2017;
const MIXED_DAY = 10;

/** A day whose only event was deleted, years before everything else here. */
const ORPHAN_YEAR = 2010;
const ORPHAN_DAY = 12;

/** What the rail asks for: the whole history, as `ActivityTimelineRail` does, to a fixed far end. */
const HISTORY = { start: '1970-01-01', end: '2030-12-31' };

const EVENT_TYPE = 'meeting';
const DECOY_TYPE = 'decoy_type';
const DECOY_SOURCE = 'decoy_source';
const PERSON_NAME = 'Alice Example';
const PLACE_NAME = 'Studio Venue';

/** Every source the lifecycle table's events come from. */
const CASE_SOURCES = [...new Set(EVENT_LIFECYCLE_CASES.map((c) => c.lifecycle.sourceSystem))];

/** The filters the query takes. Each keeps the cases' events and none of the decoys. */
const FILTERS: Array<{ label: string; filters: ActivityTimelineFilters }> = [
  { label: 'event type', filters: { eventTypes: [EVENT_TYPE] } },
  // Case-insensitive substrings, as the list's own Who and Where patterns are.
  { label: 'person', filters: { people: ['ALIC'] } },
  { label: 'place', filters: { places: ['stud'] } },
  // A source is not event-only, so this one takes the other path through the
  // service: every sourced kind, of which only events are included here.
  { label: 'connector', filters: { includeTypes: ['event'], connectors: CASE_SOURCES } },
  {
    label: 'all four',
    filters: { eventTypes: [EVENT_TYPE], people: ['alic'], places: ['STUD'], connectors: CASE_SOURCES },
  },
];

/** No filter: events only, read from the rollup. */
const UNFILTERED: ActivityTimelineFilters = { includeTypes: ['event'] };

const ALL_FILTERS = [...FILTERS, { label: 'no filter', filters: UNFILTERED }];

/** Whether the list shows an event: only a tombstone is hidden from it. */
const listShows = (lifecycle: EventLifecycle): boolean => !lifecycle.isDeleted;

type ListOptions = Parameters<CalendarEventService['countEntitiesForEvents']>[1];

/** The filters as the list's reader takes them. `includeTypes` picks kinds, which the reader does not. */
const listOptions = ({ eventTypes, connectors, people, places }: ActivityTimelineFilters): ListOptions => ({
  eventTypes,
  connectors,
  people,
  places,
});

type PersonLink = 'participant' | 'organizer' | null;
type PlaceLink = 'linked' | 'text' | 'elsewhere';

describeWithDb(`ActivityTimelineService event counts against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let eventService: CalendarEventService;
  let service: ActivityTimelineService;
  let owner: UserServiceContext;
  let stranger: UserServiceContext;
  let aliceId: string;
  let bobId: string;
  let studioId: string;

  const query = (sql: string, params?: unknown[]): Promise<unknown> => dataSource.query(sql, params);

  async function seedEntity(userId: string, type: 'Person' | 'Location', name: string): Promise<string> {
    const id = uuidv7();

    await query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, $2, $3, '{}'::jsonb, $4)`,
      [id, type, name, userId],
    );

    return id;
  }

  /**
   * One event of `userId`'s. It names its person and its place the ways an
   * importer does, so that both arms of the Who filter and of the Where filter
   * are used: the person as a participant or as the organizer, the place by a
   * linked Location or by its venue text alone.
   */
  async function seedEvent(
    userId: string,
    event: {
      title: string;
      at: number;
      lifecycle: EventLifecycle;
      eventType: string;
      person: PersonLink;
      personId?: string;
      place: PlaceLink;
    },
  ): Promise<void> {
    const id = uuidv7();
    const personId = event.personId ?? aliceId;

    await insertEvent(query, userId, {
      id,
      title: event.title,
      at: event.at,
      lifecycle: event.lifecycle,
      point: null,
      locationName:
        event.place === 'text' ? PLACE_NAME : event.place === 'elsewhere' ? 'Somewhere else' : null,
    });
    await query(
      `UPDATE ci.events
          SET event_type = $2,
              participant_entity_ids = $3::uuid[],
              organizer_entity_id = $4,
              location_entity_id = $5
        WHERE event_id = $1`,
      [
        id,
        event.eventType,
        event.person === 'participant' ? [personId] : null,
        event.person === 'organizer' ? personId : null,
        event.place === 'linked' ? studioId : null,
      ],
    );
  }

  /**
   * An event of the owner's that every filter keeps. `arm` picks how it names
   * its person and place: the four combinations are spread over the cases.
   */
  const matching = (title: string, at: number, lifecycle: EventLifecycle, arm = 0) =>
    seedEvent(owner.userId, {
      title,
      at,
      lifecycle,
      eventType: EVENT_TYPE,
      person: arm % 2 === 0 ? 'participant' : 'organizer',
      place: Math.floor(arm / 2) % 2 === 0 ? 'linked' : 'text',
    });

  /** A live event that no filter keeps: another type, source, person and place. */
  const decoy = (title: string, at: number) =>
    seedEvent(owner.userId, {
      title,
      at,
      lifecycle: { ...HAPPENED, sourceSystem: DECOY_SOURCE },
      eventType: DECOY_TYPE,
      person: 'participant',
      personId: bobId,
      place: 'elsewhere',
    });

  /**
   * What the 15-minute cron writes for the events source, for these users and
   * no one else: the real aggregator's rows, upserted as `writeSource` does.
   * `refreshAll()` would also rewrite every other source, for every user.
   */
  async function refreshRollup(users: string[]): Promise<void> {
    const buckets = (await eventService.aggregateHourlyActivity()).filter((b) => users.includes(b.userId));

    await query(
      `INSERT INTO ci.activity_rollup (user_id, source, bucket_start, count)
       SELECT user_id, 'events', bucket_start, count
         FROM unnest($1::uuid[], $2::timestamptz[], $3::int[]) AS t(user_id, bucket_start, count)
       ON CONFLICT (user_id, source, bucket_start) DO UPDATE SET count = EXCLUDED.count`,
      [buckets.map((b) => b.userId), buckets.map((b) => b.bucketStart), buckets.map((b) => b.count)],
    );
  }

  /** The heatmap for `filters` as `date -> count`. A day with nothing is absent, as on the wire. */
  async function heatmap(
    filters: ActivityTimelineFilters,
    window: { start: string; end: string } = LIFECYCLE_WINDOW,
    context: UserServiceContext = owner,
  ): Promise<Map<string, number>> {
    const counts = await service.getDailyCounts(context, window.start, window.end, filters);

    return new Map(counts.map(({ date, count }) => [date, count]));
  }

  /** The list's own count of one local day's events under `filters`. */
  const listCount = (year: number, day: number, filters: ActivityTimelineFilters): Promise<number> =>
    eventService.countEntitiesForEvents(owner, { ...localDay(year, day), ...listOptions(filters) });

  /** `read(filters)` under every filter and under none, by label, so a failure names the one that broke. */
  async function byFilter<T>(
    read: (filters: ActivityTimelineFilters) => Promise<T>,
  ): Promise<Record<string, T>> {
    return Object.fromEntries(
      await Promise.all(ALL_FILTERS.map(async ({ label, filters }) => [label, await read(filters)] as const)),
    );
  }

  const lifecycleDate = (index: number): string => isoDay(LIFECYCLE_YEAR, LIFECYCLE_DAYS[index]);

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [EventEntity, BaseEntity, EventBaseEntity, UserEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(dataSource, 'activity/ActivityTimelineService.eventLiveness');

    owner = { userId: await createSyntheticTestUser(query, 'ActivityEventLiveness') } as UserServiceContext;
    stranger = {
      userId: await createSyntheticTestUser(query, 'ActivityEventLivenessStranger'),
    } as UserServiceContext;

    const idle = { aggregateHourlyActivity: async () => [] } as never;
    const users = { findById: async () => ({ timezone: ZONE }) } as never;
    const logger = { setContext: () => undefined } as unknown as LoggerService;

    // `countEntitiesForEvents` and `aggregateHourlyActivity` read through the
    // repository and the data source. Nothing here writes an event through it.
    eventService = new CalendarEventService(
      dataSource.getRepository(EventEntity),
      dataSource.getRepository(EventBaseEntity),
      {} as never,
      dataSource,
      {} as never,
    );
    service = new ActivityTimelineService(
      dataSource,
      new ActivityRollupService(
        dataSource,
        idle,
        eventService,
        idle,
        idle,
        idle,
        idle,
        idle,
        idle,
        users,
        logger,
      ),
      // The query and tag path, which this spec does not take.
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      users,
    );

    aliceId = await seedEntity(owner.userId, 'Person', PERSON_NAME);
    bobId = await seedEntity(owner.userId, 'Person', 'Bob Other');
    studioId = await seedEntity(owner.userId, 'Location', PLACE_NAME);

    // One case per day, beside a live decoy that no filter keeps and a live
    // event of a stranger's that most filters would. A filter or the user clause
    // that stopped working adds a row to every day.
    for (const [index, lifecycleCase] of EVENT_LIFECYCLE_CASES.entries()) {
      const day = LIFECYCLE_DAYS[index];

      await matching(lifecycleCase.name, atLocal(LIFECYCLE_YEAR, day, 12), lifecycleCase.lifecycle, index);
      await decoy(`${lifecycleCase.name}: decoy`, atLocal(LIFECYCLE_YEAR, day, 9));
      await seedEvent(stranger.userId, {
        title: `${lifecycleCase.name}: stranger`,
        at: atLocal(LIFECYCLE_YEAR, day, 12),
        lifecycle: HAPPENED,
        eventType: EVENT_TYPE,
        person: null,
        place: 'text',
      });
    }

    // Both sides of both edges of one local day. Read as UTC days, `before`,
    // `first` and `middle` would be the day, and `last` and `last, too` the next.
    const edge = (hour: number, minute: number, day = EDGE_DAY) => atLocal(EDGE_YEAR, day, hour, minute);

    await matching('edge: before', edge(23, 30, EDGE_DAY - 1), HAPPENED, 0);
    await matching('edge: first', edge(0, 30), HAPPENED, 1);
    await matching('edge: middle', edge(12, 0), HAPPENED, 2);
    await matching('edge: last', edge(23, 30), HAPPENED, 3);
    await matching('edge: last, too', edge(23, 45), HAPPENED, 0);
    await matching('edge: after', edge(0, 30, EDGE_DAY + 1), HAPPENED, 1);

    // One day, seven events, one of them deleted.
    const mixed = (hour: number) => atLocal(MIXED_YEAR, MIXED_DAY, hour);

    await matching('mixed: held', mixed(8), HAPPENED, 0);
    await matching('mixed: tentative', mixed(9), { ...HAPPENED, status: 'tentative' }, 1);
    await matching('mixed: cancelled', mixed(10), { ...HAPPENED, status: 'cancelled' }, 2);
    await matching('mixed: no-show', mixed(11), { ...HAPPENED, status: 'no_show' }, 3);
    await matching('mixed: skipped', mixed(12), { ...HAPPENED, status: 'skipped' }, 0);
    await matching('mixed: predicted', mixed(13), { ...HAPPENED, isPredicted: true }, 1);
    await matching('mixed: deleted', mixed(14), { ...HAPPENED, isDeleted: true }, 2);

    await matching('orphan: deleted', atLocal(ORPHAN_YEAR, ORPHAN_DAY, 12), { ...HAPPENED, isDeleted: true });

    await refreshRollup([owner.userId, stranger.userId]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      const users = [owner?.userId, stranger?.userId].filter(Boolean);

      await query('DELETE FROM ci.graph_deltas WHERE owner_user_id = ANY($1)', [users]);
      await query('DELETE FROM ci.events WHERE user_id = ANY($1)', [users]);
      await query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1)', [users]);
      // The users' `ci.activity_rollup` rows go with them: the foreign key cascades.
      await query('DELETE FROM ci.users WHERE id = ANY($1)', [users]);

      // Before `destroy()`: the lock is held on a connection from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('seeds every status ci.events allows', async () => {
    // A status added to the CHECK constraint fails here until the shared case
    // table seeds it, so that none can start hiding events from the heatmap
    // without a case that says whether it should.
    expect([...(await eventStatusVocabulary(query))].sort()).toEqual([...EVENT_STATUSES].sort());
  });

  describe('which events count', () => {
    it.each(EVENT_LIFECYCLE_CASES.map((c, index) => ({ name: c.name, index })))(
      '$name counts on its own day, under every filter and under none, unless it is deleted',
      async ({ index }) => {
        const shown = listShows(EVENT_LIFECYCLE_CASES[index].lifecycle);
        const date = lifecycleDate(index);
        const { 'no filter': unfiltered, ...filtered } = await byFilter(async (filters) =>
          (await heatmap(filters)).get(date),
        );

        // Absent, not zero, when the event is out: the rail starts its grid at
        // the first day returned.
        expect(filtered).toEqual(
          Object.fromEntries(FILTERS.map(({ label }) => [label, shown ? 1 : undefined])),
        );

        // With no filter the day's live decoy counts as well.
        expect(unfiltered).toBe(shown ? 2 : 1);
      },
    );

    it('counts a day mixing held, called-off, predicted and deleted events by what the list shows', async () => {
      const date = isoDay(MIXED_YEAR, MIXED_DAY);

      // Seven events and only the deleted one is out. Cancelled, no-show and
      // skipped events, and a prediction, are rows the list shows, so they
      // count. Changing that means changing the list and the rollup with it.
      const days = await byFilter(async (filters) => [
        ...(await heatmap(filters, { start: date, end: date })),
      ]);

      expect(days).toEqual(Object.fromEntries(ALL_FILTERS.map(({ label }) => [label, [[date, 6]]])));
      expect(await listCount(MIXED_YEAR, MIXED_DAY, {})).toBe(6);
    });

    it('does not return a day whose only event was deleted, so it cannot set the rail’s scroll bound', async () => {
      // The rail asks for the whole history and starts its grid at the first
      // day returned. A deleted event from 2010 pulled it back there.
      const firstDays = await byFilter(
        async (filters) => [...(await heatmap(filters, HISTORY)).keys()].sort()[0],
      );

      expect(firstDays).toEqual(
        Object.fromEntries(ALL_FILTERS.map(({ label }) => [label, isoDay(MIXED_YEAR, MIXED_DAY)])),
      );
    });
  });

  describe('against the list', () => {
    it('counts each day as many events as the list holds for it, under every filter and under none', async () => {
      const heat: Record<string, Record<string, number>> = {};
      const list: Record<string, Record<string, number>> = {};

      for (const { label, filters } of ALL_FILTERS) {
        const counts = await heatmap(filters);

        heat[label] = {};
        list[label] = {};

        for (const day of LIFECYCLE_DAYS) {
          const date = isoDay(LIFECYCLE_YEAR, day);

          heat[label][date] = counts.get(date) ?? 0;
          list[label][date] = await listCount(LIFECYCLE_YEAR, day, filters);
        }
      }

      expect(heat).toEqual(list);

      // The list is not empty to begin with, or this would agree on nothing.
      const sum = (days: Record<string, number>) => Object.values(days).reduce((total, n) => total + n, 0);
      const shown = EVENT_LIFECYCLE_CASES.filter((c) => listShows(c.lifecycle)).length;

      expect(sum(list['event type'])).toBe(shown);
      expect(sum(list['no filter'])).toBe(shown + EVENT_LIFECYCLE_CASES.length);
    });

    it('counts the mixed day and the edges of a local day as many events as the list does', async () => {
      for (const [year, day] of [
        [MIXED_YEAR, MIXED_DAY],
        [EDGE_YEAR, EDGE_DAY],
      ]) {
        const date = isoDay(year, day);
        const window = { start: date, end: date };

        expect(await byFilter(async (filters) => (await heatmap(filters, window)).get(date))).toEqual(
          await byFilter((filters) => listCount(year, day, filters)),
        );
      }
    });
  });

  describe('with a filter and without', () => {
    it('shows the same count for every day when the filter keeps every event', async () => {
      // Two ways of asking for all of the owner's events. Each takes the
      // filtered query. The baseline reads the rollup. One day, one count.
      const baseline = [...(await heatmap(UNFILTERED))];

      expect(baseline).toHaveLength(LIFECYCLE_DAYS.length);

      for (const filters of [
        { eventTypes: [EVENT_TYPE, DECOY_TYPE] },
        { includeTypes: ['event' as const], connectors: [...CASE_SOURCES, DECOY_SOURCE] },
      ]) {
        expect([...(await heatmap(filters))]).toEqual(baseline);
      }
    });
  });

  describe('the clauses of the filtered query', () => {
    it('counts only the local day asked for, not the events just either side of it', async () => {
      const date = isoDay(EDGE_YEAR, EDGE_DAY);

      // `first`, `middle`, `last` and `last, too`. The rollup agrees: it buckets
      // by the hour in UTC and rolls the hours up into the user's days.
      const days = await byFilter(async (filters) => [
        ...(await heatmap(filters, { start: date, end: date })),
      ]);

      expect(days).toEqual(Object.fromEntries(ALL_FILTERS.map(({ label }) => [label, [[date, 4]]])));
    });

    it('counts only the days inside the window asked for', async () => {
      // The other blocks of events are years from the lifecycle window, and
      // every event in them matches every filter.
      const outside = await byFilter(async (filters) =>
        [...(await heatmap(filters)).keys()].filter(
          (d) => d < LIFECYCLE_WINDOW.start || d > LIFECYCLE_WINDOW.end,
        ),
      );

      expect(outside).toEqual(Object.fromEntries(ALL_FILTERS.map(({ label }) => [label, []])));

      // And a window one day short at each end leaves out the days either side
      // of it, which hold live events that match every filter.
      const inner = { start: lifecycleDate(1), end: lifecycleDate(LIFECYCLE_DAYS.length - 2) };
      const days = await byFilter(async (filters) => [...(await heatmap(filters, inner)).keys()]);

      expect(days).toEqual(
        Object.fromEntries(
          ALL_FILTERS.map(({ label }) => [
            label,
            LIFECYCLE_DAYS.slice(1, -1).map((day) => isoDay(LIFECYCLE_YEAR, day)),
          ]),
        ),
      );
    });

    it('counts only the asking user’s events, and the stranger’s for the stranger', async () => {
      // Every day has a stranger's event that matches every filter but the Who
      // one: it names no person. The owner's counts above leave it out.
      const filters = FILTERS.filter(({ label }) => label !== 'person' && label !== 'all four');
      const days = await Promise.all(
        filters.map(
          async (f) =>
            [f.label, [...(await heatmap(f.filters, LIFECYCLE_WINDOW, stranger)).values()]] as const,
        ),
      );

      expect(Object.fromEntries(days)).toEqual(
        Object.fromEntries(filters.map(({ label }) => [label, LIFECYCLE_DAYS.map(() => 1)])),
      );
    });

    it('keeps an event only if it matches the type, source, person or place asked for', async () => {
      // The decoy is live and in the window. Each filter above leaves it out,
      // and its own filters find it and nothing else.
      const date = lifecycleDate(EVENT_LIFECYCLE_CASES.findIndex((c) => c.name === 'status confirmed'));

      expect([
        (await heatmap({ eventTypes: [DECOY_TYPE] })).get(date),
        (await heatmap({ people: ['bob'] })).get(date),
        (await heatmap({ places: ['somewhere'] })).get(date),
        (await heatmap({ includeTypes: ['event'], connectors: [DECOY_SOURCE] })).get(date),
      ]).toEqual([1, 1, 1, 1]);
    });
  });
});
