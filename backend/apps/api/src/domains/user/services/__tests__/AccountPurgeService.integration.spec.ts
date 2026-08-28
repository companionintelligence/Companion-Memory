import { randomUUID } from 'node:crypto';

import { LoggerService } from '@ci/common/logging';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../../__tests__/support/scratchDatabase';
import type { PurgeObjectStore } from '../../purge/objectStore';
import { AccountPurgeService } from '../AccountPurgeService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The purge, against the real schema.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The unit tests pin the plan's *rules*. They cannot tell you the plan works,
 * because the thing that makes account deletion hard here is not the algorithm —
 * it is fifty-odd foreign keys with three different delete actions, fourteen
 * tables with no foreign key at all, TimescaleDB chunks, a self-referencing
 * message hierarchy and a users↔entities cycle. The only honest test of "the
 * data is gone" is a database with all of that in it.
 *
 * So this suite builds one: every migration, from empty, in a database of its
 * own that is dropped afterwards (see `scratchDatabase.ts` for why a
 * rolled-back transaction is not good enough). It skips when there is no
 * administrative connection, and says so.
 *
 * Two accounts are seeded, not one. Half of what a purge has to get right is
 * what it must *not* delete, and a single-account fixture cannot fail that way.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  // Printed once, so a skipped suite is never mistaken for a passing one.

  console.warn(`[AccountPurgeService.integration] SKIPPED — ${availability.reason}`);
}

/** Enough rows to make the batch loop go round more than once. */
const POSITION_ROWS = 1_200;

