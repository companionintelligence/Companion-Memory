import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource, type QueryRunner } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVENTS THAT WERE DELETED OR FORGOTTEN BEFORE THE TWO FLAGS MOVED TOGETHER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `CalendarEventService.remove` used to set `ci.events.is_deleted` and leave
 * `ci.entities.is_active` alone, and `memory.forget` did the opposite.
 * {@link MIGRATION} converges the rows either one left behind, and this suite
 * applies it, verbatim from disk, to a row in every state an event can be in.
 * Each case asserts what the migration left, including that it rewrote exactly
 * the rows it should and no other (a row's `ctid` moves on every UPDATE).
 *
 * Everything happens in one transaction, rolled back in `afterAll`. Opt-in like
 * its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated database of your
 * OWN, or run `make test-db`, which provides one.
 */

const MIGRATION = '20261001061105_converge_event_liveness_flags.sql';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../db/postgres/migrations');

/** The `-- migrate:up` half of the migration, as dbmate would run it. */
function migrationUpSql(): string {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');
  const down = sql.indexOf('-- migrate:down');

  return down === -1 ? sql : sql.slice(0, down);
}

const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/convergeEventLivenessFlags.migration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

/** What every seeded row's `updated_at` says, so a bump is visible. */
const SEEDED_AT = new Date('2026-09-01T00:00:00Z');

interface Stored {
  is_deleted: boolean;
  is_active: boolean;
  /** Moves on every UPDATE, so an unmoved one proves the row was not rewritten. */
  base_ctid: string;
  detail_ctid: string;
  base_updated_at: Date;
  detail_updated_at: Date;
}

describeWithDb(`converging an event's two liveness flags (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let ownerId: string;

  const ids = new Map<string, string>();
  const before = new Map<string, Stored>();
  let afterFirstRun: Map<string, Stored>;

  function q<T>(text: string, params?: unknown[]): Promise<T> {
    return runner.query(text, params) as Promise<T>;
  }

  function id(label: string): string {
    const found = ids.get(label);

    if (found == null) {
      throw new Error(`no row seeded as "${label}"`);
    }

    return found;
  }

  /** One event aggregate: the base row, the detail row, in the given state. */
  async function event(
    label: string,
    state: { isDeleted: boolean; isActive: boolean; mergedInto?: string },
  ): Promise<void> {
    const eventId = uuidv7();

    await q(
      `INSERT INTO ci.entities
         (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id,
          is_active, merged_into_entity_id, updated_at)
       VALUES ($1, 'Event', $2, '{}'::jsonb, $3, 'events', $1, $4, $5, $6)`,
      [eventId, label, ownerId, state.isActive, state.mergedInto ?? null, SEEDED_AT],
    );
    await q(
      `INSERT INTO ci.events (event_id, user_id, start_time, is_deleted, updated_at)
       VALUES ($1, $2, '2026-08-19T17:00:00Z', $3, $4)`,
      [eventId, ownerId, state.isDeleted, SEEDED_AT],
    );

    ids.set(label, eventId);
  }

  /** The two search rows an indexed event has. */
  async function indexed(label: string): Promise<void> {
    await q(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES (gen_random_uuid(), 'event', $1, to_tsvector('simple', $2), $3)`,
      [id(label), label, ownerId],
    );
    await q(
      `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, user_id)
       VALUES (gen_random_uuid(), 'event', $1, $2)`,
      [id(label), ownerId],
    );
  }

  async function searchRows(label: string): Promise<{ vectors: number; embeddings: number }> {
    const [{ vectors }] = await q<Array<{ vectors: string }>>(
      `SELECT count(*) AS vectors FROM ci_search.vectors WHERE entity_type = 'event' AND entity_id = $1`,
      [id(label)],
    );
    const [{ embeddings }] = await q<Array<{ embeddings: string }>>(
      `SELECT count(*) AS embeddings FROM ci_search.embeddings WHERE entity_type = 'event' AND entity_id = $1`,
      [id(label)],
    );

    return { vectors: Number(vectors), embeddings: Number(embeddings) };
  }

  async function stored(label: string): Promise<Stored> {
    const [row] = await q<Stored[]>(
      `SELECT ev.is_deleted, e.is_active,
              e.ctid::text AS base_ctid, ev.ctid::text AS detail_ctid,
              e.updated_at AS base_updated_at, ev.updated_at AS detail_updated_at
         FROM ci.events ev
         JOIN ci.entities e ON e.entity_id = ev.event_id
        WHERE ev.event_id = $1`,
      [id(label)],
    );

    return row;
  }

  async function snapshotAll(): Promise<Map<string, Stored>> {
    const rows = new Map<string, Stored>();

    for (const label of EVENT_LABELS) {
      rows.set(label, await stored(label));
    }

    return rows;
  }

  const EVENT_LABELS = ['live', 'deleted-old', 'forgotten-old', 'in-the-trash', 'merged-away'] as const;

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
      synchronize: false,
      logging: false,
      extra: { max: 2 },
    });
    await dataSource.initialize();

    // The migration row-locks every event it repairs, whoever owns it, for as
    // long as this transaction is open.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/convergeEventLivenessFlags.migration');

    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    ownerId = await createSyntheticTestUser((sql, params) => q(sql, params), 'EventFlagsRepair');

    // The healthy case: nothing to repair.
    await event('live', { isDeleted: false, isActive: true });
    await indexed('live');

    // Deleted from the app before `remove` covered the base row.
    await event('deleted-old', { isDeleted: true, isActive: true });

    // Forgotten by the agent before `forget` tombstoned the detail row. Search
    // never heard about it.
    await event('forgotten-old', { isDeleted: false, isActive: false });
    await indexed('forgotten-old');

    // What `remove` writes today: already consistent, already un-indexed.
    await event('in-the-trash', { isDeleted: true, isActive: false });

    // Inactive because it was merged away, not because anyone forgot it.
    const survivor = uuidv7();

    await q(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, updated_at)
       VALUES ($1, 'Event', 'survivor', '{}'::jsonb, $2, $3)`,
      [survivor, ownerId, SEEDED_AT],
    );
    await event('merged-away', { isDeleted: false, isActive: false, mergedInto: survivor });
    await indexed('merged-away');

    // Rows that are not an event aggregate at all. A graph-only `Event` node
    // (graph ingest writes them, with no `ci.events` row behind them) and an
    // inactive node of another type must not be read as a forgotten event.
    for (const [label, entityType] of [
      ['graph-only-event', 'Event'],
      ['inactive-concept', 'Concept'],
    ]) {
      const nodeId = uuidv7();

      await q(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, is_active, updated_at)
         VALUES ($1, $2, $3, '{}'::jsonb, $4, FALSE, $5)`,
        [nodeId, entityType, label, ownerId, SEEDED_AT],
      );
      ids.set(label, nodeId);
    }

    // `events_event_id_entities_fk` is DEFERRABLE INITIALLY DEFERRED, and in a
    // transaction that is never committed it would never fire at all: a fixture
    // the real schema rejects would pass. Check them now.
    await q('SET CONSTRAINTS ALL IMMEDIATE');

    for (const [label, snapshot] of await snapshotAll()) {
      before.set(label, snapshot);
    }

    await q(migrationUpSql());

    afterFirstRun = await snapshotAll();
  });

  afterAll(async () => {
    if (runner != null) {
      await runner.rollbackTransaction();
      await runner.release();
    }

    await schemaLock?.release();

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  function after(label: string): Stored {
    const row = afterFirstRun.get(label);

    if (row == null) {
      throw new Error(`no snapshot for "${label}"`);
    }

    return row;
  }

  function wasNotRewritten(label: string): void {
    const was = before.get(label)!;
    const now = after(label);

    expect(now.base_ctid).toBe(was.base_ctid);
    expect(now.detail_ctid).toBe(was.detail_ctid);
    expect(now.base_updated_at).toEqual(was.base_updated_at);
    expect(now.detail_updated_at).toEqual(was.detail_updated_at);
  }

  it('deactivates the base row of an event deleted before remove() did, and keeps both rows', () => {
    expect(before.get('deleted-old')).toMatchObject({ is_deleted: true, is_active: true });
    expect(after('deleted-old')).toMatchObject({ is_deleted: true, is_active: false });
    expect(after('deleted-old').base_updated_at.getTime()).toBeGreaterThan(SEEDED_AT.getTime());
    // The detail row is the deletion itself. It is not rewritten.
    expect(after('deleted-old').detail_ctid).toBe(before.get('deleted-old')!.detail_ctid);
  });

  it('moves an event forgotten before forget tombstoned it to the trash, and un-indexes it', async () => {
    expect(before.get('forgotten-old')).toMatchObject({ is_deleted: false, is_active: false });
    expect(after('forgotten-old')).toMatchObject({ is_deleted: true, is_active: false });
    expect(after('forgotten-old').detail_updated_at.getTime()).toBeGreaterThan(SEEDED_AT.getTime());
    // The node was already inactive. Only the detail row is written.
    expect(after('forgotten-old').base_ctid).toBe(before.get('forgotten-old')!.base_ctid);

    expect(await searchRows('forgotten-old')).toEqual({ vectors: 0, embeddings: 0 });
  });

  it('leaves a healthy event, with its search rows, exactly as it was', async () => {
    wasNotRewritten('live');
    expect(after('live')).toMatchObject({ is_deleted: false, is_active: true });
    expect(await searchRows('live')).toEqual({ vectors: 1, embeddings: 1 });
  });

  it('leaves an event that is already in the trash exactly as it was', () => {
    wasNotRewritten('in-the-trash');
    expect(after('in-the-trash')).toMatchObject({ is_deleted: true, is_active: false });
  });

  it('does not read a merge tombstone as a forgotten event', async () => {
    wasNotRewritten('merged-away');
    expect(after('merged-away')).toMatchObject({ is_deleted: false, is_active: false });
    expect(await searchRows('merged-away')).toEqual({ vectors: 1, embeddings: 1 });
  });

  it('does not touch an inactive node that is not an event aggregate', async () => {
    for (const label of ['graph-only-event', 'inactive-concept']) {
      const [row] = await q<Array<{ is_active: boolean; updated_at: Date }>>(
        `SELECT is_active, updated_at FROM ci.entities WHERE entity_id = $1`,
        [id(label)],
      );

      expect(row.is_active).toBe(false);
      expect(row.updated_at).toEqual(SEEDED_AT);
    }

    expect(
      await q(`SELECT 1 FROM ci.events WHERE event_id = ANY($1::uuid[])`, [
        [id('graph-only-event'), id('inactive-concept')],
      ]),
    ).toEqual([]);
  });

  it('is idempotent: a second run rewrites nothing', async () => {
    await q(migrationUpSql());

    const second = await snapshotAll();

    for (const label of EVENT_LABELS) {
      expect(second.get(label)).toEqual(after(label));
    }
  });
});
