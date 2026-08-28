import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';

import { ObjectMergeService } from './ObjectMergeService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const TARGET = '00000000-0000-0000-0000-0000000000b1';
const SOURCE_A = '00000000-0000-0000-0000-0000000000c1';
const SOURCE_B = '00000000-0000-0000-0000-0000000000c2';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

interface ObjectRow {
  object_id: string;
  user_id: string;
  merged_into_object_id: string | null;
  quantity: number;
  acquired_at: Date | null;
  last_seen_at: Date | null;
  last_seen_place_entity_id: string | null;
  brand: string | null;
  identifier_codes: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  [key: string]: unknown;
}

function objectRow(id: string, overrides: Partial<ObjectRow> = {}): ObjectRow {
  return {
    object_id: id,
    user_id: USER,
    merged_into_object_id: null,
    product_id: null,
    acquisition_receipt_id: null,
    acquisition_line_item_id: null,
    category: null,
    subcategory: null,
    brand: null,
    model: null,
    condition: null,
    currency: null,
    purchase_price: null,
    current_value: null,
    identifier_codes: {},
    metadata: {},
    quantity: 1,
    acquired_at: null,
    last_seen_at: null,
    last_seen_place_entity_id: null,
    warranty_expires_at: null,
    storage_location: null,
    location_description: null,
    lifecycle_state: 'active',
    identity_method: null,
    identity_confidence: 1,
    ...overrides,
  };
}

/**
 * The commit and every event send, in the order they actually happened.
 *
 * "Emitted after the commit" is otherwise not testable from a mock: the old
 * version of that assertion checked `statements.length === 0` inside `send`,
 * which is false by then whether the send sits inside the transaction callback
 * or after it — so it passed either way.
 */
type Timeline = Array<'commit' | 'send'>;

interface Harness {
  service: ObjectMergeService;
  statements: Array<{ sql: string; params: unknown[] }>;
  repointSubject: jest.Mock;
  send: jest.Mock;
  timeline: Timeline;
}

function makeHarness(rows: ObjectRow[]): Harness {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const timeline: Timeline = [];

  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });

    if (sql.includes('FROM ci.objects') && sql.includes('FOR UPDATE')) {
      const requested = (params[1] as string[]) ?? [];

      return rows.filter((row) => requested.includes(row.object_id));
    }

    if (sql.includes('SELECT name, description')) {
      return [{ name: 'Coffee mug', description: null }];
    }

    return mockWriteResult(sql);
  });

  const manager = {
    query,
    transaction: jest.fn(async (cb: (em: { query: typeof query }) => Promise<unknown>) => {
      const result = await cb({ query });

      timeline.push('commit');

      return result;
    }),
  };

  const itemRepository = {
    manager,
    findOne: jest.fn(async () => ({ id: TARGET, metadata: {}, composition: {} })),
  };
  const productRepository = { manager, findOne: jest.fn(async () => ({ id: TARGET })) };

  const repointSubject = jest.fn(async () => 2);
  const send = jest.fn(async () => {
    timeline.push('send');

    return [];
  });
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new ObjectMergeService(
    itemRepository as never,
    productRepository as never,
    { repointSubject } as never,
    { send } as never,
    logger as never,
  );

  return { service, statements, repointSubject, send, timeline };
}

/**
 * What the real driver hands back, so this mock cannot flatter the code.
 *
 * TypeORM's Postgres runner returns the driver's ROWS for a SELECT and for an
 * `INSERT … RETURNING`, but the PAIR `[rows, rowCount]` for an
 * `UPDATE … RETURNING` or a `DELETE … RETURNING`. The previous version of this
 * mock returned a one-element array for anything containing `RETURNING 1` — a
 * shape the driver never produces — which is why every `….length` count in the
 * service read as 1 here and as a constant 2 in production.
 *
 * Every counting write now wraps itself in `WITH … SELECT COUNT(*)`, so the
 * outer command is a SELECT and the count is a real number. This mock answers
 * that shape with a count, and answers a BARE `UPDATE/DELETE … RETURNING` with
 * the pair — so if one ever loses its wrapper again, the count stops making
 * sense here too instead of only in Postgres.
 */
