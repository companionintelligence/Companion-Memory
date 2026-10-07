import { randomUUID } from 'node:crypto';

import { LoggerService } from '@ci/common/logging';
import { OrphanCleanupService } from '@ci/domains/search-ingress';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../../__tests__/support/scratchDatabase';
import { INGEST_RESET_TABLES, IngestResetService } from '../IngestResetService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INGEST RESET AND THE INDEX TRUNCATE AGAINST THE REAL SCHEMA.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Both statements empty whole tables, so they run in a database of their own
 * (ScratchDatabase), never the shared test database other suites are writing
 * to. What a mock cannot show and this does:
 *
 *  - the reset's table list is the real foreign-key closure of the ingest
 *    tables, so its TRUNCATE (which has no CASCADE) runs at all;
 *  - a row of another account's in a table the old CASCADE emptied without
 *    looking (`ci.files` here) stops the reset, and nothing is lost;
 *  - the entity and ledger statements touch only the caller's rows;
 *  - the truncate re-opens the index ledger, so the pipeline re-embeds.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[maintenance/IngestResetService.scratch.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(600_000);

describeWithDatabase('ingest reset and index truncate on a scratch database', () => {
  let scratch: ScratchDatabase;
  let reset: IngestResetService;
  let orphanCleanup: OrphanCleanupService;

  const caller = randomUUID();
  const other = randomUUID();

  const query = async <T>(sql: string, params?: unknown[]): Promise<T[]> =>
    (await scratch.dataSource.query(sql, params)) as T[];

  const count = async (sql: string, params?: unknown[]): Promise<number> => {
    const [row] = await query<{ n: number }>(sql, params);

    return Number(row?.n ?? 0);
  };

  const seedEvent = async (userId: string): Promise<string> => {
    const eventId = randomUUID();

    await query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, linked_table, linked_id)
       VALUES ($1::uuid, 'Event', $2::uuid, 'events', $1::uuid)`,
      [eventId, userId],
    );
    await query(`INSERT INTO ci.events (event_id, user_id, start_time) VALUES ($1::uuid, $2::uuid, now())`, [
      eventId,
      userId,
    ]);

    return eventId;
  };

  const seedFile = async (userId: string, eventId: string | null = null): Promise<string> => {
    const fileId = randomUUID();

    await query(
      `INSERT INTO ci.files (id, user_id, content_type, event_id) VALUES ($1::uuid, $2::uuid, 'text/plain', $3::uuid)`,
      [fileId, userId, eventId],
    );

    return fileId;
  };

  const seedLedger = async (userId: string, stage: string, entityId: string): Promise<void> => {
    await query(
      `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, status, stage_version, user_id)
       VALUES ('person', $1::uuid, $2, 'done', 3, $3::uuid)`,
      [entityId, stage, userId],
    );
  };

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'ingest reset and index truncate' });
    await scratch.assertOwn();

    // dbmate migrations do not create pg-boss's schema (the queue library does
    // at boot), and the reset deletes from it. The two columns it reads are enough.
    await query(`CREATE SCHEMA IF NOT EXISTS pgboss`);
    await query(
      `CREATE TABLE IF NOT EXISTS pgboss.job (name text NOT NULL, state text NOT NULL, data jsonb)`,
    );

    await query(`INSERT INTO ci.users (id, email) VALUES ($1::uuid, $2), ($3::uuid, $4)`, [
      caller,
      `owner-${caller}@example.com`,
      other,
      `member-${other}@example.com`,
    ]);

    const logger = new LoggerService();

    reset = new IngestResetService(scratch.dataSource, logger);
    orphanCleanup = new OrphanCleanupService(scratch.dataSource, logger);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('names the whole foreign-key closure of the ingest tables, no more and no less', async () => {
    const closure = await query<{ rel: string }>(
      `WITH RECURSIVE t(rel) AS (
         SELECT unnest($1::regclass[])
         UNION
         SELECT c.conrelid FROM pg_constraint c JOIN t ON c.confrelid = t.rel WHERE c.contype = 'f'
       )
       SELECT rel::text AS rel FROM t`,
      [INGEST_RESET_TABLES.ingest.map(({ schema, table }) => `${schema}.${table}`)],
    );
    const listed = [...INGEST_RESET_TABLES.ingest, ...INGEST_RESET_TABLES.dependents].map(
      ({ schema, table }) => `${schema}.${table}`,
    );

    expect(closure.map(({ rel }) => rel).sort()).toEqual([...listed].sort());
  });

  it('probes every listed table that has a user column, and the rest hang off a probed one', async () => {
    const withUserColumn = await query<{ rel: string }>(
      `SELECT table_schema || '.' || table_name AS rel FROM information_schema.columns
        WHERE column_name = 'user_id' AND (table_schema || '.' || table_name) = ANY($1::text[])`,
      [
        [...INGEST_RESET_TABLES.ingest, ...INGEST_RESET_TABLES.dependents].map(
          ({ schema, table }) => `${schema}.${table}`,
        ),
      ],
    );
    const probed = INGEST_RESET_TABLES.probed.map(({ schema, table }) => `${schema}.${table}`);

    for (const { rel } of withUserColumn) {
      expect(probed).toContain(rel);
    }

    for (const { schema, table, ownedVia } of INGEST_RESET_TABLES.dependents) {
      if (ownedVia === undefined) {
        continue;
      }

      const [parent, column] = /^(\S+) \((\w+)\)$/.exec(ownedVia)?.slice(1) ?? [];
      const notNullFk = await count(
        `SELECT count(*)::int AS n
           FROM pg_constraint c
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
          WHERE c.contype = 'f' AND c.conrelid = $1::regclass AND c.confrelid = $2::regclass
            AND a.attname = $3 AND a.attnotnull`,
        [`${schema}.${table}`, parent, column],
      );

      expect({ table: `${schema}.${table}`, notNullFk }).toEqual({
        table: `${schema}.${table}`,
        notNullFk: 1,
      });
      expect(probed).toContain(parent);
    }
  });

  it('refuses while another account has a file, which the old CASCADE emptied without looking, and loses nothing', async () => {
    const callersEvent = await seedEvent(caller);
    const othersFile = await seedFile(other);

    await expect(reset.reset({ userId: caller })).rejects.toThrow(/ci\.files/);

    expect(await count(`SELECT count(*)::int AS n FROM ci.files WHERE id = $1::uuid`, [othersFile])).toBe(1);
    expect(
      await count(`SELECT count(*)::int AS n FROM ci.events WHERE event_id = $1::uuid`, [callersEvent]),
    ).toBe(1);

    await query(`DELETE FROM ci.files WHERE id = $1::uuid`, [othersFile]);
  });

  it("resets the caller's data and leaves the other account's graph, ledger and queue alone", async () => {
    const callersEvent = await seedEvent(caller);

    await seedFile(caller, callersEvent);

    // The other account keeps rows the reset must not touch: a graph base row
    // that shares the reset's entity type, a ledger row, a queued index job.
    const othersBaseRow = randomUUID();

    await query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, linked_table, linked_id)
       VALUES ($1::uuid, 'Event', $2::uuid, 'events', $1::uuid)`,
      [othersBaseRow, other],
    );

    const callersPerson = randomUUID();
    const othersPerson = randomUUID();

    await seedLedger(caller, 'index.embed_person', callersPerson);
    await seedLedger(other, 'index.embed_person', othersPerson);
    await query(
      `INSERT INTO pgboss.job (name, state, data) VALUES
         ('search-index', 'created', $1::jsonb), ('search-index', 'created', $2::jsonb)`,
      [
        JSON.stringify({ userId: caller, eventId: callersEvent }),
        JSON.stringify({ userId: other, personId: othersPerson }),
      ],
    );

    const result = await reset.reset({ userId: caller });

    expect(result.truncated).toEqual(
      expect.arrayContaining(['ci.events', 'ci.files', 'ci_search.embeddings']),
    );
    expect(await count(`SELECT count(*)::int AS n FROM ci.events`)).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM ci.files`)).toBe(0);

    // The caller's mirror row went with its event; the other account's did not.
    expect(
      await count(`SELECT count(*)::int AS n FROM ci.entities WHERE entity_id = $1::uuid`, [callersEvent]),
    ).toBe(0);
    expect(
      await count(`SELECT count(*)::int AS n FROM ci.entities WHERE entity_id = $1::uuid`, [othersBaseRow]),
    ).toBe(1);

    const versions = await query<{ entity_id: string; stage_version: number }>(
      `SELECT entity_id, stage_version FROM ci.pipeline_state WHERE entity_id = ANY($1::uuid[])`,
      [[callersPerson, othersPerson]],
    );

    expect(Object.fromEntries(versions.map((row) => [row.entity_id, row.stage_version]))).toEqual({
      [callersPerson]: 0,
      [othersPerson]: 3,
    });
    expect(result.ledgerRowsReopened).toBe(1);

    const jobs = await query<{ owner: string }>(`SELECT data->>'userId' AS owner FROM pgboss.job`);

    expect(jobs).toEqual([{ owner: other }]);
    expect(result.searchIndexJobsDeleted).toBe(1);

    await query(`DELETE FROM ci.entities WHERE entity_id = $1::uuid`, [othersBaseRow]);
    await query(`DELETE FROM ci.pipeline_state WHERE entity_id = ANY($1::uuid[])`, [
      [callersPerson, othersPerson],
    ]);
  });

  it("truncating the index re-opens every account's index ledger, and nothing else", async () => {
    const callersPerson = randomUUID();
    const othersPerson = randomUUID();

    await seedLedger(caller, 'index.embed_person', callersPerson);
    await seedLedger(other, 'index.vector_person', othersPerson);
    // Not an index stage: the truncate has no business with it.
    await seedLedger(caller, 'enrich.person_link', callersPerson);

    const result = await orphanCleanup.truncateSearchIndex();

    const rows = await query<{ stage: string; stage_version: number }>(
      `SELECT stage, stage_version FROM ci.pipeline_state WHERE entity_id = ANY($1::uuid[]) ORDER BY stage`,
      [[callersPerson, othersPerson]],
    );

    expect(rows).toEqual([
      { stage: 'enrich.person_link', stage_version: 3 },
      { stage: 'index.embed_person', stage_version: 0 },
      { stage: 'index.vector_person', stage_version: 0 },
    ]);
    expect(result.ledgerRowsReopened).toBe(2);
  });
});
