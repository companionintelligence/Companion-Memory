import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import {
  EVENT_LIFECYCLE_CASES,
  HAPPENED,
  insertEvent,
  type EventLifecycle,
} from '../../../__tests__/support/eventLifecycleFixtures';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { PlaceService } from '../PlaceService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PLACE APPEARS IN A DATE WINDOW ONLY FOR A VISIT THAT HAPPENED. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * With a date filter, the Places browse (`PlaceService.getEntitiesForPlaces`
 * and `countEntitiesForPlaces`, through `appearanceBrowse.ts`) lists a place
 * when an event linked to it starts in the window, and dates it from the
 * earliest such event: `PlaceType.appearedAt`, "first real visit inside the
 * active search date window". It excluded the events whose time is the import
 * wall clock and nothing else, so a place appeared in "last week" because of a
 * meeting that was cancelled, a photo the user deleted, or a prediction, and
 * was dated from it. It now applies `EVENT_HAPPENED_SQL`, as a place's visit
 * count does (see `PlaceService.visitStats.integration.spec.ts`).
 *
 * The People browse shares the window predicate and is NOT changed: an
 * organizer or participant of a cancelled meeting still appears. Whether they
 * should is a different question from whether the user was at a place.
 *
 * Every event is linked by a plain UPDATE, as the legacy writers do, and no
 * writer is run. Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to
 * a migrated database, or run
 * `make test-db ARGS=PlaceService.appearance.integration`. Every fixture
 * belongs to a synthetic user and is deleted in `afterAll`.
 */
const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/PlaceService.appearance.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const DAY_MS = 86_400_000;
const FIRST_DAY = Date.parse('2019-03-04T15:00:00Z');

/** `n` days after the first, at a fixed hour. Far in the past: nothing here is upcoming. */
const day = (n: number): number => FIRST_DAY + n * DAY_MS;

/** Holds every lifecycle case's event, one per day, and nothing else. */
const CASES_WINDOW = { startTime: new Date(day(-1)), endTime: new Date(day(EVENT_LIFECYCLE_CASES.length)) };

/** Holds the history below: days 100 to 200. */
const HISTORY_WINDOW = { startTime: new Date(day(100)), endTime: new Date(day(200)) };

interface Seeded {
  placeId: string;
  at: number;
}

