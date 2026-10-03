import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { HbpeNotifyService } from '@ci/common/hbpe';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { CommunicationRemovedEvent } from '@ci/domains/memory/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { CommunicationBaseEntity } from '../../entities/CommunicationBaseEntity';
import { CommunicationEntity } from '../../entities/CommunicationEntity';
import { CommunicationService } from '../CommunicationService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';
import { nothingWrapped } from '../wrappedFilePurge';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PURGED COMMUNICATION LEAVES NOTHING BEHIND. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `memory.forget`'s `archive_and_delete` deleted a `Communication` node by
 * deleting its `ci.entities` row and trusting the foreign keys. Nothing in the
 * schema references `ci.communications`, so the delete was never refused, and it
 * left every row that names the message by id with no foreign key to say so:
 * the provenance ledger, the pipeline bookkeeping, the tags and categories and
 * the graph deltas, which carry the subject line. It also left the identifier
 * claims, which are the raw sender and recipients of the message.
 *
 * `CommunicationService.purge` is the teardown that replaces it for
 * `memory.forget`. Each case here seeds a doomed communication and a CONTROL one
 * with a row in every table the purge is meant to clean, and checks that every
 * one of those rows is gone for the first, and that the second did not move. The
 * footprint is asserted non-zero before the purge, in every table, so the test
 * cannot pass because a fixture quietly wrote nothing.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database of your OWN, or run `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/CommunicationService.purge.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

const SENT_ON = new Date('2026-08-19T17:00:00Z');
const MOVED_TO = new Date('2026-08-23T09:30:00Z');

const logger = () =>
  ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

/**
 * Polls until `probe` finds something. For waiting on Postgres to show a state, where a fixed sleep is
 * either too short under load or a slow test everywhere else.
 */
async function until<T>(probe: () => Promise<T | null>, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const found = await probe();

    if (found !== null) {
      return found;
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The UTC day of a time, which is the unit HBPE re-serialises. */
const dayOf = (time: Date): string => time.toISOString().slice(0, 10);

/** One communication and the Person its sender resolved to. */
interface Aggregate {
  communicationId: string;
  /** The Person a claim of this message resolved to. A Person is a node in its own right, so it outlives the message. */
  personId: string;
}

/** Every place a row can point at a communication, with how to count them. A probe takes its id as `$1`. */
const FOOTPRINT: Array<[label: string, sql: string]> = [
  ['ci.entities (Communication)', `SELECT count(*) FROM ci.entities WHERE entity_id = $1`],
  ['ci.communications', `SELECT count(*) FROM ci.communications WHERE id = $1`],
  [
    'ci.relationships',
    `SELECT count(*) FROM ci.relationships WHERE from_entity_id = $1 OR to_entity_id = $1`,
  ],
  [
    'ci.graph_deltas (of its edges)',
    `SELECT count(*) FROM ci.graph_deltas
      WHERE node_type = 'relationship' AND (from_entity_id = $1 OR to_entity_id = $1)`,
  ],
  [
    'ci.record_sources',
    `SELECT count(*) FROM ci.record_sources WHERE record_table = 'communications' AND record_id = $1`,
  ],
  [
    'ci.identifier_claims',
    `SELECT count(*) FROM ci.identifier_claims WHERE subject_type = 'communication' AND subject_id = $1`,
  ],
  ['ci.pipeline_state', `SELECT count(*) FROM ci.pipeline_state WHERE entity_id = $1`],
  ['ci.pipeline_dead_letters', `SELECT count(*) FROM ci.pipeline_dead_letters WHERE entity_id = $1`],
  ['ci.graph_deltas', `SELECT count(*) FROM ci.graph_deltas WHERE entity_id = $1`],
  ['ci_search.entity_tag', `SELECT count(*) FROM ci_search.entity_tag WHERE entity_id = $1`],
  ['ci_search.entity_categories', `SELECT count(*) FROM ci_search.entity_categories WHERE entity_id = $1`],
  ['ci_search.vectors', `SELECT count(*) FROM ci_search.vectors WHERE entity_id = $1`],
  ['ci_search.embeddings', `SELECT count(*) FROM ci_search.embeddings WHERE entity_id = $1`],
  ['ci_search.index_skips', `SELECT count(*) FROM ci_search.index_skips WHERE entity_id = $1`],
];

describeWithDb(`CommunicationService.purge against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let communications: CommunicationService;

  const ownerId = uuidv7();
  const strangerId = uuidv7();
  const owner = { userId: ownerId } as UserServiceContext;
  const stranger = { userId: strangerId } as UserServiceContext;

  const published: Array<{ name: string; payload: unknown }> = [];
  const notified: Array<{ userId: string; days: string[] }> = [];

  /** Every id a case seeded, for the tables that carry no owner to wipe by. */
  let seeded: string[] = [];

  const signalling = {
    send: jest.fn(async (name: string, payload: unknown) => {
      published.push({ name, payload });

      return [];
    }),
  } as unknown as EventService;
  const hbpe = {
    notifyCommunications: jest.fn(async (userId: string, times: Date | Iterable<Date>) => {
      notified.push({ userId, days: Array.from(times instanceof Date ? [times] : times, dayOf).sort() });
    }),
  } as unknown as HbpeNotifyService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [BaseEntity, UserEntity, CommunicationBaseEntity, CommunicationEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/CommunicationService.purge');

    for (const userId of [ownerId, strangerId]) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'CommPurge', userId);
    }

    communications = new CommunicationService(
      dataSource.getRepository(CommunicationEntity),
      signalling,
      logger(),
      dataSource,
      new GraphDeltaWriter(dataSource, logger()),
      hbpe,
    );
  });

  async function wipe(): Promise<void> {
    const users = [ownerId, strangerId];

    await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = ANY($1::uuid[])', [users]);
    await dataSource.query(
      `DELETE FROM ci_search.entity_tag WHERE tag_id IN (SELECT id FROM ci_search.tags WHERE user_id = ANY($1::uuid[]))`,
      [users],
    );
    await dataSource.query(
      `DELETE FROM ci_search.entity_categories WHERE category_tag_id IN (SELECT id FROM ci_search.tags WHERE user_id = ANY($1::uuid[]))`,
      [users],
    );
    await dataSource.query('DELETE FROM ci_search.tags WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci_search.vectors WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci_search.embeddings WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci_search.index_skips WHERE entity_id = ANY($1::uuid[])', [seeded]);
    await dataSource.query('DELETE FROM ci.pipeline_state WHERE entity_id = ANY($1::uuid[])', [seeded]);
    await dataSource.query('DELETE FROM ci.pipeline_dead_letters WHERE entity_id = ANY($1::uuid[])', [
      seeded,
    ]);
    await dataSource.query('DELETE FROM ci.identifier_claims WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.summaries WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.record_sources WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.communications WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.entities WHERE entity_id = ANY($1::uuid[])', [seeded]);
    seeded = [];
  }

  beforeEach(() => {
    published.length = 0;
    notified.length = 0;
  });

  afterEach(wipe);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [[ownerId, strangerId]]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  // ── Fixtures ──────────────────────────────────────────────────────────────

  async function node(entityType: string, name: string, forUser = ownerId): Promise<string> {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, $2, $3, '{}'::jsonb, $4)`,
      [id, entityType, name, forUser],
    );
    seeded.push(id);

    return id;
  }

  /** An edge, and the delta that recorded its creation, which names its two endpoints. */
  async function edge(from: string, to: string, type: string): Promise<void> {
    const [{ relationship_id: relationshipId }] = await dataSource.query(
      `INSERT INTO ci.relationships (from_entity_id, to_entity_id, relationship_type, owner_user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING relationship_id`,
      [from, to, type, ownerId],
    );

    await dataSource.query(
      `INSERT INTO ci.graph_deltas
         (node_type, relationship_id, relationship_type, from_entity_id, to_entity_id, change_type, changed_fields, owner_user_id)
       VALUES ('relationship', $1, $2, $3, $4, 'created', '{}'::jsonb, $5)`,
      [relationshipId, type, from, to, ownerId],
    );
  }

  /** The `ci.entities` base row and `ci.communications` detail row of one message, and nothing else. */
  async function bareCommunication(
    subject: string,
    forUser: string,
    extra: { time?: Date } = {},
  ): Promise<string> {
    const id = uuidv7();

    seeded.push(id);
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Communication', $2, '{}'::jsonb, $3, 'communications', $1)`,
      [id, subject, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci.communications (id, "time", user_id, communication_type, direction, subject, content)
       VALUES ($1, $2, $3, 'email', 'inbound', $4, $5)`,
      [id, extra.time ?? SENT_ON, forUser, subject, `${subject} body`],
    );

    return id;
  }

  /**
   * A message the way the importer writes it, and then everything the appliance hangs off one: edges in
   * both directions, each with its delta, a ledger entry, the identifier claims of its sender and
   * recipient, pipeline bookkeeping, a delta that carries the subject, tags and categories, and search rows.
   */
  async function email(subject: string, forUser = ownerId, extra: { time?: Date } = {}): Promise<Aggregate> {
    const communicationId = await bareCommunication(subject, forUser, extra);

    // Graph edges, in both directions, each with the delta that recorded it.
    const sender = await node('Person', `${subject} sender`, forUser);
    const topic = await node('Concept', `${subject} topic`, forUser);

    await edge(sender, communicationId, 'SENT');
    await edge(communicationId, topic, 'MENTIONS');

    // The provenance ledger.
    await dataSource.query(
      `INSERT INTO ci.record_sources (user_id, record_table, record_id, source_type, source_system, source_id)
       VALUES ($1, 'communications', $2, 'ci.import', 'comm_purge_spec', $3)`,
      [forUser, communicationId, `communications-${communicationId}`],
    );

    // The person-link stage's claims about the message: one resolved to a Person, one that matched nobody.
    await dataSource.query(
      `INSERT INTO ci.identifier_claims
         (owner_user_id, subject_type, subject_id, role, kind, value_normalized, raw_value, entity_id, confidence)
       VALUES ($1, 'communication', $2, 'from', 'email', $3, $3, $4, 1.0),
              ($1, 'communication', $2, 'to', 'email', $5, $5, NULL, NULL)`,
      [
        forUser,
        communicationId,
        `sender-${communicationId}@example.invalid`,
        sender,
        `recipient-${communicationId}@example.invalid`,
      ],
    );

    // Pipeline bookkeeping.
    await dataSource.query(
      `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, status, user_id)
       VALUES ('communication', $1, 'comm_purge_spec.stage', 'done', $2)`,
      [communicationId, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci.pipeline_dead_letters (queue, event_name, entity_type, entity_id, payload, error, user_id)
       VALUES ('pipeline', 'communication.created', 'communication', $1, '{}'::jsonb, 'boom', $2)`,
      [communicationId, forUser],
    );

    // The graph delta the message's creation would have written, and the subject in it.
    await dataSource.query(
      `INSERT INTO ci.graph_deltas (node_type, entity_id, entity_type, change_type, changed_fields, owner_user_id)
       VALUES ('entity', $1, 'Communication', 'created', jsonb_build_object('name', jsonb_build_object('new', $2::text)), $3)`,
      [communicationId, subject, forUser],
    );

    // Tags and categories, which live in the search schema and have no foreign key to the message.
    const [{ id: tag }] = await dataSource.query(
      `INSERT INTO ci_search.tags (id, label, user_id) VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
      [`comm-purge-spec-${subject}`, forUser],
    );

    await dataSource.query(
      `INSERT INTO ci_search.entity_tag (entity_type, entity_id, tag_id) VALUES ('communication', $1, $2)`,
      [communicationId, tag],
    );
    await dataSource.query(
      `INSERT INTO ci_search.entity_categories (entity_type, entity_id, category_tag_id, position)
       VALUES ('communication', $1, $2, 0)`,
      [communicationId, tag],
    );
    await dataSource.query(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES (gen_random_uuid(), 'communication', $1, to_tsvector('simple', $2), $3)`,
      [communicationId, subject, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, user_id)
       VALUES (gen_random_uuid(), 'communication', $1, $2)`,
      [communicationId, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci_search.index_skips (entity_type, entity_id, reason) VALUES ('communication', $1, 'comm_purge_spec')`,
      [communicationId],
    );

    return { communicationId, personId: sender };
  }

  // ── Probes ────────────────────────────────────────────────────────────────

  async function footprint(aggregate: Aggregate): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};

    for (const [label, sql] of FOOTPRINT) {
      const [{ count }] = await dataSource.query(sql, [aggregate.communicationId]);

      counts[label] = Number(count);
    }

    return counts;
  }

  /** What `footprint` reads when every row is gone. */
  const EMPTY = Object.fromEntries(FOOTPRINT.map(([label]) => [label, 0]));

  function expectEveryTableTouched(counts: Record<string, number>): void {
    for (const [label, count] of Object.entries(counts)) {
      // A fixture that wrote nothing here would let the purge "clean" an empty table.
      expect({ label, count: count > 0 }).toEqual({ label, count: true });
    }
  }

  async function exists(sql: string, id: string): Promise<boolean> {
    const [{ count }] = await dataSource.query(sql, [id]);

    return Number(count) > 0;
  }

  // ── Cases ─────────────────────────────────────────────────────────────────

  it('removes the communication, its node and every row that points at it, and nothing else', async () => {
    const doomed = await email('Trip itinerary');
    const control = await email('Shopping list');

    const doomedBefore = await footprint(doomed);
    const controlBefore = await footprint(control);

    expectEveryTableTouched(doomedBefore);
    expectEveryTableTouched(controlBefore);

    const purged = await communications.purge(owner, [doomed.communicationId]);

    // These have no attachments, so nothing but the message goes: no content row, no stored file.
    expect(purged).toEqual({
      communicationIds: [doomed.communicationId],
      contentIds: [],
      files: nothingWrapped(),
    });
    expect(await footprint(doomed)).toEqual(EMPTY);
    // The control communication is exactly as it was, row for row.
    expect(await footprint(control)).toEqual(controlBefore);
  });

  it('deletes the identifier claims, which are the raw sender and recipients, and only that message’s', async () => {
    const doomed = await email('Trip itinerary');
    const control = await email('Shopping list');

    const claimsOf = (aggregate: Aggregate) =>
      dataSource.query(
        `SELECT value_normalized FROM ci.identifier_claims
          WHERE subject_type = 'communication' AND subject_id = $1
          ORDER BY role`,
        [aggregate.communicationId],
      );

    expect(await claimsOf(doomed)).toHaveLength(2);

    await communications.purge(owner, [doomed.communicationId]);

    expect(await claimsOf(doomed)).toEqual([]);
    expect(await claimsOf(control)).toHaveLength(2);
  });

  it('purges several in one call, once each, and leaves the rest', async () => {
    const first = await email('Trip itinerary');
    const second = await email('Recipe');
    const control = await email('Shopping list');
    const controlBefore = await footprint(control);

    const purged = await communications.purge(owner, [
      first.communicationId,
      second.communicationId,
      first.communicationId,
    ]);

    expect(purged.communicationIds.sort()).toEqual([first.communicationId, second.communicationId].sort());
    expect(await footprint(first)).toEqual(EMPTY);
    expect(await footprint(second)).toEqual(EMPTY);
    expect(await footprint(control)).toEqual(controlBefore);
  });

  it('removes a communication nothing has processed yet, which a plain delete handled too', async () => {
    const bare = await bareCommunication('Unprocessed', ownerId);

    expect(await exists('SELECT count(*) FROM ci.entities WHERE entity_id = $1', bare)).toBe(true);
    expect(await exists('SELECT count(*) FROM ci.communications WHERE id = $1', bare)).toBe(true);

    expect(await communications.purge(owner, [bare])).toEqual({
      communicationIds: [bare],
      contentIds: [],
      files: nothingWrapped(),
    });
    expect(await exists('SELECT count(*) FROM ci.entities WHERE entity_id = $1', bare)).toBe(false);
    expect(await exists('SELECT count(*) FROM ci.communications WHERE id = $1', bare)).toBe(false);
  });

  it('leaves the records that merely mention the communication', async () => {
    const doomed = await email('Trip itinerary');
    const control = await email('Shopping list');

    // A summary of the period names the message, and is a record of the period: it is neither the
    // message's nor the purge's to rewrite.
    const [{ summary_id: summaryId }] = await dataSource.query(
      `INSERT INTO ci.summaries (user_id, period_start, period_end, period_type, source_types, related_communications_ids)
       VALUES ($1, $2, $3, 'daily', ARRAY['communication'], ARRAY[$4::uuid])
       RETURNING summary_id`,
      [ownerId, '2026-08-19T00:00:00Z', '2026-08-20T00:00:00Z', doomed.communicationId],
    );

    await communications.purge(owner, [doomed.communicationId]);

    expect(
      await dataSource.query('SELECT related_communications_ids FROM ci.summaries WHERE summary_id = $1', [
        summaryId,
      ]),
    ).toEqual([{ related_communications_ids: [doomed.communicationId] }]);

    // The people on it are nodes in their own right. Forgetting a message does not forget who sent it.
    expect(await exists('SELECT count(*) FROM ci.entities WHERE entity_id = $1', doomed.personId)).toBe(true);
    expect(await exists('SELECT count(*) FROM ci.entities WHERE entity_id = $1', control.personId)).toBe(
      true,
    );
  });

  it('announces each removal after it has committed, and nothing for the ids it did not take', async () => {
    const doomed = await email('Trip itinerary');
    const missing = uuidv7();

    published.length = 0;

    await communications.purge(owner, [doomed.communicationId, missing]);

    expect(published).toEqual([
      { name: CommunicationRemovedEvent, payload: { communicationId: doomed.communicationId } },
    ]);
  });

  it('announces a removal only once it has committed, so a listener that looks finds the row gone', async () => {
    const doomed = await email('Trip itinerary');
    const found: number[] = [];

    (signalling.send as jest.Mock).mockImplementationOnce(async (name: string, payload: unknown) => {
      // A listener reads on its own connection. Were the delete not committed yet, it would still find the row.
      const [{ count }] = await dataSource.query('SELECT count(*) FROM ci.communications WHERE id = $1', [
        doomed.communicationId,
      ]);

      found.push(Number(count));
      published.push({ name, payload });

      return [];
    });

    await communications.purge(owner, [doomed.communicationId]);

    // Precondition: the listener was asked, and asked once.
    expect(published).toEqual([
      { name: CommunicationRemovedEvent, payload: { communicationId: doomed.communicationId } },
    ]);
    expect(found).toEqual([0]);
  });

  it('tells HBPE which days to re-serialise, in one call, for the messages it purged and no others', async () => {
    const monday = await email('Monday mail', ownerId, { time: new Date('2026-08-17T08:00:00Z') });
    const mondayLater = await email('Monday evening mail', ownerId, {
      time: new Date('2026-08-17T21:00:00Z'),
    });
    const wednesday = await email('Wednesday mail', ownerId, { time: new Date('2026-08-19T08:00:00Z') });
    const untouched = await email('Friday mail', ownerId, { time: new Date('2026-08-21T08:00:00Z') });

    notified.length = 0;

    await communications.purge(owner, [
      monday.communicationId,
      mondayLater.communicationId,
      wednesday.communicationId,
    ]);

    // One call, for the owner, naming the days the three messages fell on. The Friday message is not one.
    expect(notified).toHaveLength(1);
    expect(notified[0].userId).toBe(ownerId);
    expect([...new Set(notified[0].days)]).toEqual(['2026-08-17', '2026-08-19']);
    expect(
      await exists('SELECT count(*) FROM ci.communications WHERE id = $1', untouched.communicationId),
    ).toBe(true);
  });

  it('asks HBPE to re-serialise only once the delete has committed', async () => {
    const doomed = await email('Trip itinerary');
    const found: number[] = [];

    (hbpe.notifyCommunications as jest.Mock).mockImplementationOnce(
      async (userId: string, times: unknown) => {
        // HBPE reads the day on its own connection when it is told, so the message has to be gone by then.
        const [{ count }] = await dataSource.query('SELECT count(*) FROM ci.communications WHERE id = $1', [
          doomed.communicationId,
        ]);

        found.push(Number(count));
        notified.push({ userId, days: Array.from(times as Iterable<Date>, dayOf) });
      },
    );

    await communications.purge(owner, [doomed.communicationId]);

    expect(notified).toHaveLength(1);
    expect(found).toEqual([0]);
  });

  it('leaves somebody else’s communication alone, and ignores ids that do not exist', async () => {
    const theirs = await email('Their mail', strangerId);
    const theirsBefore = await footprint(theirs);

    published.length = 0;
    notified.length = 0;

    const purged = await communications.purge(owner, [theirs.communicationId, uuidv7()]);

    expect(purged).toEqual({ communicationIds: [], contentIds: [], files: nothingWrapped() });
    expect(await footprint(theirs)).toEqual(theirsBefore);
    expect(published).toEqual([]);
    expect(notified).toEqual([]);

    // And in the other direction: the stranger can purge their own.
    expect((await communications.purge(stranger, [theirs.communicationId])).communicationIds).toEqual([
      theirs.communicationId,
    ]);
    expect(await footprint(theirs)).toEqual(EMPTY);
  });

  it('leaves a Communication node with no ci.communications row behind it, for the generic delete', async () => {
    // Graph ingest writes these. There is no detail row to cascade and nothing to tell HBPE about.
    const graphOnly = await node('Communication', 'Imported without a detail row');

    published.length = 0;
    notified.length = 0;

    expect(await communications.purge(owner, [graphOnly])).toEqual({
      communicationIds: [],
      contentIds: [],
      files: nothingWrapped(),
    });
    expect(await exists('SELECT count(*) FROM ci.entities WHERE entity_id = $1', graphOnly)).toBe(true);
    expect(published).toEqual([]);
    expect(notified).toEqual([]);
  });

  it('does nothing for an empty request', async () => {
    expect(await communications.purge(owner, [])).toEqual({
      communicationIds: [],
      contentIds: [],
      files: nothingWrapped(),
    });
    expect(published).toEqual([]);
    expect(notified).toEqual([]);
  });

  it('waits for a writer that has the message open, and names the day it has moved the message to', async () => {
    const doomed = await email('Trip itinerary');
    const writer = dataSource.createQueryRunner();

    await writer.connect();
    await writer.startTransaction();

    let purging: Promise<unknown> | undefined;

    try {
      const [{ pid }] = await writer.query('SELECT pg_backend_pid() AS pid');

      // Another day, uncommitted: invisible to the purge until the writer commits.
      await writer.query('UPDATE ci.communications SET "time" = $2 WHERE id = $1', [
        doomed.communicationId,
        MOVED_TO,
      ]);

      purging = communications.purge(owner, [doomed.communicationId]);

      // Ask Postgres who is waiting on that connection, rather than sleeping, and WHERE: the purge has to
      // be held at the statement that locks the message, before it has read its time or deleted anything.
      // Held at the delete instead, it would have read the day the message has just left.
      const blocked = await until(async () => {
        const rows: Array<{ query: string }> = await dataSource.query(
          'SELECT query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
          [pid],
        );

        return rows.length > 0 ? rows : null;
      }, 'the purge to block on the writer connection');

      expect(blocked).toHaveLength(1);
      expect(blocked[0].query).toMatch(/\bFOR UPDATE\b/);

      await writer.commitTransaction();
    } catch (error) {
      await writer.rollbackTransaction().catch(() => undefined);
      // Let a purge that was released by the rollback finish, so it cannot run into the next test's clean-up.
      await purging?.catch(() => undefined);

      throw error;
    } finally {
      await writer.release();
    }

    // Having waited, the purge saw the committed row: the new day, which is the one HBPE has to redo.
    expect(await purging).toEqual({
      communicationIds: [doomed.communicationId],
      contentIds: [],
      files: nothingWrapped(),
    });
    expect(notified).toEqual([{ userId: ownerId, days: [dayOf(MOVED_TO)] }]);
    expect(await footprint(doomed)).toEqual(EMPTY);
  });

  it('is all or nothing when something it does not know about blocks the delete', async () => {
    const doomed = await email('Trip itinerary');
    const doomedBefore = await footprint(doomed);

    // `ci.users.entity_id` references ci.entities with no ON DELETE action. Pointing
    // it at the message's node stands in for a table this teardown has never heard of.
    await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [
      doomed.communicationId,
      strangerId,
    ]);

    published.length = 0;
    notified.length = 0;

    await expect(communications.purge(owner, [doomed.communicationId])).rejects.toThrow(/foreign key/i);

    // Every delete that ran before the one that failed was rolled back with it.
    expect(await footprint(doomed)).toEqual(doomedBefore);
    expect(published).toEqual([]);
    expect(notified).toEqual([]);
  });
});
