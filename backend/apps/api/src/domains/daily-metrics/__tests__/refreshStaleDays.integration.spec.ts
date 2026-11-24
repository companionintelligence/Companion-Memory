import { DataSource, type Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { databaseAvailability, dataSourceConnection } from '../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../__tests__/support/schemaLock';
import { DailyMetricEntity } from '../entities/DailyMetricEntity';
import { DailyMetricsService } from '../services/DailyMetricsService';

/**
 * A refresh leaves no stored day behind whose data has moved.
 *
 * A thing picked as Oct 1 is stored as UTC midnight. Before #3260 the daily
 * stats counted it on Sep 30 in Los Angeles, and stores that ran then hold a
 * Sep 30 row with its spend. Now it counts on Oct 1, but Sep 30 has no data of
 * its own, so the refresh never recomputes it and an upsert alone left the old
 * spend there: the engines that read the store saw the purchase on both days.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database of your OWN, or run `make test-db ARGS=refreshStaleDays`. Every
 * fixture belongs to a synthetic user and is deleted in `afterAll`.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[daily-metrics/refreshStaleDays.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const ZONE = 'America/Los_Angeles';

function logger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;
}

describeWithDb(`Daily stats refresh after a thing's date moved (${availability.target})`, () => {
  let dataSource: DataSource;
  let repository: Repository<DailyMetricEntity>;
  let schemaLock: SchemaLock | undefined;
  let service: DailyMetricsService;

  const userId = uuidv7();
  const context: UserServiceContext = { userId };
  const thingId = uuidv7();

  async function storedSpend(): Promise<Record<string, number | null>> {
    const rows: Array<{ date: string; spend: string | number | null }> = await dataSource.query(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, spend_total AS spend
         FROM ci_derived.daily_metrics
        WHERE user_id = $1::uuid
        ORDER BY date`,
      [userId],
    );

    return Object.fromEntries(rows.map(({ date, spend }) => [date, spend == null ? null : Number(spend)]));
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [DailyMetricEntity],
      synchronize: false,
    });
    await dataSource.initialize();
    repository = dataSource.getRepository(DailyMetricEntity);
    service = new DailyMetricsService(repository, logger(), {} as never);

    schemaLock = await acquireSchemaWriteLock(dataSource, 'daily-metrics/refreshStaleDays.integration');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [userId, 'Daily stats stale days fixture', `dailystaledays.${userId}@example.invalid`],
    );
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, linked_table, linked_id)
       VALUES ($1::uuid, 'Item', 'Picked grinder', $2::uuid, 'objects', $1::uuid)`,
      [thingId, userId],
    );
    await dataSource.query(
      `INSERT INTO ci.objects (object_id, user_id, entity_type, acquired_at, purchase_price)
       VALUES ($1::uuid, $2::uuid, 'Item', '2026-10-01T00:00:00.000Z'::timestamptz, 40)`,
      [thingId, userId],
    );
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM ci_derived.daily_metrics WHERE user_id = $1', [userId]);
    // What a store refreshed before #3260 holds: the grinder's spend on Sep 30.
    await dataSource.query(
      `INSERT INTO ci_derived.daily_metrics (user_id, date, timezone, spend_total, coverage, computed_at)
       VALUES ($1::uuid, '2026-09-30', $2, 40, '{}'::jsonb, now())`,
      [userId, ZONE],
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci_derived.daily_metrics WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.objects WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('counts the purchase once, on the day it was picked', async () => {
    await service.refreshForUser(context, 30, ZONE);

    await expect(storedSpend()).resolves.toEqual({ '2026-10-01': 40 });
  });

  it('keeps a stored day that a shorter window did not reach', async () => {
    // An older purchase on Aug 15, stored, and a window of one day that only reaches Oct 1.
    const olderId = uuidv7();
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, linked_table, linked_id)
       VALUES ($1::uuid, 'Item', 'Older kettle', $2::uuid, 'objects', $1::uuid)`,
      [olderId, userId],
    );
    await dataSource.query(
      `INSERT INTO ci.objects (object_id, user_id, entity_type, acquired_at, purchase_price)
       VALUES ($1::uuid, $2::uuid, 'Item', '2026-08-15T00:00:00.000Z'::timestamptz, 12)`,
      [olderId, userId],
    );
    await dataSource.query(
      `DELETE FROM ci_derived.daily_metrics WHERE user_id = $1::uuid AND date = '2026-09-30'`,
      [userId],
    );
    await dataSource.query(
      `INSERT INTO ci_derived.daily_metrics (user_id, date, timezone, spend_total, coverage, computed_at)
       VALUES ($1::uuid, '2026-08-15', $2, 12, '{}'::jsonb, now())`,
      [userId, ZONE],
    );

    await service.refreshForUser(context, 1, ZONE);

    await expect(storedSpend()).resolves.toEqual({ '2026-08-15': 12, '2026-10-01': 40 });
  });
});
