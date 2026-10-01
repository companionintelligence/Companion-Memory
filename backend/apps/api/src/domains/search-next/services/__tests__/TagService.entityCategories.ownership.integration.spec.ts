import { randomUUID } from 'node:crypto';

import { DataSource, type EntityManager, type QueryRunner } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { EntityCategoryEntity } from '../../entities/EntityCategoryEntity';
import { EntityTagEntity } from '../../entities/EntityTagEntity';
import { TagEntity } from '../../entities/TagEntity';
import { TAGGABLE_ENTITIES, type TaggableEntity } from '../../types';
import { TagService } from '../TagService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * setEntityCategories WRITES ONLY THE CALLER'S OWN ENTITY, AGAINST A REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ci_search.entity_categories` keys on `(entity_type, entity_id)` with no FK
 * to the entity: fifteen taggable types live in thirteen tables. The only way
 * to tie a row to an owner is a lookup in the entity's own table. Before that
 * lookup existed, `setEntityCategories` deleted every assignment on whatever
 * entity id the caller named, then attached the caller's categories to it.
 * Any signed-in user, or MCP client (the mutation is an auto-wrapped tool),
 * could wipe another user's categories.
 *
 * Why Postgres and not a mock: every row of the per-type owner map
 * (`taggableEntityOwnership.ts`) has to name a real table and the real owner
 * column. Get one wrong and it is either a SQL error or a refusal of the
 * owner, and the per-type cases below catch both. The fixtures here are
 * written as SQL from the schema, NOT generated from that map, so a mistake in
 * the map is not copied into the test. They also leave `owner_user_id` NULL on
 * the three tables that carry one beside `user_id`, so a map that picked the
 * wrong column refuses the owner and fails.
 *
 * Each test runs inside ONE transaction that is always rolled back. The service
 * is bound to that transaction's manager, and its own `transaction()` nests as
 * a savepoint. Nothing a test seeds outlives it or is visible to other
 * sessions on the database.
 *
 * Opt-in: set `SEARCH_NEXT_TEST_DATABASE_URL` (or `DATABASE_URL`). The suite
 * SKIPS legibly when nothing is reachable.
 *
 *   SEARCH_NEXT_TEST_DATABASE_URL=postgres://companion:pw@127.0.0.1:<port>/companion \
 *     yarn workspace @ci/be-api jest TagService.entityCategories.ownership
 */

const TAG_DATABASE_ENV = {
  urlEnvVar: 'SEARCH_NEXT_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'SEARCH_NEXT_TEST_PROBE_TIMEOUT_MS',
};

const availability = databaseAvailability(TAG_DATABASE_ENV);
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(
    `[search-next/TagService.entityCategories.ownership.integration] SKIPPED — ${availability.reason}`,
  );
}

jest.setTimeout(60_000);

type Seed = (runner: QueryRunner, id: string, ownerId: string) => Promise<unknown>;

const graphNode =
  (entityType: string): Seed =>
  (runner, id, ownerId) =>
    runner.query(`INSERT INTO ci.entities (entity_id, entity_type, owner_user_id) VALUES ($1, $2, $3)`, [
      id,
      entityType,
      ownerId,
    ]);

/**
 * The class-table-inheritance types: a `ci.entities` base row plus a detail
 * row sharing its uuid. Kept apart so the split-owner case can give the two
 * halves different owners.
 */
const CTI_TYPES = ['communication', 'content', 'event', 'item'] as const;

type CtiType = (typeof CTI_TYPES)[number];

const CTI: Record<CtiType, { baseType: string; detail: Seed }> = {
  communication: {
    baseType: 'Communication',
    detail: (runner, id, ownerId) =>
      runner.query(
        `INSERT INTO ci.communications (id, user_id, time, communication_type, direction, content)
         VALUES ($1, $2, now(), 'email', 'inbound', 'fixture')`,
        [id, ownerId],
      ),
  },
  content: {
    baseType: 'Content',
    detail: (runner, id, ownerId) =>
      runner.query(`INSERT INTO ci.content (id, user_id) VALUES ($1, $2)`, [id, ownerId]),
  },
  event: {
    baseType: 'Event',
    detail: (runner, id, ownerId) =>
      runner.query(`INSERT INTO ci.events (event_id, user_id, start_time) VALUES ($1, $2, now())`, [
        id,
        ownerId,
      ]),
  },
  item: {
    baseType: 'Item',
    detail: (runner, id, ownerId) =>
      runner.query(`INSERT INTO ci.objects (object_id, user_id) VALUES ($1, $2)`, [id, ownerId]),
  },
};

const cti =
  (type: CtiType): Seed =>
  async (runner, id, ownerId) => {
    await graphNode(CTI[type].baseType)(runner, id, ownerId);
    await CTI[type].detail(runner, id, ownerId);
  };

/** One owned row (or CTI pair) per taggable type, in the smallest shape the schema accepts. */
const SEED: Record<TaggableEntity, Seed> = {
  action: (runner, id, ownerId) =>
    runner.query(`INSERT INTO ci.actions (id, user_id) VALUES ($1, $2)`, [id, ownerId]),
  'browser-activity': (runner, id, ownerId) =>
    runner.query(
      `INSERT INTO ci.browser_activity (id, user_id, time, url) VALUES ($1, $2, now(), 'https://example.test/')`,
      [id, ownerId],
    ),
  communication: cti('communication'),
  concept: graphNode('Concept'),
  content: cti('content'),
  event: cti('event'),
  file: (runner, id, ownerId) =>
    runner.query(`INSERT INTO ci.files (id, user_id, content_type) VALUES ($1, $2, 'text/plain')`, [
      id,
      ownerId,
    ]),
  item: cti('item'),
  note: (runner, id, ownerId) =>
    runner.query(`INSERT INTO ci.notes (id, user_id) VALUES ($1, $2)`, [id, ownerId]),
  person: graphNode('Person'),
  place: graphNode('Location'),
  product: (runner, id, ownerId) =>
    runner.query(`INSERT INTO ci.product_models (product_id, user_id, title) VALUES ($1, $2, 'fixture')`, [
      id,
      ownerId,
    ]),
  receipt: (runner, id, ownerId) =>
    runner.query(`INSERT INTO ci.receipts (receipt_id, user_id) VALUES ($1, $2)`, [id, ownerId]),
  task: (runner, id, ownerId) =>
    runner.query(`INSERT INTO ci.tasks (id, user_id, title) VALUES ($1, $2, 'fixture')`, [id, ownerId]),
  thread: (runner, id, ownerId) =>
    runner.query(`INSERT INTO ci.threads (thread_id, user_id) VALUES ($1, $2)`, [id, ownerId]),
};

/**
 * The transaction body `setEntityCategories` ran before the fix, verbatim,
 * given the caller's already-resolved category ids: drop EVERY row on the
 * entity, then insert the caller's. The control runs this so it exercises the
 * exact statements that shipped.
 */
async function preFixTransactionBody(
  manager: EntityManager,
  type: TaggableEntity,
  id: string,
  orderedCategoryIds: string[],
): Promise<void> {
  await manager.getRepository(EntityCategoryEntity).delete({ entityType: type, entityId: id });

  for (const [position, categoryTagId] of orderedCategoryIds.entries()) {
    await manager
      .getRepository(EntityCategoryEntity)
      .createQueryBuilder()
      .insert()
      .values({ entityType: type, entityId: id, categoryTagId, position })
      .orIgnore()
      .execute();
  }
}

interface World {
  runner: QueryRunner;
  service: TagService;
  user: () => Promise<string>;
  category: (userId: string, label: string) => Promise<string>;
  entity: (type: TaggableEntity, ownerId: string) => Promise<string>;
  /** Plants an assignment directly, bypassing the service. */
  assign: (type: TaggableEntity, id: string, categoryTagId: string, position: number) => Promise<void>;
  rowsOn: (type: TaggableEntity, id: string) => Promise<Array<{ category_tag_id: string; position: number }>>;
}

const as = (userId: string) => ({ userId }) as UserServiceContext;

describeWithDatabase(`TagService.setEntityCategories ownership (${availability.target})`, () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    const connection = resolveConnection(TAG_DATABASE_ENV);

    if (connection == null) {
      throw new Error('databaseAvailability passed but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      entities: [TagEntity, EntityTagEntity, EntityCategoryEntity],
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
    });

    await dataSource.initialize();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  async function inRolledBackTransaction(test: (world: World) => Promise<void>): Promise<void> {
    const runner = dataSource.createQueryRunner();

    await runner.connect();
    await runner.startTransaction();

    try {
      // The CTI detail tables reach ci.entities through DEFERRABLE INITIALLY
      // DEFERRED foreign keys, and a transaction that never commits never
      // checks those. Checking per statement keeps every fixture one that the
      // real schema would accept.
      await runner.query('SET CONSTRAINTS ALL IMMEDIATE');

      const service = new TagService(
        runner.manager.getRepository(TagEntity),
        // TagService uses only transaction()/getRepository()/query() on it, which the
        // runner's manager has. Its transaction() nests as a SAVEPOINT in this one.
        runner.manager as unknown as DataSource,
      );

      await test({
        runner,
        service,
        user: async () => {
          const id = randomUUID();

          await runner.query(`INSERT INTO ci.users (id, email, name) VALUES ($1, $2, $3)`, [
            id,
            `entity-categories.${id}@example.test`,
            'entity-categories ownership fixture',
          ]);

          return id;
        },
        category: async (userId, label) => {
          const id = randomUUID();

          await runner.query(
            `INSERT INTO ci_search.tags (id, label, user_id, kind) VALUES ($1, $2, $3, 'category')`,
            [id, label, userId],
          );

          return id;
        },
        entity: async (type, ownerId) => {
          const id = randomUUID();

          await SEED[type](runner, id, ownerId);

          return id;
        },
        assign: async (type, id, categoryTagId, position) => {
          await runner.query(
            `INSERT INTO ci_search.entity_categories (entity_type, entity_id, category_tag_id, position)
             VALUES ($1, $2, $3, $4)`,
            [type, id, categoryTagId, position],
          );
        },
        rowsOn: (type, id) =>
          runner.query(
            `SELECT category_tag_id, position FROM ci_search.entity_categories
              WHERE entity_type = $1 AND entity_id = $2
              ORDER BY position, category_tag_id`,
            [type, id],
          ),
      });
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  }

  it("CONTROL: the pre-fix statements delete another user's assignments and attach the caller's own", () =>
    inRolledBackTransaction(async ({ runner, user, category, entity, assign, rowsOn }) => {
      const victim = await user();
      const attacker = await user();
      const theirs = await category(victim, 'health');
      const mine = await category(attacker, 'career');
      const taskId = await entity('task', victim);

      await assign('task', taskId, theirs, 0);

      await preFixTransactionBody(runner.manager, 'task', taskId, [mine]);

      // The victim's assignment is gone and the attacker's category now sits on
      // the victim's task. This is the hazard the refusals below must prevent.
      expect(await rowsOn('task', taskId)).toEqual([{ category_tag_id: mine, position: 0 }]);
    }));

  describe("another user's entity is refused, and their categories are untouched", () => {
    it.each(TAGGABLE_ENTITIES)('%s', (type) =>
      inRolledBackTransaction(async ({ service, user, category, entity, assign, rowsOn }) => {
        const victim = await user();
        const attacker = await user();
        const theirs = await category(victim, 'health');
        const mine = await category(attacker, 'career');
        const id = await entity(type, victim);

        await assign(type, id, theirs, 0);

        // Replacing with the attacker's own category, and clearing, are both refused.
        expect(await service.setEntityCategories(as(attacker), { type, id }, [mine])).toBeNull();
        expect(await service.setEntityCategories(as(attacker), { type, id }, [])).toBeNull();

        expect(await rowsOn(type, id)).toEqual([{ category_tag_id: theirs, position: 0 }]);
      }),
    );
  });

  describe("the owner still replaces their own entity's categories", () => {
    it.each(TAGGABLE_ENTITIES)('%s', (type) =>
      inRolledBackTransaction(async ({ service, user, category, entity, rowsOn }) => {
        const owner = await user();
        const health = await category(owner, 'health');
        const career = await category(owner, 'career');
        const id = await entity(type, owner);

        const set = await service.setEntityCategories(as(owner), { type, id }, [career, health]);

        expect(set?.map((tag) => tag.label)).toEqual(['career', 'health']);
        expect(await rowsOn(type, id)).toEqual([
          { category_tag_id: career, position: 0 },
          { category_tag_id: health, position: 1 },
        ]);

        expect(await service.setEntityCategories(as(owner), { type, id }, [])).toEqual([]);
        expect(await rowsOn(type, id)).toEqual([]);
      }),
    );
  });

  describe('a CTI entity whose detail row and base row name different owners belongs to neither', () => {
    // The `/v1` caller-supplied-id shape: the caller's detail row attached to
    // another owner's `ci.entities` base row. Refusing the detail owner proves
    // the base row is checked. Refusing the base owner proves the detail row is.
    it.each(CTI_TYPES)('%s', (type) =>
      inRolledBackTransaction(async ({ runner, service, user, category, rowsOn }) => {
        const detailOwner = await user();
        const baseOwner = await user();
        const id = randomUUID();

        await graphNode(CTI[type].baseType)(runner, id, baseOwner);
        await CTI[type].detail(runner, id, detailOwner);

        const detailOwnersCategory = await category(detailOwner, 'health');
        const baseOwnersCategory = await category(baseOwner, 'health');

        expect(
          await service.setEntityCategories(as(detailOwner), { type, id }, [detailOwnersCategory]),
        ).toBeNull();
        expect(
          await service.setEntityCategories(as(baseOwner), { type, id }, [baseOwnersCategory]),
        ).toBeNull();

        expect(await rowsOn(type, id)).toEqual([]);
      }),
    );
  });

  describe("ids that name nothing of the caller's", () => {
    it('refuses an id that names no entity at all, writing nothing', () =>
      inRolledBackTransaction(async ({ service, user, category, rowsOn }) => {
        const owner = await user();
        const health = await category(owner, 'health');
        const id = randomUUID();

        expect(await service.setEntityCategories(as(owner), { type: 'task', id }, [health])).toBeNull();
        expect(await rowsOn('task', id)).toEqual([]);
      }));

    it('refuses a malformed id instead of letting Postgres reject the uuid cast', () =>
      inRolledBackTransaction(async ({ service, user, category }) => {
        const owner = await user();
        const health = await category(owner, 'health');

        await expect(
          service.setEntityCategories(as(owner), { type: 'task', id: 'not-a-uuid' }, [health]),
        ).resolves.toBeNull();
      }));

    it("refuses the caller's own entity named under another type", () =>
      inRolledBackTransaction(async ({ service, user, category, entity, rowsOn }) => {
        const owner = await user();
        const health = await category(owner, 'health');
        const personId = await entity('person', owner);
        const taskId = await entity('task', owner);

        // Same table, same owner: only the discriminator tells a Person from a place.
        expect(
          await service.setEntityCategories(as(owner), { type: 'place', id: personId }, [health]),
        ).toBeNull();
        expect(
          await service.setEntityCategories(as(owner), { type: 'note', id: taskId }, [health]),
        ).toBeNull();

        expect(await rowsOn('place', personId)).toEqual([]);
        expect(await rowsOn('note', taskId)).toEqual([]);
      }));
  });

  it("the owner's replace deletes only rows pointing at the owner's own category tags", () =>
    inRolledBackTransaction(async ({ service, user, category, entity, assign, rowsOn }) => {
      const owner = await user();
      const other = await user();
      const health = await category(owner, 'health');
      const career = await category(owner, 'career');
      const planted = await category(other, 'growth');
      const taskId = await entity('task', owner);

      // A row pointing at someone else's tag: what the pre-fix code let any
      // caller leave on any entity. The owner never sees it (reads join on the
      // caller's own tags), and the scoped DELETE never touches it either.
      await assign('task', taskId, career, 0);
      await assign('task', taskId, planted, 1);

      const set = await service.setEntityCategories(as(owner), { type: 'task', id: taskId }, [health]);

      expect(set?.map((tag) => tag.label)).toEqual(['health']);
      expect(
        (await service.getEntityCategories(as(owner), { type: 'task', id: taskId })).map((tag) => tag.label),
      ).toEqual(['health']);
      expect(await rowsOn('task', taskId)).toEqual(
        expect.arrayContaining([
          { category_tag_id: health, position: 0 },
          { category_tag_id: planted, position: 1 },
        ]),
      );
      expect(await rowsOn('task', taskId)).toHaveLength(2);
    }));
});
