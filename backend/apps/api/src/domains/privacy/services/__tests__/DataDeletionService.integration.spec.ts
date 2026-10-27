import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';

import {
  resolveAdminConnection,
  ScratchDatabase,
  scratchDatabaseAvailability,
} from '../../../__tests__/support/scratchDatabase';
import { DataDeletionAuditEntity } from '../../entities/DataDeletionAuditEntity';
import { DataDeletionService } from '../DataDeletionService';

/**
 * `POST /users/me/delete`, against the real schema: every migration, in a
 * database of its own (see `scratchDatabase.ts`).
 *
 * What only a real Postgres can show: that a table delete which fails part way
 * through takes back every table already purged (the unit test's in-memory
 * rollback is a model of that, not a proof), that the deletes of a compressed
 * hypertable chunk fit in one transaction, and that the foreign keys the plan
 * does not list (`ci.users.created_by`) no longer refuse the account row.
 *
 * Skips (loudly) when there is no administrative connection.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[DataDeletionService.integration] SKIPPED — ${availability.reason}`);
}

/**
 * One past TimescaleDB's default cap on the tuples one TRANSACTION may
 * decompress (`timescaledb.max_tuples_decompressed_per_dml_transaction`). Each
 * statement used to commit on its own; in one transaction the cap is shared.
 */
const COMPRESSED_POSITION_ROWS = 100_001;

jest.setTimeout(600_000);

