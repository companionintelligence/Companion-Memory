import { DataSource, type QueryRunner } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { RequestContext } from '@ci/common/context';
import { Events } from '@ci/domains/events';
import {
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
 * `memory.remember` against a name the user already has, plus a link to an
 * entity made in the same call, on real Postgres: the exact-name read
 * (`queryNodes` `nameEquals`) and an edge queued before its new node lands.
 * Stood in: the queue, held until `flush()` and handed to GraphUtilityService
 * the way GraphEventListener does, relationship first to show the order does
 * not matter. Each test runs in one transaction and rolls back. Skips with the
 * reason when nothing listens at `MEMORY_TEST_DATABASE_URL` / `DATABASE_URL`.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[WriteKnowledgeTool.sameName.integration] SKIPPED - ${availability.reason}`);
}

jest.setTimeout(60_000);

const logger = {
  setContext: () => undefined,
  debug: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describeWithDb(`WriteKnowledgeTool by name on real Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let owner: string;
  let queued: Array<{ event: string; body: string }>;
  let tool: WriteKnowledgeTool;
  let flush: () => Promise<void>;

  const insertEntity = async (entityType: string, name: string, createdAt: Date) => {
    const id = uuidv7();
    await runner.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, entityType, owner, name, createdAt],
    );

    return id;
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
      entities: [GraphNodeEntity, RelationshipEntity],
      synchronize: false,
    });
    await dataSource.initialize();

    // SHARED: these tests row-lock ci.entities / ci.users inside their
    // transaction. See domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'WriteKnowledgeTool.sameName');
  });

  afterAll(async () => {
    await schemaLock?.release();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    owner = await createSyntheticTestUser(
      (sql, params) => runner.query(sql, params),
      'WriteKnowledgeTool-sameName',
    );

    const graphUtility = new GraphUtilityService(
      runner.manager.getRepository(GraphNodeEntity),
      runner.manager.getRepository(RelationshipEntity),
      logger as never,
    );

    queued = [];
    const graphEvents = new GraphEventService(
      {
        send: async (event: string, body: unknown) => {
          queued.push({ event, body: JSON.stringify(body) });

          return ['job'];
        },
      } as never,
      logger as never,
    );
    // Relationships first: the two queues are worked concurrently, so an edge can land before its node.
    flush = async () => {
      const jobs = queued.splice(0).map(({ event, body }) => ({ event, wire: JSON.parse(body) }));
      for (const { wire } of jobs.filter((job) => job.event === Events.GRAPH_RELATIONSHIP_UPSERTED)) {
        await graphUtility.createOrUpdateRelationship(wire.ownerId, wire.relationship);
      }

      for (const { wire } of jobs.filter((job) => job.event === Events.GRAPH_NODE_UPSERTED)) {
        await graphUtility.createOrUpdateNode(wire.ownerId, wire.node);
      }
    };

    tool = new WriteKnowledgeTool(
      graphEvents,
      new GraphQueryService({} as never, graphUtility),
      logger as never,
      { getSelfIdentity: async () => null } as never,
    );
  });

  afterEach(async () => {
    await runner.rollbackTransaction();
    await runner.release();
  });

  it('lands on the one "Art" concept behind 30 newer concepts whose names only contain it', async () => {
    const art = await insertEntity('Concept', 'Art', new Date('2026-01-01T00:00:00Z'));
    for (let i = 0; i < 30; i += 1) {
      await insertEntity(
        'Concept',
        `Art class ${i}`,
        new Date(`2026-02-01T00:${String(i).padStart(2, '0')}:00Z`),
      );
    }

    const result = await tool.execute({ userId: owner } as RequestContext, {
      operations: [
        { kind: 'entity.create', entityType: 'Concept', name: ' art ', properties: { tried: 'watercolour' } },
      ],
    });
    await flush();

    expect(result.data?.results[0]).toMatchObject({ status: 'updated', entityId: art });
    const [{ count }] = await runner.query(
      `SELECT count(*)::int AS count FROM ci.entities WHERE owner_user_id = $1 AND lower(name) = 'art'`,
      [owner],
    );
    expect(count).toBe(1);
  });

  it('links an existing person to a concept created in the same call', async () => {
    const jordan = await insertEntity('Person', 'Jordan Lee', new Date('2026-01-01T00:00:00Z'));

    const result = await tool.execute({ userId: owner } as RequestContext, {
      operations: [
        { kind: 'entity.create', entityType: 'Concept', name: 'bebop' },
        {
          kind: 'relationship.create',
          relationshipType: 'LIKES',
          from: { name: 'Jordan Lee' },
          to: { name: 'bebop' },
        },
      ],
    });
    await flush();

    expect(result.data).toMatchObject({ createdNodes: 1, createdRelationships: 1, failures: 0 });
    const edges = await runner.query(
      `SELECT r.relationship_type, e.name AS to_name
         FROM ci.relationships r JOIN ci.entities e ON e.entity_id = r.to_entity_id
        WHERE r.owner_user_id = $1 AND r.from_entity_id = $2 AND r.is_active`,
      [owner, jordan],
    );
    expect(edges).toEqual([{ relationship_type: 'LIKES', to_name: 'bebop' }]);
  });
});
