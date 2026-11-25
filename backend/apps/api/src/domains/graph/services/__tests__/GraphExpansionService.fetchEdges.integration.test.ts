import { DataSource, type QueryRunner } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { GraphExpansionService } from '../GraphExpansionService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GRAPH EXPANSION READS ONLY THE OWNER'S ENTITIES — REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fetchEdges` filtered on the relationship's owner alone. An edge the owner
 * holds onto another user's entity (`ci.relationships` has no foreign key to
 * `ci.entities`, and `memory.remember` once wrote one from an `entity.create`
 * naming another user's `entityId`) read that entity's name and description
 * into the owner's recall. Both ends must be the owner's too.
 *
 * Every test runs in one transaction on one connection and rolls back. Skips
 * with the reason when nothing listens at `MEMORY_TEST_DATABASE_URL` /
 * `DATABASE_URL`, like the sibling suites.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[GraphExpansionService.fetchEdges.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

interface EdgeRow {
  neighbour_id: string;
  neighbour_name: string;
}

describeWithDb(`GraphExpansionService.fetchEdges (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;

  const newUser = (prefix: string) =>
    createSyntheticTestUser((sql: string, params?: unknown[]) => runner.query(sql, params), prefix);

  const newPerson = async (ownerId: string, name: string, description: string) => {
    const entityId = uuidv7();
    await runner.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, description, properties, owner_user_id)
       VALUES ($1, 'Person', $2, $3, '{}'::jsonb, $4)`,
      [entityId, name, description, ownerId],
    );

    return entityId;
  };

  const newEdge = (ownerId: string, from: string, to: string) =>
    runner.query(
      `INSERT INTO ci.relationships
         (relationship_id, owner_user_id, from_entity_id, to_entity_id, relationship_type,
          strength, is_bidirectional, properties, from_entity_type, to_entity_type)
       VALUES ($1, $2, $3, $4, 'KNOWS', 0.5, false, '{}'::jsonb, 'Person', 'Person')`,
      [uuidv7(), ownerId, from, to],
    );

  /** The service over this test's transaction; `fetchEdges` is what is under test, so it is called directly. */
  const fetchEdges = (userId: string, seedIds: string[]): Promise<EdgeRow[]> => {
    const service = new GraphExpansionService(
      runner.manager as never,
      {} as never,
      { setContext: () => undefined, warn: () => undefined } as never,
    );

    return (service as unknown as { fetchEdges: (u: string, s: string[]) => Promise<EdgeRow[]> }).fetchEdges(
      userId,
      seedIds,
    );
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
      synchronize: false,
    });
    await dataSource.initialize();

    // SHARED: these tests row-lock ci.entities / ci.users inside their transaction.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'GraphExpansionService.fetchEdges');
  });

  afterAll(async () => {
    await schemaLock?.release();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
  });

  afterEach(async () => {
    await runner.rollbackTransaction();
    await runner.release();
  });

  it("returns the owner's neighbours and leaves out an edge onto another owner's entity", async () => {
    const owner = await newUser('GraphExpansion-fetchEdges');
    const stranger = await newUser('GraphExpansion-fetchEdges-stranger');
    const alex = await newPerson(owner, 'Alex Rivera', 'friend');
    const sam = await newPerson(owner, 'Sam Lee', 'colleague');
    const secret = await newPerson(stranger, 'Stranger Person', "the stranger's private note");
    await newEdge(owner, alex, sam);
    await newEdge(owner, alex, secret);
    await newEdge(owner, secret, alex);

    const rows = await fetchEdges(owner, [alex]);

    expect(rows.map((row) => row.neighbour_name)).toEqual(['Sam Lee']);
  });

  it("returns nothing for a seed that is another owner's entity", async () => {
    const owner = await newUser('GraphExpansion-fetchEdges-seed');
    const stranger = await newUser('GraphExpansion-fetchEdges-seed-stranger');
    const alex = await newPerson(owner, 'Alex Rivera', 'friend');
    const secret = await newPerson(stranger, 'Stranger Person', "the stranger's private note");
    await newEdge(owner, secret, alex);

    expect(await fetchEdges(owner, [secret])).toEqual([]);
  });
});
