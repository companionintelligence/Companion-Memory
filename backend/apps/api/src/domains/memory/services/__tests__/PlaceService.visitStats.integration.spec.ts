import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import {
  EVENT_LIFECYCLE_CASES,
  EVENT_STATUSES,
  HAPPENED,
  eventStatusVocabulary,
  insertEvent,
  type EventLifecycle,
} from '../../../__tests__/support/eventLifecycleFixtures';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { PlaceService } from '../PlaceService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AN EVENT THAT DID NOT HAPPEN IS NOT A VISIT TO ITS PLACE. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `PlaceService.getVisitStats` (reached from `PlaceType.visitStats`) counted
 * every event linked to a place, with no liveness filter: a deleted, predicted
 * or cancelled event was a visit and moved the first and last visit dates. It
 * now applies `EVENT_HAPPENED_SQL`, the rule Known places applies. The read is
 * the one place that can be right whoever linked the event, and the writers
 * differ: `promote.place` refuses such events, but the legacy
 * `GeocodeBatchListener` and the importers link them, and an event cancelled
 * after it was linked keeps its link. So every event here is linked by a plain
 * UPDATE, as those writers do, and no writer is run.
 *
 * What only a real database can show, and a stubbed `query` agrees with
 * unconditionally:
 *
 *  1. every status `ci.events` allows is classified (the shared case table is
 *     checked against the live CHECK constraint);
 *  2. each case in that table, linked alone to its own place, is a visit only if
 *     it happened, and gives that place a first and last visit date only if so;
 *  3. dead events at both ends of a place's history do not move its first and
 *     last visit dates;
 *  4. what the count does to `status`, which is judged like any other zero.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database, or run `make test-db ARGS=PlaceService.visitStats.integration`.
 * Every fixture belongs to a synthetic user and is deleted in `afterAll`.
 */
const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/PlaceService.visitStats.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

// `status` depends on whether geocoding is configured, which is the process's
// environment. The tests decide it, so that only `ci.pipeline_state` varies.
const mockGeocodingConfigured = jest.fn<boolean, []>();

// `__esModule` is not enumerable, so the spread drops it, and without it the
// default export (`config`) is read off the wrong object.
jest.mock('@ci/configuration', () => ({
  ...jest.requireActual('@ci/configuration'),
  __esModule: true,
  isGeocodingConfigured: () => mockGeocodingConfigured(),
}));

const DAY_MS = 86_400_000;
const FIRST_DAY = Date.parse('2019-03-04T15:00:00Z');

/** `day` days after the first, at a fixed hour. Far in the past: nothing here is upcoming. */
const day = (n: number): number => FIRST_DAY + n * DAY_MS;

interface Seeded {
  placeId: string;
  eventId: string;
  at: number;
}

