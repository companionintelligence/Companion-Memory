import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource, type QueryRunner } from 'typeorm';

import { LIVE_EVENT_SQL } from '@ci/domains/memory';

import { createSyntheticTestUser } from '../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../__tests__/support/databaseConnection';

import { IMPORT_DATABASE_ENV } from './support/stagingHarness';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 20260930174042 — A CANCELLED TAKEOUT RESERVATION, STORED CANCELLED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * google_purchases.ts used to record Google's `canceled: true` only as
 * `metadata.Canceled`, leaving `ci.events.status` at its DEFAULT. The migration
 * repairs the rows already stored that way. Each guard it applies is pinned
 * here on rows Postgres holds, in one transaction that is rolled back.
 *
 * Invented throughout: venues, ids.
 */

const availability = databaseAvailability(IMPORT_DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[import/repairCancelledReservationStatus.migration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

function migrationUp(): string {
  const file = path.resolve(
    __dirname,
    '../../../../db/postgres/migrations/20260930174042_repair_cancelled_google_reservation_status.sql',
  );
  const sql = readFileSync(file, 'utf8');
  const start = sql.indexOf('-- migrate:up');
  const end = sql.indexOf('-- migrate:down');

  if (start < 0 || end < 0) {
    throw new Error(`${file} has no migrate:up / migrate:down markers.`);
  }

  return sql.slice(start + '-- migrate:up'.length, end);
}

/** Older than any timestamp the migration could stamp, so "touched" is observable. */
const SEEDED_AT = '2026-01-01T00:00:00Z';

interface Seed {
  sourceSystem: string;
  status: string;
  metadata: Record<string, unknown>;
  deleted?: boolean;
}

describeWithDb(`repairing cancelled Google reservations (${availability.target})`, () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  let userId: string;

  /** What each seeded row is, and whether the migration should move it. */
  const seeds: Record<string, Seed & { repaired: boolean }> = {
    // The three shapes Google writes a cancellation in, and a tombstone: the
    // column should be right if the user ever restores it.
    booking: {
      sourceSystem: 'google_purchases',
      status: 'confirmed',
      metadata: { Kind: 'reservation', Title: 'Booking — Harbor Noodle House', Canceled: true },
      repaired: true,
    },
    waitlist: {
      sourceSystem: 'google_purchases',
      status: 'confirmed',
      metadata: { Kind: 'waitlist', Title: 'Waitlist — Harbor Noodle House', Canceled: true },
      repaired: true,
    },
    tombstoned: {
      sourceSystem: 'google_purchases',
      status: 'confirmed',
      metadata: { Kind: 'reservation', Canceled: true },
      deleted: true,
      repaired: true,
    },
    // Not cancelled, or not said in the importer's own spelling.
    kept: {
      sourceSystem: 'google_purchases',
      status: 'confirmed',
      metadata: { Kind: 'reservation', Canceled: false },
      repaired: false,
    },
    unmarked: {
      sourceSystem: 'google_purchases',
      status: 'confirmed',
      metadata: { Kind: 'reservation', Title: 'Dinner — Lantern Hall' },
      repaired: false,
    },
    stringTrue: {
      sourceSystem: 'google_purchases',
      status: 'confirmed',
      metadata: { Kind: 'reservation', Canceled: 'true' },
      repaired: false,
    },
    // A status set since the import is the user's, or a later stage's.
    completed: {
      sourceSystem: 'google_purchases',
      status: 'completed',
      metadata: { Kind: 'reservation', Canceled: true },
      repaired: false,
    },
    // Provenance first: only what google_purchases wrote.
    otherSource: {
      sourceSystem: 'calendar',
      status: 'confirmed',
      metadata: { Kind: 'reservation', Canceled: true },
      repaired: false,
    },
    ics: {
      sourceSystem: 'calendar',
      status: 'confirmed',
      metadata: { Source: 'ICS', Summary: 'Weekly sync', isRecurring: false },
      repaired: false,
    },
  };

  const ids: Record<string, string> = Object.fromEntries(
    Object.keys(seeds).map((key) => [key, randomUUID()]),
  );

  function q<T>(text: string, params?: unknown[]): Promise<T> {
    return runner.query(text, params) as Promise<T>;
  }

  async function seed(key: string): Promise<void> {
    const row = seeds[key];

    await q(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Event', $2, '{}'::jsonb, $3, 'events', $1)`,
      [ids[key], key, userId],
    );
    await q(
      `INSERT INTO ci.events
         (event_id, user_id, start_time, event_type, source_type, source_system, source_id,
          metadata, status, is_deleted, updated_at)
       VALUES ($1::uuid, $2, '2023-10-22T03:30:00Z', 'event', 'ci-import-tools', $3, $4,
               $5::jsonb, $6, $7, $8::timestamptz)`,
      [
        ids[key],
        userId,
        row.sourceSystem,
        `seed:${key}`,
        JSON.stringify(row.metadata),
        row.status,
        row.deleted ?? false,
        SEEDED_AT,
      ],
    );
  }

  async function stored(): Promise<
    Record<string, { status: string; metadata: Record<string, unknown>; touched: boolean }>
  > {
    const rows = await q<
      Array<{ source_id: string; status: string; metadata: Record<string, unknown>; touched: boolean }>
    >(
      `SELECT source_id, status, metadata, updated_at > $2::timestamptz AS touched
         FROM ci.events WHERE user_id = $1`,
      [userId, SEEDED_AT],
    );

    return Object.fromEntries(
      rows.map((row) => [
        row.source_id.replace('seed:', ''),
        { status: row.status, metadata: row.metadata, touched: row.touched },
      ]),
    );
  }

  beforeAll(async () => {
    const connection = resolveConnection(IMPORT_DATABASE_ENV);

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
      entities: [],
      synchronize: false,
      logging: false,
      extra: { max: 2 },
    });
    await dataSource.initialize();

    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    userId = await createSyntheticTestUser((sql, params) => q(sql, params), 'RepairCancelledReservation');

    for (const key of Object.keys(seeds)) {
      await seed(key);
    }
  });

  afterAll(async () => {
    if (runner?.isTransactionActive) {
      await runner.rollbackTransaction();
    }

    await runner?.release();

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('cancels exactly the reservations Google flagged cancelled, and stamps the importer key', async () => {
    await q(migrationUp());

    const after = await stored();

    const keys = Object.keys(seeds);
    const byKey = <T>(valueOf: (key: string) => T) =>
      Object.fromEntries(keys.map((key) => [key, valueOf(key)]));

    // One comparison over every row, so a guard that lets the wrong row through
    // is named in the diff rather than stopping at the first.
    expect(byKey((key) => after[key].status)).toEqual(
      byKey((key) => (seeds[key].repaired ? 'cancelled' : seeds[key].status)),
    );
    expect(byKey((key) => after[key].touched)).toEqual(byKey((key) => seeds[key].repaired));

    // A repaired row matches what the importer writes now: the flag it always
    // carried, plus the status it states.
    expect(after.booking.metadata).toEqual({
      Kind: 'reservation',
      Title: 'Booking — Harbor Noodle House',
      Canceled: true,
      eventStatus: 'cancelled',
    });

    // Everything else is byte-for-byte what was seeded, including the string
    // "true" that is not Google's boolean and the flag on another source.
    const untouched = keys.filter((key) => !seeds[key].repaired);

    expect(Object.fromEntries(untouched.map((key) => [key, after[key].metadata]))).toEqual(
      Object.fromEntries(untouched.map((key) => [key, seeds[key].metadata])),
    );
  });

  it('leaves the repaired rows out of what the calendar and Known places count', async () => {
    // Idempotent, so it is safe to run here whatever ran before this test.
    await q(migrationUp());

    // LIVE_EVENT_SQL is the one definition of "this event happened" the
    // calendar, the planner and Known places share. It is aliased `event`.
    const live = await q<Array<{ source_id: string }>>(
      `SELECT event.source_id FROM ci.events event WHERE event.user_id = $1 AND ${LIVE_EVENT_SQL}`,
      [userId],
    );

    expect(live.map((row) => row.source_id.replace('seed:', '')).sort()).toEqual(
      ['completed', 'ics', 'kept', 'otherSource', 'stringTrue', 'unmarked'].sort(),
    );
  });

  it('touches nothing when it runs again', async () => {
    await q(migrationUp());

    // `now()` is fixed inside a transaction, so a second run that re-stamped a
    // row would write the same timestamp and look untouched. Put every
    // timestamp back first, so a re-stamp has somewhere to show.
    await q(`UPDATE ci.events SET updated_at = $2::timestamptz WHERE user_id = $1`, [userId, SEEDED_AT]);

    const before = await stored();

    await q(migrationUp());

    const after = await stored();

    expect(after).toEqual(before);
    expect(Object.values(after).some((row) => row.touched)).toBe(false);
  });
});
