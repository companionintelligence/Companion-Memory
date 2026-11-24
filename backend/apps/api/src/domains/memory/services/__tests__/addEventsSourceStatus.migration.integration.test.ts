import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource, type QueryRunner } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';

/**
 * The `source_status` backfill — the migration's own UPDATE statements, read
 * verbatim from the file — over rows seeded to look like each writer left
 * them, inside one transaction that is rolled back.
 *
 * The base it sets decides whether a later re-delivery reads a row's status as
 * the source's or as the user's, so a wrong one either overwrites a user's
 * edit or strands a cancellation. Two writers left evidence of what their
 * source said — the Google transform (`metadata.rawEventStatus`, mapped as its
 * normalizeStatus maps it) and the importer (`metadata.eventStatus`, the three
 * values its push sends) — and everything else must be left NULL.
 *
 * Only the UPDATEs run, not the whole up-half. Its ALTER TABLE is a no-op on a
 * migrated database, but it would still take ACCESS EXCLUSIVE on ci.events and,
 * through the schema-lock protocol, stall every row-writing suite in the run
 * until this one finished — long enough to time out a 5-second beforeAll.
 *
 * Opt-in: set MEMORY_TEST_DATABASE_URL to a migrated database of your own.
 */
const MIGRATION = '20261001145556_add_events_source_status.sql';
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../db/postgres/migrations');

/** Every `UPDATE ci.events … ;` in the migration's `-- migrate:up` half, verbatim. */
function backfillStatements(): string[] {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');
  const down = sql.indexOf('-- migrate:down');
  const up = down === -1 ? sql : sql.slice(0, down);

  return up.match(/^UPDATE ci\.events\b[\s\S]*?;$/gm) ?? [];
}

async function runBackfill(runner: QueryRunner): Promise<void> {
  for (const statement of backfillStatements()) {
    await runner.query(statement);
  }
}

const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/addEventsSourceStatus.migration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

interface Seed {
  label: string;
  sourceType: string;
  sourceId: string | null;
  status: string;
  metadata: Record<string, unknown>;
  sourceStatus?: string;
}

