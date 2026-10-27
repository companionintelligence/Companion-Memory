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

/**
 * Rows in the compressed chunk: one past TimescaleDB's default cap on tuples a
 * single statement may decompress (`timescaledb.max_tuples_decompressed_per_dml_transaction`,
 * 100,000), so a purge that leaves the cap in place fails here as it would on
 * an appliance with a month of dense GPS history.
 */
const COMPRESSED_POSITION_ROWS = 100_001;

describeWithDatabase(`account purge, against the real schema (${availability.target})`, () => {
  let scratch: ScratchDatabase;
  let service: AccountPurgeService;
  let deletedObjects: Array<{ bucket: string; keys: string[] }>;
  /** Chunks of ci.position the fixture compressed. */
  let compressedChunks: number;

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
  /** ci.ask_audit rows the victim asked: of the bystander, and of a peer. */
  const askedBystander = randomUUID();
  const askedPeer = randomUUID();

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

    // A second chunk, two months along: the batch loop has to visit every chunk,
    // not just the one holding most of the rows.
    parameters.push(new Date(Date.UTC(2026, 2, 1)));
    positions.push(`($${parameters.length}, $1, 'gps', ST_SetSRID(ST_MakePoint(0, 0), 4326))`);

    await query(
      `INSERT INTO ci.position (time, user_id, source, location) VALUES ${positions.join(', ')}`,
      parameters,
    );

    // A third chunk, five months along, compressed below.
    await query(
      `INSERT INTO ci.position (time, user_id, source, location)
       SELECT TIMESTAMPTZ '2026-06-01 00:00:00+00' + g * INTERVAL '1 second', $1, 'gps',
              ST_SetSRID(ST_MakePoint(0, 0), 4326)
         FROM generate_series(0, $2::int - 1) g`,
      [victim, COMPRESSED_POSITION_ROWS],
    );

    await query(
      `INSERT INTO ci.position (time, user_id, source, location)
       VALUES (NOW(), $1, 'gps', ST_SetSRID(ST_MakePoint(1, 1), 4326))`,
      [bystander],
    );

    // The June chunk compressed, as the compression policy leaves old
    // position data on an appliance. A compressed chunk refuses `ctid`
    // ("transparent decompression only supports tableoid system column"), so the
    // purge has to reach those rows another way.
    compressedChunks = (
      await query(
        `SELECT compress_chunk(c) FROM show_chunks('ci.position') c
          WHERE c IN (SELECT format('%I.%I', chunk_schema, chunk_name)::regclass
                        FROM timescaledb_information.chunks
                       WHERE hypertable_schema = 'ci' AND hypertable_name = 'position'
                         AND range_end <= '2026-07-01' AND range_start >= '2026-05-01')`,
      )
    ).length;

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

    // ── Appliance-wide settings the account last changed ───────────────────
    // updated_by is each table's only reference to ci.users (SET NULL). It says
    // who changed the switch, not whose it is: the switch stays for everyone.
    await query(
      `INSERT INTO ci.outbound_settings (key, enabled, updated_at, updated_by) VALUES ('crash_reports', false, NOW(), $1)`,
      [victim],
    );
    await query(
      `INSERT INTO ci.job_settings (kind, key, mode, updated_at, updated_by) VALUES ('queue', 'seed-queue', 'paused', NOW(), $1)`,
      [victim],
    );

    // ── Ask disclosure records, which no foreign key and no user_id reach ──
    // One the bystander answered for the victim (kept, without the victim's
    // question), one only the victim and a peer were party to (deleted).
    for (const [id, asker, responder, peer] of [
      [askedBystander, victim, bystander, null],
      [askedPeer, victim, null, randomUUID()],
    ] as const) {
      await query(
        `INSERT INTO ci.ask_audit (id, asker_user_id, responder_user_id, peer_link_id, query, outcome, disclosed_entities)
         VALUES ($1, $2, $3, $4, $5, 'answered', '["bystander-entity"]')`,
        [id, asker, responder, peer, JSON.stringify({ queryType: 'retrieval', prompt: 'where was Alice?' })],
      );
    }

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

    it('takes the account out of the ask records the bystander keeps, and deletes its own', async () => {
      const rows = await query<{
        id: string;
        asker_user_id: string | null;
        query: unknown;
        disclosed_entities: unknown;
      }>(`SELECT id, asker_user_id, query, disclosed_entities FROM ci.ask_audit WHERE id = ANY($1::uuid[])`, [
        [askedBystander, askedPeer],
      ]);

      expect(rows).toEqual([
        {
          id: askedBystander,
          asker_user_id: null,
          query: { queryType: 'retrieval', prompt: '' },
          disclosed_entities: ['bystander-entity'],
        },
      ]);
    });

    it('empties a hypertable across all of its chunks', async () => {
      expect(await countWhere('ci.position', 'user_id = $1', [victim])).toBe(0);
    });

    it('reaches the rows in a compressed chunk', async () => {
      expect(compressedChunks).toBe(1);
      expect(await countWhere('ci.position', `user_id = $1 AND time >= '2026-05-01'`, [victim])).toBe(0);
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

    it('keeps the appliance settings it last changed, with who changed them cleared', async () => {
      // Deleting these rows would turn the crash-report upload back on and
      // unpause the queue for every account still here.
      expect(
        await countWhere(
          'ci.outbound_settings',
          "key = 'crash_reports' AND enabled = false AND updated_by IS NULL",
          [],
        ),
      ).toBe(1);
      expect(
        await countWhere(
          'ci.job_settings',
          "key = 'seed-queue' AND mode = 'paused' AND updated_by IS NULL",
          [],
        ),
      ).toBe(1);
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
      expect(record.deleted_rows['ci.position']).toBe(POSITION_ROWS + 1 + COMPRESSED_POSITION_ROWS);
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
      expect(record.detached_rows['ci.outbound_settings']).toBe(1);
      expect(record.detached_rows['ci.job_settings']).toBe(1);
      expect(record.deleted_rows['ci.outbound_settings']).toBeUndefined();
      // The ask record the bystander keeps, and the one only the victim had.
      expect(record.detached_rows['ci.ask_audit']).toBe(1);
      expect(record.deleted_rows['ci.ask_audit']).toBe(1);
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

  describe('a purge that destroys its own audit record', () => {
    // The failure `markCompleted` guards against, reproduced: something in the
    // purge's own statements takes out the `ci.account_purges` row, as the
    // plan once did when that table's `user_id` matched the owner naming
    // convention. A trigger stands in for that plan, scoped to one account.
    //
    // The guard read `.length` of a bare `UPDATE … RETURNING`, which TypeORM
    // resolves to `[rows, rowCount]` — 2 whether or not the row was found — so
    // until it counted through a CTE this purge reported success.
    const selfErasing = randomUUID();

    beforeAll(async () => {
      await query(
        `INSERT INTO ci.users (id, email, name, deleted_at, purge_after)
         VALUES ($1, $2, 'Self-erasing', NOW() - INTERVAL '31 days', NOW() - INTERVAL '1 day')`,
        [selfErasing, `self-erasing-${selfErasing}@example.test`],
      );
      await query(`
        CREATE FUNCTION public.purge_spec_drop_audit_record() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          DELETE FROM ci.account_purges WHERE user_id = OLD.id;
          RETURN OLD;
        END
        $$
      `);
      await query(`
        CREATE TRIGGER purge_spec_drop_audit_record
        AFTER DELETE ON ci.users
        FOR EACH ROW WHEN (OLD.id = '${selfErasing}'::uuid)
        EXECUTE FUNCTION public.purge_spec_drop_audit_record()
      `);
    }, 60_000);

    afterAll(async () => {
      await query(`DROP TRIGGER IF EXISTS purge_spec_drop_audit_record ON ci.users`);
      await query(`DROP FUNCTION IF EXISTS public.purge_spec_drop_audit_record()`);
    }, 60_000);

    it('refuses to report the account as purged', async () => {
      const outcome = await service.purgeAccount(selfErasing, new Date(), new Date());

      expect(outcome.status).toBe('failed');
      expect(outcome.error).toMatch(/audit record is missing/);
      // The data really is gone — which is why the outcome must not say so
      // with no record behind it.
      expect(await countWhere('ci.users', 'id = $1', [selfErasing])).toBe(0);
      expect(await countWhere('ci.account_purges', 'user_id = $1', [selfErasing])).toBe(0);
    }, 120_000);
  });

  /** An account ended with its purge due, and an entity it owns. */
  const addDueAccount = async (name: string): Promise<{ id: string; entity: string }> => {
    const id = randomUUID();
    const entity = randomUUID();

    await query(`INSERT INTO ci.users (id, email, name) VALUES ($1, $2, $3)`, [
      id,
      `${name.toLowerCase()}-${id}@example.test`,
      name,
    ]);
    await query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name) VALUES ($1, 'Person', $2, 'seed')`,
      [entity, id],
    );
    await query(
      `UPDATE ci.users SET deleted_at = NOW() - INTERVAL '30 days', purge_after = NOW() - INTERVAL '1 hour'
        WHERE id = $1`,
      [id],
    );

    return { id, entity };
  };

  describe("another account pointing at the account's entities", () => {
    // `ci.users.entity_id` of a different account naming one of this account's entities. The purge
    // used to delete that account through it; then it stopped, and failed on the foreign key on
    // every retry instead, leaving the ended account unpurged and its address taken for good.
    it('nulls the pointer, keeps that account, and finishes', async () => {
      const victim = await addDueAccount('Pointed-at');
      const pointer = randomUUID();

      await query(`INSERT INTO ci.users (id, email, name, entity_id) VALUES ($1, $2, 'Pointer', $3)`, [
        pointer,
        `pointer-${pointer}@example.test`,
        victim.entity,
      ]);
      await query(`INSERT INTO ci.notes (id, user_id, content) VALUES ($1, $2, 'kept')`, [
        randomUUID(),
        pointer,
      ]);

      const outcome = await service.purgeAccount(victim.id, new Date(), new Date());

      expect(outcome).toMatchObject({ status: 'purged' });
      expect(await countWhere('ci.users', 'id = $1', [victim.id])).toBe(0);
      expect(await countWhere('ci.entities', 'entity_id = $1', [victim.entity])).toBe(0);
      expect(await countWhere('ci.users', 'id = $1 AND entity_id IS NULL', [pointer])).toBe(1);
      expect(await countWhere('ci.notes', 'user_id = $1', [pointer])).toBe(1);
      // The other account's pointer, counted as detached, not deleted.
      expect(outcome.detachedRows['ci.users']).toBe(1);
    }, 120_000);
  });

  describe("a deleted account's summary labels", () => {
    // `hbpe.summary_l1_label` has no user column and no foreign key to ci.summaries, so only the
    // implicit edge in purgeCatalog.ts leads the purge to it.
    it("removes the account's labels and keeps another account's", async () => {
      const victim = await addDueAccount('Labelled');
      const victimSummary = randomUUID();
      const bystanderSummary = randomUUID();

      for (const [summary, owner] of [
        [victimSummary, victim.id],
        [bystanderSummary, bystander],
      ]) {
        await query(
          `INSERT INTO ci.summaries (summary_id, user_id, period_start, period_end, period_type, source_types)
           VALUES ($1, $2, '2026-01-01', '2026-01-02', 'daily', '{}')`,
          [summary, owner],
        );
        await query(`INSERT INTO hbpe.summary_l1_label (summary_id, l0_class) VALUES ($1, 'seed')`, [
          summary,
        ]);
      }

      const outcome = await service.purgeAccount(victim.id, new Date(), new Date());

      expect(outcome.status).toBe('purged');
      expect(outcome.deletedRows['hbpe.summary_l1_label']).toBe(1);
      expect(await countWhere('hbpe.summary_l1_label', 'summary_id = $1', [victimSummary])).toBe(0);
      expect(await countWhere('hbpe.summary_l1_label', 'summary_id = $1', [bystanderSummary])).toBe(1);
    }, 120_000);
  });

  describe('an object store that is down', () => {
    // The bytes go first, so an unreachable store keeps every row of the account. That has to
    // say which dependency failed, and reach someone, rather than retry quietly for ever.
    it('names the store in the failure and reports the account as stalled once it is overdue', async () => {
      const victim = await addDueAccount('Stored');

      await query(
        `INSERT INTO ci.files (id, user_id, content_type, bucket, key, filename)
         VALUES ($1, $2, 'image/png', 'companion', $3, 'seed.png')`,
        [randomUUID(), victim.id, randomUUID()],
      );

      const logger = new LoggerService();
      const down = new AccountPurgeService(scratch.dataSource, logger, {
        deleteObjects: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:9000');
        },
      });

      const outcome = await down.purgeAccount(victim.id, new Date(), new Date());

      expect(outcome.status).toBe('failed');
      expect(outcome.error).toMatch(/^Object store unavailable.*ECONNREFUSED/);
      expect(await countWhere('ci.users', 'id = $1', [victim.id])).toBe(1);

      const [record] = await query<{ last_error: string }>(
        `SELECT last_error FROM ci.account_purges WHERE user_id = $1`,
        [victim.id],
      );
      expect(record.last_error).toMatch(/^Object store unavailable/);

      // Not stalled yet: it was due an hour ago.
      expect((await down.findStalledPurges()).oldest.map((row) => row.userId)).not.toContain(victim.id);

      // Two days later it is, and every run says so at error level.
      const later = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
      const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);

      try {
        const summary = await down.purgeDueAccounts(later);

        expect(summary.stalled).toBeGreaterThanOrEqual(1);
        expect(error).toHaveBeenCalledWith(
          'Ended accounts are still not purged long after their deadline',
          expect.objectContaining({
            oldest: expect.arrayContaining([
              expect.objectContaining({
                userId: victim.id,
                lastError: expect.stringMatching(/^Object store unavailable/),
              }),
            ]),
          }),
        );
      } finally {
        error.mockRestore();
      }

      // The store back: the next run finishes it, and it is no longer reported.
      expect((await service.purgeAccount(victim.id, new Date(), new Date())).status).toBe('purged');
      expect((await service.findStalledPurges(later)).oldest.map((row) => row.userId)).not.toContain(
        victim.id,
      );
    }, 120_000);
  });
});
