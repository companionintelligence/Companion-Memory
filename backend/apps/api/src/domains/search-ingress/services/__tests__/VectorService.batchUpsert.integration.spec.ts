import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';

import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { VectorEntity } from '../../entities/VectorEntity';
import { VectorService, buildVectorUpsertBatchStatement } from '../VectorService';

/**
 * The batch-shaped index statement against a live Postgres: a slice of rows
 * in one statement writes each row's tsvector — the SAME tsvector the per-row
 * `setweight(...) || setweight(...)` expression built, which is what lets the
 * live listeners and the pipeline stages share the builder — and each row's
 * device document, and a repeat with unchanged text moves no document.
 */
const ENV = { urlEnvVar: 'SEARCH_INGRESS_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[VectorService.batchUpsert.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`VectorService batch upsert (${availability.target})`, () => {
  let dataSource: DataSource;
  let service: VectorService;
  const userId = randomUUID();
  const ctx = { userId } as UserServiceContext;
  const rows = [
    {
      id: uuidv7(),
      entityId: randomUUID(),
      texts: [
        { text: 'Grocery list', weight: 10 },
        { text: 'Milk, eggs, bread', weight: 5 },
      ],
    },
    { id: uuidv7(), entityId: randomUUID(), texts: [{ text: 'Call the dentist', weight: 10 }] },
  ];

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'postgres', ...dataSourceConnection(ENV), entities: [VectorEntity] });
    await dataSource.initialize();
    service = new VectorService(dataSource.getRepository(VectorEntity));
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      // The documents go with their vectors (ON DELETE CASCADE).
      await dataSource.query('DELETE FROM ci_search.vectors WHERE user_id = $1', [userId]);
      await dataSource.destroy();
    }
  });

  const stored = async (entityId: string) =>
    (
      await dataSource.query<
        Array<{ vector: string; updated_at: Date; title: string; body: string; doc_updated_at: Date }>
      >(
        `SELECT v.vector::text AS vector, v.updated_at, d.title, d.body, d.updated_at AS doc_updated_at
           FROM ci_search.vectors v
           JOIN ci_search.mobile_search_documents d ON d.id = v.id
          WHERE v.entity_type = 'note' AND v.entity_id = $1`,
        [entityId],
      )
    )[0];

  it('writes every row of a slice in one statement, with the tsvector the per-row expression built', async () => {
    const { sql, params } = buildVectorUpsertBatchStatement(rows, { entityType: 'note', userId });
    const returned = await dataSource.query<Array<{ entity_id: string }>>(sql, params);

    expect(returned.map((r) => r.entity_id).sort()).toEqual(rows.map((r) => r.entityId).sort());

    const [first, second] = await Promise.all(rows.map((row) => stored(row.entityId)));
    const [perRowFirst] = await dataSource.query<Array<{ vector: string }>>(
      `SELECT (setweight(to_tsvector('english', $1), 'A') || setweight(to_tsvector('english', $2), 'B'))::text AS vector`,
      ['Grocery list', 'Milk, eggs, bread'],
    );
    const [perRowSecond] = await dataSource.query<Array<{ vector: string }>>(
      `SELECT setweight(to_tsvector('english', $1), 'A')::text AS vector`,
      ['Call the dentist'],
    );

    expect(first.vector).toBe(perRowFirst.vector);
    expect(second.vector).toBe(perRowSecond.vector);
    expect(first).toMatchObject({ title: 'Grocery list', body: 'Milk, eggs, bread' });
    expect(second).toMatchObject({ title: 'Call the dentist', body: '' });
  });

  it('re-indexes the vectors but leaves an unchanged document alone', async () => {
    const before = await stored(rows[0].entityId);
    const { sql, params } = buildVectorUpsertBatchStatement(rows, { entityType: 'note', userId });

    await dataSource.query(sql, params);

    const after = await stored(rows[0].entityId);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect(after.doc_updated_at).toEqual(before.doc_updated_at);
  });

  it("the live listeners' single-row upsert is a batch of one, and still answers the row", async () => {
    const entityId = randomUUID();

    const result = await service.upsert(ctx, {
      entityType: 'note',
      entityId,
      searchableText: [{ text: 'Water the plants', weight: 10 }],
    });

    expect(result).toMatchObject({ entityType: 'note', entityId, userId });
    expect(await stored(entityId)).toMatchObject({ title: 'Water the plants', body: '' });
  });
});