describeWithDatabase(`account purge, against the real schema (${availability.target})`, () => {
  let scratch: ScratchDatabase;
  let service: AccountPurgeService;
  let deletedObjects: Array<{ bucket: string; keys: string[] }>;

  /** The account being deleted. */
  const victim = randomUUID();
  /** An account that must survive it, intact. */
  const bystander = randomUUID();

  const victimEntity = randomUUID();
  const bystanderEntity = randomUUID();
  const victimThread = randomUUID();
  const victimChildThread = randomUUID();
  const victimMessage = randomUUID();
  const victimTag = randomUUID();
  const victimFile = randomUUID();
  /** ci.files.key is a uuid, not a path. */
  const victimObjectKey = randomUUID();

  const query = async <T>(sql: string, parameters?: unknown[]): Promise<T[]> =>
    (await scratch.dataSource.query(sql, parameters)) as T[];

  const countWhere = async (table: string, where: string, parameters: unknown[]): Promise<number> => {
    const [row] = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE ${where}`,
      parameters,
    );

    return Number(row.count);
  };

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'AccountPurgeService.integration.spec' });

    await scratch.assertOwn();

    deletedObjects = [];

    const objectStore: PurgeObjectStore = {
      deleteObjects: async (bucket, keys) => {
        deletedObjects.push({ bucket, keys });
      },
    };

    service = new AccountPurgeService(scratch.dataSource, new LoggerService(), objectStore);

    // ── Two accounts, one of which created the other ────────────────────────
    // ci.users.created_by is NO ACTION and points at ci.users: the single most
    // dangerous shape in the schema, because following it would delete a live
    // account.
    await query(`INSERT INTO ci.users (id, email, name) VALUES ($1, $2, 'Victim')`, [
      victim,
      `victim-${victim}@example.test`,
    ]);
    await query(`INSERT INTO ci.users (id, email, name, created_by) VALUES ($1, $2, 'Bystander', $3)`, [
      bystander,
      `bystander-${bystander}@example.test`,
      victim,
    ]);

    // ── Entities: owned solely through a SET NULL column ────────────────────
    for (const [entity, owner] of [
      [victimEntity, victim],
      [bystanderEntity, bystander],
    ]) {
      await query(
        `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name) VALUES ($1, 'Event', $2, 'seed')`,
        [entity, owner],
      );
    }

    // ci.users.entity_id -> ci.entities closes a cycle with
    // ci.entities.owner_user_id -> ci.users. Nothing can be deleted until one
    // side is nulled.
    await query(`UPDATE ci.users SET entity_id = $2 WHERE id = $1`, [victim, victimEntity]);

    // CTI detail row sharing the entity's id, cascading from it.
    await query(`INSERT INTO ci.events (event_id, user_id, start_time) VALUES ($1, $2, NOW())`, [
      victimEntity,
      victim,
    ]);

    // ── A NO ACTION table, both accounts ───────────────────────────────────
    for (const owner of [victim, bystander]) {
      await query(`INSERT INTO ci.notes (id, user_id, content) VALUES ($1, $2, 'seed note')`, [
        randomUUID(),
        owner,
      ]);
    }

    // ── Self-referencing hierarchies ───────────────────────────────────────
    await query(`INSERT INTO ci.threads (thread_id, user_id, title) VALUES ($1, $2, 'root')`, [
      victimThread,
      victim,
    ]);
    await query(
      `INSERT INTO ci.threads (thread_id, user_id, title, parent_thread_id) VALUES ($1, $2, 'child', $3)`,
      [victimChildThread, victim, victimThread],
    );
    await query(
      `INSERT INTO ci.messages (message_id, user_id, thread_id, role, content)
       VALUES ($1, $2, $3, 'user', 'hello')`,
      [victimMessage, victim, victimThread],
    );
    await query(
      `INSERT INTO ci.messages (message_id, user_id, thread_id, role, content, parent_message_id)
       VALUES ($1, $2, $3, 'assistant', 'hi', $4)`,
      [randomUUID(), victim, victimThread, victimMessage],
    );

    // ── A hypertable, spread over two chunks, larger than one batch ────────
    const positions: string[] = [];
    const parameters: unknown[] = [victim];

    for (let index = 0; index < POSITION_ROWS; index += 1) {
      // Distinct timestamps, all inside one monthly chunk.
      parameters.push(new Date(Date.UTC(2026, 0, 1, 0, index, 0)));
      positions.push(`($${parameters.length}, $1, 'gps', ST_SetSRID(ST_MakePoint(0, 0), 4326))`);
    }

    // A second chunk, six months along: the batch loop has to visit every chunk,
    // not just the one holding most of the rows.
    parameters.push(new Date(Date.UTC(2026, 5, 1)));
    positions.push(`($${parameters.length}, $1, 'gps', ST_SetSRID(ST_MakePoint(0, 0), 4326))`);

    await query(
      `INSERT INTO ci.position (time, user_id, source, location) VALUES ${positions.join(', ')}`,
      parameters,
    );

    await query(
      `INSERT INTO ci.position (time, user_id, source, location)
       VALUES (NOW(), $1, 'gps', ST_SetSRID(ST_MakePoint(1, 1), 4326))`,
      [bystander],
    );

    // ── User-scoped with no foreign key whatsoever ─────────────────────────
    // The vector form of the user's memories. A cascade would never touch it.
    await query(`INSERT INTO ci_search.embeddings (id, user_id) VALUES ($1, $2)`, [randomUUID(), victim]);
    await query(`INSERT INTO ci_search.embeddings (id, user_id) VALUES ($1, $2)`, [randomUUID(), bystander]);

    // ── A blocking child that is not user-scoped itself ────────────────────
    // ci_search.entity_tag -> ci_search.tags is NO ACTION and entity_tag has no
    // user column, so it can only be reached through its parent.
    await query(`INSERT INTO ci_search.tags (id, user_id, label) VALUES ($1, $2, 'seed-tag')`, [
      victimTag,
      victim,
    ]);
    await query(
      `INSERT INTO ci_search.entity_tag (tag_id, entity_id, entity_type) VALUES ($1, $2, 'Event')`,
      [victimTag, victimEntity],
    );

    // ── A file, so the object store has something to delete ────────────────
    await query(
      `INSERT INTO ci.files (id, user_id, content_type, bucket, key, filename)
       VALUES ($1, $2, 'image/png', 'companion', $3, 'seed.png')`,
      [victimFile, victim, victimObjectKey],
    );

    // ── Deletion requested, grace period already over ──────────────────────
    await query(
      `UPDATE ci.users SET deleted_at = NOW() - INTERVAL '31 days', purge_after = NOW() - INTERVAL '1 day'
        WHERE id = $1`,
      [victim],
    );
  }, 300_000);

  afterAll(async () => {
    if (scratch) {
      await scratch.drop();
    }
  }, 60_000);

  describe('the plan it derives from this schema', () => {
    it('accounts for every user-scoped column in the database', async () => {
      const plan = await service.describePlan();

      // Independently of the planner: every uuid column named like an owner, in
      // every application schema. If one is neither purged nor deliberately
      // detached, an account's data survives its own deletion — silently, which
      // is the whole failure mode this job exists to close.
      const columns = await query<{ table: string; column: string }>(`
        SELECT ns.nspname || '.' || c.relname AS table, a.attname AS column
        FROM pg_attribute a
        JOIN pg_class c      ON c.oid = a.attrelid AND c.relkind IN ('r', 'p')
        JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE a.attname IN ('user_id', 'owner_user_id')
          AND a.atttypid = 'uuid'::regtype
          AND NOT a.attisdropped
          AND ns.nspname IN ('ci', 'ci_search', 'ci_etl', 'hbpe')
      `);

      expect(columns.length).toBeGreaterThan(40);

      const purged = new Set(plan.purgedTables);
      const detached = new Set(plan.detachedColumns);

      const unaccounted = columns.filter(
        (column) => !purged.has(column.table) && !detached.has(`${column.table}.${column.column}`),
      );

      // The one deliberate exception, spelled out here as well as in the code:
      // ci.account_purges.user_id names an account the purge already destroyed.
      expect(unaccounted).toEqual([{ table: 'ci.account_purges', column: 'user_id' }]);
    });

    it('does not treat its own audit record as account data', async () => {
      const plan = await service.describePlan();

      expect(plan.purgedTables).not.toContain('ci.account_purges');
    });

    it('is safe to execute', async () => {
      const plan = await service.describePlan();

      expect(plan.warnings).toEqual([]);
    });
  });

  describe('purging a due account', () => {
    it('reports the account as purged', async () => {
      const summary = await service.purgeDueAccounts();

      expect(summary.considered).toBe(1);
      expect(summary.purged).toBe(1);
      expect(summary.failed).toBe(0);
      expect(summary.outcomes[0]).toMatchObject({ userId: victim, status: 'purged' });
    }, 300_000);

    it('leaves no trace of the account', async () => {
      // Raw SQL rather than the repository: a soft-deleted row is invisible to
      // TypeORM, so a repository count would have "passed" before the purge ran.
      expect(await countWhere('ci.users', 'id = $1', [victim])).toBe(0);
    });

    it('removes rows behind every kind of reference', async () => {
      const remaining = await Promise.all([
        countWhere('ci.notes', 'user_id = $1', [victim]), // NO ACTION
        countWhere('ci.events', 'user_id = $1', [victim]), // CASCADE + CTI detail
        countWhere('ci.entities', 'owner_user_id = $1', [victim]), // SET NULL, sole owner
        countWhere('ci.messages', 'user_id = $1', [victim]), // self-referencing
        countWhere('ci.threads', 'user_id = $1', [victim]), // self-referencing parent
        countWhere('ci_search.embeddings', 'user_id = $1', [victim]), // no foreign key
        countWhere('ci_search.tags', 'user_id = $1', [victim]), // no foreign key, has a child
      ]);

      expect(remaining).toEqual([0, 0, 0, 0, 0, 0, 0]);
    });

    it('empties a hypertable across all of its chunks', async () => {
      expect(await countWhere('ci.position', 'user_id = $1', [victim])).toBe(0);
    });

    it('removes the blocking child that has no user column of its own', async () => {
      expect(await countWhere('ci_search.entity_tag', 'tag_id = $1', [victimTag])).toBe(0);
    });

    it('deletes the stored objects, not just the rows that point at them', async () => {
      expect(deletedObjects).toEqual([{ bucket: 'companion', keys: [victimObjectKey] }]);
      expect(await countWhere('ci.files', 'user_id = $1', [victim])).toBe(0);
    });
  });

  describe('what it must not touch', () => {
    it('leaves the other account signed up and intact', async () => {
      expect(await countWhere('ci.users', 'id = $1', [bystander])).toBe(1);

      const remaining = await Promise.all([
        countWhere('ci.notes', 'user_id = $1', [bystander]),
        countWhere('ci.entities', 'owner_user_id = $1', [bystander]),
        countWhere('ci_search.embeddings', 'user_id = $1', [bystander]),
        countWhere('ci.position', 'user_id = $1', [bystander]),
      ]);

      expect(remaining).toEqual([1, 1, 1, 1]);
    });

    it('detaches the account that provisioned it rather than deleting it', async () => {
      expect(await countWhere('ci.users', 'id = $1 AND created_by IS NULL', [bystander])).toBe(1);
    });
  });

  describe('the record it leaves', () => {
    it('records the purge after the row it describes is gone', async () => {
      const [record] = await query<{
        completed_at: Date | null;
        attempts: number;
        deleted_rows: Record<string, number>;
        detached_rows: Record<string, number>;
        deleted_objects: number;
        last_error: string | null;
      }>(`SELECT * FROM ci.account_purges WHERE user_id = $1`, [victim]);

      expect(record).toBeDefined();
      expect(record.completed_at).not.toBeNull();
      expect(record.last_error).toBeNull();
      expect(record.attempts).toBe(1);
      expect(record.deleted_objects).toBe(1);

      // Counts, per table — the evidence behind "your data was deleted".
      expect(record.deleted_rows['ci.position']).toBe(POSITION_ROWS + 1);
      expect(record.deleted_rows['ci.users']).toBe(1);
      expect(record.deleted_rows['ci_search.embeddings']).toBe(1);
    });

    it('counts rows it merely detached apart from rows it deleted', async () => {
      // Two references on ci.users were nulled — the bystander's created_by and
      // the purged account's own entity_id — and one row was deleted. Folding
      // them together would report three deletions from ci.users and overstate,
      // in the record that exists to be exact, what actually happened.
      const [record] = await query<{
        deleted_rows: Record<string, number>;
        detached_rows: Record<string, number>;
      }>(`SELECT deleted_rows, detached_rows FROM ci.account_purges WHERE user_id = $1`, [victim]);

      expect(record.deleted_rows['ci.users']).toBe(1);
      expect(record.detached_rows['ci.users']).toBe(2);
    });
  });

  describe('running again', () => {
    it('finds nothing due, and changes nothing', async () => {
      const summary = await service.purgeDueAccounts();

      expect(summary.considered).toBe(0);
      expect(await countWhere('ci.users', 'id = $1', [bystander])).toBe(1);
    });

    it('is idempotent if an account is somehow purged twice', async () => {
      // Resumability and idempotency are the same property here: every statement
      // is scoped by "belongs to this account", so a re-run finds nothing rather
      // than double-deleting or resuming from a corrupted cursor.
      const outcome = await service.purgeAccount(victim, new Date(), new Date());

      expect(outcome.status).toBe('purged');
      expect(outcome.deletedRows).toEqual({});
      expect(outcome.detachedRows).toEqual({});
    }, 120_000);
  });
});
