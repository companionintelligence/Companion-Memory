import { DataSource } from 'typeorm';

import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { EVENT_PURGE_BLOCKERS } from '../eventPurge';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PURGE KNOWS EVERY TABLE THAT CAN STOP AN EVENT BEING DELETED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Deleting an event cascades from its `ci.entities` row to `ci.events` and to
 * the event's `ci.content` rows. A table that references either with no
 * `ON DELETE` action makes that delete fail for every event it has a row for,
 * which is how `archive_and_delete` came to fail for the 98% of events HBPE had
 * clustered. `purgeEventAggregates` clears each such table first.
 *
 * Nothing but the live catalog says which tables those are, and a migration that
 * adds a new one has no reason to look in `eventPurge.ts`. So this compares the
 * two. A table in the catalog and not in {@link EVENT_PURGE_BLOCKERS} is a purge
 * that fails on a real appliance the first time it meets a row in it. A table in
 * the list and not in the catalog is a delete that has been dead code since the
 * constraint changed.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database of your OWN, or run `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/eventPurge.catalog] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`the tables that can block an event delete (${availability.target})`, () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      synchronize: false,
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('are exactly the ones eventPurge.ts clears', async () => {
    const rows: Array<{ referencing: string; referenced: string; constraint: string }> =
      await dataSource.query(
        `SELECT c.conrelid::regclass::text AS referencing,
              c.confrelid::regclass::text AS referenced,
              c.conname AS "constraint"
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.confrelid IN ('ci.events'::regclass, 'ci.content'::regclass)
          AND c.confdeltype IN ('a', 'r')
        ORDER BY 1, 3`,
      );

    const inCatalog = rows.map((row) => row.referencing);
    const listed: string[] = [...EVENT_PURGE_BLOCKERS];

    expect({
      // Add each of these to EVENT_PURGE_BLOCKERS, and delete its rows in purgeEventAggregates.
      blockingAndNotCleared: inCatalog.filter((table) => !listed.includes(table)).sort(),
      // The constraint has changed: remove the table from EVENT_PURGE_BLOCKERS, and its delete.
      clearedAndNoLongerBlocking: listed.filter((table) => !inCatalog.includes(table)).sort(),
    }).toEqual({ blockingAndNotCleared: [], clearedAndNoLongerBlocking: [] });
  });
});