describeWithDb(`PlaceService.getVisitStats against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: PlaceService;
  let ctx: UserServiceContext;
  let strangerId: string;

  /** One place per lifecycle case, holding that case's event and no other. */
  const byCase = new Map<string, Seeded>();

  const query = (sql: string, params?: unknown[]): Promise<unknown> => dataSource.query(sql, params);

  async function seedPlace(owner: string, name: string): Promise<string> {
    const id = uuidv7();

    await query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, 'Location', $2, '{}'::jsonb, $3)`,
      [id, name, owner],
    );

    return id;
  }

  /** An event of `owner`'s, linked to `placeId` the way the legacy writers do: after the fact. */
  async function seedLinkedEvent(
    owner: string,
    placeId: string,
    title: string,
    at: number,
    lifecycle: EventLifecycle = HAPPENED,
  ): Promise<string> {
    const id = uuidv7();

    await insertEvent(query, owner, { id, title, at, lifecycle, point: null });
    await query('UPDATE ci.events SET location_entity_id = $2 WHERE event_id = $1', [id, placeId]);

    return id;
  }

  /** What `PlaceType.visitStats` reads for one place, with the dates as instants. */
  async function statsOf(placeId: string) {
    const stats = (await service.getVisitStats(ctx, [placeId])).get(placeId)!;

    return {
      visitCount: stats.visitCount,
      firstVisitAt: stats.firstVisitAt?.getTime() ?? null,
      lastVisitAt: stats.lastVisitAt?.getTime() ?? null,
      status: stats.status,
    };
  }

  /** Outstanding work of the stages the status looks at, on `eventId`, until `fn` returns. */
  async function withLedgerRow<T>(eventId: string, status: string, fn: () => Promise<T>): Promise<T> {
    await query(
      `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, stage_version, status, reason, user_id)
       VALUES ('event', $1, 'promote.place', 1, $2, 'integration test', $3)`,
      [eventId, status, ctx.userId],
    );

    try {
      return await fn();
    } finally {
      await query('DELETE FROM ci.pipeline_state WHERE entity_id = $1', [eventId]);
    }
  }

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });

    if (connection == null) {
      throw new Error('databaseAvailability passed but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
    });
    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/PlaceService.visitStats.integration');

    ctx = { userId: await createSyntheticTestUser(query, 'PlaceVisitStats') } as UserServiceContext;
    strangerId = await createSyntheticTestUser(query, 'PlaceVisitStatsStranger');

    // `getVisitStats` only reads, through the repository's manager.
    service = new PlaceService({ manager: dataSource.manager } as never, {} as never, {} as never);

    for (const [index, lifecycleCase] of EVENT_LIFECYCLE_CASES.entries()) {
      const placeId = await seedPlace(ctx.userId, `Venue of: ${lifecycleCase.name}`);
      const at = day(index);
      const eventId = await seedLinkedEvent(
        ctx.userId,
        placeId,
        `Event: ${lifecycleCase.name}`,
        at,
        lifecycleCase.lifecycle,
      );

      byCase.set(lifecycleCase.name, { placeId, eventId, at });
    }
  });

  beforeEach(() => {
    mockGeocodingConfigured.mockReturnValue(true);
  });

  afterEach(() => {
    mockGeocodingConfigured.mockReset();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      const users = [ctx?.userId, strangerId].filter(Boolean);

      await query('DELETE FROM ci.pipeline_state WHERE user_id = ANY($1)', [users]);
      await query('DELETE FROM ci.graph_deltas WHERE owner_user_id = ANY($1)', [users]);
      await query('DELETE FROM ci.events WHERE user_id = ANY($1)', [users]);
      await query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1)', [users]);
      await query('DELETE FROM ci.users WHERE id = ANY($1)', [users]);

      // Before `destroy()`: the lock is held on a connection from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('classifies every status ci.events allows', async () => {
    // A status added to the CHECK constraint fails here until the shared case
    // table says whether an event carrying it happened.
    expect([...(await eventStatusVocabulary(query))].sort()).toEqual([...EVENT_STATUSES].sort());
  });

  it.each(EVENT_LIFECYCLE_CASES.map((c) => [c.name, c.happened] as const))(
    '%s (happened: %s) is a visit, and dates one, only if it happened',
    async (name, happened) => {
      const seeded = byCase.get(name)!;

      // Always really linked: leaving it out is the rule's doing, not the fixture's.
      expect(
        await query('SELECT location_entity_id FROM ci.events WHERE event_id = $1', [seeded.eventId]),
      ).toEqual([{ location_entity_id: seeded.placeId }]);

      expect(await statsOf(seeded.placeId)).toEqual(
        happened
          ? { visitCount: 1, firstVisitAt: seeded.at, lastVisitAt: seeded.at, status: 'confirmed' }
          : { visitCount: 0, firstVisitAt: null, lastVisitAt: null, status: 'confirmed' },
      );
    },
  );

  it('counts the visits that happened and dates the place from those alone', async () => {
    // A deleted import at one end of the history and a cancelled meeting at
    // the other. Counted, they would have made the first visit earlier and the
    // last one later, and added two visits.
    const placeId = await seedPlace(ctx.userId, 'Studio');

    await seedLinkedEvent(ctx.userId, placeId, 'Deleted, before', day(100), { ...HAPPENED, isDeleted: true });
    await seedLinkedEvent(ctx.userId, placeId, 'Class', day(110));
    await seedLinkedEvent(ctx.userId, placeId, 'Tentative class', day(120), {
      ...HAPPENED,
      status: 'tentative',
    });
    await seedLinkedEvent(ctx.userId, placeId, 'Cancelled, after', day(130), {
      ...HAPPENED,
      status: 'cancelled',
    });

    expect(await statsOf(placeId)).toEqual({
      visitCount: 2,
      firstVisitAt: day(110),
      lastVisitAt: day(120),
      status: 'confirmed',
    });
  });

  it("does not count another user's event, even one linked to this user's place", async () => {
    const placeId = await seedPlace(ctx.userId, 'Shared address');

    await seedLinkedEvent(ctx.userId, placeId, 'Mine', day(200));
    await seedLinkedEvent(strangerId, placeId, "Someone else's", day(210));

    expect(await statsOf(placeId)).toMatchObject({ visitCount: 1, firstVisitAt: day(200) });
  });

  it('answers a whole batch at once, a zero for a place with nothing linked and for one with only dead links', async () => {
    const live = await seedPlace(ctx.userId, 'Batch: live');
    const dead = await seedPlace(ctx.userId, 'Batch: dead');
    const empty = await seedPlace(ctx.userId, 'Batch: empty');

    await seedLinkedEvent(ctx.userId, live, 'Went', day(300));
    await seedLinkedEvent(ctx.userId, dead, 'Called off', day(310), { ...HAPPENED, status: 'cancelled' });

    const stats = await service.getVisitStats(ctx, [live, dead, empty]);

    expect([...stats.keys()]).toEqual([live, dead, empty]);
    expect(stats.get(live)).toMatchObject({ visitCount: 1, status: 'confirmed' });
    expect(stats.get(dead)).toMatchObject({ visitCount: 0, firstVisitAt: null, lastVisitAt: null });
    expect(stats.get(empty)).toMatchObject({ visitCount: 0, firstVisitAt: null, lastVisitAt: null });
  });

  describe('status of a place whose count the filter changed', () => {
    it('is a confirmed zero once nothing is outstanding, as for any place nobody visits', async () => {
      const placeId = await seedPlace(ctx.userId, 'Status: only called off');

      await seedLinkedEvent(ctx.userId, placeId, 'Called off', day(400), {
        ...HAPPENED,
        status: 'cancelled',
      });

      expect(await statsOf(placeId)).toMatchObject({ visitCount: 0, status: 'confirmed' });
    });

    it('is a pending zero while place promotion has work outstanding, as for any zero', async () => {
      const placeId = await seedPlace(ctx.userId, 'Status: only called off, work pending');
      const outstanding = await seedLinkedEvent(
        ctx.userId,
        await seedPlace(ctx.userId, 'Elsewhere'),
        'Next',
        day(410),
      );

      await seedLinkedEvent(ctx.userId, placeId, 'Called off', day(420), {
        ...HAPPENED,
        status: 'cancelled',
      });

      await withLedgerRow(outstanding, 'pending', async () => {
        expect(await statsOf(placeId)).toMatchObject({ visitCount: 0, status: 'pending_enrichment' });
      });

      // And it settles once the work is done, with nothing else changed.
      expect(await statsOf(placeId)).toMatchObject({ visitCount: 0, status: 'confirmed' });
    });

    it('stays confirmed for a place with a visit that happened, whatever is outstanding', async () => {
      const placeId = await seedPlace(ctx.userId, 'Status: went and called off');
      const went = await seedLinkedEvent(ctx.userId, placeId, 'Went', day(430));

      await seedLinkedEvent(ctx.userId, placeId, 'Called off', day(440), {
        ...HAPPENED,
        status: 'cancelled',
      });

      await withLedgerRow(went, 'pending', async () => {
        expect(await statsOf(placeId)).toEqual({
          visitCount: 1,
          firstVisitAt: day(430),
          lastVisitAt: day(430),
          status: 'confirmed',
        });
      });
    });

    it('still reads work left on an event that did not happen as outstanding, because it is per user', async () => {
      // THE LIMIT, pinned so it is a known one rather than an assumption. The
      // outstanding-work test does not ask which event the work is for, and the
      // `promote.place` sweep gates every arm, the retry arm included, on the
      // event having happened, so a row that failed before the event was
      // cancelled is never retried and stays failed. It errs towards not
      // stating a zero that is not yet known. Narrowing it to events that
      // happened would be a decision, and has to change this test.
      const placeId = await seedPlace(ctx.userId, 'Status: failed before it was called off');
      const calledOff = await seedLinkedEvent(ctx.userId, placeId, 'Called off', day(450), {
        ...HAPPENED,
        status: 'cancelled',
      });

      await withLedgerRow(calledOff, 'failed', async () => {
        expect(await statsOf(placeId)).toMatchObject({ visitCount: 0, status: 'pending_enrichment' });
      });
    });
  });
});