describeWithDatabase(`immediate account delete, against the real schema (${availability.target})`, () => {
  let scratch: ScratchDatabase;
  /** Maps the audit entity, which the scratch connection does not. */
  let dataSource: DataSource;
  let service: DataDeletionService;
  let deletedObjects: Array<{ bucket: string; keys: string[] }>;

  /** The account being deleted. */
  const victim = randomUUID();
  /** Created by the victim, and asks of / answers the victim. Must survive. */
  const bystander = randomUUID();
  /** A third account, party to nothing the victim did. */
  const other = randomUUID();
  const victimEntities = [randomUUID(), randomUUID(), randomUUID()];
  const objectKey = randomUUID();

  const audit = {
    asked: randomUUID(),
    answered: randomUUID(),
    toPeer: randomUUID(),
    fromPeer: randomUUID(),
    unrelated: randomUUID(),
  };

  const query = async <T>(sql: string, parameters?: unknown[]): Promise<T[]> =>
    (await dataSource.query(sql, parameters)) as T[];

  const count = async (table: string, where: string, parameters: unknown[]): Promise<number> => {
    const [row] = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE ${where}`,
      [...parameters],
    );

    return Number(row.count);
  };

  /** Everything of the victim's the delete must take, counted. */
  const victimFootprint = async () => ({
    user: await count('ci.users', 'id = $1', [victim]),
    entities: await count('ci.entities', 'owner_user_id = $1', [victim]),
    notes: await count('ci.notes', 'user_id = $1', [victim]),
    savedSearches: await count('ci.saved_searches', 'user_id = $1', [victim]),
    files: await count('ci.files', 'user_id = $1', [victim]),
    positions: await count('ci.position', 'user_id = $1', [victim]),
    askAudit: await count('ci.ask_audit', 'asker_user_id = $1 OR responder_user_id = $1', [victim]),
    createdBy: await count('ci.users', 'created_by = $1', [victim]),
  });

  const failingNotesTrigger = async (userId: string) => {
    await query(`
      CREATE OR REPLACE FUNCTION refuse_note_delete_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.user_id = '${userId}'::uuid THEN
          RAISE EXCEPTION 'note delete refused for the test';
        END IF;
        RETURN OLD;
      END $$`);
    await query(`DROP TRIGGER IF EXISTS refuse_note_delete ON ci.notes`);
    await query(
      `CREATE TRIGGER refuse_note_delete BEFORE DELETE ON ci.notes
         FOR EACH ROW EXECUTE FUNCTION refuse_note_delete_for_test()`,
    );
  };

  const dropFailingNotesTrigger = async () => {
    await query(`DROP TRIGGER IF EXISTS refuse_note_delete ON ci.notes`);
  };

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'DataDeletionService.integration.spec' });
    await scratch.assertOwn();

    const admin = resolveAdminConnection()!;
    dataSource = new DataSource({
      type: 'postgres',
      host: admin.host,
      port: admin.port,
      username: admin.username,
      password: admin.password,
      database: scratch.name,
      entities: [DataDeletionAuditEntity],
      synchronize: false,
      logging: false,
      extra: { max: 4 },
    });
    await dataSource.initialize();

    deletedObjects = [];
    service = new DataDeletionService(
      dataSource,
      // No connections to revoke: the revocations are not what this suite is about.
      { find: async () => [] } as never,
      dataSource.getRepository(DataDeletionAuditEntity),
      {} as never,
      { cleanOrphans: async () => ({ results: [], totalDeleted: 0, dryRun: false }) } as never,
      {} as never,
      {} as never,
      new LoggerService(),
      {
        deleteObjects: async (bucket: string, keys: string[]) => {
          deletedObjects.push({ bucket, keys });
        },
      },
    );

    // ── Three accounts; the victim created the bystander ──────────────────
    await query(`INSERT INTO ci.users (id, email, name) VALUES ($1, $2, 'Victim')`, [
      victim,
      `victim-${victim}@example.test`,
    ]);
    await query(`INSERT INTO ci.users (id, email, name, created_by) VALUES ($1, $2, 'Bystander', $3)`, [
      bystander,
      `bystander-${bystander}@example.test`,
      victim,
    ]);
    await query(`INSERT INTO ci.users (id, email, name) VALUES ($1, $2, 'Other')`, [
      other,
      `other-${other}@example.test`,
    ]);

    for (const entity of victimEntities) {
      await query(
        `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name) VALUES ($1, 'Person', $2, 'seed')`,
        [entity, victim],
      );
    }

    await query(`UPDATE ci.users SET entity_id = $2 WHERE id = $1`, [victim, victimEntities[0]]);

    for (const owner of [victim, bystander]) {
      await query(`INSERT INTO ci.notes (id, user_id, content) VALUES ($1, $2, 'seed note')`, [
        randomUUID(),
        owner,
      ]);
    }

    for (let index = 0; index < 2; index += 1) {
      await query(`INSERT INTO ci.saved_searches (id, user_id) VALUES ($1, $2)`, [randomUUID(), victim]);
    }

    await query(
      `INSERT INTO ci.files (id, user_id, content_type, bucket, key, filename)
       VALUES ($1, $2, 'image/png', 'companion', $3, 'seed.png')`,
      [randomUUID(), victim, objectKey],
    );

    // A compressed ci.position chunk holding more than the cap.
    await query(
      `INSERT INTO ci.position (time, user_id, source, location)
       SELECT TIMESTAMPTZ '2026-06-01 00:00:00+00' + g * INTERVAL '1 second', $1, 'gps',
              ST_SetSRID(ST_MakePoint(0, 0), 4326)
         FROM generate_series(0, $2::int - 1) g`,
      [victim, COMPRESSED_POSITION_ROWS],
    );
    const compressed = await query(
      `SELECT compress_chunk(c) FROM show_chunks('ci.position') c
        WHERE c IN (SELECT format('%I.%I', chunk_schema, chunk_name)::regclass
                      FROM timescaledb_information.chunks
                     WHERE hypertable_schema = 'ci' AND hypertable_name = 'position'
                       AND range_end <= '2026-07-01' AND range_start >= '2026-05-01')`,
    );
    expect(compressed).toHaveLength(1);

    // ── ci.ask_audit: every way the victim can be a party ──────────────────
    const insertAudit = (
      id: string,
      asker: string | null,
      responder: string | null,
      prompt: string,
      disclosed: string[],
    ) =>
      query(
        `INSERT INTO ci.ask_audit
           (id, asker_user_id, responder_user_id, peer_link_id, query, consent_basis, outcome,
            disclosed_entities, backing_entities, disclosed_count)
         VALUES ($1, $2, $3, $4, $5, $6, 'answered', $7, $7, $8)`,
        [
          id,
          asker,
          responder,
          asker == null || responder == null ? randomUUID() : null,
          JSON.stringify({
            queryType: 'retrieval',
            dataClass: 'calendar',
            prompt,
            filters: { who: 'Alice' },
            actor: { kind: 'person' },
          }),
          responder == null ? null : randomUUID(),
          JSON.stringify(disclosed),
          disclosed.length,
        ],
      );

    await insertAudit(audit.asked, victim, bystander, 'where was Alice on Tuesday?', ['bystander-entity']);
    await insertAudit(audit.answered, bystander, victim, 'are you free Friday?', [victimEntities[1]]);
    await insertAudit(audit.toPeer, victim, null, 'hello peer', []);
    await insertAudit(audit.fromPeer, null, victim, 'hello from a peer', [victimEntities[2]]);
    await insertAudit(audit.unrelated, bystander, other, 'unrelated', ['other-entity']);
  }, 300_000);

  afterAll(async () => {
    await dataSource?.destroy();
    await scratch?.drop();
  }, 60_000);

  it('a table delete that fails part way takes back everything already purged, and is audited as failed', async () => {
    const before = await victimFootprint();
    expect(before).toEqual({
      user: 1,
      entities: 3,
      notes: 1,
      savedSearches: 2,
      files: 1,
      positions: COMPRESSED_POSITION_ROWS,
      askAudit: 4,
      createdBy: 1,
    });
    const askAuditBefore = await query(`SELECT * FROM ci.ask_audit ORDER BY id`);

    // ci.notes comes after ci.entities, ci.position and ci.files in the plan.
    await failingNotesTrigger(victim);

    try {
      // As POST /users/me/delete runs it: inside the handover's transaction.
      await expect(
        dataSource.transaction((manager) =>
          service.deleteAccount({ userId: victim }, { transaction: manager }),
        ),
      ).rejects.toThrow('note delete refused for the test');
    } finally {
      await dropFailingNotesTrigger();
    }

    expect(await victimFootprint()).toEqual(before);
    expect(await query(`SELECT * FROM ci.ask_audit ORDER BY id`)).toEqual(askAuditBefore);
    const [user] = await query<{ entity_id: string }>(`SELECT entity_id FROM ci.users WHERE id = $1`, [
      victim,
    ]);
    expect(user.entity_id).toBe(victimEntities[0]);
    // The bytes go last, so a failure before them leaves them where they were.
    expect(deletedObjects).toEqual([]);

    const audits = await query<{ status: string; error: string; total_deleted: number }>(
      `SELECT status, error, total_deleted FROM ci.data_deletion_audit WHERE subject_user_id = $1`,
      [victim],
    );
    expect(audits).toEqual([
      { status: 'failed', error: expect.stringContaining('note delete refused'), total_deleted: 0 },
    ]);
  });

  it('then deletes the whole account in one transaction', async () => {
    const result = await dataSource.transaction((manager) =>
      service.deleteAccount({ userId: victim }, { transaction: manager }),
    );

    expect(result.userDeleted).toBe(true);
    expect(result.deletedCounts).toMatchObject({
      'ci.users': 1,
      'ci.entities': 3,
      'ci.notes': 1,
      'ci.saved_searches': 2,
      'ci.position': COMPRESSED_POSITION_ROWS,
      'ci.ask_audit': 2,
    });
    expect(result.detachedCounts).toEqual({ 'ci.ask_audit': 2, 'ci.users': 1 });
    expect(result.deletedObjects).toBe(1);
    expect(deletedObjects).toEqual([{ bucket: 'companion', keys: [objectKey] }]);

    expect(await victimFootprint()).toEqual({
      user: 0,
      entities: 0,
      notes: 0,
      savedSearches: 0,
      files: 0,
      positions: 0,
      askAudit: 0,
      createdBy: 0,
    });

    const audits = await query<{ status: string }>(
      `SELECT status FROM ci.data_deletion_audit WHERE subject_user_id = $1 ORDER BY created_at`,
      [victim],
    );
    expect(audits.map((a) => a.status)).toEqual(['failed', 'completed']);
  });

  it('leaves the account it created alive, with nothing naming the victim', async () => {
    const [row] = await query<{ created_by: string | null }>(
      `SELECT created_by FROM ci.users WHERE id = $1`,
      [bystander],
    );
    expect(row).toEqual({ created_by: null });
    expect(await count('ci.notes', 'user_id = $1', [bystander])).toBe(1);
  });

  it("keeps the other party's ask records, without the victim in them, and deletes the victim's own", async () => {
    const rows = await query<{
      id: string;
      asker_user_id: string | null;
      responder_user_id: string | null;
      query: Record<string, unknown>;
      consent_basis: string | null;
      disclosed_entities: string[];
      backing_entities: string[];
      disclosed_count: number;
    }>(
      `SELECT id, asker_user_id, responder_user_id, query, consent_basis, disclosed_entities,
              backing_entities, disclosed_count
         FROM ci.ask_audit`,
    );
    const byId = new Map(rows.map((row) => [row.id, row]));

    // Only the victim and a peer were parties: nobody is left whose record it is.
    expect(byId.has(audit.toPeer)).toBe(false);
    expect(byId.has(audit.fromPeer)).toBe(false);

    // The victim asked the bystander: the bystander's disclosure history keeps
    // what they disclosed and the kind of question, not the victim's words.
    expect(byId.get(audit.asked)).toMatchObject({
      asker_user_id: null,
      responder_user_id: bystander,
      query: { queryType: 'retrieval', dataClass: 'calendar', prompt: '' },
      disclosed_entities: ['bystander-entity'],
      disclosed_count: 1,
    });
    expect(byId.get(audit.asked)!.query).not.toHaveProperty('filters');
    expect(byId.get(audit.asked)!.query).not.toHaveProperty('actor');
    expect(byId.get(audit.asked)!.consent_basis).not.toBeNull();

    // The victim answered the bystander: the bystander's question stays; the
    // victim's entity ids and grant go.
    expect(byId.get(audit.answered)).toMatchObject({
      asker_user_id: bystander,
      responder_user_id: null,
      query: { prompt: 'are you free Friday?', filters: { who: 'Alice' } },
      consent_basis: null,
      disclosed_entities: [],
      backing_entities: [],
      disclosed_count: 1,
    });

    // Untouched.
    expect(byId.get(audit.unrelated)).toMatchObject({
      asker_user_id: bystander,
      responder_user_id: other,
      query: { prompt: 'unrelated' },
      disclosed_entities: ['other-entity'],
    });
  });

  it('opens and rolls back a transaction of its own when the caller has none', async () => {
    const second = randomUUID();
    await query(`INSERT INTO ci.users (id, email, name) VALUES ($1, $2, 'Second')`, [
      second,
      `second-${second}@example.test`,
    ]);
    await query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name) VALUES ($1, 'Person', $2, 'seed')`,
      [randomUUID(), second],
    );
    await query(`INSERT INTO ci.notes (id, user_id, content) VALUES ($1, $2, 'seed note')`, [
      randomUUID(),
      second,
    ]);
    await query(`INSERT INTO ci.users (id, email, name, created_by) VALUES ($1, $2, 'Created', $3)`, [
      randomUUID(),
      `created-${second}@example.test`,
      second,
    ]);

    await failingNotesTrigger(second);
    try {
      await expect(service.deleteAccount({ userId: second })).rejects.toThrow(
        'note delete refused for the test',
      );
    } finally {
      await dropFailingNotesTrigger();
    }

    expect(await count('ci.users', 'id = $1', [second])).toBe(1);
    expect(await count('ci.entities', 'owner_user_id = $1', [second])).toBe(1);
    expect(await count('ci.users', 'created_by = $1', [second])).toBe(1);

    const result = await service.deleteAccount({ userId: second });

    expect(result.userDeleted).toBe(true);
    expect(await count('ci.users', 'id = $1 OR created_by = $1', [second])).toBe(0);
    expect(await count('ci.entities', 'owner_user_id = $1', [second])).toBe(0);
  });
});
