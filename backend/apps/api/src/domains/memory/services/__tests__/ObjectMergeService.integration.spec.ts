import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ItemEntity } from '../../entities/ItemEntity';
import { ProductModelEntity } from '../../entities/ProductModelEntity';
import { ObjectMergeService } from '../ObjectMergeService';

/**
 * The two merge guarantees that ONLY a real Postgres can check, executed
 * against one.
 *
 * `ObjectMergeService.spec.ts` stubs `query` with a `jest.fn` and asserts on
 * the SQL TEXT the service emitted. That is the exact shape of test that let
 * `mergeProductModels` ship folding brand/model_number onto the target while
 * the sources were still live: every statement was individually well-formed and
 * in a plausible order, and a mock has no unique index to violate. The two
 * cases below are the two a mock structurally cannot see —
 *
 *  1. STATEMENT ORDER vs a non-deferrable partial unique index
 *     (`product_models_brand_model_uniq`). Folding before tombstoning raises
 *     23505 and rolls the whole merge back; tombstoning first drops the sources
 *     out of the index predicate so the fold's key is free.
 *  2. `ci_search.entity_tag` links surviving the merge. There is no FK from
 *     that table to `ci.objects` and no tombstone filter on the read side, so
 *     "did the tag move?" is a question about rows, not about SQL text.
 *
 * Opt-in: set `MEMORY_TEST_DATABASE_URL` (or `DATABASE_URL`) to a database with
 * the migrations applied — `databaseAvailability` probes it and this suite
 * SKIPS legibly, never fails, when nothing is reachable.
 *
 *   MEMORY_TEST_DATABASE_URL=postgres://companion:pw@localhost:5432/companion \
 *     yarn workspace @ci/be-api jest ObjectMergeService.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/ObjectMergeService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`ObjectMergeService — merge ordering, in Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: ObjectMergeService;

  const owner = { userId: uuidv7() } as UserServiceContext;

  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as LoggerService;

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
      entities: [ItemEntity, ProductModelEntity],
    });
    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/ObjectMergeService.integration');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [owner.userId, 'Merge spec fixture', `merge.${owner.userId}@example.invalid`],
    );

    // repointSubject is exercised by ObjectIdentifierService's own suite; here
    // it only has to be a no-op that reports a count, so the merge's real
    // statements are the only thing under test.
    const objectIdentifierService = { repointSubject: async () => 0 };
    const eventService = { send: async () => [] };

    service = new ObjectMergeService(
      dataSource.getRepository(ItemEntity),
      dataSource.getRepository(ProductModelEntity),
      objectIdentifierService as never,
      eventService as never,
      noopLogger,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query(
        `DELETE FROM ci_search.entity_tag
          WHERE entity_id IN (SELECT object_id FROM ci.objects WHERE user_id = $1)`,
        [owner.userId],
      );
      await dataSource.query(`DELETE FROM ci_search.tags WHERE user_id = $1`, [owner.userId]);
      await dataSource.query('DELETE FROM ci.entity_merges WHERE owner_user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.objects WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.product_models WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [owner.userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  /** A product model row, inserted directly so the test owns its exact shape. */
  const insertProduct = async (input: {
    title: string;
    brand?: string | null;
    modelNumber?: string | null;
  }): Promise<string> => {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.product_models (product_id, user_id, owner_user_id, title, brand, model_number)
       VALUES ($1, $2, $2, $3, $4, $5)`,
      [id, owner.userId, input.title, input.brand ?? null, input.modelNumber ?? null],
    );

    return id;
  };

  /** An owned unit plus its CTI base row, which the composite FK requires. */
  const insertUnit = async (name: string): Promise<string> => {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Item', $2, '{}'::jsonb, $3, 'objects', $1)`,
      [id, name, owner.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.objects (object_id, user_id, owner_user_id, lifecycle_state)
       VALUES ($1, $2, $2, 'active')`,
      [id, owner.userId],
    );

    return id;
  };

  const insertTagLink = async (entityId: string, label: string): Promise<string> => {
    const [tag] = await dataSource.query(
      `INSERT INTO ci_search.tags (id, user_id, label) VALUES ($1, $2, $3) RETURNING id`,
      [uuidv7(), owner.userId, label],
    );

    const tagId = (tag as { id: string } | undefined)?.id;

    if (tagId == null) {
      throw new Error(`tag ${label} was not created`);
    }

    await dataSource.query(
      `INSERT INTO ci_search.entity_tag (entity_type, entity_id, tag_id) VALUES ('item', $1, $2)`,
      [entityId, tagId],
    );

    return tagId;
  };

  // ── F1 ──────────────────────────────────────────────────────────────────

  it('folds brand/model_number onto a target that had neither, WITHOUT violating product_models_brand_model_uniq', async () => {
    // The ordinary case, not a corner: a barcode-only model (no brand, no
    // model number) and the receipt-derived model that carries both. Folding
    // before the tombstone makes the target a second live holder of
    // (owner, 'sony', 'wh-1000xm5'), which the partial unique index rejects
    // with 23505 — and because a unique INDEX is not deferrable, it rejects it
    // immediately rather than at COMMIT, taking the whole merge with it.
    const target = await insertProduct({ title: 'Scanned barcode 0027242923041' });
    const source = await insertProduct({
      title: 'Sony WH-1000XM5',
      brand: 'Sony',
      modelNumber: 'WH-1000XM5',
    });

    const { counts } = await service.mergeProductModels(owner, [source], target);

    expect(counts.identifiers).toBe(0);

    const [merged] = await dataSource.query(
      `SELECT brand, model_number, title, merged_into_product_id
         FROM ci.product_models WHERE product_id = $1`,
      [target],
    );

    // The fold happened — this is not "the merge was skipped".
    expect(merged).toMatchObject({
      brand: 'Sony',
      model_number: 'WH-1000XM5',
      merged_into_product_id: null,
    });
    // COALESCE($3, title) on a target that already had one: the target keeps it.
    expect(merged.title).toBe('Scanned barcode 0027242923041');

    const [tombstone] = await dataSource.query(
      `SELECT merged_into_product_id FROM ci.product_models WHERE product_id = $1`,
      [source],
    );
    expect(tombstone.merged_into_product_id).toBe(target);

    // …and the index the merge could have violated is intact, i.e. exactly one
    // LIVE row holds the key.
    const [{ live }] = await dataSource.query(
      `SELECT COUNT(*)::int AS live FROM ci.product_models
        WHERE owner_user_id = $1
          AND lower(btrim(brand)) = 'sony' AND lower(btrim(model_number)) = 'wh-1000xm5'
          AND merged_into_product_id IS NULL`,
      [owner.userId],
    );
    expect(live).toBe(1);
  });

  it('still folds when BOTH sides carry the same brand/model pair', async () => {
    // The other half of the ordering argument: two live rows already sharing
    // the key cannot exist (the index forbids it), so the only way this case
    // arises is different casing/whitespace — which the index normalises and
    // therefore also forbids. Merging them must tombstone first for the same
    // reason.
    const target = await insertProduct({ title: 'Kettle', brand: ' Breville ', modelNumber: 'BKE820XL' });
    const source = await insertProduct({ title: 'Breville kettle', brand: 'BREVILLE' });

    await expect(service.mergeProductModels(owner, [source], target)).resolves.toMatchObject({
      counts: { identifiers: 0 },
    });
  });

  // ── F2 ──────────────────────────────────────────────────────────────────

  it('moves the sources tag links onto the target instead of stranding them on the tombstone', async () => {
    const target = await insertUnit('Coffee mug');
    const source = await insertUnit('Mug (duplicate)');

    const shared = await insertTagLink(target, `kitchen-${owner.userId}`);
    await dataSource.query(
      `INSERT INTO ci_search.entity_tag (entity_type, entity_id, tag_id) VALUES ('item', $1, $2)`,
      [source, shared],
    );
    const onlyOnSource = await insertTagLink(source, `fragile-${owner.userId}`);

    const { counts } = await service.mergeObjects(owner, [source], target);

    // One link moved (the tag only the source had); the shared one was skipped
    // because the target already held it — that skip is what keeps
    // entity_tag_unique_entry satisfied mid-merge.
    expect(counts.tagLinksMoved).toBe(1);

    const targetTags = await dataSource.query(
      `SELECT tag_id FROM ci_search.entity_tag WHERE entity_type = 'item' AND entity_id = $1 ORDER BY tag_id`,
      [target],
    );
    expect(targetTags.map((row: { tag_id: string }) => row.tag_id).sort()).toEqual(
      [shared, onlyOnSource].sort(),
    );

    // Nothing left addressing the tombstone.
    const sourceTags = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM ci_search.entity_tag WHERE entity_type = 'item' AND entity_id = $1`,
      [source],
    );
    expect(sourceTags[0].count).toBe(0);
  });

  it('collapses a tag two sources both claimed into one link on the target', async () => {
    const target = await insertUnit('Screwdriver');
    const sourceA = await insertUnit('Screwdriver (dup A)');
    const sourceB = await insertUnit('Screwdriver (dup B)');

    const tagId = await insertTagLink(sourceA, `tools-${owner.userId}`);
    await dataSource.query(
      `INSERT INTO ci_search.entity_tag (entity_type, entity_id, tag_id) VALUES ('item', $1, $2)`,
      [sourceB, tagId],
    );

    const { counts } = await service.mergeObjects(owner, [sourceA, sourceB], target);

    expect(counts.tagLinksMoved).toBe(1);

    const [{ count }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM ci_search.entity_tag
        WHERE entity_type = 'item' AND entity_id = $1 AND tag_id = $2`,
      [target, tagId],
    );
    expect(count).toBe(1);
  });
});
