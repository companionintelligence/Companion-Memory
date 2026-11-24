import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { BaseEntity, PersonEntity } from '@ci/domains/memory';

import { createSyntheticTestUser } from '../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../__tests__/support/schemaLock';
import { RelationshipEntity } from '../entities/RelationshipEntity';

import { RelationshipService } from './RelationshipService';

/**
 * `RelationshipService.createMany` against a real Postgres: the one multi-row
 * `INSERT ... ON CONFLICT DO NOTHING` the ETL participant path writes a page
 * of owner↔contact edges with. What a mock cannot show is the conflict
 * behaviour itself — that `relationships_unique_directed_idx` (a PARTIAL
 * unique index, `WHERE is_active = TRUE`) absorbs a duplicate of an existing
 * edge silently, that a duplicate within one batch is collapsed before the
 * statement so the arbiter row is never touched twice, and that the
 * `RECEIVED_EMAIL_FROM` write-time alias lands as the swapped `EMAILED` edge
 * the single-row create() would have written.
 *
 * Opt-in like its neighbours: `make test-db` provides the database.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[graph/RelationshipService.createMany.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const logger = () =>
  ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

describeWithDb(`RelationshipService.createMany against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: RelationshipService;
  let owner: string;
  let selfId: string;
  let aliceId: string;
  let bobId: string;

  const context = () => ({ userId: owner }) as UserServiceContext;
  const edge = (toNodeId: string, type: 'EMAILED' | 'RECEIVED_EMAIL_FROM') => ({
    fromNodeId: selfId,
    fromNodeType: 'person',
    toNodeId,
    toNodeType: 'person',
    type,
    properties: { source: 'email' },
  });

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [BaseEntity, PersonEntity, RelationshipEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'graph/RelationshipService.createMany');

    owner = await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'RelCreateMany');

    const repo = dataSource.getRepository(PersonEntity);
    const person = async (name: string) =>
      (await repo.save(repo.create({ id: uuidv7(), name, userId: owner, properties: {} }))).id;

    selfId = await person('Owner');
    aliceId = await person('Alice');
    bobId = await person('Bob');

    // createMany never looks an endpoint up, so every finder can be a stub.
    const stub = {} as never;
    service = new RelationshipService(
      dataSource.getRepository(RelationshipEntity),
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      logger(),
    );
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = $1', [owner]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [owner]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [owner]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  const stored = () =>
    dataSource.query<Array<{ from_entity_id: string; to_entity_id: string; relationship_type: string }>>(
      `SELECT from_entity_id, to_entity_id, relationship_type
         FROM ci.relationships WHERE owner_user_id = $1
        ORDER BY relationship_id`,
      [owner],
    );

  it('writes a page of edges in one statement, collapsing duplicates within the batch', async () => {
    const inserted = await service.createMany(context(), [
      edge(aliceId, 'EMAILED'),
      edge(bobId, 'EMAILED'),
      // The same edge again, as a second message to Alice on the page produces.
      edge(aliceId, 'EMAILED'),
      // The write-time alias: stored as Alice EMAILED the owner.
      edge(aliceId, 'RECEIVED_EMAIL_FROM'),
    ]);

    expect(inserted).toHaveLength(3);
    expect(await stored()).toEqual([
      { from_entity_id: selfId, to_entity_id: aliceId, relationship_type: 'EMAILED' },
      { from_entity_id: selfId, to_entity_id: bobId, relationship_type: 'EMAILED' },
      { from_entity_id: aliceId, to_entity_id: selfId, relationship_type: 'EMAILED' },
    ]);
  });

  it('skips edges that already exist and reports only what it inserted', async () => {
    await service.createMany(context(), [edge(aliceId, 'EMAILED')]);

    const inserted = await service.createMany(context(), [edge(aliceId, 'EMAILED'), edge(bobId, 'EMAILED')]);

    expect(inserted.map((relationship) => relationship.toNodeId)).toEqual([bobId]);
    expect(await stored()).toHaveLength(2);
  });

  it('does nothing for an empty page', async () => {
    expect(await service.createMany(context(), [])).toEqual([]);
    expect(await stored()).toHaveLength(0);
  });
});
