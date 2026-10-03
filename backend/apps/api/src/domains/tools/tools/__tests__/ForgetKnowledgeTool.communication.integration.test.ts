import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { RequestContext, UserServiceContext } from '@ci/common/context';
import type { HbpeNotifyService } from '@ci/common/hbpe';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import {
  BaseEntity,
  CalendarEventService,
  CommunicationBaseEntity,
  CommunicationEntity,
  CommunicationService,
  ContentBaseEntity,
  ContentEntity,
  ContentService,
  EventBaseEntity,
  EventEntity,
  GraphDeltaWriter,
  GraphNodeEntity,
  GraphUtilityService,
  type FileService,
  type ItemService,
  RelationshipEntity,
} from '@ci/domains/memory';
import {
  CommunicationRemovedEvent,
  ConceptRemovedEvent,
  ContentRemovedEvent,
  EventRemovedEvent,
} from '@ci/domains/memory/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { GRAPH_ENTITY_ENTITIES, graphEntityServices } from '../../../__tests__/support/graphEntityServices';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ForgetKnowledgeTool } from '../ForgetKnowledgeTool';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `memory.forget` ON A COMMUNICATION. THE REAL TOOL, THE REAL SERVICES, POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `archive_and_delete` used to delete a `Communication` node by deleting its
 * `ci.entities` row and trusting the foreign keys. Nothing references
 * `ci.communications`, so the delete went through, and it left every row that
 * names the message by id with no foreign key to say so: the ledger, the pipeline
 * bookkeeping, the tags and the graph deltas, which carry the subject. The tool
 * told the caller so, in a warning. It also left the participants' identifier
 * claims, which it did not say, because nobody had looked.
 *
 * A communication is now purged by `CommunicationService.purge`, as an event is by
 * `CalendarEventService.purge` and content by `ContentService.purge`. The unit
 * suite for the tool proves the routing against doubles. A double cannot say
 * whether the message is then really gone, so this file drives the real thing and
 * asks Postgres.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database of your OWN, or run `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[tools/ForgetKnowledgeTool.communication.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

const SENT_AT = new Date('2026-08-19T17:00:00Z');
const DINNER_AT = new Date('2026-08-19T19:00:00Z');

const logger = () =>
  ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

/** What `remains` reads once every row of the nodes it was asked about is gone. */
const NOTHING = {
  entities: 0,
  communications: 0,
  relationships: 0,
  recordSources: 0,
  graphDeltas: 0,
  identifierClaims: 0,
  pipelineState: 0,
  events: 0,
  content: 0,
};

describeWithDb(`memory.forget on a Communication node, against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let calendar: CalendarEventService;
  let graph: GraphUtilityService;
  let tool: ForgetKnowledgeTool;

  const ownerId = uuidv7();
  const strangerId = uuidv7();
  const owner = { userId: ownerId } as UserServiceContext;
  const asOwner = { userId: ownerId } as RequestContext;
  const asStranger = { userId: strangerId } as RequestContext;

  /** Every domain event the code under test published, in order. */
  const published: Array<{ name: string; payload: unknown }> = [];
  const signalling = {
    send: jest.fn(async (name: string, payload: unknown) => {
      published.push({ name, payload });

      return [];
    }),
  } as unknown as EventService;

  /** Every time HBPE was told a communication day is stale. */
  const notified: Array<{ userId: string; days: string[] }> = [];
  const hbpe = {
    notifyCommunications: jest.fn(async (userId: string, times: Date | Iterable<Date>) => {
      const days = Array.from(times instanceof Date ? [times] : times, (time) =>
        time.toISOString().slice(0, 10),
      );

      notified.push({ userId, days });
    }),
  } as unknown as HbpeNotifyService;

  function publishedOf(name: string): unknown[] {
    return published.filter((event) => event.name === name).map((event) => event.payload);
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [
        EventEntity,
        BaseEntity,
        EventBaseEntity,
        ContentEntity,
        ContentBaseEntity,
        CommunicationEntity,
        CommunicationBaseEntity,
        GraphNodeEntity,
        RelationshipEntity,
        UserEntity,
        ...GRAPH_ENTITY_ENTITIES,
      ],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'tools/ForgetKnowledgeTool.communication');

    for (const userId of [ownerId, strangerId]) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'ForgetComm', userId);
    }

    const deltaWriter = new GraphDeltaWriter(dataSource, logger());

    calendar = new CalendarEventService(
      dataSource.getRepository(EventEntity),
      dataSource.getRepository(EventBaseEntity),
      signalling,
      dataSource,
      deltaWriter,
    );
    graph = new GraphUtilityService(
      dataSource.getRepository(GraphNodeEntity),
      dataSource.getRepository(RelationshipEntity),
      logger(),
    );
    const services = graphEntityServices(dataSource, signalling, logger());

    tool = new ForgetKnowledgeTool(
      graph,
      signalling,
      calendar,
      new ContentService(
        dataSource.getRepository(ContentEntity),
        dataSource.getRepository(ContentBaseEntity),
        dataSource.getRepository(EventEntity),
        signalling,
        deltaWriter,
      ),
      new CommunicationService(
        dataSource.getRepository(CommunicationEntity),
        signalling,
        logger(),
        dataSource,
        deltaWriter,
        hbpe,
      ),
      // No case here names an item or a file, so the tool never reaches for either.
      {} as unknown as ItemService,
      {} as unknown as FileService,
      services.people,
      services.places,
      services.concepts,
      logger(),
    );
  });

  async function wipe(userId: string): Promise<void> {
    // Both users, whichever one a case pointed at which node: `ci.users.entity_id` is what a case uses
    // to stand in for a table the purge has never heard of, and it would stop this very delete.
    await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = ANY($1::uuid[])', [
      [ownerId, strangerId],
    ]);
    await dataSource.query(
      `DELETE FROM hbpe.l1_event_cluster WHERE event_id IN (SELECT event_id FROM ci.events WHERE user_id = $1)`,
      [userId],
    );
    await dataSource.query(
      `DELETE FROM hbpe.l2_content_cluster WHERE content_id IN (SELECT id FROM ci.content WHERE user_id = $1)`,
      [userId],
    );
    await dataSource.query('DELETE FROM hbpe.content_context WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM hbpe.l2_clusters WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM hbpe.l1_clusters WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.identifier_claims WHERE owner_user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.record_sources WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.communications WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.content WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.events WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [userId]);
  }

  beforeEach(() => {
    published.length = 0;
    notified.length = 0;
  });

  afterEach(async () => {
    await wipe(ownerId);
    await wipe(strangerId);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [[ownerId, strangerId]]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  // ── Fixtures ──────────────────────────────────────────────────────────────

  async function seedNode(entityType: string, name: string, forUser = ownerId): Promise<string> {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, $2, $3, '{}'::jsonb, $4)`,
      [id, entityType, name, forUser],
    );

    return id;
  }

  async function seedEdge(from: string, to: string, type: string): Promise<string> {
    const [{ relationship_id }] = await dataSource.query(
      `INSERT INTO ci.relationships (from_entity_id, to_entity_id, relationship_type, owner_user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING relationship_id`,
      [from, to, type, ownerId],
    );

    return relationship_id;
  }

  /** The `ci.entities` base row and `ci.communications` detail row of one message, and nothing else. */
  async function seedCommunication(
    subject: string,
    extra: { forUser?: string; time?: Date } = {},
  ): Promise<string> {
    const id = uuidv7();
    const forUser = extra.forUser ?? ownerId;

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Communication', $2, '{}'::jsonb, $3, 'communications', $1)`,
      [id, subject, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci.communications (id, "time", user_id, communication_type, direction, subject, content)
       VALUES ($1, $2, $3, 'email', 'inbound', $4, 'hello')`,
      [id, extra.time ?? SENT_AT, forUser, subject],
    );

    return id;
  }

  /**
   * Rows that name a message and have no foreign key to it: a ledger entry, a delta that carries the
   * subject, the pipeline's bookkeeping, and the claims the person-link stage wrote about the sender
   * and a recipient.
   */
  async function seedTrail(id: string, subject: string, forUser = ownerId): Promise<void> {
    await dataSource.query(
      `INSERT INTO ci.record_sources (user_id, record_table, record_id, source_type, source_system, source_id)
       VALUES ($1, 'communications', $2, 'ci.import', 'forget_comm_spec', $3)`,
      [forUser, id, `communications-${id}`],
    );
    await dataSource.query(
      `INSERT INTO ci.graph_deltas (node_type, entity_id, entity_type, change_type, changed_fields, owner_user_id)
       VALUES ('entity', $1, 'Communication', 'created', jsonb_build_object('name', jsonb_build_object('new', $2::text)), $3)`,
      [id, subject, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, status, user_id)
       VALUES ('communication', $1, 'forget_comm_spec.stage', 'done', $2)`,
      [id, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci.identifier_claims (owner_user_id, subject_type, subject_id, role, kind, value_normalized)
       VALUES ($1, 'communication', $2, 'from', 'email', $3),
              ($1, 'communication', $2, 'to', 'email', $4)`,
      [forUser, id, `dana-${id}@example.invalid`, `lee-${id}@example.invalid`],
    );
  }

  async function seedEvent(title: string): Promise<string> {
    const [event] = await calendar.create(owner, { title, start_time: DINNER_AT });

    return event.id;
  }

  async function seedContent(title: string): Promise<string> {
    const contentId = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Content', $2, '{}'::jsonb, $3, 'content', $1)`,
      [contentId, title, ownerId],
    );
    await dataSource.query(`INSERT INTO ci.content (id, type, text, user_id) VALUES ($1, 'note', $2, $3)`, [
      contentId,
      `${title} body`,
      ownerId,
    ]);

    return contentId;
  }

  /** Rows of these nodes that are still there, by table. */
  async function remains(...ids: string[]): Promise<Record<string, number>> {
    const count = async (sql: string): Promise<number> => {
      const [{ count: n }] = await dataSource.query(sql, [ids]);

      return Number(n);
    };

    return {
      entities: await count('SELECT count(*) FROM ci.entities WHERE entity_id = ANY($1::uuid[])'),
      communications: await count('SELECT count(*) FROM ci.communications WHERE id = ANY($1::uuid[])'),
      relationships: await count(
        `SELECT count(*) FROM ci.relationships
          WHERE from_entity_id = ANY($1::uuid[]) OR to_entity_id = ANY($1::uuid[])`,
      ),
      recordSources: await count('SELECT count(*) FROM ci.record_sources WHERE record_id = ANY($1::uuid[])'),
      graphDeltas: await count('SELECT count(*) FROM ci.graph_deltas WHERE entity_id = ANY($1::uuid[])'),
      identifierClaims: await count(
        'SELECT count(*) FROM ci.identifier_claims WHERE subject_id = ANY($1::uuid[])',
      ),
      pipelineState: await count('SELECT count(*) FROM ci.pipeline_state WHERE entity_id = ANY($1::uuid[])'),
      events: await count('SELECT count(*) FROM ci.events WHERE event_id = ANY($1::uuid[])'),
      content: await count('SELECT count(*) FROM ci.content WHERE id = ANY($1::uuid[])'),
    };
  }

  async function nodeExists(id: string): Promise<boolean> {
    return (await dataSource.query('SELECT 1 FROM ci.entities WHERE entity_id = $1', [id])).length === 1;
  }

  async function forget(
    entityIds: string[],
    mode: 'archive' | 'archive_and_delete' = 'archive_and_delete',
    who: RequestContext = asOwner,
  ) {
    return tool.execute(who, { entityIds, mode });
  }

  // ── Cases ─────────────────────────────────────────────────────────────────

  it('removes a communication and every row that names it, announces it, and tells HBPE the day', async () => {
    const id = await seedCommunication('A mail from Dana');

    await seedEdge(id, await seedNode('Person', 'Dana'), 'FROM');
    await seedEdge(await seedNode('Person', 'Lee'), id, 'RECEIVED');
    await seedTrail(id, 'A mail from Dana');

    // Precondition: every kind of row is there, so "gone" below means the purge took it.
    expect(await remains(id)).toEqual({
      ...NOTHING,
      entities: 1,
      communications: 1,
      relationships: 2,
      recordSources: 1,
      graphDeltas: 1,
      identifierClaims: 2,
      pipelineState: 1,
    });

    const result = await forget([id]);

    expect(result.success).toBe(true);
    expect(result.data?.archivedEntityIds).toEqual([id]);
    // The node, its detail row, its edges in both directions, and everything that named it by id,
    // the two claims among it. The warning the tool used to give, that these were left, is gone with them.
    expect(await remains(id)).toEqual(NOTHING);
    expect(result.data?.warnings).toBeUndefined();
    // Its search rows are announced as gone, once, and HBPE is told which day to redo.
    expect(publishedOf(CommunicationRemovedEvent)).toEqual([{ communicationId: id }]);
    expect(notified).toEqual([{ userId: ownerId, days: ['2026-08-19'] }]);
  });

  it('removes a communication and a concept named in one call', async () => {
    const mail = await seedCommunication('A mail from Dana');
    const concept = await seedNode('Concept', 'Jazz');

    await seedTrail(mail, 'A mail from Dana');

    const result = await forget([mail, concept]);

    expect(result.success).toBe(true);
    expect(result.data?.archivedEntityIds).toEqual([mail, concept]);
    expect(await remains(mail, concept)).toEqual(NOTHING);
    expect(publishedOf(CommunicationRemovedEvent)).toEqual([{ communicationId: mail }]);
    expect(publishedOf(ConceptRemovedEvent)).toEqual([{ conceptId: concept }]);
  });

  it('does not purge a communication in archive mode, which only deactivates its node', async () => {
    const id = await seedCommunication('A mail from Dana');

    await seedTrail(id, 'A mail from Dana');

    const result = await forget([id], 'archive');

    expect(result.success).toBe(true);
    // The detail row, the claims and the rest are as they were, and nobody is told anything was deleted.
    expect(await remains(id)).toMatchObject({ entities: 1, communications: 1, identifierClaims: 2 });
    expect(publishedOf(CommunicationRemovedEvent)).toEqual([]);
    expect(notified).toEqual([]);
  });

  it('removes a communication that was archived earlier, which is what archive then delete means', async () => {
    const id = await seedCommunication('A mail from Dana');

    await seedTrail(id, 'A mail from Dana');
    expect((await forget([id], 'archive')).success).toBe(true);

    const result = await forget([id]);

    expect(result.success).toBe(true);
    expect(await remains(id)).toEqual(NOTHING);
    expect(publishedOf(CommunicationRemovedEvent)).toEqual([{ communicationId: id }]);
  });

  it('removes a Communication node that has no ci.communications row, and announces it itself', async () => {
    // Graph ingest writes these. There is nothing to purge, so the generic delete takes the node, and
    // the tool still tells search, because that is the one thing the generic delete does not.
    const id = await seedNode('Communication', 'Imported without a detail row');

    const result = await forget([id]);

    expect(result.success).toBe(true);
    expect(await nodeExists(id)).toBe(false);
    expect(publishedOf(CommunicationRemovedEvent)).toEqual([{ communicationId: id }]);
    expect(notified).toEqual([]);
  });

  it('refuses to delete somebody else’s communication, and leaves its claims alone', async () => {
    const theirs = await seedCommunication('Their mail', { forUser: strangerId });

    await seedTrail(theirs, 'Their mail', strangerId);

    const result = await forget([theirs]);

    // The node is not the caller's, so the tool does not even find it.
    expect(result.success).toBe(true);
    expect(result.data?.archivedEntityIds).toEqual([]);
    expect(result.data?.warnings).toEqual([`Entity ${theirs} not found or not owned by user`]);
    expect(await remains(theirs)).toMatchObject({
      entities: 1,
      communications: 1,
      identifierClaims: 2,
      recordSources: 1,
    });
    expect(publishedOf(CommunicationRemovedEvent)).toEqual([]);
    expect(notified).toEqual([]);

    // And the stranger can forget their own.
    expect((await forget([theirs], 'archive_and_delete', asStranger)).success).toBe(true);
    expect(await remains(theirs)).toEqual(NOTHING);
  });

  it('is refused whole by a foreign key it does not know about, and says that trying again will not help', async () => {
    const id = await seedCommunication('A mail from Dana');
    const edge = await seedEdge(id, await seedNode('Concept', 'Jazz'), 'MENTIONS');

    await seedTrail(id, 'A mail from Dana');
    // `ci.users.entity_id` references ci.entities with no ON DELETE action: a stand-in for a table the
    // purge has never heard of.
    await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [id, strangerId]);

    const result = await forget([id]);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'CONSTRAINT_VIOLATION',
      retryable: false,
      details: { constraint: 'users_entity_id_fkey', table: 'users' },
    });
    expect(result.error?.details).not.toHaveProperty('deletedEntityIds');

    // Nothing changed: the claims, the ledger entry and the edge the purge had cleared were rolled back with it.
    expect(await remains(id)).toMatchObject({
      entities: 1,
      communications: 1,
      relationships: 1,
      recordSources: 1,
      identifierClaims: 2,
      graphDeltas: 1,
      pipelineState: 1,
    });
    expect(
      await dataSource.query('SELECT 1 FROM ci.relationships WHERE relationship_id = $1', [edge]),
    ).toHaveLength(1);
    expect(publishedOf(CommunicationRemovedEvent)).toEqual([]);
    expect(notified).toEqual([]);
  });

  it('names the communication it had already destroyed when it is the rest of the call that is refused', async () => {
    const mail = await seedCommunication('A mail from Dana');
    const me = await seedNode('Person', 'Me');

    await seedTrail(mail, 'A mail from Dana');
    await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [me, ownerId]);

    // The purge commits first, and cannot be undone. Then the node the foreign key protects is refused.
    const result = await forget([mail, me]);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'CONSTRAINT_VIOLATION',
      retryable: false,
      details: { constraint: 'users_entity_id_fkey', deletedEntityIds: [mail] },
    });
    expect(result.error?.message).toContain(`Already deleted: ${mail}.`);

    expect(await remains(mail)).toEqual(NOTHING);
    expect(await nodeExists(me)).toBe(true);
    expect(publishedOf(CommunicationRemovedEvent)).toEqual([{ communicationId: mail }]);
  });

  it('names the event and the content it had already destroyed when it is the communication purge that is refused', async () => {
    const event = await seedEvent('Dinner with Dana');
    const content = await seedContent('Trip notes');
    const mail = await seedCommunication('A mail from Dana');

    await seedTrail(mail, 'A mail from Dana');
    // The foreign key that protects the user's own node now protects this communication's node.
    await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [mail, ownerId]);

    // Events, then content, then communications, each in a transaction of its own that cannot be undone.
    const result = await forget([event, content, mail]);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'CONSTRAINT_VIOLATION',
      retryable: false,
      details: { constraint: 'users_entity_id_fkey', deletedEntityIds: [event, content] },
    });
    expect(result.error?.message).toContain(`Already deleted: ${event}, ${content}.`);

    expect(await remains(event, content)).toEqual(NOTHING);
    // The communication was refused whole: its node, its row, its claims and its ledger entry are as they were.
    expect(await remains(mail)).toMatchObject({
      entities: 1,
      communications: 1,
      identifierClaims: 2,
      recordSources: 1,
    });
    expect(publishedOf(EventRemovedEvent)).toEqual([{ eventId: event }]);
    expect(publishedOf(ContentRemovedEvent)).toEqual([{ contentId: content }]);
    expect(publishedOf(CommunicationRemovedEvent)).toEqual([]);
  });
});
