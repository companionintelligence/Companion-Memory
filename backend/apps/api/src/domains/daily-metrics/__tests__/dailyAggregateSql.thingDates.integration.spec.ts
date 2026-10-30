import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { databaseAvailability, dataSourceConnection } from '../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../__tests__/support/schemaLock';
import { DAILY_AGGREGATE_SQL, RECENT_DATA_DAYS_SQL } from '../metrics/dailyAggregateSql';

/**
 * A thing's Acquired date, counted on the right day of the daily stats.
 *
 * The web app stores a picked day as UTC midnight, and an importer that only
 * knows the day writes the same. Read as a moment in the user's zone, that
 * instant is the day before everywhere west of UTC, so a thing picked as Oct 1
 * counted on Sep 30 in Los Angeles. A real moment (an importer's order time) is
 * still counted on the user's local day.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database of your OWN, or run `make test-db ARGS=dailyAggregateSql.thingDates`.
 * Every fixture belongs to a synthetic user and is deleted in `afterAll`.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[daily-metrics/dailyAggregateSql.thingDates.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`Daily stats over a thing's acquired date (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | undefined;

  const userId = uuidv7();

  /** Picked as Oct 1 in the web app. */
  const PICKED = { id: uuidv7(), acquiredAt: '2026-10-01T00:00:00.000Z', price: 40 };
  /** An order placed at 8 pm on Sep 30 in Los Angeles, already Oct 1 in UTC and in Tokyo. */
  const ORDERED = { id: uuidv7(), acquiredAt: '2026-10-01T03:00:00.000Z', price: 15 };

  async function inventoryFor(
    day: string,
    zone: string,
  ): Promise<{ rows: number; priced: number; sum: number }> {
    const [row] = await dataSource.query(DAILY_AGGREGATE_SQL, [userId, day, zone]);

    return {
      rows: Number(row.inv_rows),
      priced: Number(row.inv_rows_with_price),
      sum: Number(row.inv_price_sum ?? 0),
    };
  }

  async function daysWithData(zone: string): Promise<string[]> {
    const rows: Array<{ day: string | Date }> = await dataSource.query(RECENT_DATA_DAYS_SQL, [
      userId,
      zone,
      '2026-12-31',
      10,
    ]);

    // node-postgres turns a `date` into local midnight, so it is read back with the local getters.
    return rows.map(({ day }) =>
      day instanceof Date
        ? `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
        : String(day).slice(0, 10),
    );
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [],
      synchronize: false,
    });
    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(
      dataSource,
      'daily-metrics/dailyAggregateSql.thingDates.integration',
    );

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [userId, 'Daily stats thing dates fixture', `dailythingdates.${userId}@example.invalid`],
    );

    for (const [name, thing] of [
      ['Picked grinder', PICKED],
      ['Ordered kettle', ORDERED],
    ] as const) {
      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, linked_table, linked_id)
         VALUES ($1::uuid, 'Item', $2, $3::uuid, 'objects', $1::uuid)`,
        [thing.id, name, userId],
      );
      await dataSource.query(
        `INSERT INTO ci.objects (object_id, user_id, entity_type, acquired_at, purchase_price)
         VALUES ($1::uuid, $2::uuid, 'Item', $3::timestamptz, $4)`,
        [thing.id, userId, thing.acquiredAt, thing.price],
      );
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.objects WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('counts a picked day on that day west of UTC, and an order on its local day', async () => {
    await expect(inventoryFor('2026-10-01', 'America/Los_Angeles')).resolves.toEqual({
      rows: 1,
      priced: 1,
      sum: 40,
    });
    await expect(inventoryFor('2026-09-30', 'America/Los_Angeles')).resolves.toEqual({
      rows: 1,
      priced: 1,
      sum: 15,
    });
  });

  it('counts both on Oct 1 east of UTC, and nothing the day before', async () => {
    await expect(inventoryFor('2026-10-01', 'Asia/Tokyo')).resolves.toEqual({ rows: 2, priced: 2, sum: 55 });
    await expect(inventoryFor('2026-09-30', 'Asia/Tokyo')).resolves.toEqual({ rows: 0, priced: 0, sum: 0 });
  });

  it('lists the same days as having data', async () => {
    await expect(daysWithData('America/Los_Angeles')).resolves.toEqual(['2026-10-01', '2026-09-30']);
    await expect(daysWithData('Asia/Tokyo')).resolves.toEqual(['2026-10-01']);
  });
});
