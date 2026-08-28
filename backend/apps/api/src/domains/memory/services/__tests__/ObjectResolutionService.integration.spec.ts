import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { EMBEDDING_DISTANCE_FLOOR, ObjectResolutionService } from '../ObjectResolutionService';

/**
 * The embedding rung's PLAN, read out of Postgres.
 *
 * `ObjectResolutionService`'s docblock claimed HNSW acceleration for as long as
 * the query existed, and the query never had it: the probe arrived through
 * `WITH probe AS (…) … JOIN probe ON TRUE`, so `probe.embedding` was an ordinary
 * column of a joined relation and `col <=> other_relation.col` is not an
 * indexable order-by expression at all. Every claim in that docblock was true
 * of the SQL text and false of the plan, and no amount of string-matching a
 * mock could tell the difference — which is exactly why this file reads
 * `EXPLAIN` instead.
 *
 * `resolveUnresolved` runs the rung once per observation, up to 100 per sweep,
 * so the difference is 100 scans of `ci_search.embeddings` versus 100 index
 * probes.
 *
 * Two things have to hold, and BOTH are load-bearing:
 *
 *  1. the probe is folded into an `InitPlan` (the scalar-subquery shape), so an
 *     ANN index is reachable at all;
 *  2. `embeddings_item_embedding_hnsw_idx` exists (migration
 *     20260819173813), so the ANN plan is also the cheap one — the
 *     whole-corpus HNSW index is not, because `entity_type = 'item'` is a
 *     fraction of a percent of that table and the graph walk would spend its
 *     effort on rows this rung can never match.
 *
 * Opt-in: set `MEMORY_TEST_DATABASE_URL` (or `DATABASE_URL`); this suite SKIPS
 * legibly when nothing is reachable.
 *
 *   MEMORY_TEST_DATABASE_URL=postgres://companion:pw@localhost:5432/companion \
 *     yarn workspace @ci/be-api jest ObjectResolutionService.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/ObjectResolutionService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`ObjectResolutionService — the embedding plan, in Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let embeddingSql: string;

  const owner = { userId: uuidv7() };
  const observationId = uuidv7();
  const objectIds = [uuidv7(), uuidv7()];

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
      entities: [],
    });
    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/ObjectResolutionService.integration');

    // The statement UNDER TEST, taken from the service rather than retyped —
    // a copy here could pass forever while the shipped query regressed.
    embeddingSql = (
      ObjectResolutionService.prototype as unknown as { buildEmbeddingQuery: () => string }
    ).buildEmbeddingQuery.call(null);

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [owner.userId, 'Resolution spec fixture', `resolve.${owner.userId}@example.invalid`],
    );

    const vector = `[${Array.from({ length: 768 }, (_, i) => (i % 7) / 7).join(',')}]`;

    for (const objectId of objectIds) {
      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
         VALUES ($1, 'Item', 'Coffee mug', '{}'::jsonb, $2, 'objects', $1)`,
        [objectId, owner.userId],
      );
      await dataSource.query(
        `INSERT INTO ci.objects (object_id, user_id, owner_user_id, lifecycle_state)
         VALUES ($1, $2, $2, 'active')`,
        [objectId, owner.userId],
      );
      await dataSource.query(
        `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, user_id, embedding)
         VALUES ($1, 'item', $2, $3, $4::vector)`,
        [uuidv7(), objectId, owner.userId, vector],
      );
    }

    await dataSource.query(
      `INSERT INTO ci.object_observations
         (observation_id, user_id, owner_user_id, observed_at, label, embedding)
       VALUES ($1, $2, $2, now(), 'mug', $3::vector)`,
      [observationId, owner.userId, vector],
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.object_observations WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci_search.embeddings WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.objects WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [owner.userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  /**
   * The plan, optionally with sorting priced out of the planner's reach.
   *
   * Asserting on the UNFORCED plan would make this suite depend on how many
   * `item` embeddings the database happens to hold: at a few rows an exact scan
   * plus a top-N sort is genuinely cheaper than any ANN walk, and the planner is
   * right to choose it. What must be true at every size is that the ANN plan is
   * REACHABLE — which is precisely what the old joined-probe shape made
   * impossible, at any cost setting, because `col <=> other_relation.col` is not
   * an indexable order-by expression.
   *
   * So the discriminating question is asked directly: with sorting disabled,
   * can the planner reach the index? The old shape answers `Sort (Disabled:
   * true)` — it has nowhere else to go. The new one answers with the HNSW scan.
   */
  const explain = async (options: { withoutSort?: boolean } = {}): Promise<string> => {
    const runner = dataSource.createQueryRunner();

    try {
      await runner.connect();
      await runner.startTransaction();

      if (options.withoutSort === true) {
        // SET LOCAL, so it dies with the transaction and cannot leak into
        // another suite sharing this database.
        await runner.query('SET LOCAL enable_sort = off');
        await runner.query('SET LOCAL enable_incremental_sort = off');
      }

      const rows = await runner.query(`EXPLAIN ${embeddingSql}`, [
        owner.userId,
        observationId,
        EMBEDDING_DISTANCE_FLOOR,
      ]);

      await runner.rollbackTransaction();

      return rows.map((row: Record<string, string>) => Object.values(row)[0]).join('\n');
    } finally {
      await runner.release();
    }
  };

  it('has the index the plan depends on — otherwise this suite would silently test the slow path', async () => {
    const [row] = await dataSource.query(
      `SELECT to_regclass('ci_search.embeddings_item_embedding_hnsw_idx') AS idx`,
    );

    if (row?.idx == null) {
      throw new Error(
        'ci_search.embeddings_item_embedding_hnsw_idx is missing — apply the migrations ' +
          '(`yarn workspace @ci/be-api migrate`) before running this suite. ' +
          'This is a broken setup, not an absent database, so it FAILS rather than skipping.',
      );
    }
  });

  it('orders by a PSEUDOCONSTANT — the probe is folded into an InitPlan, not joined in as a column', async () => {
    const plan = await explain();

    // Whatever the planner picks at this data size, the distance's right-hand
    // side is an InitPlan output. That is the property an ANN index needs, and
    // the one the `JOIN probe ON TRUE` shape could never have.
    expect(plan).toContain('(InitPlan 1).col1');
    expect(plan).not.toContain('probe.embedding');
  });

  it('CAN plan as an HNSW index scan ordered by the distance operator', async () => {
    const plan = await explain({ withoutSort: true });

    expect(plan).toContain('Index Scan using embeddings_item_embedding_hnsw_idx');
    expect(plan).toMatch(/Order By: \(embedding <=> \(InitPlan \d+\)\.col1\)/);

    // The pre-fix shape answers this same question with
    // `Sort / Disabled: true`, because it has no index to fall back on.
    expect(plan).not.toContain('Disabled: true');
  });

  it('returns the nearest LIVE unit and skips a merge tombstone', async () => {
    const [near, tombstoned] = objectIds;

    await dataSource.query(`UPDATE ci.objects SET merged_into_object_id = $2 WHERE object_id = $1`, [
      tombstoned,
      near,
    ]);

    const rows = await dataSource.query(embeddingSql, [
      owner.userId,
      observationId,
      EMBEDDING_DISTANCE_FLOOR,
    ]);

    // A merged-away unit keeps its embedding until the merge deletes it, and
    // the join is inside the LIMIT so the index keeps yielding neighbours until
    // one is live rather than the query returning nothing.
    expect(rows).toHaveLength(1);
    expect(rows[0].object_id).toBe(near);

    await dataSource.query(`UPDATE ci.objects SET merged_into_object_id = NULL WHERE object_id = $1`, [
      tombstoned,
    ]);
  });

  it('returns nothing when the nearest neighbour is beyond the distance floor', async () => {
    const rows = await dataSource.query(embeddingSql, [owner.userId, observationId, 0]);

    // The floor is applied OUTSIDE the ANN limit: it filters the one nearest
    // neighbour rather than every candidate. A floor of 0 admits nothing.
    expect(rows).toHaveLength(0);
  });
});