describeWithDb(`${MIGRATION} backfill (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;

  const userId = uuidv7();

  const SEEDS: Seed[] = [
    {
      label: 'google confirmed',
      sourceType: 'ETL',
      sourceId: 'a',
      status: 'confirmed',
      metadata: { rawEventStatus: 'confirmed' },
    },
    {
      label: 'google tentative',
      sourceType: 'ETL',
      sourceId: 'b',
      status: 'tentative',
      metadata: { rawEventStatus: 'tentative' },
    },
    {
      label: 'google cancelled',
      sourceType: 'ETL',
      sourceId: 'c',
      status: 'cancelled',
      metadata: { rawEventStatus: 'cancelled' },
    },
    {
      label: 'google, odd case',
      sourceType: 'ETL',
      sourceId: 'd',
      status: 'cancelled',
      metadata: { rawEventStatus: 'Cancelled' },
    },
    {
      label: 'google, unknown status',
      sourceType: 'ETL',
      sourceId: 'e',
      status: 'confirmed',
      metadata: { rawEventStatus: 'weird' },
    },
    {
      label: 'google, explicit null',
      sourceType: 'ETL',
      sourceId: 'f',
      status: 'confirmed',
      metadata: { rawEventStatus: null },
    },
    // Confirmed at the sync, marked a no-show by the user since: the base is
    // still Google's, and the difference is what marks the edit.
    {
      label: 'google, user-edited',
      sourceType: 'ETL',
      sourceId: 'g',
      status: 'no_show',
      metadata: { rawEventStatus: 'confirmed' },
    },
    {
      label: 'outlook (no raw status)',
      sourceType: 'ETL',
      sourceId: 'h',
      status: 'cancelled',
      metadata: { outlookEventUrl: 'x' },
    },
    // The Google key belongs to the Google transform's rows only.
    {
      label: 'importer row',
      sourceType: 'ci-import-tools',
      sourceId: 'i',
      status: 'confirmed',
      metadata: { rawEventStatus: 'cancelled' },
    },
    // What the importer writes since it can state a status: the value on the
    // column, and the same value kept as metadata.eventStatus.
    {
      label: 'importer tentative (.ics)',
      sourceType: 'ci-import-tools',
      sourceId: 'l',
      status: 'tentative',
      metadata: { Source: 'ICS', eventStatus: 'tentative' },
    },
    {
      label: 'importer cancelled reservation',
      sourceType: 'ci-import-tools',
      sourceId: 'm',
      status: 'cancelled',
      metadata: { Canceled: true, eventStatus: 'cancelled' },
    },
    // A value the push would not send (canonical.ts importedEventStatus):
    // the column kept its default, so there is no base to record.
    {
      label: 'importer, unmapped status',
      sourceType: 'ci-import-tools',
      sourceId: 'n',
      status: 'confirmed',
      metadata: { eventStatus: 'CANCELLED' },
    },
    // And the importer's key belongs to the importer's rows only.
    {
      label: 'capture row with an eventStatus key',
      sourceType: 'capture',
      sourceId: 'o',
      status: 'confirmed',
      metadata: { eventStatus: 'cancelled' },
    },
    {
      label: 'no source id',
      sourceType: 'ETL',
      sourceId: null,
      status: 'confirmed',
      metadata: { rawEventStatus: 'cancelled' },
    },
    {
      label: 'already based',
      sourceType: 'ETL',
      sourceId: 'k',
      status: 'confirmed',
      metadata: { rawEventStatus: 'cancelled' },
      sourceStatus: 'tentative',
    },
  ];

  const EXPECTED: Record<string, string | null> = {
    'google confirmed': 'confirmed',
    'google tentative': 'tentative',
    'google cancelled': 'cancelled',
    'google, odd case': 'cancelled',
    'google, unknown status': 'confirmed',
    'google, explicit null': 'confirmed',
    'google, user-edited': 'confirmed',
    'outlook (no raw status)': null,
    'importer row': null,
    'importer tentative (.ics)': 'tentative',
    'importer cancelled reservation': 'cancelled',
    'importer, unmapped status': null,
    'capture row with an eventStatus key': null,
    'no source id': null,
    'already based': 'tentative',
  };

  async function bases(): Promise<Record<string, string | null>> {
    const rows: Array<{ label: string; source_status: string | null }> = await runner.query(
      `SELECT n.name AS label, e.source_status
         FROM ci.events e JOIN ci.entities n ON n.entity_id = e.event_id
        WHERE e.user_id = $1`,
      [userId],
    );

    return Object.fromEntries(rows.map((row) => [row.label, row.source_status]));
  }

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'postgres', ...dataSourceConnection(DATABASE_ENV) });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/addEventsSourceStatus.migration');

    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    await runner.query(
      `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
       VALUES ($1, 'Backfill fixture', $2, 'x', true, 'UTC')`,
      [userId, `backfill.${userId}@example.test`],
    );

    for (const seed of SEEDS) {
      const id = uuidv7();
      await runner.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
         VALUES ($1, 'Event', $2, '{}'::jsonb, $3, 'events', $1)`,
        [id, seed.label, userId],
      );
      await runner.query(
        `INSERT INTO ci.events (event_id, user_id, start_time, status, source_type, source_system, source_id,
                                metadata, source_status)
         VALUES ($1, $2, '2026-09-23T19:00:00Z', $3, $4, 'calendar', $5, $6::jsonb, $7)`,
        [
          id,
          userId,
          seed.status,
          seed.sourceType,
          seed.sourceId === null ? null : `${seed.sourceId}-${userId}@example.test`,
          JSON.stringify(seed.metadata),
          seed.sourceStatus ?? null,
        ],
      );
    }
  });

  afterAll(async () => {
    if (runner?.isTransactionActive) {
      await runner.rollbackTransaction();
    }

    await runner?.release();
    await schemaLock?.release();
    await dataSource?.destroy();
  });

  it('sets the base exactly where the Google transform or the importer left evidence of it', async () => {
    // One statement per writer. Pinned so a pattern that stopped matching
    // cannot turn this into a test of nothing.
    expect(backfillStatements()).toHaveLength(2);

    await runBackfill(runner);

    expect(await bases()).toEqual(EXPECTED);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const [before] = await runner.query(
      `SELECT string_agg(ctid::text, ',' ORDER BY event_id) AS ctids FROM ci.events WHERE user_id = $1`,
      [userId],
    );

    await runBackfill(runner);

    const [after] = await runner.query(
      `SELECT string_agg(ctid::text, ',' ORDER BY event_id) AS ctids FROM ci.events WHERE user_id = $1`,
      [userId],
    );
    expect(after.ctids).toBe(before.ctids);
    expect(await bases()).toEqual(EXPECTED);
  });
});
