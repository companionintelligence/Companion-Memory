import { DataSource, type QueryRunner } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { EmbeddingGenerationService } from '@ci/common/embeddings';
import type { LoggerService } from '@ci/common/logging';

import { createSyntheticTestUser } from '../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../__tests__/support/databaseConnection';

import { GraphExpansionService } from './GraphExpansionService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A FORGOTTEN NODE IS NOT A RECALL NEIGHBOUR. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Recall finds its seeds in the search index and then walks one hop to bring
 * back the neighbours that bear on the question, writing each one's NAME and
 * DESCRIPTION into the model's context. The walk reads `ci.relationships`, and
 * an edge is active until somebody deactivates it. Forgetting a node
 * deactivates the edges it points away from, not the ones that point at it, and
 * deleting or forgetting an event leaves all of its edges active on purpose, so
 * Undo can put it back exactly as it was. Either way an active edge ends at a
 * node the user asked the appliance to forget, so the neighbour's own
 * `is_active` is what has to say whether it still exists.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database of your OWN, or run `make test-db`, which provides one. The whole
 * suite runs in one transaction that is rolled back in `afterAll`.
 */
const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[graph/GraphExpansionService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

describeWithDb(`GraphExpansionService against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  let service: GraphExpansionService;
  let owner: UserServiceContext;

  const ids = new Map<string, string>();

  function id(label: string): string {
    const found = ids.get(label);

    if (found == null) {
      throw new Error(`no node seeded as "${label}"`);
    }

    return found;
  }

  async function node(
    label: string,
    entityType: string,
    isActive = true,
    description: string | null = null,
  ): Promise<void> {
    const nodeId = uuidv7();

    await runner.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, description, properties, owner_user_id, is_active)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6)`,
      [nodeId, entityType, label, description, owner.userId, isActive],
    );
    ids.set(label, nodeId);
  }

  async function edge(from: string, to: string, type: string): Promise<void> {
    await runner.query(
      `INSERT INTO ci.relationships (from_entity_id, to_entity_id, relationship_type, owner_user_id)
       VALUES ($1, $2, $3, $4)`,
      [id(from), id(to), type, owner.userId],
    );
  }

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
      synchronize: false,
      logging: false,
      extra: { max: 2 },
    });
    await dataSource.initialize();

    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    owner = {
      userId: await createSyntheticTestUser((sql, params) => runner.query(sql, params), 'GraphExpansion'),
    } as UserServiceContext;

    // The service only ever calls `query` on its DataSource. Pointed at the
    // transaction, everything it reads is what this suite wrote.
    const inTransaction = {
      query: (sql: string, params?: unknown[]) => runner.query(sql, params),
    } as unknown as DataSource;

    // One vector for every text, so every relationship type scores a perfect
    // cosine against the query and nothing is pruned for relevance: what is
    // left out below is left out for being forgotten, and for nothing else.
    const embeddings = {
      generateEmbedding: jest.fn(async () => [1, 0, 0]),
    } as unknown as EmbeddingGenerationService;
    const logger = {
      setContext: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as LoggerService;

    service = new GraphExpansionService(inTransaction, embeddings, logger);

    await node('Dana', 'Person');
    await node('Bo', 'Person', true, 'Dana’s neighbour');
    await node('Lunch with Bo', 'Event', true, 'A live event');
    // Forgotten: the user asked the appliance to forget them.
    await node('Alex', 'Person', false, 'Somebody the user asked to forget');
    await node('Dinner at Dana’s', 'Event', false, 'An event the user asked to forget');

    await edge('Dana', 'Bo', 'KNOWS');
    await edge('Dana', 'Lunch with Bo', 'PARTICIPATED_IN');
    // Outbound to a forgotten event, and INBOUND from a forgotten person: the
    // service reads both directions.
    await edge('Dana', 'Dinner at Dana’s', 'PARTICIPATED_IN');
    await edge('Alex', 'Dana', 'KNOWS');
  });

  afterAll(async () => {
    if (runner != null) {
      await runner.rollbackTransaction();
      await runner.release();
    }

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('brings back the live neighbours and leaves out the ones the user asked to forget', async () => {
    const neighbours = await service.expand(
      owner,
      [id('Dana')],
      'who is Dana connected to',
      new Set([id('Dana')]),
    );

    expect(neighbours.map((neighbour) => neighbour.entityId).sort()).toEqual(
      [id('Bo'), id('Lunch with Bo')].sort(),
    );

    // Nothing of a forgotten node reaches the model's context: not its name,
    // not its description.
    const context = neighbours.map((neighbour) => neighbour.line).join('\n');

    expect(context).toContain('Lunch with Bo');
    expect(context).not.toMatch(/Alex|Dinner at Dana|asked to forget/);
  });
});
