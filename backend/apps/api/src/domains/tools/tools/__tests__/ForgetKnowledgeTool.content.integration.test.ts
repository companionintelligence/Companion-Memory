import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { RequestContext, UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import {
  BaseEntity,
  CalendarEventService,
  ContentBaseEntity,
  ContentEntity,
  ContentService,
  EventBaseEntity,
  EventEntity,
  GraphDeltaWriter,
  GraphNodeEntity,
  GraphUtilityService,
  RelationshipEntity,
} from '@ci/domains/memory';
import {
  CommunicationRemovedEvent,
  ConceptRemovedEvent,
  ContentRemovedEvent,
  EventRemovedEvent,
  ItemRemovedEvent,
} from '@ci/domains/memory/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ForgetKnowledgeTool } from '../ForgetKnowledgeTool';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `memory.forget` ON A CONTENT NODE. THE REAL TOOL, THE REAL SERVICES, POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `archive_and_delete` used to delete a `Content` node by deleting its
 * `ci.entities` row and trusting the foreign keys. HBPE has clustered nearly
 * every content row, and its link tables reference the row with no `ON DELETE`
 * action, so the delete failed on nearly all of it. The tool reported that
 * correctly, as a refusal that retrying will not change, and the content stayed.
 *
 * Content is now purged by `ContentService.purge`, as an event is by
 * `CalendarEventService.purge`. The unit suite for the tool proves the routing
 * against doubles. A double cannot say whether a clustered row is then really
 * gone, so this file drives the real thing and asks Postgres.
 *
 * It also holds the tool to what it says about the two types that have no purge
 * of their own, an item and a communication: the node and its detail row are
 * deleted, and the rows that name them by id are left, which is what the tool's
 * warning says.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database of your OWN, or run `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[tools/ForgetKnowledgeTool.content.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

const DINNER_AT = new Date('2026-08-19T17:00:00Z');

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
  events: 0,
  content: 0,
  relationships: 0,
  l1EventCluster: 0,
  l2ContentCluster: 0,
  contentContext: 0,
  recordSources: 0,
  graphDeltas: 0,
};

describeWithDb(`memory.forget on a Content node, against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let calendar: CalendarEventService;
  let contents: ContentService;
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
        GraphNodeEntity,
        RelationshipEntity,
        UserEntity,
      ],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'tools/ForgetKnowledgeTool.content');

    for (const userId of [ownerId, strangerId]) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'ForgetContent', userId);
    }

    const deltaWriter = new GraphDeltaWriter(dataSource, logger());

    calendar = new CalendarEventService(
      dataSource.getRepository(EventEntity),
      dataSource.getRepository(EventBaseEntity),
      signalling,
      dataSource,
      deltaWriter,
    );
    contents = new ContentService(
      dataSource.getRepository(ContentEntity),
      dataSource.getRepository(ContentBaseEntity),
      dataSource.getRepository(EventEntity),
      signalling,
      deltaWriter,
    );
    graph = new GraphUtilityService(
      dataSource.getRepository(GraphNodeEntity),
      dataSource.getRepository(RelationshipEntity),
      logger(),
    );
    tool = new ForgetKnowledgeTool(graph, signalling, calendar, contents, logger());
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
    await dataSource.query('DELETE FROM ci.record_sources WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.content WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.events WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.communications WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.objects WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [userId]);
  }

  beforeEach(() => {
    published.length = 0;
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

  /** A content item the way the importer writes it: a `Content` node and its `ci.content` row. */
  async function seedContent(
    title: string,
    extra: { forUser?: string; eventId?: string } = {},
  ): Promise<string> {
    const contentId = uuidv7();
    const forUser = extra.forUser ?? ownerId;

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Content', $2, '{}'::jsonb, $3, 'content', $1)`,
      [contentId, title, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci.content (id, type, text, user_id, event_id) VALUES ($1, 'note', $2, $3, $4)`,
      [contentId, `${title} body`, forUser, extra.eventId ?? null],
    );

    return contentId;
  }

  async function seedEvent(title: string): Promise<string> {
    const [event] = await calendar.create(owner, { title, start_time: DINNER_AT });

    return event.id;
  }

  /** A ledger entry and a delta that carries the title: rows that name a node and have no foreign key to it. */
  async function seedTrail(
    id: string,
    recordTable: string,
    entityType: string,
    title: string,
    forUser = ownerId,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO ci.record_sources (user_id, record_table, record_id, source_type, source_system, source_id)
       VALUES ($1, $2, $3, 'ci.import', 'forget_content_spec', $4)`,
      [forUser, recordTable, id, `${recordTable}-${id}`],
    );
    await dataSource.query(
      `INSERT INTO ci.graph_deltas (node_type, entity_id, entity_type, change_type, changed_fields, owner_user_id)
       VALUES ('entity', $1, $2, 'created', jsonb_build_object('name', jsonb_build_object('new', $3::text)), $4)`,
      [id, entityType, title, forUser],
    );
  }

  /**
   * What HBPE does to nearly every content row, and every event: cluster it, and give the content a
   * context. Each of these tables references the row with no `ON DELETE` action, which is what stopped
   * a delete.
   */
  async function clusterAtHbpe(contentId: string, eventId?: string, forUser = ownerId): Promise<void> {
    const [{ cluster_id: l1 }] = await dataSource.query(
      `INSERT INTO hbpe.l1_clusters (user_id, l0_class, label) VALUES ($1, 'x', 'dinners') RETURNING cluster_id`,
      [forUser],
    );
    const [{ cluster_id: l2 }] = await dataSource.query(
      `INSERT INTO hbpe.l2_clusters (user_id, l0_class, l1_cluster_id, label) VALUES ($1, 'x', $2, 'photos') RETURNING cluster_id`,
      [forUser, l1],
    );

    await dataSource.query(
      `INSERT INTO hbpe.l2_content_cluster (content_id, cluster_id, similarity) VALUES ($1, $2, 0.9)`,
      [contentId, l2],
    );
    await dataSource.query(
      `INSERT INTO hbpe.content_context (content_id, user_id, l0_class, l1_cluster_id) VALUES ($1, $2, 'x', $3)`,
      [contentId, forUser, l1],
    );

    if (eventId != null) {
      await dataSource.query(
        `INSERT INTO hbpe.l1_event_cluster (event_id, cluster_id, similarity) VALUES ($1, $2, 0.9)`,
        [eventId, l1],
      );
    }
  }

  /** Rows of these nodes that are still there, by table. */
  async function remains(...ids: string[]): Promise<Record<string, number>> {
    const count = async (sql: string): Promise<number> => {
      const [{ count: n }] = await dataSource.query(sql, [ids]);

      return Number(n);
    };

    return {
      entities: await count('SELECT count(*) FROM ci.entities WHERE entity_id = ANY($1::uuid[])'),
      events: await count('SELECT count(*) FROM ci.events WHERE event_id = ANY($1::uuid[])'),
      content: await count('SELECT count(*) FROM ci.content WHERE id = ANY($1::uuid[])'),
      relationships: await count(
        `SELECT count(*) FROM ci.relationships
          WHERE from_entity_id = ANY($1::uuid[]) OR to_entity_id = ANY($1::uuid[])`,
      ),
      l1EventCluster: await count(
        'SELECT count(*) FROM hbpe.l1_event_cluster WHERE event_id = ANY($1::uuid[])',
      ),
      l2ContentCluster: await count(
        'SELECT count(*) FROM hbpe.l2_content_cluster WHERE content_id = ANY($1::uuid[])',
      ),
      contentContext: await count(
        'SELECT count(*) FROM hbpe.content_context WHERE content_id = ANY($1::uuid[])',
      ),
      recordSources: await count('SELECT count(*) FROM ci.record_sources WHERE record_id = ANY($1::uuid[])'),
      graphDeltas: await count('SELECT count(*) FROM ci.graph_deltas WHERE entity_id = ANY($1::uuid[])'),
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

  // ── Content ───────────────────────────────────────────────────────────────

  it('removes content HBPE has clustered, which used to fail on a foreign key', async () => {
    const dana = await seedNode('Person', 'Dana');
    const id = await seedContent('Trip notes');

    await clusterAtHbpe(id);
    await seedTrail(id, 'content', 'Content', 'Trip notes');
    await seedEdge(dana, id, 'AUTHORED');
    await seedEdge(id, dana, 'MENTIONS');

    // Every table that can hold a row for the content holds one.
    expect(await remains(id)).toEqual({
      ...NOTHING,
      entities: 1,
      content: 1,
      relationships: 2,
      l2ContentCluster: 1,
      contentContext: 1,
      recordSources: 1,
      graphDeltas: 1,
    });

    const result = await forget([id]);

    // It raised `l2_content_cluster_content_id_fkey` here, for every content row HBPE had clustered.
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ archivedEntityIds: [id], mode: 'archive_and_delete' });
    expect(result.data?.warnings).toBeUndefined();

    // The node, its detail row, HBPE's links and every row that named it, in either direction.
    expect(await remains(id)).toEqual(NOTHING);
    expect(publishedOf(ContentRemovedEvent)).toEqual([{ contentId: id }]);
    // Somebody else's node is somebody else's: only the content's own edges were taken.
    expect(await nodeExists(dana)).toBe(true);
  });

  it('removes content HBPE has not clustered', async () => {
    const id = await seedContent('Unlabelled note');
    const outbound = await seedEdge(id, await seedNode('Concept', 'Jazz'), 'MENTIONS');

    expect(await remains(id)).toMatchObject({ entities: 1, content: 1, relationships: 1 });

    const result = await forget([id]);

    expect(result.success).toBe(true);
    expect(await remains(id)).toEqual(NOTHING);
    expect(
      await dataSource.query('SELECT 1 FROM ci.relationships WHERE relationship_id = $1', [outbound]),
    ).toEqual([]);
    expect(publishedOf(ContentRemovedEvent)).toEqual([{ contentId: id }]);
  });

  it('removes an event and its photo named in the same call, and announces each once', async () => {
    const event = await seedEvent('Dinner with Dana');
    const photo = await seedContent('Photo of the dinner', { eventId: event });

    await clusterAtHbpe(photo, event);

    expect(await remains(event, photo)).toMatchObject({
      entities: 2,
      events: 1,
      content: 1,
      l1EventCluster: 1,
      l2ContentCluster: 1,
      contentContext: 1,
    });

    // The event purge takes the photo with it, so by the time the photo's own turn comes it is gone.
    const result = await forget([event, photo]);

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.data?.archivedEntityIds).toEqual([event, photo]);
    expect(await remains(event, photo)).toEqual(NOTHING);
    expect(publishedOf(EventRemovedEvent)).toEqual([{ eventId: event }]);
    expect(publishedOf(ContentRemovedEvent)).toEqual([{ contentId: photo }]);
  });

  it('removes one photo of an event and leaves the event and its other photo alone', async () => {
    const event = await seedEvent('Dinner with Dana');
    const first = await seedContent('First photo', { eventId: event });
    const second = await seedContent('Second photo', { eventId: event });

    await clusterAtHbpe(first, event);
    await clusterAtHbpe(second);

    const result = await forget([first]);

    expect(result.success).toBe(true);
    expect(await remains(first)).toEqual(NOTHING);
    // The event, its clustering and its other photo (with its own HBPE rows) are as they were.
    expect(await remains(event)).toMatchObject({ entities: 1, events: 1, l1EventCluster: 1 });
    expect(await remains(second)).toMatchObject({
      entities: 1,
      content: 1,
      l2ContentCluster: 1,
      contentContext: 1,
    });
  });

  it('removes content and a concept in one call', async () => {
    const content = await seedContent('Trip notes');
    const concept = await seedNode('Concept', 'Jazz');

    await clusterAtHbpe(content);

    expect(await remains(content)).toMatchObject({ entities: 1, content: 1, l2ContentCluster: 1 });
    expect(await nodeExists(concept)).toBe(true);

    const result = await forget([content, concept]);

    expect(result.success).toBe(true);
    expect(result.data?.archivedEntityIds).toEqual([content, concept]);
    expect(await remains(content)).toEqual(NOTHING);
    expect(await nodeExists(concept)).toBe(false);
    expect(publishedOf(ContentRemovedEvent)).toEqual([{ contentId: content }]);
    expect(publishedOf(ConceptRemovedEvent)).toEqual([{ conceptId: concept }]);
  });

  it('removes content that was archived earlier, which is what archive then delete means', async () => {
    const id = await seedContent('Trip notes');

    await clusterAtHbpe(id);
    await forget([id], 'archive');

    expect(await dataSource.query('SELECT is_active FROM ci.entities WHERE entity_id = $1', [id])).toEqual([
      { is_active: false },
    ]);
    // Archived is not deleted: the detail row and HBPE's links are all still there.
    expect(await remains(id)).toMatchObject({
      entities: 1,
      content: 1,
      l2ContentCluster: 1,
      contentContext: 1,
    });

    const result = await forget([id]);

    // The node is inactive by now. It used to answer "not found" here.
    expect(result.success).toBe(true);
    expect(result.data?.warnings).toBeUndefined();
    expect(result.data?.archivedEntityIds).toEqual([id]);
    expect(await remains(id)).toEqual(NOTHING);
  });

  it('does not purge content in archive mode, which only deactivates its node', async () => {
    const id = await seedContent('Trip notes');

    await clusterAtHbpe(id);

    const result = await forget([id], 'archive');

    expect(result.success).toBe(true);
    expect(await remains(id)).toMatchObject({
      entities: 1,
      content: 1,
      l2ContentCluster: 1,
      contentContext: 1,
    });
    expect(publishedOf(ContentRemovedEvent)).toEqual([]);
  });

  it('removes a Content node that has no ci.content row behind it, and announces it itself', async () => {
    // Graph ingest writes these. There is nothing to purge, and nothing for HBPE to have clustered.
    const node = await seedNode('Content', 'Imported without a detail row');

    expect(await nodeExists(node)).toBe(true);
    expect((await remains(node)).content).toBe(0);

    const result = await forget([node]);

    expect(result.success).toBe(true);
    expect(await nodeExists(node)).toBe(false);
    expect(publishedOf(ContentRemovedEvent)).toEqual([{ contentId: node }]);
  });

  it('refuses to delete somebody else’s content, and leaves its HBPE rows alone', async () => {
    const id = await seedContent('Their notes', { forUser: strangerId });

    await clusterAtHbpe(id, undefined, strangerId);

    const result = await forget([id], 'archive_and_delete', asOwner);

    expect(result.success).toBe(true);
    expect(result.data?.archivedEntityIds).toEqual([]);
    expect(result.data?.warnings).toEqual([`Entity ${id} not found or not owned by user`]);
    expect(await remains(id)).toMatchObject({
      entities: 1,
      content: 1,
      l2ContentCluster: 1,
      contentContext: 1,
    });

    // And in the other direction: the stranger can delete their own.
    expect((await forget([id], 'archive_and_delete', asStranger)).success).toBe(true);
    expect(await remains(id)).toEqual(NOTHING);
  });

  it('is refused whole by a foreign key it does not know about, and says that trying again will not help', async () => {
    const id = await seedContent('Trip notes');
    const edge = await seedEdge(id, await seedNode('Concept', 'Jazz'), 'MENTIONS');

    await clusterAtHbpe(id);
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

    // Nothing changed: the HBPE links the purge had cleared, and the edge, were rolled back with it.
    expect(await remains(id)).toMatchObject({
      entities: 1,
      content: 1,
      relationships: 1,
      l2ContentCluster: 1,
      contentContext: 1,
    });
    expect(
      await dataSource.query('SELECT 1 FROM ci.relationships WHERE relationship_id = $1', [edge]),
    ).toHaveLength(1);
    expect(publishedOf(ContentRemovedEvent)).toEqual([]);
  });

  it('names the content it had already destroyed when it is the rest of the call that is refused', async () => {
    const content = await seedContent('Trip notes');
    const me = await seedNode('Person', 'Me');

    await clusterAtHbpe(content);
    await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [me, ownerId]);

    expect(await remains(content)).toMatchObject({ entities: 1, content: 1, l2ContentCluster: 1 });

    // The purge commits first, and cannot be undone. Then the node the foreign key protects is refused.
    const result = await forget([content, me]);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'CONSTRAINT_VIOLATION',
      retryable: false,
      details: { constraint: 'users_entity_id_fkey', deletedEntityIds: [content] },
    });
    expect(result.error?.message).toContain(`Already deleted: ${content}.`);

    expect(await remains(content)).toEqual(NOTHING);
    expect(await nodeExists(me)).toBe(true);
  });

  it('names the event it had already destroyed when it is the content purge that is refused', async () => {
    const event = await seedEvent('Dinner with Dana');
    const content = await seedContent('Trip notes');

    await clusterAtHbpe(content, event);
    // The foreign key that protects the user's own node now protects this content row.
    await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [content, ownerId]);

    // Events are purged first, in their own transaction, and cannot be undone. Then the content is refused.
    const result = await forget([event, content]);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'CONSTRAINT_VIOLATION',
      retryable: false,
      details: { constraint: 'users_entity_id_fkey', deletedEntityIds: [event] },
    });
    expect(result.error?.message).toContain(`Already deleted: ${event}.`);

    expect(await remains(event)).toEqual(NOTHING);
    // The content was refused whole: its node, its row and its HBPE links are as they were.
    expect(await remains(content)).toMatchObject({
      entities: 1,
      content: 1,
      l2ContentCluster: 1,
      contentContext: 1,
    });
  });

  // ── Item and Communication: the generic delete, and what the tool says it left ──────────

  describe('an item and a communication, which go through the generic delete', () => {
    async function seedCommunication(title: string): Promise<string> {
      const id = uuidv7();

      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
         VALUES ($1, 'Communication', $2, '{}'::jsonb, $3, 'communications', $1)`,
        [id, title, ownerId],
      );
      await dataSource.query(
        `INSERT INTO ci.communications (id, time, user_id, communication_type, direction, content)
         VALUES ($1, now(), $2, 'email', 'inbound', 'hello')`,
        [id, ownerId],
      );

      return id;
    }

    async function seedItem(title: string, parent?: string): Promise<string> {
      const id = uuidv7();

      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
         VALUES ($1, 'Item', $2, '{}'::jsonb, $3, 'objects', $1)`,
        [id, title, ownerId],
      );
      await dataSource.query(
        `INSERT INTO ci.objects (object_id, user_id, parent_object_id) VALUES ($1, $2, $3)`,
        [id, ownerId, parent ?? null],
      );

      return id;
    }

    async function detailExists(table: 'communications' | 'objects', column: 'id' | 'object_id', id: string) {
      return (await dataSource.query(`SELECT 1 FROM ci.${table} WHERE ${column} = $1`, [id])).length === 1;
    }

    it('deletes a communication, announces it, and says that the rows that name it by id were left', async () => {
      const id = await seedCommunication('A mail from Dana');

      await seedEdge(id, await seedNode('Person', 'Dana'), 'FROM');
      await seedTrail(id, 'communications', 'Communication', 'A mail from Dana');

      expect(await nodeExists(id)).toBe(true);
      expect(await detailExists('communications', 'id', id)).toBe(true);
      expect((await remains(id)).relationships).toBe(1);

      const result = await forget([id]);

      expect(result.success).toBe(true);
      // The node, its detail row (by cascade) and its edges.
      expect(await nodeExists(id)).toBe(false);
      expect(await detailExists('communications', 'id', id)).toBe(false);
      expect((await remains(id)).relationships).toBe(0);
      // Its search rows are announced as gone, now, and not at the nightly sweep.
      expect(publishedOf(CommunicationRemovedEvent)).toEqual([{ communicationId: id }]);

      // What the warning says is true: the ledger entry and the delta, which carries the title, are
      // still there. If that changes, the warning has to change with it.
      expect(result.data?.warnings).toEqual([
        `Communication ${id} was deleted, but rows that name it only by id were left in place: its provenance entries, pipeline state, tags and change history.`,
      ]);
      expect(await remains(id)).toMatchObject({ recordSources: 1, graphDeltas: 1 });
    });

    it('deletes an item the same way', async () => {
      const id = await seedItem('A kettle');

      await seedTrail(id, 'objects', 'Item', 'A kettle');

      expect(await nodeExists(id)).toBe(true);
      expect(await detailExists('objects', 'object_id', id)).toBe(true);

      const result = await forget([id]);

      expect(result.success).toBe(true);
      expect(await nodeExists(id)).toBe(false);
      expect(await detailExists('objects', 'object_id', id)).toBe(false);
      expect(publishedOf(ItemRemovedEvent)).toEqual([{ itemId: id }]);
      expect(result.data?.warnings).toEqual([expect.stringContaining(`Item ${id} was deleted`)]);
      expect((await remains(id)).graphDeltas).toBe(1);
    });

    it('refuses an item that is another item’s parent, and changes nothing', async () => {
      const kit = await seedItem('A tool kit');
      const part = await seedItem('A screwdriver', kit);

      const result = await forget([kit]);

      // The one foreign key that stops an item being deleted.
      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({
        code: 'CONSTRAINT_VIOLATION',
        retryable: false,
        details: { constraint: 'objects_parent_object_id_fkey', table: 'objects' },
      });
      expect(await nodeExists(kit)).toBe(true);
      expect(await nodeExists(part)).toBe(true);
      expect(publishedOf(ItemRemovedEvent)).toEqual([]);

      // Taking the part first is what lets the kit go.
      expect((await forget([part])).success).toBe(true);
      expect((await forget([kit])).success).toBe(true);
      expect(await nodeExists(kit)).toBe(false);
    });
  });
});
