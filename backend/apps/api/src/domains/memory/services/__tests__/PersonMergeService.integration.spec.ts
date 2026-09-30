import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { PersonEntity } from '../../entities/PersonEntity';
import { GraphDeltaWriter } from '../GraphDeltaWriter';
import { MergeCandidateService } from '../MergeCandidateService';
import { type MergeCounts, PersonMergeService } from '../PersonMergeService';

/**
 * The counts a person merge records, checked against the rows it moved — in
 * Postgres, because only the real driver can show what was wrong with them.
 *
 * Every count used to be `….length` of a bare `UPDATE/DELETE … RETURNING 1`,
 * and TypeORM's Postgres runner resolves those to the PAIR `[rows, rowCount]`.
 * So every `ci.entity_merges.details.counts` value read 2 — and
 * `relationshipsDropped`, a sum of three, read 6 — whatever the merge moved,
 * zero rows included. `PersonMergeService.spec.ts` could not see it: its
 * `query` stub answered with plain rows, a shape the driver never returns for
 * those statements.
 *
 * Every expected number below is chosen to differ from the constant the old
 * code reported, and the second case is the one it got most wrong: nothing to
 * move at all.
 *
 * Opt-in: set `MEMORY_TEST_DATABASE_URL` (or `DATABASE_URL`) to a database with
 * the migrations applied; with nothing reachable this suite SKIPS legibly.
 *
 *   MEMORY_TEST_DATABASE_URL=postgres://companion:pw@localhost:5432/companion \
 *     yarn workspace @ci/be-api jest PersonMergeService.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/PersonMergeService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`PersonMergeService — audit counts, in Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let merger: PersonMergeService;
  let candidates: MergeCandidateService;

  const owner = { userId: uuidv7() } as UserServiceContext;

  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as LoggerService;

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
    });
    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/PersonMergeService.integration');

    await dataSource.query(`INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3)`, [
      owner.userId,
      'Person merge counts fixture',
      `person-merge.${owner.userId}@example.invalid`,
    ]);

    const personRepository = {
      // The merge's statements all run on the real manager, in one real
      // transaction. Only the read-back of the target for the return value is
      // stubbed: it needs the whole ci.entities inheritance tree registered,
      // and what it returns is not under test.
      manager: dataSource.manager,
      findOne: async () =>
        Object.assign(new PersonEntity(), { id: uuidv7(), entityType: 'Person', properties: {} }),
    };

    merger = new PersonMergeService(
      personRepository as never,
      noopLogger,
      { send: async () => [] } as never,
      new GraphDeltaWriter(dataSource, noopLogger),
    );
    candidates = new MergeCandidateService(personRepository as never, noopLogger, merger);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.merge_candidates WHERE owner_user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.entity_merges WHERE owner_user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.entity_identifiers WHERE owner_user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.communications WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.events WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [owner.userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  const insertPerson = async (name: string): Promise<string> => {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, 'Person', $2, '{}'::jsonb, $3)`,
      [id, name, owner.userId],
    );

    return id;
  };

  const insertIdentifiers = async (entityId: string, count: number): Promise<void> => {
    for (let i = 0; i < count; i += 1) {
      const value = `${uuidv7()}@example.invalid`;

      await dataSource.query(
        `INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized, raw_value)
         VALUES ($1, $2, 'email', $3, $3)`,
        [entityId, owner.userId, value],
      );
    }
  };

  /** A message plus its CTI base row, which the composite FK requires. */
  const insertMessage = async (from: string, to: string[]): Promise<string> => {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Communication', $2, 'communications', $1)`,
      [id, owner.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.communications
              (id, time, user_id, communication_type, direction, from_entity_id, to_entity_ids, content)
       VALUES ($1, now(), $2, 'email', 'inbound', $3, $4::uuid[], 'fixture')`,
      [id, owner.userId, from, to],
    );

    return id;
  };

  /** An event plus its CTI base row. */
  const insertEvent = async (organizer: string, participants: string[]): Promise<string> => {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Event', $2, 'events', $1)`,
      [id, owner.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.events (event_id, user_id, start_time, organizer_entity_id, participant_entity_ids)
       VALUES ($1, $2, now(), $3, $4::uuid[])`,
      [id, owner.userId, organizer, participants],
    );

    return id;
  };

  const insertEdge = async (
    from: string,
    to: string,
    type: string,
    options: { active?: boolean; createdAt?: string } = {},
  ): Promise<void> => {
    await dataSource.query(
      `INSERT INTO ci.relationships (from_entity_id, to_entity_id, relationship_type, owner_user_id, is_active, created_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))`,
      [from, to, type, owner.userId, options.active ?? true, options.createdAt ?? null],
    );
  };

  const auditCounts = async (targetId: string): Promise<Array<{ source: string; counts: MergeCounts }>> => {
    const rows: Array<{ source_entity_id: string; details: { counts: MergeCounts } }> =
      await dataSource.query(
        `SELECT source_entity_id, details FROM ci.entity_merges
        WHERE owner_user_id = $1 AND target_entity_id = $2
        ORDER BY source_entity_id`,
        [owner.userId, targetId],
      );

    return rows.map((row) => ({ source: row.source_entity_id, counts: row.details.counts }));
  };

  it('records the rows each re-point moved, not the length of TypeORM’s [rows, rowCount] pair', async () => {
    const target = await insertPerson('Dana Quill');
    const a = await insertPerson('Dana Q');
    const b = await insertPerson('D. Quill');
    const x = await insertPerson('Xavier');
    const y = await insertPerson('Yolanda');

    // Identifiers: 4 + 2 on the sources move; the target's own stays put.
    await insertIdentifiers(a, 4);
    await insertIdentifiers(b, 2);
    await insertIdentifiers(target, 1);

    // Messages. FROM moves on 3 (a, b, a); TO moves on 5.
    await insertMessage(a, [x]); // from
    await insertMessage(b, [target]); // from
    await insertMessage(x, [a, target]); // to → [target]
    await insertMessage(x, [b]); // to
    await insertMessage(target, [x]); // untouched
    await insertMessage(a, [b]); // from AND to
    await insertMessage(x, [b, y]); // to → [target, y]
    await insertMessage(y, [a]); // to

    // Events. The organizer moves on 1; participants move on 4.
    await insertEvent(a, [x]); // organizer
    await insertEvent(x, [a, b]); // participants → [target]
    await insertEvent(x, [target, b, y]); // participants → [target, y]
    await insertEvent(target, [x]); // untouched
    await insertEvent(x, [a]); // participants
    await insertEvent(y, [b, x]); // participants

    // Relationships — dropped as self-references: 3.
    await insertEdge(a, target, 'KNOWS');
    await insertEdge(a, b, 'KNOWS');
    await insertEdge(target, a, 'KNOWS');
    // From side: 3 re-pointed (the oldest active a|b → x KNOWS, and two
    // inactive edges), 2 left on a source and deleted (the younger duplicate,
    // and one the target already has).
    await insertEdge(a, x, 'KNOWS', { createdAt: '2020-01-01T00:00:00Z' });
    await insertEdge(b, x, 'KNOWS', { createdAt: '2020-01-02T00:00:00Z' });
    await insertEdge(target, y, 'KNOWS');
    await insertEdge(a, y, 'KNOWS');
    await insertEdge(b, y, 'FOLLOWS', { active: false });
    await insertEdge(a, x, 'KNEW', { active: false });
    // To side: 3 re-pointed, 2 deleted — the same two shapes.
    await insertEdge(x, a, 'WORKS_WITH', { createdAt: '2020-01-01T00:00:00Z' });
    await insertEdge(x, b, 'WORKS_WITH', { createdAt: '2020-01-02T00:00:00Z' });
    await insertEdge(y, b, 'FRIEND', { active: false });
    await insertEdge(x, b, 'ADVISES');
    await insertEdge(y, a, 'MENTORS');
    await insertEdge(y, target, 'MENTORS');

    await merger.mergePeople(owner, [a, b], target);

    const expected: MergeCounts = {
      identifiers: 6,
      claims: 0,
      blocksCarried: 0,
      communicationsFrom: 3,
      communicationsTo: 5,
      eventsOrganizer: 1,
      eventsParticipants: 4,
      relationshipsFrom: 3,
      relationshipsTo: 3,
      relationshipsDropped: 7,
    };

    // One audit row per source, each carrying the merge's counts.
    expect(await auditCounts(target)).toEqual([a, b].sort().map((source) => ({ source, counts: expected })));

    // …and the counts describe rows that really moved: nothing addresses a
    // source any more, and the target holds what the sources held.
    const [refs] = await dataSource.query(
      `SELECT
         (SELECT count(*)::int FROM ci.entity_identifiers WHERE owner_user_id = $1 AND entity_id = ANY($2::uuid[])) AS identifiers,
         (SELECT count(*)::int FROM ci.communications WHERE user_id = $1
             AND (from_entity_id = ANY($2::uuid[]) OR to_entity_ids && $2::uuid[])) AS communications,
         (SELECT count(*)::int FROM ci.events WHERE user_id = $1
             AND (organizer_entity_id = ANY($2::uuid[]) OR participant_entity_ids && $2::uuid[])) AS events,
         (SELECT count(*)::int FROM ci.relationships WHERE owner_user_id = $1
             AND (from_entity_id = ANY($2::uuid[]) OR to_entity_id = ANY($2::uuid[]))) AS relationships`,
      [owner.userId, [a, b]],
    );
    expect(refs).toEqual({ identifiers: 0, communications: 0, events: 0, relationships: 0 });

    const [onTarget] = await dataSource.query(
      `SELECT
         (SELECT count(*)::int FROM ci.entity_identifiers WHERE owner_user_id = $1 AND entity_id = $2) AS identifiers,
         (SELECT count(*)::int FROM ci.communications WHERE user_id = $1 AND from_entity_id = $2) AS messages_from,
         (SELECT count(*)::int FROM ci.communications WHERE user_id = $1 AND $2 = ANY(to_entity_ids)) AS messages_to,
         (SELECT count(*)::int FROM ci.relationships WHERE owner_user_id = $1) AS edges_left`,
      [owner.userId, target],
    );
    // 6 moved + the target's own; 3 moved + the target's own; the one
    // message already addressed to the target, plus 5; 15 edges less 7 dropped.
    expect(onTarget).toEqual({ identifiers: 7, messages_from: 4, messages_to: 6, edges_left: 8 });
  });

  it('records zeros when the sources are referenced by nothing — the old code said 2 (and 6)', async () => {
    const target = await insertPerson('Robin Vale');
    const source = await insertPerson('R. Vale');

    await merger.mergePeople(owner, [source], target);

    expect(await auditCounts(target)).toEqual([
      {
        source,
        counts: {
          identifiers: 0,
          communicationsFrom: 0,
          communicationsTo: 0,
          eventsOrganizer: 0,
          eventsParticipants: 0,
          relationshipsFrom: 0,
          relationshipsTo: 0,
          relationshipsDropped: 0,
        },
      },
    ]);
  });

  it('resolvePairs reports the pending candidates it stamped', async () => {
    const people = (
      await Promise.all(['Ada', 'Ada Q', 'A. Quill', 'Ada Quill', 'Somebody Else'].map(insertPerson))
    ).sort();
    const [p1, p2, p3, p4, outsider] = people;

    const insertCandidate = async (left: string, right: string, status: string): Promise<void> => {
      const [lo, hi] = [left, right].sort();

      await dataSource.query(
        `INSERT INTO ci.merge_candidates
                (owner_user_id, entity_type, entity_id_a, entity_id_b, score, status, detected_by, detector_version)
         VALUES ($1, 'Person', $2, $3, 0.9, $4, 'test', 1)`,
        [owner.userId, lo, hi, status],
      );
    };

    await insertCandidate(p1, p2, 'pending');
    await insertCandidate(p1, p3, 'pending');
    await insertCandidate(p3, p4, 'pending');
    await insertCandidate(p2, p3, 'rejected'); // already decided: keeps its answer
    await insertCandidate(p1, outsider, 'pending'); // one endpoint outside the decision

    await expect(candidates.resolvePairs(owner, [p1, p2, p3, p4], 'accepted')).resolves.toBe(3);
    // Nothing pending is left inside the set, so a second stamp touches nothing.
    await expect(candidates.resolvePairs(owner, [p1, p2, p3, p4], 'accepted')).resolves.toBe(0);

    const statuses: Array<{ status: string; count: number }> = await dataSource.query(
      `SELECT status, count(*)::int AS count FROM ci.merge_candidates
        WHERE owner_user_id = $1 AND (entity_id_a = ANY($2::uuid[]) OR entity_id_b = ANY($2::uuid[]))
        GROUP BY status ORDER BY status`,
      [owner.userId, people],
    );
    expect(statuses).toEqual([
      { status: 'accepted', count: 3 },
      { status: 'pending', count: 1 },
      { status: 'rejected', count: 1 },
    ]);
  });
});