describeWithDb(`PlaceService place appearance against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: PlaceService;
  let ctx: UserServiceContext;

  /** One place per lifecycle case, holding that case's event and no other. */
  const byCase = new Map<string, Seeded>();
  /** The places of the history below, by name. */
  const history = new Map<string, string>();

  const query = (sql: string, params?: unknown[]): Promise<unknown> => dataSource.query(sql, params);

  async function seedPlace(name: string): Promise<string> {
    const id = uuidv7();

    await query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, 'Location', $2, '{}'::jsonb, $3)`,
      [id, name, ctx.userId],
    );

    return id;
  }

  /** An event linked to `placeId` the way the legacy writers do: after the fact. */
  async function seedLinkedEvent(
    placeId: string,
    title: string,
    at: number,
    lifecycle: EventLifecycle = HAPPENED,
  ): Promise<void> {
    const id = uuidv7();

    await insertEvent(query, ctx.userId, { id, title, at, lifecycle, point: null });
    await query('UPDATE ci.events SET location_entity_id = $2 WHERE event_id = $1', [id, placeId]);
  }

  /** The places the browse lists in `window`, each with the instant it is dated from. */
  async function browse(window: { startTime: Date; endTime: Date }) {
    const found = await service.getEntitiesForPlaces(ctx, window);

    return new Map(found.map((identifier) => [identifier.id, identifier.sortTime?.getTime() ?? null]));
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

    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/PlaceService.appearance.integration');

    ctx = { userId: await createSyntheticTestUser(query, 'PlaceAppearance') } as UserServiceContext;

    // The browse only reads, through the repository's manager.
    service = new PlaceService({ manager: dataSource.manager } as never, {} as never, {} as never);

    for (const [index, lifecycleCase] of EVENT_LIFECYCLE_CASES.entries()) {
      const placeId = await seedPlace(`Venue of: ${lifecycleCase.name}`);

      await seedLinkedEvent(placeId, `Event: ${lifecycleCase.name}`, day(index), lifecycleCase.lifecycle);
      byCase.set(lifecycleCase.name, { placeId, at: day(index) });
    }

    // Three places with a history inside HISTORY_WINDOW.
    //  - Only a cancelled meeting inside it. The user did go, but outside it.
    //  - A deleted import early in it, then a visit. Dated from the visit.
    //  - Only a visit, the control.
    const calledOff = await seedPlace('History: called off in the window');
    const deletedFirst = await seedPlace('History: deleted, then visited');
    const visited = await seedPlace('History: visited');

    await seedLinkedEvent(calledOff, 'Went, before', day(50));
    await seedLinkedEvent(calledOff, 'Called off', day(120), { ...HAPPENED, status: 'cancelled' });
    await seedLinkedEvent(deletedFirst, 'Deleted import', day(110), { ...HAPPENED, isDeleted: true });
    await seedLinkedEvent(deletedFirst, 'Went', day(130));
    await seedLinkedEvent(visited, 'Went', day(150));

    history.set('calledOff', calledOff);
    history.set('deletedFirst', deletedFirst);
    history.set('visited', visited);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      if (ctx != null) {
        await query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [ctx.userId]);
        await query('DELETE FROM ci.events WHERE user_id = $1', [ctx.userId]);
        await query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ctx.userId]);
        await query('DELETE FROM ci.users WHERE id = $1', [ctx.userId]);
      }

      // Before `destroy()`: the lock is held on a connection from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it.each(EVENT_LIFECYCLE_CASES.map((c) => [c.name, c.happened] as const))(
    '%s (happened: %s) brings its place into the window, dated from it, only if it happened',
    async (name, happened) => {
      const seeded = byCase.get(name)!;
      const listed = await browse(CASES_WINDOW);

      // Always really linked and inside the window: leaving it out is the
      // rule's doing, not the fixture's.
      expect(
        await query(
          `SELECT count(*)::int AS n FROM ci.events
            WHERE user_id = $1 AND location_entity_id = $2 AND start_time BETWEEN $3 AND $4`,
          [ctx.userId, seeded.placeId, CASES_WINDOW.startTime, CASES_WINDOW.endTime],
        ),
      ).toEqual([{ n: 1 }]);

      if (happened) {
        expect(listed.get(seeded.placeId)).toBe(seeded.at);
      } else {
        expect(listed.has(seeded.placeId)).toBe(false);
      }
    },
  );

  it('counts the places that appear, the same ones the list returns', async () => {
    const happenedCount = EVENT_LIFECYCLE_CASES.filter((c) => c.happened).length;

    expect(await service.countEntitiesForPlaces(ctx, CASES_WINDOW)).toBe(happenedCount);
    expect((await browse(CASES_WINDOW)).size).toBe(happenedCount);
  });

  describe('a place with a history', () => {
    it('does not appear for a cancelled meeting inside the window, even though it was visited outside it', async () => {
      expect((await browse(HISTORY_WINDOW)).has(history.get('calledOff')!)).toBe(false);
    });

    it('is dated from the visit, not from a deleted event before it', async () => {
      expect((await browse(HISTORY_WINDOW)).get(history.get('deletedFirst')!)).toBe(day(130));
    });

    it('still appears, dated from its first visit, when it was visited', async () => {
      expect((await browse(HISTORY_WINDOW)).get(history.get('visited')!)).toBe(day(150));
    });

    it('counts exactly the places that appear', async () => {
      expect(await service.countEntitiesForPlaces(ctx, HISTORY_WINDOW)).toBe(2);
    });
  });
});
