import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import {
  BaseEntity,
  type CalendarEventService,
  type CommunicationService,
  type ContentService,
  type FileService,
  GraphDeltaWriter,
  GraphNodeEntity,
  GraphUtilityService,
  ItemBaseEntity,
  ItemEntity,
  ItemService,
  RelationshipEntity,
} from '@ci/domains/memory';
import { ConceptRemovedEvent, ItemRemovedEvent } from '@ci/domains/memory/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ForgetKnowledgeTool } from '../ForgetKnowledgeTool';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `memory.forget` ON AN ITEM. THE REAL TOOL, THE REAL SERVICES, POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `archive_and_delete` used to delete an `Item` node by deleting its `ci.entities`
 * row and trusting the foreign keys. Only an item that is another item's parent
 * was refused. Everything else went through and left rows that name the item by id
 * with no foreign key to say so, and the tool said as much in a warning. It did not
 * say that the item's serial number kept being claimed by a unit that no longer
 * existed, or that a merge survivor's hidden tombstones came back as archived
 * items.
 *
 * An item is now purged by `ItemService.purge`, as an event is by
 * `CalendarEventService.purge`. The unit suite for the tool proves the routing
 * against doubles. A double cannot say whether the item is then really gone, so
 * this file drives the real thing and asks Postgres.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database of your OWN, or run `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[tools/ForgetKnowledgeTool.item.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

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
  objects: 0,
  relationships: 0,
  recordSources: 0,
  graphDeltas: 0,
  identifiers: 0,
  merges: 0,
  pipelineState: 0,
};

describeWithDb(`memory.forget on an Item node, against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let tool: ForgetKnowledgeTool;

  const ownerId = uuidv7();
  const strangerId = uuidv7();
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
      entities: [BaseEntity, ItemEntity, ItemBaseEntity, GraphNodeEntity, RelationshipEntity, UserEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'tools/ForgetKnowledgeTool.item');

    for (const userId of [ownerId, strangerId]) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'ForgetItem', userId);
    }

    const graph = new GraphUtilityService(
      dataSource.getRepository(GraphNodeEntity),
      dataSource.getRepository(RelationshipEntity),
      logger(),
    );

    // No case here names an event, content or a communication, so the tool never reaches for those.
    tool = new ForgetKnowledgeTool(
      graph,
      signalling,
      {} as unknown as CalendarEventService,
      {} as unknown as ContentService,
      {} as unknown as CommunicationService,
      new ItemService(
        dataSource.getRepository(ItemEntity),
        dataSource.getRepository(ItemBaseEntity),
        logger(),
        signalling,
        new GraphDeltaWriter(dataSource, logger()),
      ),
      // No case here names a file, so the tool never reaches for it.
      {} as unknown as FileService,
      logger(),
    );
  });

  async function wipe(userId: string): Promise<void> {
    // Both users, whichever one a case pointed at which node: `ci.users.entity_id` is what a case uses
    // to stand in for a table the purge has never heard of, and it would stop this very delete.
    await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = ANY($1::uuid[])', [
      [ownerId, strangerId],
    ]);
    await dataSource.query('DELETE FROM ci.object_identifiers WHERE owner_user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.entity_merges WHERE owner_user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.record_sources WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [userId]);
    // Children before parents: `parent_object_id` has no ON DELETE action.
    await dataSource.query(
      'UPDATE ci.objects SET parent_object_id = NULL, merged_into_object_id = NULL WHERE user_id = $1',
      [userId],
    );
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

  /** An item the way the importer writes it: an `Item` node and its `ci.objects` row. */
  async function seedItem(
    title: string,
    extra: { forUser?: string; parent?: string; mergedInto?: string } = {},
  ): Promise<string> {
    const id = uuidv7();
    const forUser = extra.forUser ?? ownerId;

    await dataSource.query(
      `INSERT INTO ci.entities
         (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id, is_active, merged_into_entity_id)
       VALUES ($1, 'Item', $2, '{}'::jsonb, $3, 'objects', $1, $4, $5)`,
      [id, title, forUser, extra.mergedInto === undefined, extra.mergedInto ?? null],
    );
    await dataSource.query(
      `INSERT INTO ci.objects (object_id, user_id, parent_object_id, merged_into_object_id, lifecycle_state)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        id,
        forUser,
        extra.parent ?? null,
        extra.mergedInto ?? null,
        extra.mergedInto === undefined ? 'active' : 'archived',
      ],
    );

    return id;
  }

  /**
   * Rows that name an item and have no foreign key to it: a ledger entry, a delta that carries the title,
   * the pipeline's bookkeeping, the serial number it was recognised by, and the audit row of a merge.
   */
  async function seedTrail(id: string, title: string, forUser = ownerId): Promise<void> {
    await dataSource.query(
      `INSERT INTO ci.record_sources (user_id, record_table, record_id, source_type, source_system, source_id)
       VALUES ($1, 'objects', $2, 'ci.import', 'forget_item_spec', $3)`,
      [forUser, id, `objects-${id}`],
    );
    await dataSource.query(
      `INSERT INTO ci.graph_deltas (node_type, entity_id, entity_type, change_type, changed_fields, owner_user_id)
       VALUES ('entity', $1, 'Item', 'created', jsonb_build_object('name', jsonb_build_object('new', $2::text)), $3)`,
      [id, title, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, status, user_id)
       VALUES ('item', $1, 'forget_item_spec.stage', 'done', $2)`,
      [id, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci.object_identifiers (owner_user_id, subject_type, subject_id, namespace, value_normalized)
       VALUES ($1, 'object_instance', $2, 'serial', $3)`,
      [forUser, id, `SN-${id}`],
    );
    await dataSource.query(
      `INSERT INTO ci.entity_merges (owner_user_id, source_entity_id, target_entity_id, entity_type, details)
       VALUES ($1, $2, $3, 'ObjectInstance', '{}'::jsonb)`,
      [forUser, uuidv7(), id],
    );
  }

  /** Rows of these nodes that are still there, by table. */
  async function remains(...ids: string[]): Promise<Record<string, number>> {
    const count = async (sql: string): Promise<number> => {
      const [{ count: n }] = await dataSource.query(sql, [ids]);

      return Number(n);
    };

    return {
      entities: await count('SELECT count(*) FROM ci.entities WHERE entity_id = ANY($1::uuid[])'),
      objects: await count('SELECT count(*) FROM ci.objects WHERE object_id = ANY($1::uuid[])'),
      relationships: await count(
        `SELECT count(*) FROM ci.relationships
          WHERE from_entity_id = ANY($1::uuid[]) OR to_entity_id = ANY($1::uuid[])`,
      ),
      recordSources: await count('SELECT count(*) FROM ci.record_sources WHERE record_id = ANY($1::uuid[])'),
      graphDeltas: await count('SELECT count(*) FROM ci.graph_deltas WHERE entity_id = ANY($1::uuid[])'),
      identifiers: await count(
        'SELECT count(*) FROM ci.object_identifiers WHERE subject_id = ANY($1::uuid[])',
      ),
      merges: await count(
        `SELECT count(*) FROM ci.entity_merges
          WHERE source_entity_id = ANY($1::uuid[]) OR target_entity_id = ANY($1::uuid[])`,
      ),
      pipelineState: await count('SELECT count(*) FROM ci.pipeline_state WHERE entity_id = ANY($1::uuid[])'),
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

  it('removes an item and every row that names it, and announces it', async () => {
    const id = await seedItem('A kettle');

    await seedEdge(id, await seedNode('Location', 'The kitchen'), 'STORED_AT');
    await seedEdge(await seedNode('Person', 'Dana'), id, 'OWNS');
    await seedTrail(id, 'A kettle');

    // Precondition: every kind of row is there, so "gone" below means the purge took it.
    expect(await remains(id)).toEqual({
      ...NOTHING,
      entities: 1,
      objects: 1,
      relationships: 2,
      recordSources: 1,
      graphDeltas: 1,
      identifiers: 1,
      merges: 1,
      pipelineState: 1,
    });

    const result = await forget([id]);

    expect(result.success).toBe(true);
    expect(result.data?.archivedEntityIds).toEqual([id]);
    // The node, its detail row, its edges in both directions, and everything that named it by id: the
    // serial number it was recognised by and the merge audit row among it. The warning the tool used to
    // give, that these were left, is gone with them.
    expect(await remains(id)).toEqual(NOTHING);
    expect(result.data?.warnings).toBeUndefined();
    expect(publishedOf(ItemRemovedEvent)).toEqual([{ itemId: id }]);
  });

  it('removes an item and a concept named in one call', async () => {
    const item = await seedItem('A kettle');
    const concept = await seedNode('Concept', 'Jazz');

    await seedTrail(item, 'A kettle');

    const result = await forget([item, concept]);

    expect(result.success).toBe(true);
    expect(result.data?.archivedEntityIds).toEqual([item, concept]);
    expect(await remains(item, concept)).toEqual(NOTHING);
    expect(publishedOf(ItemRemovedEvent)).toEqual([{ itemId: item }]);
    expect(publishedOf(ConceptRemovedEvent)).toEqual([{ conceptId: concept }]);
  });

  it('does not purge an item in archive mode, which only deactivates its node', async () => {
    const id = await seedItem('A kettle');

    await seedTrail(id, 'A kettle');

    const result = await forget([id], 'archive');

    expect(result.success).toBe(true);
    // The detail row, the identifier and the rest are as they were, and nobody is told anything was deleted.
    expect(await remains(id)).toMatchObject({ entities: 1, objects: 1, identifiers: 1, merges: 1 });
    expect(publishedOf(ItemRemovedEvent)).toEqual([]);
  });

  it('removes an item that was archived earlier, which is what archive then delete means', async () => {
    const id = await seedItem('A kettle');

    await seedTrail(id, 'A kettle');
    expect((await forget([id], 'archive')).success).toBe(true);

    const result = await forget([id]);

    expect(result.success).toBe(true);
    expect(await remains(id)).toEqual(NOTHING);
    expect(publishedOf(ItemRemovedEvent)).toEqual([{ itemId: id }]);
  });

  it('removes a survivor with the duplicates that were merged into it, and says so', async () => {
    const survivor = await seedItem('A kettle');
    const first = await seedItem('A kettle (duplicate)', { mergedInto: survivor });
    const second = await seedItem('A kettle (another)', { mergedInto: survivor });

    await seedTrail(survivor, 'A kettle');
    await seedTrail(first, 'A kettle (duplicate)');

    const result = await forget([survivor]);

    expect(result.success).toBe(true);
    // The caller named one item. The tool says that two it never named went with it, and does not list
    // them among the nodes it deleted, because the caller asked about only one.
    expect(result.data?.archivedEntityIds).toEqual([survivor]);
    expect(result.data?.warnings).toHaveLength(1);
    expect(result.data?.warnings?.[0]).toContain(first);
    expect(result.data?.warnings?.[0]).toContain(second);
    expect(await remains(survivor, first, second)).toEqual(NOTHING);
    // Each was announced, so search drops them all.
    expect((publishedOf(ItemRemovedEvent) as Array<{ itemId: string }>).map((e) => e.itemId).sort()).toEqual(
      [survivor, first, second].sort(),
    );
  });

  it('refuses an item that is another item’s parent, and changes nothing', async () => {
    const kit = await seedItem('A tool kit');
    const part = await seedItem('A screwdriver', { parent: kit });

    await seedTrail(kit, 'A tool kit');

    const result = await forget([kit]);

    // The one foreign key that stops an item being deleted, and the user's decision that it should.
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'CONSTRAINT_VIOLATION',
      retryable: false,
      details: { constraint: 'objects_parent_object_id_fkey', table: 'objects' },
    });
    expect(result.error?.details).not.toHaveProperty('deletedEntityIds');
    // Everything the purge had cleared before the key refused was rolled back with it.
    expect(await remains(kit)).toMatchObject({
      entities: 1,
      objects: 1,
      recordSources: 1,
      identifiers: 1,
      merges: 1,
    });
    expect(await nodeExists(part)).toBe(true);
    expect(publishedOf(ItemRemovedEvent)).toEqual([]);
  });

  it('removes the kit once its parts are named too, in the same call', async () => {
    const kit = await seedItem('A tool kit');
    const part = await seedItem('A screwdriver', { parent: kit });

    expect((await forget([kit])).success).toBe(false);

    // Naming the whole kit is what lets it go.
    const result = await forget([part, kit]);

    expect(result.success).toBe(true);
    expect(await remains(kit, part)).toEqual(NOTHING);
    expect((publishedOf(ItemRemovedEvent) as Array<{ itemId: string }>).map((e) => e.itemId).sort()).toEqual(
      [kit, part].sort(),
    );
  });

  it('removes an Item node that has no ci.objects row, and announces it itself', async () => {
    // Graph ingest writes these. There is nothing to purge, so the generic delete takes the node, and the
    // tool still tells search, because that is the one thing the generic delete does not.
    const id = await seedNode('Item', 'Imported without a detail row');

    const result = await forget([id]);

    expect(result.success).toBe(true);
    expect(await nodeExists(id)).toBe(false);
    expect(result.data?.warnings).toBeUndefined();
    expect(publishedOf(ItemRemovedEvent)).toEqual([{ itemId: id }]);
  });

  it('refuses to delete somebody else’s item, and leaves its identifier alone', async () => {
    const theirs = await seedItem('Their kettle', { forUser: strangerId });

    await seedTrail(theirs, 'Their kettle', strangerId);

    const result = await forget([theirs]);

    // The node is not the caller's, so the tool does not even find it.
    expect(result.success).toBe(true);
    expect(result.data?.archivedEntityIds).toEqual([]);
    expect(result.data?.warnings).toEqual([`Entity ${theirs} not found or not owned by user`]);
    expect(await remains(theirs)).toMatchObject({
      entities: 1,
      objects: 1,
      identifiers: 1,
      recordSources: 1,
    });
    expect(publishedOf(ItemRemovedEvent)).toEqual([]);

    // And the stranger can forget their own.
    expect((await forget([theirs], 'archive_and_delete', asStranger)).success).toBe(true);
    expect(await remains(theirs)).toEqual(NOTHING);
  });

  it('is refused whole by a foreign key it does not know about, and says that trying again will not help', async () => {
    const id = await seedItem('A kettle');
    const edge = await seedEdge(id, await seedNode('Concept', 'Jazz'), 'MENTIONS');

    await seedTrail(id, 'A kettle');
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

    // Nothing changed: the identifier, the merge row, the ledger entry and the edge the purge had cleared
    // were rolled back with it.
    expect(await remains(id)).toMatchObject({
      entities: 1,
      objects: 1,
      relationships: 1,
      recordSources: 1,
      identifiers: 1,
      merges: 1,
    });
    expect(
      await dataSource.query('SELECT 1 FROM ci.relationships WHERE relationship_id = $1', [edge]),
    ).toHaveLength(1);
    expect(publishedOf(ItemRemovedEvent)).toEqual([]);
  });

  it('names the item it had already destroyed when it is the rest of the call that is refused', async () => {
    const item = await seedItem('A kettle');
    const me = await seedNode('Person', 'Me');

    await seedTrail(item, 'A kettle');
    await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [me, ownerId]);

    // The purge commits first, and cannot be undone. Then the node the foreign key protects is refused.
    const result = await forget([item, me]);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'CONSTRAINT_VIOLATION',
      retryable: false,
      details: { constraint: 'users_entity_id_fkey', deletedEntityIds: [item] },
    });
    expect(result.error?.message).toContain(`Already deleted: ${item}.`);

    expect(await remains(item)).toEqual(NOTHING);
    expect(await nodeExists(me)).toBe(true);
    expect(publishedOf(ItemRemovedEvent)).toEqual([{ itemId: item }]);
  });
});
