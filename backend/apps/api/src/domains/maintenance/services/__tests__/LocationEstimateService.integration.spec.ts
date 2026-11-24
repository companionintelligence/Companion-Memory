import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { LocationEstimateService } from '../LocationEstimateService';

/**
 * `estimateBatch`'s `estimated` count, checked against the rows it filled.
 *
 * The estimate is one UPDATE behind a `candidate` CTE. With the UPDATE as the
 * statement's outer command TypeORM returns `[rows, rowCount]`, so `.length`
 * reported 2 filled rows for every batch that had candidates at all — the
 * number `LocationEstimateService.spec.ts` used to expect, because its stub
 * answered the UPDATE with two plain rows. Every batch here fills a number of
 * rows other than 2.
 *
 * Fixtures sit in 1985 under a synthetic user, are committed (the service uses
 * its own connection), and are deleted by owner afterwards.
 */

const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[maintenance/LocationEstimateService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const noopLogger = {
  setContext: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

const HOUR_MS = 60 * 60 * 1000;
const T0 = new Date('1985-06-01T12:00:00.000Z');
const at = (hours: number): Date => new Date(T0.getTime() + hours * HOUR_MS);

const BATCH = { maxGapHours: 24, sourceSystems: ['calendar'] };

describeWithDatabase(`LocationEstimateService against the live schema (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: LocationEstimateService;

  const userId = randomUUID();
  /** Four coordinate-less calendar events within a day of the donor, oldest first. */
  const candidates = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

  /** One `ci.entities` row and its `ci.events` detail row, in one statement for the deferred FK. */
  const insertEvent = async (fields: {
    id?: string;
    sourceSystem: string;
    startTime: Date;
    located?: boolean;
  }): Promise<void> => {
    await dataSource.query(
      `WITH entity AS (
         INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, is_active)
         VALUES ($1, 'Event', 'estimate spec fixture', $2, TRUE)
         RETURNING entity_id
       )
       INSERT INTO ci.events (event_id, user_id, start_time, source_system, location_coordinates)
       SELECT entity_id, $2, $3, $4,
              CASE WHEN $5::bool THEN ST_SetSRID(ST_MakePoint(-122.42, 37.77), 4326)::geography END
         FROM entity`,
      [fields.id ?? randomUUID(), userId, fields.startTime, fields.sourceSystem, fields.located === true],
    );
  };

  const estimatedCount = async (): Promise<number> => {
    const [row] = (await dataSource.query(
      `SELECT count(*)::int AS count
         FROM ci.events
        WHERE user_id = $1
          AND location_coordinates IS NOT NULL
          AND metadata->>'location_source' = 'estimated'`,
      [userId],
    )) as Array<{ count: number }>;

    return row.count;
  };

  beforeAll(async () => {
    const connection = resolveConnection();

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

    // SHARED: this suite commits ci.users / ci.entities / ci.events rows. See
    // domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'maintenance/LocationEstimateService.integration');

    await createSyntheticTestUser(
      (sql, params) => dataSource.query(sql, params as unknown[]),
      'LocationEstimate',
      userId,
    );

    // The donor: a located calendar event at T0.
    await insertEvent({ sourceSystem: 'calendar', startTime: T0, located: true });

    // The candidates, at -2h, -1h, +1h and +2h.
    for (const [index, hours] of [-2, -1, 1, 2].entries()) {
      await insertEvent({ id: candidates[index], sourceSystem: 'calendar', startTime: at(hours) });
    }

    // Not candidates: a source outside the allowlist, and a calendar event with
    // no donor within the gap.
    await insertEvent({ sourceSystem: 'gmail', startTime: at(0.5) });
    await insertEvent({ sourceSystem: 'calendar', startTime: at(30 * 24) });

    service = new LocationEstimateService(dataSource, noopLogger);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      // ci.events cascades from its ci.entities row.
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [userId]);
      // Before `destroy()`: the lock is held on a runner from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('reports as estimated exactly the rows a limited batch filled', async () => {
    await expect(service.estimateBatch(userId, { ...BATCH, limit: 3 })).resolves.toEqual({
      candidates: 4,
      estimated: 3,
    });

    expect(await estimatedCount()).toBe(3);

    // The newest three: the oldest candidate is the one left for next time.
    const [oldest] = (await dataSource.query(
      `SELECT location_coordinates IS NULL AS unfilled FROM ci.events WHERE event_id = $1`,
      [candidates[0]],
    )) as Array<{ unfilled: boolean }>;

    expect(oldest.unfilled).toBe(true);
  });

  it('fills, and reports, the one candidate the previous batch left', async () => {
    await expect(service.estimateBatch(userId, { ...BATCH, limit: 3 })).resolves.toEqual({
      candidates: 1,
      estimated: 1,
    });

    expect(await estimatedCount()).toBe(4);
  });

  it('reports nothing once every candidate is filled', async () => {
    await expect(service.estimateBatch(userId, { ...BATCH, limit: 3 })).resolves.toEqual({
      candidates: 0,
      estimated: 0,
    });
  });

  it('counts every prior estimate a forced re-sweep re-coordinates', async () => {
    await expect(service.estimateBatch(userId, { ...BATCH, limit: 10, forced: true })).resolves.toEqual({
      candidates: 4,
      estimated: 4,
    });

    expect(await estimatedCount()).toBe(4);
  });
});
