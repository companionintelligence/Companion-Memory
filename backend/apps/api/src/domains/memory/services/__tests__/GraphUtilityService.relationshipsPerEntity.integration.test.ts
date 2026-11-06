import { DataSource, type QueryRunner } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { GraphNodeEntity } from '../../entities/GraphNodeEntity';
import { RelationshipEntity } from '../../entities/RelationshipEntity';
import { GraphUtilityService } from '../GraphUtilityService';

/**
 * `getRelationshipsPerEntity` against a real Postgres: each entity's newest
 * `limit` active edges in one read, keyed by entity — the window function and
 * the hydration that the `outgoingRelationships` / `incomingRelationships`
 * loader stands on. Every test runs in one transaction and rolls back.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[GraphUtilityService.relationshipsPerEntity.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const logger = { setContext: () => undefined };

describeWithDb(`GraphUtilityService.getRelationshipsPerEntity (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let service: GraphUtilityService;
  let owner: string;
  let stranger: string;
  let alex: string;
  let sam: string;
  let kim: string;

  const newUser = (prefix: string) =>
    createSyntheticTestUser((sql: string, params?: unknown[]) => runner.query(sql, params), prefix);

  const newPerson = async (ownerId: string, name: string) => {
    const entityId = uuidv7();
    await runner.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, 'Person', $2, '{}'::jsonb, $3)`,
      [entityId, name, ownerId],
    );

    return entityId;
  };

  /** An edge stamped at `at`, so the "newest first" order is under the test's control. */
  const edge = async (
    from: string,
    to: string,
    at: string,
    fields: { owner?: string; active?: boolean; type?: string } = {},
  ) => {
    const id = uuidv7();
    await runner.query(
      `INSERT INTO ci.relationships
         (relationship_id, owner_user_id, from_entity_id, to_entity_id, relationship_type,
          strength, is_bidirectional, properties, from_entity_type, to_entity_type, is_active, created_at)
       VALUES ($1, $2, $3, $4, $5, 0.5, false, '{}'::jsonb, 'Person', 'Person', $6, $7::timestamptz)`,
      [id, fields.owner ?? owner, from, to, fields.type ?? 'KNOWS', fields.active ?? true, at],
    );

    return id;
  };

  const idsOf = (rows: RelationshipEntity[] | undefined) => rows?.map((row) => row.relationship_id);

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(ENV),
      entities: [GraphNodeEntity, RelationshipEntity],
      synchronize: false,
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'GraphUtilityService.relationshipsPerEntity');
  });

  afterAll(async () => {
    await schemaLock?.release();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    owner = await newUser('GraphUtility-perEntity');
    stranger = await newUser('GraphUtility-perEntity-stranger');
    alex = await newPerson(owner, 'Alex Rivera');
    sam = await newPerson(owner, 'Sam Lee');
    kim = await newPerson(owner, 'Kim Park');
    service = new GraphUtilityService(
      runner.manager.getRepository(GraphNodeEntity),
      runner.manager.getRepository(RelationshipEntity),
      logger as never,
    );
  });

  afterEach(async () => {
    await runner.rollbackTransaction();
    await runner.release();
  });

  it("keeps each entity's newest `limit` active edges, keyed by entity, and no others", async () => {
    const alexOldest = await edge(alex, sam, '2026-01-01T00:00:00Z');
    const alexMiddle = await edge(alex, kim, '2026-01-02T00:00:00Z');
    // Its own type: one ACTIVE edge per (from, to, type) is what relationships_unique_directed_idx allows.
    const alexNewest = await edge(alex, sam, '2026-01-03T00:00:00Z', { type: 'WORKS_WITH' });
    await edge(alex, kim, '2026-01-04T00:00:00Z', { active: false });
    const samOnly = await edge(sam, alex, '2026-01-05T00:00:00Z');
    await edge(kim, alex, '2026-01-06T00:00:00Z'); // kim was not asked for

    const outbound = await service.getRelationshipsPerEntity(owner, {
      entityIds: [alex, sam],
      direction: 'outbound',
      limit: 2,
    });

    expect(idsOf(outbound.get(alex))).toEqual([alexNewest, alexMiddle]);
    expect(idsOf(outbound.get(sam))).toEqual([samOnly]);
    expect(outbound.has(kim)).toBe(false);
    expect(alexOldest).toBeDefined();
  });

  it('reads the other direction with the same shape', async () => {
    const toSam = await edge(alex, sam, '2026-01-01T00:00:00Z');
    const toKim = await edge(alex, kim, '2026-01-02T00:00:00Z');
    await edge(sam, alex, '2026-01-03T00:00:00Z');

    const inbound = await service.getRelationshipsPerEntity(owner, {
      entityIds: [sam, kim],
      direction: 'inbound',
      limit: 5,
    });

    expect(idsOf(inbound.get(sam))).toEqual([toSam]);
    expect(idsOf(inbound.get(kim))).toEqual([toKim]);
  });

  it("never reads another owner's edges, and reads nothing for no entities or no limit", async () => {
    await edge(alex, sam, '2026-01-01T00:00:00Z', { owner: stranger });

    const ours = await service.getRelationshipsPerEntity(owner, {
      entityIds: [alex],
      direction: 'outbound',
      limit: 5,
    });
    expect(ours.size).toBe(0);

    expect(
      (await service.getRelationshipsPerEntity(owner, { entityIds: [], direction: 'outbound', limit: 5 }))
        .size,
    ).toBe(0);
    expect(
      (await service.getRelationshipsPerEntity(owner, { entityIds: [alex], direction: 'outbound', limit: 0 }))
        .size,
    ).toBe(0);
  });
});
