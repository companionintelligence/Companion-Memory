import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { RequestContext, UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { DeterministicEdgeBackfillService } from '@ci/domains/maintenance';
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
  KnownPlacesService,
  RelationshipEntity,
  type CreateEventDto,
} from '@ci/domains/memory';
import { ConceptRemovedEvent, EventRemovedEvent, EventUpdatedEvent } from '@ci/domains/memory/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ForgetKnowledgeTool } from '../ForgetKnowledgeTool';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `memory.forget` ON AN EVENT. THE REAL TOOL, THE REAL SERVICES, POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An event is two rows: the `ci.entities` base row (`is_active`) and the
 * `ci.events` detail row (`is_deleted`). Forget used to flip only the first, so
 * every reader that decides liveness from the second — the calendar, Known
 * places, the location-enrichment stages, HBPE, search hydration — went on
 * returning an event the user had asked the appliance to forget, while every
 * reader of the first — the graph's node reads, the edge matrix's endpoint
 * join — hid it. Deleting an event from the app had the same split, the other
 * way round.
 *
 * Archive mode now moves an event to the trash through
 * `CalendarEventService.remove`, the call `deleteEvent` makes, and `remove`
 * writes both flags. The unit suite for the tool proves the routing against
 * doubles. A double cannot say whether each reader then agrees, so this file
 * drives the real thing and asks each of them.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database of your OWN, or run `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[tools/ForgetKnowledgeTool.events.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

const DINNER_AT = new Date('2026-08-19T17:00:00Z');
const WINDOW_FROM = new Date('2026-08-18T00:00:00Z');
const WINDOW_TO = new Date('2026-08-21T00:00:00Z');
const KITCHEN = { lat: 34.0522, lng: -118.2437 };

const logger = () =>
  ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

/** Everything one event looks like to each family of reader. */
interface Visibility {
  /** `CalendarEventService` reads — the calendar, the explorer, search hydration. */
  byId: boolean;
  inAll: boolean;
  inPage: boolean;
  inCalendarRange: boolean;
  /** The trash, the only read that returns tombstones. */
  inTrash: boolean;
  /** `GraphUtilityService` reads — the graph explorer, overview counts. */
  graphNode: boolean;
  inGraphList: boolean;
  /** The Places page, which shows event titles under each candidate. */
  inKnownPlaces: boolean;
}

const LIVE: Visibility = {
  byId: true,
  inAll: true,
  inPage: true,
  inCalendarRange: true,
  inTrash: false,
  graphNode: true,
  inGraphList: true,
  inKnownPlaces: true,
};

const GONE: Visibility = {
  byId: false,
  inAll: false,
  inPage: false,
  inCalendarRange: false,
  inTrash: true,
  graphNode: false,
  inGraphList: false,
  inKnownPlaces: false,
};

/** What `remains` reads once every row of an aggregate is gone. */
const NOTHING = {
  entities: 0,
  events: 0,
  content: 0,
  relationships: 0,
  l1EventCluster: 0,
  l2ContentCluster: 0,
  contentContext: 0,
};

describeWithDb(`memory.forget on an Event, against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let calendar: CalendarEventService;
  let graph: GraphUtilityService;
  let knownPlaces: KnownPlacesService;
  let edges: DeterministicEdgeBackfillService;
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
    schemaLock = await acquireSchemaWriteLock(dataSource, 'tools/ForgetKnowledgeTool.events');

    for (const userId of [ownerId, strangerId]) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'ForgetEvents', userId);
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
    knownPlaces = new KnownPlacesService(dataSource, logger(), {} as never);
    edges = new DeterministicEdgeBackfillService(dataSource, deltaWriter, logger());
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
      logger(),
    );
  });

  async function wipe(userId: string): Promise<void> {
    await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = $1', [userId]);
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
    await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.content WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.events WHERE user_id = $1', [userId]);
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

  async function seedEvent(title: string, extra: Partial<CreateEventDto> = {}): Promise<string> {
    const [event] = await calendar.create(owner, { title, start_time: DINNER_AT, ...extra });

    return event.id;
  }

  /** An event with its own coordinate, so the Places page counts it. */
  function seedLocatedEvent(title: string, extra: Partial<CreateEventDto> = {}): Promise<string> {
    return seedEvent(title, {
      location_name: 'Dana’s kitchen',
      location_coordinates: { type: 'Point', coordinates: [KITCHEN.lng, KITCHEN.lat] },
      ...extra,
    });
  }

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

  /** A photo on the event, the way the importer attaches one: a `Content` node and its `media` row. */
  async function attachPhoto(eventId: string, title: string): Promise<string> {
    const contentId = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Content', $2, '{}'::jsonb, $3, 'content', $1)`,
      [contentId, title, ownerId],
    );
    await dataSource.query(
      `INSERT INTO ci.content (id, type, url, mimetype, user_id, event_id)
       VALUES ($1, 'media', 'file:///photo.jpg', 'image/jpeg', $2, $3)`,
      [contentId, ownerId, eventId],
    );

    return contentId;
  }

  /**
   * What HBPE does to nearly every event: cluster it, and cluster and contextualise
   * its content. Each of these tables references the row with no `ON DELETE`
   * action, which is what stopped a delete.
   */
  async function clusterAtHbpe(eventId: string, contentId?: string): Promise<void> {
    const [{ cluster_id: l1 }] = await dataSource.query(
      `INSERT INTO hbpe.l1_clusters (user_id, l0_class, label) VALUES ($1, 'x', 'dinners') RETURNING cluster_id`,
      [ownerId],
    );

    await dataSource.query(
      `INSERT INTO hbpe.l1_event_cluster (event_id, cluster_id, similarity) VALUES ($1, $2, 0.9)`,
      [eventId, l1],
    );

    if (contentId != null) {
      const [{ cluster_id: l2 }] = await dataSource.query(
        `INSERT INTO hbpe.l2_clusters (user_id, l0_class, l1_cluster_id, label) VALUES ($1, 'x', $2, 'photos') RETURNING cluster_id`,
        [ownerId, l1],
      );

      await dataSource.query(
        `INSERT INTO hbpe.l2_content_cluster (content_id, cluster_id, similarity) VALUES ($1, $2, 0.9)`,
        [contentId, l2],
      );
      await dataSource.query(
        `INSERT INTO hbpe.content_context (content_id, user_id, l0_class, l1_cluster_id) VALUES ($1, $2, 'x', $3)`,
        [contentId, ownerId, l1],
      );
    }
  }

  /** Rows of an aggregate that are still there, by table, for the ids given. */
  async function remains(eventId: string, contentId?: string): Promise<Record<string, number>> {
    const ids = contentId == null ? [eventId] : [eventId, contentId];
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
    };
  }

  // ── Probes ────────────────────────────────────────────────────────────────

  /** Both halves of the aggregate, or `undefined` once neither row exists. */
  async function flags(id: string): Promise<{ is_deleted: boolean; is_active: boolean } | undefined> {
    const rows = await dataSource.query(
      `SELECT ev.is_deleted, e.is_active
         FROM ci.events ev
         JOIN ci.entities e ON e.entity_id = ev.event_id
        WHERE ev.event_id = $1`,
      [id],
    );

    return rows[0];
  }

  async function visibility(id: string): Promise<Visibility> {
    const page = { first: 100 };
    const nodes = await graph.queryNodes(ownerId, { entityType: 'Event' }, { limit: 200 });
    const candidates = await knownPlaces.buildKnownPlaces(owner);

    return {
      byId: (await calendar.findById(owner, id)) !== null,
      inAll: (await calendar.findAll(owner)).some((event) => event.id === id),
      inPage: (await calendar.findPage(owner, page)).entities.some((event) => event.id === id),
      inCalendarRange: (await calendar.findInRange(owner, WINDOW_FROM, WINDOW_TO)).some(
        (event) => event.id === id,
      ),
      inTrash: (await calendar.findDeletedPage(owner, page)).entities.some((event) => event.id === id),
      graphNode: (await graph.getNodeById(id, ownerId)) !== null,
      inGraphList: nodes.some((node) => node.entity_id === id),
      inKnownPlaces: candidates.some((candidate) =>
        candidate.sampleEvents.some((sample) => sample.id === id),
      ),
    };
  }

  async function eventNodeCount(): Promise<number> {
    const counts = await graph.getEntityTypeCounts(ownerId);

    return counts.find((row) => row.entityType === 'Event')?.count ?? 0;
  }

  async function edgesOf(id: string): Promise<Array<{ relationship_type: string; is_active: boolean }>> {
    return dataSource.query(
      `SELECT relationship_type, is_active
         FROM ci.relationships
        WHERE from_entity_id = $1 OR to_entity_id = $1
        ORDER BY relationship_type`,
      [id],
    );
  }

  async function deltasOf(id: string): Promise<Array<{ change_type: string; change_source: string }>> {
    return dataSource.query(
      `SELECT change_type, change_source
         FROM ci.graph_deltas
        WHERE entity_id = $1
        ORDER BY changed_at, delta_id`,
      [id],
    );
  }

  async function forget(
    entityIds: string[],
    mode: 'archive' | 'archive_and_delete' = 'archive',
    who: RequestContext = asOwner,
  ) {
    return tool.execute(who, { entityIds, mode });
  }

  // ── Archive mode ──────────────────────────────────────────────────────────

  describe('archive mode', () => {
    it('tombstones both halves of the aggregate and keeps both rows', async () => {
      const id = await seedEvent('Dinner with Dana');

      expect(await flags(id)).toEqual({ is_deleted: false, is_active: true });

      const result = await forget([id]);

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        archivedEntityIds: [id],
        restorableEventIds: [id],
        mode: 'archive',
      });
      expect(result.data?.warnings).toBeUndefined();

      // Nothing was destroyed: the row is in the trash, not gone, and the graph
      // node is deactivated rather than deleted.
      expect(await flags(id)).toEqual({ is_deleted: true, is_active: false });

      // `remove` wrote the graph delta in the same transaction, and told search
      // exactly once. The tool added neither of its own.
      expect(await deltasOf(id)).toEqual([
        { change_type: 'created', change_source: 'CalendarEventService.create' },
        { change_type: 'deleted', change_source: 'CalendarEventService.remove' },
      ]);
      expect(publishedOf(EventRemovedEvent)).toEqual([{ eventId: id }]);
    });

    it('leaves every reader agreeing that the event is gone, and the next event untouched', async () => {
      const forgotten = await seedLocatedEvent('Dinner with Dana');
      const kept = await seedLocatedEvent('Lunch with Dana');

      expect(await visibility(forgotten)).toEqual(LIVE);
      expect(await visibility(kept)).toEqual(LIVE);
      expect(await eventNodeCount()).toBe(2);

      await forget([forgotten]);

      expect(await visibility(forgotten)).toEqual(GONE);
      expect(await visibility(kept)).toEqual(LIVE);
      expect(await eventNodeCount()).toBe(1);
    });

    it('leaves the event’s edges as they were, and derives no new ones onto it', async () => {
      const dana = await seedNode('Person', 'Dana');
      const kitchen = await seedNode('Location', 'Dana’s kitchen');
      const forgotten = await seedEvent('Dinner with Dana', {
        participant_entity_ids: [dana],
        location_entity_id: kitchen,
      });
      const kept = await seedEvent('Lunch with Dana', {
        participant_entity_ids: [dana],
        location_entity_id: kitchen,
      });

      // The tombstone cascades nothing. That is what lets `restore` put the
      // event back exactly as it was, and it is how `deleteEvent` has always
      // left them.
      await seedEdge(dana, forgotten, 'FRIEND_OF_EVENT');
      await seedEdge(forgotten, kitchen, 'HOSTED_AT');

      const result = await forget([forgotten]);

      expect(result.data?.archivedRelationshipIds).toEqual([]);
      expect(await edgesOf(forgotten)).toEqual([
        { relationship_type: 'FRIEND_OF_EVENT', is_active: true },
        { relationship_type: 'HOSTED_AT', is_active: true },
      ]);

      // The edge matrix joins both endpoints on `ci.entities.is_active`. A
      // tombstone that only set `ci.events.is_deleted` would be invisible to
      // it, and it would go on wiring the deleted event into the graph.
      const created = await edges.materializeForSourceIds(ownerId, 'events', [forgotten, kept]);

      expect(created).toBe(2);
      expect(await edgesOf(kept)).toEqual([
        { relationship_type: 'LOCATED_AT', is_active: true },
        { relationship_type: 'PARTICIPATED_IN', is_active: true },
      ]);
      expect((await edgesOf(forgotten)).map((edge) => edge.relationship_type)).toEqual([
        'FRIEND_OF_EVENT',
        'HOSTED_AT',
      ]);
    });

    it('is undone by restore, which brings every reader back', async () => {
      const dana = await seedNode('Person', 'Dana');
      const id = await seedLocatedEvent('Dinner with Dana', { participant_entity_ids: [dana] });

      await forget([id]);

      expect(await visibility(id)).toEqual(GONE);

      published.length = 0;

      const restored = await calendar.restore(owner, id);

      expect(restored?.id).toBe(id);
      expect(await flags(id)).toEqual({ is_deleted: false, is_active: true });
      expect(await visibility(id)).toEqual(LIVE);
      expect(await eventNodeCount()).toBe(1);

      // Search is told to index it again, and the edge matrix may wire it in.
      expect(publishedOf(EventUpdatedEvent)).toEqual([{ eventId: id }]);
      expect(await edges.materializeForSourceIds(ownerId, 'events', [id])).toBe(1);
    });

    it('treats a tombstone left by the old delete, which kept the graph node active, as already forgotten', async () => {
      const id = await seedEvent('Dinner with Dana');

      await calendar.remove(owner, id);
      // `remove` did not used to touch the base row; put it back the way a
      // deletion made before that change left it.
      await dataSource.query('UPDATE ci.entities SET is_active = true WHERE entity_id = $1', [id]);

      expect(await flags(id)).toEqual({ is_deleted: true, is_active: true });

      published.length = 0;

      const result = await forget([id]);

      // `remove` has nothing live left to tombstone, so the node takes the
      // generic path, which is exactly the half that was missing.
      expect(result.success).toBe(true);
      expect(result.data?.restorableEventIds).toBeUndefined();
      expect(await flags(id)).toEqual({ is_deleted: true, is_active: false });
      expect(published).toEqual([]);

      // And it is still in the trash, so Undo works.
      expect((await calendar.restore(owner, id))?.id).toBe(id);
      expect(await flags(id)).toEqual({ is_deleted: false, is_active: true });
    });

    it('refuses to forget somebody else’s event', async () => {
      const id = await seedEvent('Dinner with Dana');

      const result = await forget([id], 'archive', asStranger);

      expect(result.success).toBe(true);
      expect(result.data?.archivedEntityIds).toEqual([]);
      expect(result.data?.warnings).toEqual([`Entity ${id} not found or not owned by user`]);
      expect(await flags(id)).toEqual({ is_deleted: false, is_active: true });
      expect(published).not.toContainEqual(expect.objectContaining({ name: EventRemovedEvent }));
    });

    it('sends an event through the tombstone and a concept through the generic path, in one call', async () => {
      const dana = await seedNode('Person', 'Dana');
      const event = await seedEvent('Dinner with Dana');
      const concept = await seedNode('Concept', 'Jazz');
      const conceptEdge = await seedEdge(concept, dana, 'RELATED_TO');
      const missing = uuidv7();

      const result = await forget([event, concept, missing]);

      expect(result.success).toBe(true);
      expect(result.data?.archivedEntityIds).toEqual([event, concept]);
      expect(result.data?.restorableEventIds).toEqual([event]);
      expect(result.data?.warnings).toEqual([`Entity ${missing} not found or not owned by user`]);

      expect(await flags(event)).toEqual({ is_deleted: true, is_active: false });

      // The concept has no detail row to tombstone: its node is deactivated,
      // its own edges go with it, and search drops it, exactly as before.
      const [conceptRow] = await dataSource.query('SELECT is_active FROM ci.entities WHERE entity_id = $1', [
        concept,
      ]);
      const [edgeRow] = await dataSource.query(
        'SELECT is_active FROM ci.relationships WHERE relationship_id = $1',
        [conceptEdge],
      );

      expect(conceptRow).toEqual({ is_active: false });
      expect(edgeRow).toEqual({ is_active: false });
      expect(publishedOf(ConceptRemovedEvent)).toEqual([{ conceptId: concept }]);
      expect(publishedOf(EventRemovedEvent)).toEqual([{ eventId: event }]);
    });
  });

  // ── Archive-and-delete mode ───────────────────────────────────────────────

  describe('archive_and_delete mode', () => {
    it('removes an unclustered event outright, rather than moving it to the trash', async () => {
      const dana = await seedNode('Person', 'Dana');
      const id = await seedEvent('Dinner with Dana');
      const outbound = await seedEdge(id, dana, 'HOSTED_BY');

      const result = await forget([id], 'archive_and_delete');

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ archivedEntityIds: [id], mode: 'archive_and_delete' });
      expect(result.data?.restorableEventIds).toBeUndefined();

      // Both rows are gone, not tombstoned, so there is nothing for restore to
      // find, and the event's outbound edge was deleted with it.
      expect(await flags(id)).toBeUndefined();
      expect(await dataSource.query('SELECT 1 FROM ci.entities WHERE entity_id = $1', [id])).toEqual([]);
      expect(await dataSource.query('SELECT 1 FROM ci.events WHERE event_id = $1', [id])).toEqual([]);
      expect(
        await dataSource.query('SELECT 1 FROM ci.relationships WHERE relationship_id = $1', [outbound]),
      ).toEqual([]);
      expect(await calendar.restore(owner, id)).toBeNull();
    });

    it('removes an event HBPE has clustered, with its photo, which used to fail on a foreign key', async () => {
      const dana = await seedNode('Person', 'Dana');
      const id = await seedEvent('Dinner with Dana', { participant_entity_ids: [dana] });
      const photo = await attachPhoto(id, 'Photo of the dinner');

      await clusterAtHbpe(id, photo);
      await seedEdge(dana, id, 'PARTICIPATED_IN');
      await seedEdge(id, dana, 'HOSTED_BY');
      await seedEdge(photo, id, 'DOCUMENTS');

      // Every table that can hold a row for the event holds one.
      expect(await remains(id, photo)).toEqual({
        entities: 2,
        events: 1,
        content: 1,
        relationships: 3,
        l1EventCluster: 1,
        l2ContentCluster: 1,
        contentContext: 1,
      });

      const result = await forget([id], 'archive_and_delete');

      // It raised `l1_event_cluster_event_id_fkey` here, for every event HBPE had clustered.
      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ archivedEntityIds: [id], mode: 'archive_and_delete' });

      // The event, its photo's node and the photo itself, and every edge in either direction.
      expect(await remains(id, photo)).toEqual(NOTHING);
      expect(publishedOf(EventRemovedEvent)).toEqual([{ eventId: id }]);
    });

    it('removes an event that is already in the trash, which is what archive then delete means', async () => {
      const id = await seedEvent('Dinner with Dana');

      await clusterAtHbpe(id);
      await forget([id]);

      expect(await flags(id)).toEqual({ is_deleted: true, is_active: false });

      const result = await forget([id], 'archive_and_delete');

      // The node is inactive by now. It used to answer "not found" here.
      expect(result.success).toBe(true);
      expect(result.data?.warnings).toBeUndefined();
      expect(result.data?.archivedEntityIds).toEqual([id]);
      expect(await remains(id)).toEqual(NOTHING);
    });

    it('removes an event and a concept in one call', async () => {
      const event = await seedEvent('Dinner with Dana');
      const concept = await seedNode('Concept', 'Jazz');

      await clusterAtHbpe(event);

      const result = await forget([event, concept], 'archive_and_delete');

      expect(result.success).toBe(true);
      expect(result.data?.archivedEntityIds).toEqual([event, concept]);
      expect(await remains(event)).toEqual(NOTHING);
      expect(await dataSource.query('SELECT 1 FROM ci.entities WHERE entity_id = $1', [concept])).toEqual([]);
    });

    it('removes an Event node that has no ci.events row behind it', async () => {
      // Graph ingest writes these. There is nothing to purge, so it is deleted like any node.
      const node = await seedNode('Event', 'Imported without a detail row');

      const result = await forget([node], 'archive_and_delete');

      expect(result.success).toBe(true);
      expect(await dataSource.query('SELECT 1 FROM ci.entities WHERE entity_id = $1', [node])).toEqual([]);
    });

    it('refuses to delete somebody else’s event, and leaves its HBPE rows alone', async () => {
      const id = await seedEvent('Dinner with Dana');

      await clusterAtHbpe(id);

      const result = await forget([id], 'archive_and_delete', asStranger);

      expect(result.success).toBe(true);
      expect(result.data?.archivedEntityIds).toEqual([]);
      expect(result.data?.warnings).toEqual([`Entity ${id} not found or not owned by user`]);
      expect(await remains(id)).toEqual({ ...NOTHING, entities: 1, events: 1, l1EventCluster: 1 });
    });
  });

  describe('archive_and_delete mode, for every other type', () => {
    it('takes a node’s edges in both directions, not just the ones leaving it', async () => {
      const dana = await seedNode('Person', 'Dana');
      const jazz = await seedNode('Concept', 'Jazz');
      const outbound = await seedEdge(jazz, dana, 'RELATED_TO');
      // This one points AT the node. Nothing used to delete it, and `ci.relationships` has no
      // foreign key to `ci.entities` to do it instead, so it stayed, pointing at nothing.
      const inbound = await seedEdge(dana, jazz, 'LIKES');
      const unrelated = await seedEdge(dana, await seedNode('Concept', 'Blues'), 'LIKES');

      const result = await forget([jazz], 'archive_and_delete');

      expect(result.success).toBe(true);
      expect(await dataSource.query('SELECT 1 FROM ci.entities WHERE entity_id = $1', [jazz])).toEqual([]);
      expect(
        await dataSource.query('SELECT 1 FROM ci.relationships WHERE relationship_id = ANY($1::uuid[])', [
          [outbound, inbound],
        ]),
      ).toEqual([]);
      // Somebody else's edge is somebody else's: only the deleted node's own are taken.
      expect(
        await dataSource.query('SELECT 1 FROM ci.relationships WHERE relationship_id = $1', [unrelated]),
      ).toHaveLength(1);
    });

    it('does not touch the edges of a node it does not own', async () => {
      const mine = await seedNode('Concept', 'Jazz');
      const theirs = await seedNode('Concept', 'Jazz', strangerId);

      // An edge of the stranger's that happens to name my node's id is the stranger's to keep.
      const [{ relationship_id }] = await dataSource.query(
        `INSERT INTO ci.relationships (from_entity_id, to_entity_id, relationship_type, owner_user_id)
         VALUES ($1, $2, 'SAME_AS', $3) RETURNING relationship_id`,
        [theirs, mine, strangerId],
      );

      const result = await forget([mine], 'archive_and_delete');

      expect(result.success).toBe(true);
      expect(
        await dataSource.query('SELECT 1 FROM ci.relationships WHERE relationship_id = $1', [
          relationship_id,
        ]),
      ).toHaveLength(1);
      expect(await dataSource.query('SELECT 1 FROM ci.entities WHERE entity_id = $1', [theirs])).toHaveLength(
        1,
      );
    });

    it('deletes a node that was archived earlier, where archiving it again finds nothing', async () => {
      const jazz = await seedNode('Concept', 'Jazz');

      await forget([jazz]);

      expect(await forget([jazz])).toMatchObject({
        success: true,
        data: { archivedEntityIds: [], warnings: [`Entity ${jazz} not found or not owned by user`] },
      });

      const result = await forget([jazz], 'archive_and_delete');

      expect(result.data?.archivedEntityIds).toEqual([jazz]);
      expect(await dataSource.query('SELECT 1 FROM ci.entities WHERE entity_id = $1', [jazz])).toEqual([]);
    });

    it('is refused whole by a foreign key, and says that trying again will not help', async () => {
      // `ci.users.entity_id` references the user's own Person with no ON DELETE action.
      const me = await seedNode('Person', 'Me');
      const dana = await seedNode('Person', 'Dana');
      const outbound = await seedEdge(me, dana, 'KNOWS');
      const inbound = await seedEdge(dana, me, 'KNOWS');

      await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [me, ownerId]);

      const result = await forget([me], 'archive_and_delete');

      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({
        code: 'CONSTRAINT_VIOLATION',
        retryable: false,
        details: { constraint: 'users_entity_id_fkey', table: 'users' },
      });
      expect(result.error?.message).toContain('mode "archive"');
      expect(result.error?.details).not.toHaveProperty('deletedEntityIds');

      // Nothing changed: the node and both edges are as they were. The edges were deleted first,
      // in the same transaction, and the refused delete took that back.
      expect(await dataSource.query('SELECT 1 FROM ci.entities WHERE entity_id = $1', [me])).toHaveLength(1);
      expect(
        await dataSource.query('SELECT 1 FROM ci.relationships WHERE relationship_id = ANY($1::uuid[])', [
          [outbound, inbound],
        ]),
      ).toHaveLength(2);
    });

    it('names the events it had already destroyed when it is the rest of the call that is refused', async () => {
      const event = await seedEvent('Dinner with Dana');
      const me = await seedNode('Person', 'Me');

      await clusterAtHbpe(event);
      await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [me, ownerId]);

      // The purge commits first, and cannot be undone. Then the node the foreign key protects is refused.
      const result = await forget([event, me], 'archive_and_delete');

      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({
        code: 'CONSTRAINT_VIOLATION',
        retryable: false,
        details: { constraint: 'users_entity_id_fkey', deletedEntityIds: [event] },
      });
      expect(result.error?.message).toContain(`Already deleted: ${event}.`);

      expect(await remains(event)).toEqual(NOTHING);
      expect(await dataSource.query('SELECT 1 FROM ci.entities WHERE entity_id = $1', [me])).toHaveLength(1);
    });
  });
});
