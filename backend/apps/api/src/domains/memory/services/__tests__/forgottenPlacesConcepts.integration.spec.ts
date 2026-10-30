import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { ConceptEntity } from '../../entities/ConceptEntity';
import { PlaceEntity } from '../../entities/PlaceEntity';
import { ConceptService } from '../ConceptService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';
import { PlaceService } from '../PlaceService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PLACE OR CONCEPT THE USER ASKED MEMORY TO FORGET STAYS OUT. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `memory.forget` in archive mode sets `ci.entities.is_active` false and
 * un-indexes the row. The explorer's Places and Concepts browse (no search
 * text), its total and the `concepts` list read `ci.entities` directly, so they
 * listed a forgotten place or concept anyway. They now leave it out, as people
 * always were (`PersonService.getEntitiesForPeople`). The rows still load by id
 * (`findById` / `findByIds`), which is what the search listeners read
 * `isActive` from.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database, or run `make test-db ARGS=forgottenPlacesConcepts`. Every fixture
 * belongs to a synthetic user and is deleted in `afterAll`.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/forgottenPlacesConcepts.integration] SKIPPED — ${availability.reason}`);
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

const signalling = { send: jest.fn(async () => []) } as unknown as EventService;

describeWithDb(`forgotten places and concepts against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let ctx: UserServiceContext;
  let places: PlaceService;
  let concepts: ConceptService;

  const ids = {
    keptPlace: uuidv7(),
    forgottenPlace: uuidv7(),
    keptConcept: uuidv7(),
    forgottenConcept: uuidv7(),
  };

  const query = (sql: string, params?: unknown[]): Promise<unknown> => dataSource.query(sql, params);

  async function seed(id: string, entityType: string, name: string, isActive: boolean): Promise<void> {
    await query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, is_active)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, $5)`,
      [id, entityType, name, ctx.userId, isActive],
    );
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [BaseEntity, ConceptEntity, PlaceEntity, UserEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/forgottenPlacesConcepts.integration');

    ctx = { userId: await createSyntheticTestUser(query, 'ForgottenPlacesConcepts') } as UserServiceContext;

    places = new PlaceService(
      dataSource.getRepository(PlaceEntity),
      signalling,
      new GraphDeltaWriter(dataSource, logger()),
    );
    concepts = new ConceptService(dataSource.getRepository(ConceptEntity), logger(), signalling);

    await seed(ids.keptPlace, 'Location', 'Blue Bottle', true);
    await seed(ids.forgottenPlace, 'Location', 'Ravenwood Cottage', false);
    await seed(ids.keptConcept, 'Concept', 'Photography', true);
    await seed(ids.forgottenConcept, 'Concept', 'Quillfeather Project', false);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      if (ctx != null) {
        await query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [ctx.userId]);
        await query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ctx.userId]);
        await query('DELETE FROM ci.users WHERE id = $1', [ctx.userId]);
      }

      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('leaves a forgotten place out of the Places browse and its total', async () => {
    const listed = await places.getEntitiesForPlaces(ctx, { limit: 50 });

    expect(listed.map((identifier) => identifier.id)).toEqual([ids.keptPlace]);
    expect(await places.countEntitiesForPlaces(ctx, {})).toBe(1);
  });

  it('leaves a forgotten concept out of the Concepts browse, its total and the concept list', async () => {
    const listed = await concepts.getEntitiesForConcepts(ctx, { limit: 50 });

    expect(listed.map((identifier) => identifier.id)).toEqual([ids.keptConcept]);
    expect(await concepts.countEntitiesForConcepts(ctx, {})).toBe(1);
    expect((await concepts.findAll(ctx)).map((concept) => concept.id)).toEqual([ids.keptConcept]);
  });

  it('still loads both by id, carrying the flag search reads', async () => {
    const [place] = await places.findByIds(ctx, [ids.forgottenPlace]);
    const concept = await concepts.findById(ctx, ids.forgottenConcept);

    expect(place).toEqual(expect.objectContaining({ id: ids.forgottenPlace, isActive: false }));
    expect(concept).toEqual(expect.objectContaining({ id: ids.forgottenConcept, isActive: false }));
    expect((await places.findById(ctx, ids.keptPlace))?.isActive).toBe(true);
  });
});