function mockWriteResult(sql: string): unknown {
  if (sql.includes('SELECT COUNT(*)::int AS count')) {
    return [{ count: 1 }];
  }

  if (/^\s*(UPDATE|DELETE)/.test(sql) && sql.includes('RETURNING')) {
    return [[{ '?column?': 1 }], 1];
  }

  return [];
}

function statementsMatching(harness: Harness, fragment: string) {
  return harness.statements.filter(({ sql }) => sql.includes(fragment));
}

describe('ObjectMergeService.mergeObjects validation', () => {
  it('rejects a merge with no source distinct from the target', async () => {
    const harness = makeHarness([objectRow(TARGET)]);

    await expect(harness.service.mergeObjects(CONTEXT, [TARGET], TARGET)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects a missing source', async () => {
    const harness = makeHarness([objectRow(TARGET)]);

    await expect(harness.service.mergeObjects(CONTEXT, [SOURCE_A], TARGET)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('refuses a tombstoned target — its data is already folded into someone else', async () => {
    const harness = makeHarness([
      objectRow(TARGET, { merged_into_object_id: SOURCE_B }),
      objectRow(SOURCE_A),
    ]);

    await expect(harness.service.mergeObjects(CONTEXT, [SOURCE_A], TARGET)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('refuses a tombstoned source, so nothing is moved twice', async () => {
    const harness = makeHarness([objectRow(TARGET), objectRow(SOURCE_A, { merged_into_object_id: TARGET })]);

    await expect(harness.service.mergeObjects(CONTEXT, [SOURCE_A], TARGET)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('locks the target and every source in one FOR UPDATE', async () => {
    const harness = makeHarness([objectRow(TARGET), objectRow(SOURCE_A), objectRow(SOURCE_B)]);

    await harness.service.mergeObjects(CONTEXT, [SOURCE_A, SOURCE_B], TARGET);

    const lock = statementsMatching(harness, 'FOR UPDATE')[0];
    expect(lock.params[1]).toEqual([TARGET, SOURCE_A, SOURCE_B]);
  });
});

describe('ObjectMergeService.mergeObjects re-points', () => {
  it('re-points identifiers through the sanctioned service, inside the transaction', async () => {
    const harness = makeHarness([objectRow(TARGET), objectRow(SOURCE_A)]);

    const { counts } = await harness.service.mergeObjects(CONTEXT, [SOURCE_A], TARGET);

    expect(harness.repointSubject).toHaveBeenCalledWith(
      USER,
      'object_instance',
      SOURCE_A,
      TARGET,
      expect.anything(),
    );
    expect(counts.identifiers).toBe(2);
  });

  it('re-points observations, parents, related arrays and receipt lines', async () => {
    const harness = makeHarness([objectRow(TARGET), objectRow(SOURCE_A)]);

    const { counts } = await harness.service.mergeObjects(CONTEXT, [SOURCE_A], TARGET);

    expect(statementsMatching(harness, 'UPDATE ci.object_observations')).toHaveLength(1);
    expect(statementsMatching(harness, 'SET minted_object_id')).toHaveLength(1);
    expect(counts.observations).toBe(1);
    expect(counts.receiptLineItems).toBe(1);
  });

  it('de-duplicates a related_object_ids row that referenced two sources', async () => {
    const harness = makeHarness([objectRow(TARGET), objectRow(SOURCE_A), objectRow(SOURCE_B)]);

    await harness.service.mergeObjects(CONTEXT, [SOURCE_A, SOURCE_B], TARGET);

    const related = statementsMatching(harness, 'related_object_ids = sub.new_ids')[0];
    expect(related.sql).toContain('SELECT DISTINCT');
    // ...and drops the self-reference the re-point would otherwise create.
    expect(related.sql).toContain('<> object_id');
  });

  it('never lets the target become its own parent', async () => {
    const harness = makeHarness([objectRow(TARGET), objectRow(SOURCE_A)]);

    await harness.service.mergeObjects(CONTEXT, [SOURCE_A], TARGET);

    const nulled = statementsMatching(harness, 'SET parent_object_id = NULL')[0];
    expect(nulled.sql).toContain('object_id = $3::uuid');
  });
});

describe('ObjectMergeService.mergeObjects folds and tombstones', () => {
  it('sums quantities, takes the earliest acquisition and the latest sighting', async () => {
    const early = new Date('2020-01-01T00:00:00Z');
    const late = new Date('2026-03-02T10:00:00Z');
    const harness = makeHarness([
      objectRow(TARGET, { quantity: 2, acquired_at: late, last_seen_at: early }),
      objectRow(SOURCE_A, {
        quantity: 3,
        acquired_at: early,
        last_seen_at: late,
        last_seen_place_entity_id: 'place-1',
      }),
    ]);

    await harness.service.mergeObjects(CONTEXT, [SOURCE_A], TARGET);

    const fold = statementsMatching(harness, 'SET product_id')[0];
    // Two rows for one thing are two units of it.
    expect(fold.params[17]).toBe(5);
    // You have owned it since the FIRST acquisition, not since the duplicate row.
    expect(fold.params[18]).toBe(early);
    // The most recent sighting is the true one, and it may sit on a source.
    expect(fold.params[19]).toBe(late);
    expect(fold.params[20]).toBe('place-1');
  });

  it('lets the target win a scalar it already has', async () => {
    const harness = makeHarness([
      objectRow(TARGET, { brand: 'Sony' }),
      objectRow(SOURCE_A, { brand: 'SONY CORP' }),
    ]);

    await harness.service.mergeObjects(CONTEXT, [SOURCE_A], TARGET);

    expect(statementsMatching(harness, 'SET product_id')[0].params[7]).toBe('Sony');
  });

  it('takes a source scalar the target is missing', async () => {
    const harness = makeHarness([objectRow(TARGET, { brand: null }), objectRow(SOURCE_A, { brand: 'Sony' })]);

    await harness.service.mergeObjects(CONTEXT, [SOURCE_A], TARGET);

    expect(statementsMatching(harness, 'SET product_id')[0].params[7]).toBe('Sony');
  });

  it('merges the jsonb bags with the target on top', async () => {
    const harness = makeHarness([
      objectRow(TARGET, { identifier_codes: { gtin: 'target' } }),
      objectRow(SOURCE_A, { identifier_codes: { gtin: 'source', asin: 'B0' } }),
    ]);

    await harness.service.mergeObjects(CONTEXT, [SOURCE_A], TARGET);

    expect(JSON.parse(statementsMatching(harness, 'SET product_id')[0].params[21] as string)).toEqual({
      gtin: 'target',
      asin: 'B0',
    });
  });

  it('tombstones the sources and compresses an existing tombstone chain', async () => {
    const harness = makeHarness([objectRow(TARGET), objectRow(SOURCE_A)]);

    await harness.service.mergeObjects(CONTEXT, [SOURCE_A], TARGET);

    expect(statementsMatching(harness, 'SET merged_into_object_id = $3::uuid, lifecycle_state')).toHaveLength(
      1,
    );
    // Every reader follows exactly ONE hop, so a chain must be flattened.
    expect(
      statementsMatching(harness, 'WHERE user_id = $1::uuid AND merged_into_object_id = ANY($2::uuid[])'),
    ).toHaveLength(1);
  });

  it('deactivates the CTI base rows so the graph stops traversing them', async () => {
    const harness = makeHarness([objectRow(TARGET), objectRow(SOURCE_A)]);

    await harness.service.mergeObjects(CONTEXT, [SOURCE_A], TARGET);

    const base = statementsMatching(harness, 'UPDATE ci.entities')[0];
    expect(base.sql).toContain('is_active = FALSE');
    expect(base.sql).toContain("entity_type = 'Item'");
  });

  it('deletes BOTH search stores, not just the embeddings', async () => {
    const harness = makeHarness([objectRow(TARGET), objectRow(SOURCE_A)]);

    const { counts } = await harness.service.mergeObjects(CONTEXT, [SOURCE_A], TARGET);

    // ci_search.vectors is the keyword CANDIDATE source and joins nothing back
    // to ci.objects, so deleting only the embedding leaves the tombstone
    // fully findable.
    expect(statementsMatching(harness, 'DELETE FROM ci_search.embeddings')).toHaveLength(1);
    expect(statementsMatching(harness, 'DELETE FROM ci_search.vectors')).toHaveLength(1);
    expect(counts.searchRowsDeleted).toBe(2);
  });

  it('writes one audit row per source, typed ObjectInstance', async () => {
    const harness = makeHarness([objectRow(TARGET), objectRow(SOURCE_A), objectRow(SOURCE_B)]);

    await harness.service.mergeObjects(CONTEXT, [SOURCE_A, SOURCE_B], TARGET);

    const audits = statementsMatching(harness, 'INSERT INTO ci.entity_merges');
    expect(audits).toHaveLength(2);
    expect(audits.map(({ params }) => params[1])).toEqual([SOURCE_A, SOURCE_B]);
    expect(audits[0].params[3]).toBe('ObjectInstance');
    expect(JSON.parse(audits[0].params[4] as string).counts).toMatchObject({ identifiers: 4 });
  });

  it('emits the target update only after the transaction has committed', async () => {
    const harness = makeHarness([objectRow(TARGET), objectRow(SOURCE_A)]);

    await harness.service.mergeObjects(CONTEXT, [SOURCE_A], TARGET);

    expect(harness.send).toHaveBeenCalledWith('item.updated', { itemId: TARGET });
    // Sent from inside the transaction body, the re-index would race the rows
    // it is supposed to read — so the ORDER is the assertion.
    expect(harness.timeline).toEqual(['commit', 'send']);
  });
});

describe('ObjectMergeService.mergeProductModels', () => {
  function productHarness(rows: Array<Record<string, unknown>>) {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const timeline: Timeline = [];
    // How many statements had run when the transaction callback returned, so a
    // write can be shown to be INSIDE it rather than merely to have happened.
    let statementsAtCommit = -1;

    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });

      if (sql.includes('FROM ci.product_models') && sql.includes('FOR UPDATE')) {
        const requested = (params[1] as string[]) ?? [];

        return rows.filter((row) => requested.includes(row.product_id as string));
      }

      return mockWriteResult(sql);
    });

    const manager = {
      query,
      transaction: jest.fn(async (cb: (em: { query: typeof query }) => Promise<unknown>) => {
        const result = await cb({ query });

        statementsAtCommit = statements.length;
        timeline.push('commit');

        return result;
      }),
    };
    const repointSubject = jest.fn(async () => 1);
    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const send = jest.fn(async () => {
      timeline.push('send');

      return [];
    });

    const service = new ObjectMergeService(
      { manager, findOne: jest.fn() } as never,
      { manager, findOne: jest.fn(async () => ({ id: TARGET })) } as never,
      { repointSubject } as never,
      { send } as never,
      logger as never,
    );

    return { service, statements, repointSubject, send, timeline, committedAfter: () => statementsAtCommit };
  }

  const productRow = (id: string, overrides: Record<string, unknown> = {}) => ({
    product_id: id,
    user_id: USER,
    merged_into_product_id: null,
    title: null,
    brand: null,
    manufacturer: null,
    model_number: null,
    category: null,
    subcategory: null,
    product_type: null,
    description: null,
    variant_attributes: {},
    spec: {},
    metadata: {},
    msrp_minor: null,
    currency: null,
    image_content_id: null,
    product_entity_id: null,
    ...overrides,
  });

  it('re-points line items, objects and observations onto the surviving model', async () => {
    const harness = productHarness([productRow(TARGET), productRow(SOURCE_A)]);

    const { counts } = await harness.service.mergeProductModels(CONTEXT, [SOURCE_A], TARGET);

    expect(harness.repointSubject).toHaveBeenCalledWith(
      USER,
      'product_model',
      SOURCE_A,
      TARGET,
      expect.anything(),
    );
    expect(counts).toEqual({
      identifiers: 1,
      receiptLineItems: 1,
      objectProduct: 1,
      observations: 1,
      searchRowsDeleted: 2,
    });
  });

  it('writes an audit row typed ProductModel', async () => {
    const harness = productHarness([productRow(TARGET), productRow(SOURCE_A)]);

    await harness.service.mergeProductModels(CONTEXT, [SOURCE_A], TARGET);

    const audit = harness.statements.find(({ sql }) => sql.includes('INSERT INTO ci.entity_merges'));
    expect(audit?.params[3]).toBe('ProductModel');
  });

  it('refuses a tombstoned model on either side', async () => {
    const harness = productHarness([
      productRow(TARGET),
      productRow(SOURCE_A, { merged_into_product_id: TARGET }),
    ]);

    await expect(harness.service.mergeProductModels(CONTEXT, [SOURCE_A], TARGET)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('deletes the sources from BOTH search stores, in the merge transaction', async () => {
    const harness = productHarness([productRow(TARGET), productRow(SOURCE_A), productRow(SOURCE_B)]);

    const { counts } = await harness.service.mergeProductModels(CONTEXT, [SOURCE_A, SOURCE_B], TARGET);

    // No listener can do this: every by-id read filters tombstones, so the
    // merged-away model reads as absent and the indexer returns before it
    // could remove anything. Left undone, the duplicate answers search forever
    // and every hit hydrates to nothing.
    const embeddings = statementsMatching(harness, 'DELETE FROM ci_search.embeddings');
    const vectors = statementsMatching(harness, 'DELETE FROM ci_search.vectors');

    expect(embeddings).toHaveLength(1);
    expect(vectors).toHaveLength(1);
    // 'product', not 'item' — an owned unit that happens to share an id must
    // not be unindexed by a catalog merge.
    expect(embeddings[0].params).toEqual([USER, [SOURCE_A, SOURCE_B], 'product']);
    expect(vectors[0].params).toEqual([USER, [SOURCE_A, SOURCE_B], 'product']);
    expect(counts.searchRowsDeleted).toBe(2);

    // Both ran before the transaction callback returned, so a rolled-back
    // merge cannot leave a model live with its search rows deleted.
    const deletes = harness.statements
      .map(({ sql }, index) => ({ sql, index }))
      .filter(({ sql }) => sql.includes('DELETE FROM ci_search.'));
    expect(deletes.map(({ index }) => index < harness.committedAfter())).toEqual([true, true]);
  });

  it('emits ProductUpdatedEvent for the target only', async () => {
    const harness = productHarness([productRow(TARGET), productRow(SOURCE_A), productRow(SOURCE_B)]);

    await harness.service.mergeProductModels(CONTEXT, [SOURCE_A, SOURCE_B], TARGET);

    // A source is a tombstone by now: its search rows are already gone and
    // every read path filters it, so an event naming one can only log a miss.
    expect(harness.send).toHaveBeenCalledWith('product.updated', { productId: TARGET });
    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it('emits the target update only after the transaction has committed', async () => {
    const harness = productHarness([productRow(TARGET), productRow(SOURCE_A)]);

    await harness.service.mergeProductModels(CONTEXT, [SOURCE_A], TARGET);

    expect(harness.timeline).toEqual(['commit', 'send']);
  });
});
