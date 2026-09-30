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
 * ═══════════════════════════════════════════════════════════════════════════
 * `write_knowledge` NAMING ANOTHER OWNER'S ENTITY — REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `entity.create` with an `entityId` looks for the row through an
 * owner-scoped read, so an id held by another owner's row reads as "no row"
 * and the write is queued anyway. GraphUtilityService.createOrUpdateNode used
 * to apply it with TypeORM's save(), which resolves a row by primary key
 * alone, so the queued write became an UPDATE of the other owner's row: its
 * owner, name and bag all replaced by the caller's.
 *
 * Real here: the tool, GraphQueryService's read, GraphUtilityService's write
 * and the schema. Stood in: the queue, as a JSON round-trip held until
 * `flush()`, handing each payload to createOrUpdateNode the way
 * GraphEventListener does. The listener itself runs against this write in
 * GraphUtilityService.createOrUpdateNode.integration.test.ts, along with the
 * control showing the takeover.
 *
 * Every test runs inside one transaction on one connection and rolls back.
 * Opt-in like the other DB-backed suites: skips with the reason when nothing
 * listens at `MEMORY_TEST_DATABASE_URL` / `DATABASE_URL`.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[WriteKnowledgeTool.foreignEntityId.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const logger = {
  setContext: () => undefined,
  debug: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describeWithDb(`WriteKnowledgeTool on another owner's entity id (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let alice: string;
  let bobsContact: string;
  let queued: Array<{ event: string; body: string }>;
  let tool: WriteKnowledgeTool;
  let flush: () => Promise<void>;

  /** The whole row, plus its physical address: any UPDATE — even of identical values — moves `ctid`. */
  const stored = async (entityId: string) => {
    const [row] = await runner.query(
      `SELECT ctid::text AS ctid, owner_user_id, entity_type, name, description, search_content,
              linked_table, linked_id, properties, is_active
         FROM ci.entities
        WHERE entity_id = $1`,
      [entityId],
    );

    return row as Record<string, unknown>;
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
    schemaLock = await acquireSchemaWriteLock(dataSource, 'WriteKnowledgeTool.foreignEntityId');
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
    alice = await createSyntheticTestUser(query, 'WriteKnowledgeTool-foreignEntityId-alice');
    const bob = await createSyntheticTestUser(query, 'WriteKnowledgeTool-foreignEntityId-bob');

    bobsContact = uuidv7();
    await runner.query(
      `INSERT INTO ci.entities
         (entity_id, entity_type, owner_user_id, name, linked_table, linked_id, properties)
       VALUES ($1, 'Person', $2, 'Jo Park', 'import:google-contacts', $3, $4::jsonb)`,
      [bobsContact, bob, uuidv7(), JSON.stringify({ emails: ['jo@example.com'] })],
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
    flush = async () => {
      for (const { event, body } of queued.splice(0)) {
        const wire = JSON.parse(body);
        if (event === Events.GRAPH_NODE_UPSERTED) {
          await graphUtility.createOrUpdateNode(wire.ownerId, wire.node);
        }
      }
    };

    tool = new WriteKnowledgeTool(
      graphEvents,
      new GraphQueryService({} as never, graphUtility),
      logger as never,
    );
  });

  afterEach(async () => {
    await runner.rollbackTransaction();
    await runner.release();
  });

  it('queues an entity.create under that id, and the queued write refuses the row instead of taking it over', async () => {
    const before = await stored(bobsContact);

    await tool.execute({ userId: alice } as RequestContext, {
      operations: [
        { kind: 'entity.create', entityId: bobsContact, entityType: 'Person', name: 'Written by Alice' },
      ],
    });

    // The tool's own check cannot see Bob's row, so the write goes on the
    // queue; the refusal has to come from the write itself.
    expect(queued.map(({ event }) => event)).toEqual([Events.GRAPH_NODE_UPSERTED]);

    await expect(flush()).rejects.toThrow(`is not owned by ${alice}`);
    expect(await stored(bobsContact)).toEqual(before);
  });
});
