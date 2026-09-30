import { DataSource, type QueryRunner } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { Events } from '@ci/domains/events';
import {
  EntityIdentifierEntity,
  EntityIdentifierService,
  GraphIngestService,
  NodeEntity,
  RelationshipEntity as IngestRelationshipEntity,
} from '@ci/domains/graph';
import {
  GraphDeltaWriter,
  GraphEventService,
  GraphNodeEntity,
  GraphQueryService,
  GraphUtilityService,
  RelationshipEntity,
} from '@ci/domains/memory';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { WriteKnowledgeTool } from '../WriteKnowledgeTool';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AN AGENT WRITE ONTO AN IMPORTED PERSON, THEN THE NEXT IMPORT — REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * GraphIngestService upserts on `(owner_user_id, entity_type, linked_table,
 * linked_id)`. A `memory.remember` that reused an imported Person's id used to
 * write `linked_table = NULL, linked_id = NULL` onto it, so the next import of
 * the same source found no row at that coordinate and minted a second Alex.
 *
 * Real here: the tool, GraphEventService, GraphUtilityService's TypeORM write,
 * GraphQueryService's reads, GraphIngestService and the schema. Stood in: the
 * queue, as a JSON round-trip held until `flush()`, handing each payload to
 * createOrUpdateNode the way GraphEventListener does (the listener adds nothing
 * on the way — pinned in GraphEventListener.nodeUpserted.test.ts).
 *
 * Every test runs inside one transaction on one connection and rolls back, so
 * nothing is committed. Opt-in like the other DB-backed suites: skips with the
 * reason when nothing listens at `MEMORY_TEST_DATABASE_URL` / `DATABASE_URL`.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[WriteKnowledgeTool.importKey.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const logger = {
  setContext: () => undefined,
  debug: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** A contact as the Google Contacts importer sends it. */
const ALEX = {
  key: 'google-contacts:contact:alex@example.com',
  entityType: 'Person',
  name: 'Alex Rivera',
  sourceSystem: 'google-contacts',
  properties: { emails: ['alex@example.com'] },
};

/** Keys other writers add after the import: a merge's folded identifiers, a person edit, the planner. */
const OTHER_WRITERS = {
  phones: ['+15551230001', '+15551230002'],
  names: ['Alex Rivera', 'A. Rivera'],
  first_name: 'Alex',
  planner: { trust_mode: 'ask' },
};

describeWithDb(`WriteKnowledgeTool on an imported entity (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let owner: string;
  let context: UserServiceContext;
  let ingest: GraphIngestService;
  let graphEvents: GraphEventService;
  let tool: WriteKnowledgeTool;
  let flush: () => Promise<void>;

  const row = async (entityId: string) => {
    const [found] = await runner.query(
      `SELECT entity_type, name, description, linked_table, linked_id, properties, is_active
         FROM ci.entities WHERE entity_id = $1`,
      [entityId],
    );

    return found as {
      entity_type: string;
      name: string | null;
      description: string | null;
      linked_table: string | null;
      linked_id: string | null;
      properties: Record<string, unknown>;
      is_active: boolean;
    };
  };

  /** Import ALEX (optionally with fresh properties) and return the id the key resolved to. */
  const importAlex = async (properties: Record<string, unknown> = ALEX.properties) => {
    const result = await ingest.ingest(context, { entities: [{ ...ALEX, properties }], relationships: [] });
    expect(result.errors).toEqual([]);

    return result.entities[0].entityId;
  };

  beforeAll(async () => {
    const connection = resolveConnection(ENV);

    if (connection == null) {
      throw new Error('availability said yes but no connection resolved');
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
      entities: [GraphNodeEntity, RelationshipEntity, NodeEntity, IngestRelationshipEntity, EntityIdentifierEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();

    // SHARED: these tests row-lock ci.entities / ci.users inside their
    // transaction. See domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'WriteKnowledgeTool.importKey');
  });

  afterAll(async () => {
    await schemaLock?.release();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    const query = (sql: string, params?: unknown[]) => runner.query(sql, params);
    owner = await createSyntheticTestUser(query, 'WriteKnowledgeTool-importKey');
    context = { userId: owner } as UserServiceContext;

    const manager = runner.manager;
    ingest = new GraphIngestService(
      manager.getRepository(NodeEntity),
      manager.getRepository(IngestRelationshipEntity),
      new EntityIdentifierService(manager.getRepository(EntityIdentifierEntity), logger as never),
      logger as never,
      // GraphDeltaWriter only ever calls `.query`, so this keeps its rows in the transaction too.
      new GraphDeltaWriter({ query } as never, logger as never),
    );

    const graphUtility = new GraphUtilityService(
      manager.getRepository(GraphNodeEntity),
      manager.getRepository(RelationshipEntity),
      logger as never,
    );

    const queued: Array<{ event: string; body: string }> = [];
    graphEvents = new GraphEventService(
      {
        send: async (event: string, body: unknown) => {
          queued.push({ event, body: JSON.stringify(body) });

          return ['job'];
        },
      } as never,
      logger as never,
    );
    flush = async () => {
      for (const { event, body } of queued.splice(0)) {
        const wire = JSON.parse(body);
        if (event === Events.GRAPH_NODE_UPSERTED) {
          await graphUtility.createOrUpdateNode(wire.ownerId, wire.node);
        } else if (event === Events.GRAPH_RELATIONSHIP_UPSERTED) {
          await graphUtility.createOrUpdateRelationship(wire.ownerId, wire.relationship);
        }
      }
    };

    tool = new WriteKnowledgeTool(graphEvents, new GraphQueryService({} as never, graphUtility), logger as never);
  });

  afterEach(async () => {
    await runner.rollbackTransaction();
    await runner.release();
  });

  it('keeps an imported Person on its import key, so the next import updates it instead of minting a duplicate', async () => {
    const alexId = await importAlex();
    await runner.query(`UPDATE ci.entities SET properties = properties || $2::jsonb WHERE entity_id = $1`, [
      alexId,
      JSON.stringify(OTHER_WRITERS),
    ]);

    const result = await tool.execute(context, {
      operations: [
        { kind: 'entity.create', entityId: alexId, entityType: 'Person', properties: { occupation: 'dentist' } },
      ],
    });
    await flush();

    expect(result.data).toMatchObject({ updatedNodes: 1, createdNodes: 0, failures: 0 });
    expect(await row(alexId)).toEqual({
      entity_type: 'Person',
      name: 'Alex Rivera',
      description: null,
      linked_table: 'import:google-contacts',
      linked_id: GraphIngestService.linkedIdFor(ALEX.key),
      properties: { ...ALEX.properties, ...OTHER_WRITERS, occupation: 'dentist' },
      is_active: true,
    });

    // The source learns something new about Alex, so the import writes rather than skips.
    const reimported = await importAlex({ emails: ['alex@example.com'], birthday: '1990-04-01' });

    expect(reimported).toBe(alexId);
    const alexes = await runner.query(
      `SELECT entity_id FROM ci.entities WHERE owner_user_id = $1 AND entity_type = 'Person' AND name = 'Alex Rivera'`,
      [owner],
    );
    expect(alexes).toEqual([{ entity_id: alexId }]);
  });

  it('control: the payload the tool used to send detaches the row, and the next import mints a second Alex', async () => {
    // Shows the coordinate assertions above can fail. This is, field for field,
    // what WriteKnowledgeTool sent for the same call before the fix — and what
    // an explicit null still means: clear it.
    const alexId = await importAlex();
    await runner.query(`UPDATE ci.entities SET properties = properties || $2::jsonb WHERE entity_id = $1`, [
      alexId,
      JSON.stringify(OTHER_WRITERS),
    ]);

    await graphEvents.upsertNode(owner, {
      entityId: alexId,
      entityType: 'Person',
      name: null,
      description: null,
      properties: { occupation: 'dentist' },
      searchContent: null,
      linkedTable: null,
      linkedId: null,
      mergeProperties: false,
    });
    await flush();

    expect(await row(alexId)).toMatchObject({
      name: null,
      linked_table: null,
      linked_id: null,
      properties: { occupation: 'dentist' },
    });

    const reimported = await importAlex();

    expect(reimported).not.toBe(alexId);
    const people = await runner.query(
      `SELECT entity_id FROM ci.entities WHERE entity_id = ANY($1::uuid[]) AND is_active`,
      [[alexId, reimported]],
    );
    expect(people).toHaveLength(2);
  });

  it('an entity.update queued behind another writer does not revert that writer, and prunes at write time', async () => {
    const alexId = await importAlex();
    await runner.query(`UPDATE ci.entities SET properties = properties || $2::jsonb WHERE entity_id = $1`, [
      alexId,
      JSON.stringify(OTHER_WRITERS),
    ]);

    await tool.execute(context, {
      operations: [
        {
          kind: 'entity.update',
          entityId: alexId,
          properties: { occupation: 'dentist' },
          removeProperties: ['planner'],
        },
      ],
    });
    // PersonService.patch-style atomic write, landing while the update is still queued.
    await runner.query(
      `UPDATE ci.entities
          SET properties = properties || '{"phones": ["+15551230001", "+15551230002", "+15551230003"]}'::jsonb,
              name = 'Alex Q. Rivera'
        WHERE entity_id = $1`,
      [alexId],
    );
    await flush();

    const stored = await row(alexId);
    expect(stored).toMatchObject({
      name: 'Alex Q. Rivera',
      linked_table: 'import:google-contacts',
      linked_id: GraphIngestService.linkedIdFor(ALEX.key),
    });
    expect(stored.properties).toEqual({
      emails: ['alex@example.com'],
      phones: ['+15551230001', '+15551230002', '+15551230003'],
      names: OTHER_WRITERS.names,
      first_name: 'Alex',
      occupation: 'dentist',
    });
  });

  it('a relationship.create reusing an imported edge keeps its strength and properties, and merges its own', async () => {
    const SAM = { ...ALEX, key: 'google-contacts:contact:sam@example.com', name: 'Sam Lee', properties: {} };
    const result = await ingest.ingest(context, {
      entities: [ALEX, SAM],
      relationships: [{ fromKey: ALEX.key, toKey: SAM.key, type: 'KNOWS', properties: { source: 'google-contacts' } }],
    });
    expect(result.errors).toEqual([]);
    const [alexId, samId] = [ALEX.key, SAM.key].map((key) => result.entities.find((e) => e.key === key)!.entityId);
    // Not `UPDATE … RETURNING`: TypeORM's postgres `query()` hands an UPDATE back as [rows, rowCount].
    const [{ relationship_id: edgeId }] = await runner.query(
      `SELECT relationship_id FROM ci.relationships
        WHERE from_entity_id = $1 AND to_entity_id = $2 AND relationship_type = 'KNOWS'`,
      [alexId, samId],
    );
    await runner.query(`UPDATE ci.relationships SET strength = 0.4 WHERE relationship_id = $1`, [edgeId]);

    const written = await tool.execute(context, {
      operations: [
        {
          kind: 'relationship.create',
          relationshipId: edgeId,
          fromEntityId: alexId,
          toEntityId: samId,
          relationshipType: 'KNOWS',
          properties: { context: 'dentist' },
        },
      ],
    });
    await flush();

    expect(written.data).toMatchObject({ updatedRelationships: 1, createdRelationships: 0, failures: 0 });
    const [edge] = await runner.query(
      `SELECT from_entity_id, to_entity_id, relationship_type, strength, properties
         FROM ci.relationships WHERE relationship_id = $1`,
      [edgeId],
    );
    expect(edge).toEqual({
      from_entity_id: alexId,
      to_entity_id: samId,
      relationship_type: 'KNOWS',
      strength: 0.4,
      properties: { source: 'google-contacts', context: 'dentist' },
    });
  });

  describe('restating an edge without its id — how a model says a thing it was already told', () => {
    // relationships_unique_directed_idx allows one active edge per (from, to,
    // type). These writes used to mint a fresh id and INSERT beside the
    // imported edge; flush() — the listener's write — threw
    // `duplicate key value violates unique constraint
    // "relationships_unique_directed_idx"`, which in production fails the
    // job into the dead letter queue after the tool has answered "Created".
    const SAM = { ...ALEX, key: 'google-contacts:contact:sam@example.com', name: 'Sam Lee', properties: {} };
    const KNOWS_EDGE = { fromKey: ALEX.key, toKey: SAM.key, type: 'KNOWS', properties: { source: 'google-contacts' } };

    /** Import Alex and Sam — with the KNOWS edge between them unless `withEdge` is false. */
    const importPair = async (withEdge = true) => {
      const result = await ingest.ingest(context, {
        entities: [ALEX, SAM],
        relationships: withEdge ? [KNOWS_EDGE] : [],
      });
      expect(result.errors).toEqual([]);
      const [alexId, samId] = [ALEX.key, SAM.key].map((key) => result.entities.find((e) => e.key === key)!.entityId);

      return { alexId, samId };
    };

    const knowsEdges = (alexId: string, samId: string) =>
      runner.query(
        `SELECT relationship_id, strength, is_bidirectional, properties
           FROM ci.relationships
          WHERE from_entity_id = $1 AND to_entity_id = $2 AND relationship_type = 'KNOWS' AND is_active`,
        [alexId, samId],
      ) as Promise<
        Array<{ relationship_id: string; strength: number; is_bidirectional: boolean; properties: object }>
      >;

    it('relationship.create lands on the imported edge, keeps its strength, and merges its properties', async () => {
      const { alexId, samId } = await importPair();
      const [{ relationship_id: edgeId }] = await knowsEdges(alexId, samId);
      await runner.query(`UPDATE ci.relationships SET strength = 0.4 WHERE relationship_id = $1`, [edgeId]);

      const written = await tool.execute(context, {
        operations: [
          {
            kind: 'relationship.create',
            fromEntityId: alexId,
            toEntityId: samId,
            // What a model writes; ci.relationships' CHECK only stores upper snake case.
            relationshipType: 'knows',
            properties: { context: 'dentist' },
          },
        ],
      });
      await flush();

      expect(written.data).toMatchObject({ updatedRelationships: 1, createdRelationships: 0, failures: 0 });
      expect(written.data?.results[0]).toMatchObject({ status: 'updated', relationshipId: edgeId });
      expect(await knowsEdges(alexId, samId)).toEqual([
        {
          relationship_id: edgeId,
          strength: 0.4,
          is_bidirectional: false,
          properties: { source: 'google-contacts', context: 'dentist' },
        },
      ]);
    });

    it("an entity.create's relationships land on the imported edge the same way", async () => {
      const { alexId, samId } = await importPair();
      const [{ relationship_id: edgeId }] = await knowsEdges(alexId, samId);
      await runner.query(`UPDATE ci.relationships SET strength = 0.4 WHERE relationship_id = $1`, [edgeId]);

      const written = await tool.execute(context, {
        operations: [
          {
            kind: 'entity.create',
            entityId: alexId,
            entityType: 'Person',
            relationships: [{ toEntityId: samId, relationshipType: 'KNOWS', properties: { context: 'dentist' } }],
          },
        ],
      });
      await flush();

      expect(written.data).toMatchObject({ updatedNodes: 1, updatedRelationships: 1, createdRelationships: 0 });
      expect(await knowsEdges(alexId, samId)).toEqual([
        {
          relationship_id: edgeId,
          strength: 0.4,
          is_bidirectional: false,
          properties: { source: 'google-contacts', context: 'dentist' },
        },
      ]);
    });

    it('an edge the import writes while the restatement is still queued is merged into, not duplicated', async () => {
      const { alexId, samId } = await importPair(false);

      const written = await tool.execute(context, {
        operations: [
          {
            kind: 'relationship.create',
            fromEntityId: alexId,
            toEntityId: samId,
            relationshipType: 'KNOWS',
            properties: { context: 'dentist' },
          },
        ],
      });
      // Nothing was on the coordinate when the tool looked.
      expect(written.data?.results[0].status).toBe('created');

      await importPair();
      const [{ relationship_id: importedId }] = await knowsEdges(alexId, samId);
      await flush();

      expect(await knowsEdges(alexId, samId)).toEqual([
        expect.objectContaining({
          relationship_id: importedId,
          properties: { source: 'google-contacts', context: 'dentist' },
        }),
      ]);
    });

    it('a relationship with nothing on its coordinate is inserted with the defaults', async () => {
      const { alexId, samId } = await importPair(false);

      const written = await tool.execute(context, {
        operations: [{ kind: 'relationship.create', fromEntityId: alexId, toEntityId: samId, relationshipType: 'KNOWS' }],
      });
      await flush();

      expect(written.data).toMatchObject({ createdRelationships: 1, updatedRelationships: 0, failures: 0 });
      expect(await knowsEdges(alexId, samId)).toEqual([
        {
          relationship_id: written.data?.results[0].relationshipId,
          strength: 1,
          is_bidirectional: false,
          properties: {},
        },
      ]);
    });
  });
});
