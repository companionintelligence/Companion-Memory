import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import type { ObjectIdentifierService } from '@ci/domains/graph';
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
  ProductModelEntity,
  ProductModelService,
  RelationshipEntity,
} from '@ci/domains/memory';
import { ItemUpdatedEvent, ProductRemovedEvent } from '@ci/domains/memory/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { GRAPH_ENTITY_ENTITIES, graphEntityServices } from '../../../__tests__/support/graphEntityServices';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ForgetKnowledgeTool } from '../ForgetKnowledgeTool';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `memory.forget` ON A PRODUCT. THE REAL TOOL, THE REAL SERVICES, POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A `Product` node is the graph mirror of a `ci.product_models` row, which points at it from
 * `product_entity_id` with no `ON DELETE` action. Archive refuses one, because archive cannot hide
 * the model from search, and points at `archive_and_delete`. That delete went down the generic path,
 * whose DELETE of the node was refused by the model's key, so there was no mode that worked. A
 * product is now purged by `ProductModelService.purge`, and this file asks Postgres what is left.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated database of your OWN, or
 * run `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[tools/ForgetKnowledgeTool.product.integration] SKIPPED — ${availability.reason}`);
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

describeWithDb(`memory.forget on a Product node, against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let tool: ForgetKnowledgeTool;

  const ownerId = uuidv7();
  const strangerId = uuidv7();
  const asOwner = { userId: ownerId } as RequestContext;
  const asStranger = { userId: strangerId } as RequestContext;

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
        BaseEntity,
        ItemEntity,
        ItemBaseEntity,
        ProductModelEntity,
        GraphNodeEntity,
        RelationshipEntity,
        UserEntity,
        ...GRAPH_ENTITY_ENTITIES,
      ],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'tools/ForgetKnowledgeTool.product');

    for (const userId of [ownerId, strangerId]) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'ForgetProduct', userId);
    }

    const graph = new GraphUtilityService(
      dataSource.getRepository(GraphNodeEntity),
      dataSource.getRepository(RelationshipEntity),
      logger(),
    );
    const services = graphEntityServices(dataSource, signalling, logger());

    tool = new ForgetKnowledgeTool(
      graph,
      signalling,
      // No case here names an event, content, a message or a file, so the tool never reaches for those.
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
      {} as unknown as FileService,
      services.people,
      services.places,
      services.concepts,
      // The purge never resolves an identifier, it deletes them.
      new ProductModelService(
        dataSource.getRepository(ProductModelEntity),
        {} as unknown as ObjectIdentifierService,
        signalling,
        logger(),
      ),
      logger(),
    );
  });

  async function wipe(userId: string): Promise<void> {
    await dataSource.query('DELETE FROM ci.entity_merges WHERE owner_user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.record_sources WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci_search.vectors WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.object_identifiers WHERE owner_user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.objects WHERE user_id = $1', [userId]);
    await dataSource.query('UPDATE ci.product_models SET merged_into_product_id = NULL WHERE user_id = $1', [
      userId,
    ]);
    await dataSource.query('DELETE FROM ci.product_models WHERE user_id = $1', [userId]);
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

  async function seedNode(
    entityType: string,
    name: string,
    forUser = ownerId,
    active = true,
  ): Promise<string> {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, is_active)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, $5)`,
      [id, entityType, name, forUser, active],
    );

    return id;
  }

  /**
   * A product the way the catalog writes it: a `Product` node and the `ci.product_models` row that
   * points at it, with a barcode and a search row keyed by the model's id.
   */
  async function seedProduct(
    title: string,
    extra: { forUser?: string; mergedInto?: string; active?: boolean } = {},
  ): Promise<{ nodeId: string; productId: string }> {
    const forUser = extra.forUser ?? ownerId;
    const nodeId = await seedNode('Product', title, forUser, extra.active ?? true);
    const productId = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.product_models (product_id, user_id, owner_user_id, product_entity_id, title, merged_into_product_id)
       VALUES ($1, $2, $2, $3, $4, $5)`,
      [productId, forUser, nodeId, title, extra.mergedInto ?? null],
    );
    await dataSource.query(
      `INSERT INTO ci.object_identifiers (owner_user_id, subject_type, subject_id, namespace, value_normalized)
       VALUES ($1, 'product_model', $2, 'custom', $3)`,
      [forUser, productId, productId],
    );
    await dataSource.query(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES (gen_random_uuid(), 'product', $1, to_tsvector('simple', $2), $3)`,
      [productId, title, forUser],
    );

    return { nodeId, productId };
  }

  /** A thing that is an instance of the model: a `ci.objects` row naming it in `product_id`. */
  async function seedThing(title: string, productId: string): Promise<string> {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Item', $2, '{}'::jsonb, $3, 'objects', $1)`,
      [id, title, ownerId],
    );
    await dataSource.query(
      `INSERT INTO ci.objects (object_id, user_id, lifecycle_state, product_id) VALUES ($1, $2, 'active', $3)`,
      [id, ownerId, productId],
    );

    return id;
  }

  async function count(sql: string, params: unknown[]): Promise<number> {
    const [{ count: n }] = await dataSource.query(sql, params);

    return Number(n);
  }

  async function remains(nodeIds: string[], productIds: string[]) {
    return {
      nodes: await count('SELECT count(*) FROM ci.entities WHERE entity_id = ANY($1::uuid[])', [nodeIds]),
      models: await count('SELECT count(*) FROM ci.product_models WHERE product_id = ANY($1::uuid[])', [
        productIds,
      ]),
      barcodes: await count(
        `SELECT count(*) FROM ci.object_identifiers WHERE subject_type = 'product_model' AND subject_id = ANY($1::uuid[])`,
        [productIds],
      ),
      searchRows: await count('SELECT count(*) FROM ci_search.vectors WHERE entity_id = ANY($1::uuid[])', [
        productIds,
      ]),
      edges: await count(
        'SELECT count(*) FROM ci.relationships WHERE from_entity_id = ANY($1::uuid[]) OR to_entity_id = ANY($1::uuid[])',
        [nodeIds],
      ),
    };
  }

  // ── Cases ─────────────────────────────────────────────────────────────────

  it('deletes a product with its model, barcode, search row, edges and merged duplicate, and keeps the thing unlinked', async () => {
    const product = await seedProduct('Kettle 1.7 L');
    const duplicate = await seedProduct('Kettle 1.7L', { mergedInto: product.productId, active: false });
    const thing = await seedThing('Kitchen kettle', product.productId);
    const brand = await seedNode('Organization', 'Kettle Co');

    await dataSource.query(
      `INSERT INTO ci.relationships (from_entity_id, to_entity_id, relationship_type, owner_user_id)
       VALUES ($1, $2, 'MADE_BY', $3)`,
      [product.nodeId, brand, ownerId],
    );
    // What `ObjectMergeService.mergeProductModels` writes: keyed by the MODELS' ids, with a snapshot of
    // the loser's row.
    await dataSource.query(
      `INSERT INTO ci.entity_merges (owner_user_id, source_entity_id, target_entity_id, entity_type, details)
       VALUES ($1, $2, $3, 'ProductModel', $4::jsonb)`,
      [ownerId, duplicate.productId, product.productId, JSON.stringify({ source: { title: 'Kettle 1.7L' } })],
    );
    // What the bulk ingest ledgers for a model it wrote.
    await dataSource.query(
      `INSERT INTO ci.record_sources (user_id, record_table, record_id, source_type, source_system, source_id)
       VALUES ($1, 'product_models', $2, 'import', 'amazon', 'B0KETTLE')`,
      [ownerId, product.productId],
    );

    const result = await tool.execute(asOwner, { entityIds: [product.nodeId], mode: 'archive_and_delete' });

    expect(result.success).toBe(true);
    expect(result.data?.archivedEntityIds).toEqual([product.nodeId]);
    expect(result.data?.warnings).toEqual([
      `Also deleted, because each had been merged into a product named here: ${duplicate.nodeId}.`,
      'Kept but no longer linked to the deleted product: 1 thing.',
    ]);
    expect(
      await remains([product.nodeId, duplicate.nodeId], [product.productId, duplicate.productId]),
    ).toEqual({ nodes: 0, models: 0, barcodes: 0, searchRows: 0, edges: 0 });
    expect(
      await count(
        'SELECT count(*) FROM ci.entity_merges WHERE source_entity_id = ANY($1::uuid[]) OR target_entity_id = ANY($1::uuid[])',
        [[product.productId, duplicate.productId]],
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*) FROM ci.record_sources WHERE record_table = 'product_models' AND record_id = $1`,
        [product.productId],
      ),
    ).toBe(0);

    // The thing is a record in its own right: it stays, without the model, and is indexed again
    // without the model's title and brand.
    const [row] = await dataSource.query('SELECT product_id FROM ci.objects WHERE object_id = $1', [thing]);
    expect(row).toEqual({ product_id: null });
    expect(publishedOf(ItemUpdatedEvent)).toEqual([{ itemId: thing }]);
    expect(await count('SELECT count(*) FROM ci.entities WHERE entity_id = $1', [brand])).toBe(1);
    expect(publishedOf(ProductRemovedEvent)).toEqual(
      expect.arrayContaining([{ productId: product.productId }, { productId: duplicate.productId }]),
    );
  });

  it('deletes the thing and its product named in one call, with nothing left to unlink', async () => {
    const product = await seedProduct('Lamp');
    const thing = await seedThing('Desk lamp', product.productId);

    const result = await tool.execute(asOwner, {
      entityIds: [product.nodeId, thing],
      mode: 'archive_and_delete',
    });

    expect(result.success).toBe(true);
    expect(result.data?.warnings).toBeUndefined();
    expect(await count('SELECT count(*) FROM ci.objects WHERE object_id = $1', [thing])).toBe(0);
    expect(await remains([product.nodeId], [product.productId])).toMatchObject({ nodes: 0, models: 0 });
  });

  it("leaves another account's product alone", async () => {
    const theirs = await seedProduct('Their kettle', { forUser: strangerId });

    await tool.execute(asOwner, { entityIds: [theirs.nodeId], mode: 'archive_and_delete' });

    expect(await remains([theirs.nodeId], [theirs.productId])).toMatchObject({
      nodes: 1,
      models: 1,
      barcodes: 1,
    });
    expect(publishedOf(ProductRemovedEvent)).toEqual([]);

    // Its owner can.
    const result = await tool.execute(asStranger, { entityIds: [theirs.nodeId], mode: 'archive_and_delete' });

    expect(result.success).toBe(true);
    expect(await remains([theirs.nodeId], [theirs.productId])).toMatchObject({ nodes: 0, models: 0 });
  });

  it('refuses to archive a product with its model, before queueing and when it runs, and changes nothing', async () => {
    const product = await seedProduct('Toaster');

    const refusal = await tool.checkCall(asOwner, { entityIds: [product.nodeId], mode: 'archive' });
    const result = await tool.execute(asOwner, { entityIds: [product.nodeId], mode: 'archive' });

    expect(refusal).toMatchObject({ code: 'ARCHIVE_REFUSED' });
    expect(refusal?.message).toContain(`thing ${product.nodeId}`);
    expect(result.error).toMatchObject({ code: 'ARCHIVE_REFUSED', retryable: false });
    const [row] = await dataSource.query('SELECT is_active FROM ci.entities WHERE entity_id = $1', [
      product.nodeId,
    ]);
    expect(row).toEqual({ is_active: true });
  });

  it('refuses a product node archived earlier, instead of reporting it missing', async () => {
    const product = await seedProduct('Mixer', { active: false });

    const result = await tool.execute(asOwner, { entityIds: [product.nodeId], mode: 'archive' });

    expect(result.error).toMatchObject({ code: 'ARCHIVE_REFUSED' });
    expect(result.error?.message).toContain(`thing ${product.nodeId}`);
  });

  it('archives the node a merge left behind, whose model is only a tombstone', async () => {
    const winner = await seedProduct('Blender');
    const loser = await seedProduct('Blender 2', { mergedInto: winner.productId });

    expect(await tool.checkCall(asOwner, { entityIds: [loser.nodeId], mode: 'archive' })).toBeUndefined();

    const result = await tool.execute(asOwner, { entityIds: [loser.nodeId], mode: 'archive' });

    expect(result.success).toBe(true);
    const [row] = await dataSource.query('SELECT is_active FROM ci.entities WHERE entity_id = $1', [
      loser.nodeId,
    ]);
    expect(row).toEqual({ is_active: false });
  });

  it.each([['Product'], ['Object'], ['Thing']])(
    'archives a %s node that has no detail row behind it',
    async (entityType) => {
      const node = await seedNode(entityType, `A bare ${entityType}`);

      expect(await tool.checkCall(asOwner, { entityIds: [node], mode: 'archive' })).toBeUndefined();

      const result = await tool.execute(asOwner, { entityIds: [node], mode: 'archive' });

      expect(result.success).toBe(true);
      const [row] = await dataSource.query('SELECT is_active FROM ci.entities WHERE entity_id = $1', [node]);
      expect(row).toEqual({ is_active: false });
    },
  );

  it('knows every key that points at a product model, and each one only unlinks', async () => {
    // The purge leaves the records that MENTION a model to their own keys and counts them for the
    // warning. A new key with another ON DELETE action would make it fail, or take rows along.
    const keys: Array<{ child: string; column: string; action: string }> = await dataSource.query(
      `SELECT n.nspname || '.' || cl.relname AS child, a.attname AS column, c.confdeltype AS action
         FROM pg_constraint c
         JOIN pg_class cl ON cl.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.confrelid = 'ci.product_models'::regclass
        ORDER BY 1, 2`,
    );

    expect(keys).toEqual([
      { child: 'ci.object_observations', column: 'resolved_product_id', action: 'n' },
      { child: 'ci.objects', column: 'product_id', action: 'n' },
      { child: 'ci.product_models', column: 'merged_into_product_id', action: 'n' },
      { child: 'ci.receipt_line_items', column: 'product_id', action: 'n' },
    ]);
  });
});
