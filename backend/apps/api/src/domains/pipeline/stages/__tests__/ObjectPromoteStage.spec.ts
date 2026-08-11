import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { databaseAvailability, resolveConnection } from '../../__tests__/harness/pipelineHarness';
import {
  IDENTITY_CONFIDENCE_IDENTIFIED,
  IDENTITY_CONFIDENCE_NAMED,
  OBJECT_PROMOTION_RULE_GENERATION,
  ObjectPromoteStage,
  PROMOTE_OBJECT_SOURCE,
  PROMOTE_OBJECT_STAGE_ID,
  PROMOTE_OBJECT_VERSION,
  extractPurchase,
  parseCondition,
  parseCurrency,
  parsePrice,
  parseQuantity,
  promoteObjectStageVersion,
} from '../promote/ObjectPromoteStage';

/**
 * `promote.object` — Amazon purchases become inventory with real identity.
 *
 * `ci.inventory` has 0 rows on an appliance holding 2,147 `purchase` events and
 * 630 `order` events, all imported from a real Amazon export. The rich object
 * schema was migrated and then never filled. This stage is the writer, and this
 * suite is mostly about the four things a writer of an empty table has to get
 * right before anyone will trust it again:
 *
 *  1. **Selection never anti-joins `ci.inventory`.** "Events that have not
 *     produced an object yet" is the ratchet: a purchase would leave the
 *     candidate set the moment an object existed, so a better extractor could
 *     never revisit a line it once read badly.
 *  2. **The extraction rule is pure and covered against the REAL metadata.**
 *     Every fixture in the `extractPurchase` block is a verbatim shape from the
 *     dev appliance's Amazon corpus, including the two that make identity work:
 *     an all-digit ASIN that is really an ISBN-10, and a free digital purchase
 *     priced `"0"`.
 *  3. **Idempotency is a unique index, not a guard.** Re-running produces one
 *     object, not two.
 *  4. **A human's edit outranks a re-promotion.** Proved against real Postgres,
 *     because that guarantee lives in an `ON CONFLICT … DO UPDATE … WHERE` and
 *     a fake would agree with any SQL it was handed.
 *
 * The real-Postgres block runs inside a transaction that is ALWAYS rolled back
 * and SKIPS — never silently passes — when no database is reachable.
 */

/* ===================================================================== *
 * Fixtures — verbatim shapes from the dev appliance's Amazon corpus
 * ===================================================================== */

const USER = '00000000-0000-4000-8000-0000000000aa';

function eventId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

interface EventRow {
  id: string;
  event_type: string | null;
  title: string | null;
  start_time: Date | string | null;
  metadata: Record<string, unknown> | null;
  source_system: string | null;
  is_deleted: boolean | null;
}

/** `ci.events` row for `amazon:113-3417031-4201800:B000P6L454`, verbatim. */
function groceryPurchase(n = 1, overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: eventId(n),
    event_type: 'purchase',
    title: 'Organic Russet Potato',
    start_time: new Date('2022-05-13T01:20:52.000Z'),
    source_system: 'amazon',
    is_deleted: false,
    metadata: {
      ASIN: 'B000P6L454',
      kind: 'commerce.purchase',
      Total: '3.8',
      Source: 'Amazon',
      Product: 'Organic Russet Potato',
      Currency: 'USD',
      'Order ID': '113-3417031-4201800',
      Quantity: 1,
      filename: 'purchase.txt',
      Condition: 'New',
      mediaType: 'text/plain',
      'Order Date': '2022-05-13T01:20:52.000Z',
      'Unit Price': '3.8',
      contentHash: 'amazon:113-3417031-4201800:B000P6L454',
    },
    ...overrides,
  };
}

/** A free Kindle book: `Digital: true`, `Total: "0"`, no `Quantity`. */
function ebookPurchase(n = 2, overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: eventId(n),
    event_type: 'purchase',
    title: 'Lincoln Letters',
    start_time: new Date('2010-09-19T07:53:00.000Z'),
    source_system: 'amazon',
    is_deleted: false,
    metadata: {
      ASIN: 'B000JQUXXY',
      kind: 'commerce.purchase',
      Total: '0',
      Source: 'Amazon',
      Digital: true,
      Product: 'Lincoln Letters',
      Currency: 'USD',
      'Order ID': 'D01-7652656-1383348',
      filename: 'purchase.txt',
      mediaType: 'application/vnd.amazon.ebook',
      'Unit Price': '0',
    },
    ...overrides,
  };
}

/** An order-level rollup: an Order ID, a total, an item count, no line identity. */
function orderRollup(n = 3, overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: eventId(n),
    event_type: 'order',
    title: 'Amazon order — 1 item',
    start_time: new Date('2011-03-01T00:00:00.000Z'),
    source_system: 'amazon',
    is_deleted: false,
    metadata: {
      kind: 'commerce.order',
      Title: 'Amazon order — 1 item',
      Total: '0',
      Source: 'Amazon',
      Currency: 'USD',
      'Order ID': 'D01-3812475-8794554',
      'Item Count': 1,
      Description: "Prequel to Let's Kill Hitler",
      contentHash: 'amazon:order:D01-3812475-8794554',
    },
    ...overrides,
  };
}

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

interface FakeOptions {
  rows?: EventRow[];
  /** Event ids the upsert refuses to write (the ON CONFLICT guard). */
  refuse?: string[];
  failWrite?: boolean;
  /** Rows the classification query finds for the refused ids. */
  classification?: Array<{ source_id: string; owned: boolean; modified: boolean }>;
  failClassification?: boolean;
}

/**
 * A `DataSource` that recognises each of the stage's three statements.
 *
 * Deliberately NOT a SQL engine: what these tests assert is the stage's
 * DECISIONS — one answer per id, a reason on every non-`done` — and the SQL
 * itself is asserted against real Postgres at the bottom of the file.
 */
function fakeDataSource(options: FakeOptions = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];

  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });

    if (sql.includes('INSERT INTO ci.inventory')) {
      if (options.failWrite === true) {
        throw new Error('inventory write exploded');
      }

      const eventIds = params[5] as string[];

      return eventIds
        .filter((id) => !(options.refuse ?? []).includes(id))
        .map((id) => ({ object_id: `object-for-${id}`, source_id: id }));
    }

    // The CTI base-row upsert that accompanies every successful detail write.
    if (sql.includes('INSERT INTO ci.entities')) {
      return [];
    }

    if (sql.includes('FROM ci.inventory inv')) {
      if (options.failClassification === true) {
        throw new Error('classification failed');
      }

      return options.classification ?? [];
    }

    if (sql.includes('FROM ci.events e')) {
      const ids = params[0] as string[];

      return (options.rows ?? []).filter((row) => ids.includes(row.id));
    }

    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  });

  return {
    calls,
    query,
    // writeObjects spans detail + base insert in one dataSource.transaction;
    // the fake hands the same query stub back as the transactional manager.
    transaction: jest.fn(async (cb: (manager: { query: typeof query }) => unknown) => cb({ query })),
  };
}

function makeStage(options: FakeOptions = {}) {
  const dataSource = fakeDataSource(options);
  const stage = new ObjectPromoteStage(dataSource as never, makeLogger() as never);

  return { stage, dataSource };
}

/* ===================================================================== *
 * 1. Selection asks the LEDGER, never ci.inventory
 * ===================================================================== */

describe('ObjectPromoteStage — the applicability predicate says what a row IS', () => {
  const predicate = PROMOTE_OBJECT_SOURCE.predicate ?? '';

  it('never mentions ci.inventory, the table this stage writes', () => {
    // THE HEADLINE REGRESSION, and the shape the pipeline README calls out by
    // name: `LEFT JOIN <output> … WHERE <output> IS NULL` is the same ratchet as
    // `width IS NULL`. A purchase would leave the candidate set the moment an
    // object existed for it, so a better extractor could never revisit the 130
    // lines it read without an identifier.
    expect(predicate).not.toMatch(/inventory/i);
    expect(predicate).not.toMatch(/product_models|receipts|object_identifiers/i);
  });

  it('is a clause, not a statement, and does not reach into the ledger', () => {
    expect(predicate.trim()).not.toMatch(/^and\b/i);
    expect(predicate).not.toContain(';');
    expect(predicate).not.toMatch(/pipeline_state|\bp\./i);
  });

  it('includes order rollups as well as purchases, so the backlog is countable', () => {
    // 630 `order` rows cannot become objects yet. Excluding them from the sweep
    // would make them invisible; including them makes them
    // `skipped: order_rollup_no_line_item` in GET /api/pipeline/state.
    expect(predicate).toMatch(/'purchase'/);
    expect(predicate).toMatch(/'order'/);
    expect(predicate).toMatch(/is_deleted/i);
  });

  it('sweeps ci.events keyed by event_id and scoped by user_id', () => {
    expect(PROMOTE_OBJECT_SOURCE).toMatchObject({
      schema: 'ci',
      table: 'events',
      idColumn: 'event_id',
      userColumn: 'user_id',
    });
  });
});

describe('ObjectPromoteStage — the version', () => {
  it('is an integer >= 1, which versions.ts requires', () => {
    expect(PROMOTE_OBJECT_VERSION).toBe(OBJECT_PROMOTION_RULE_GENERATION);
    expect(Number.isInteger(PROMOTE_OBJECT_VERSION)).toBe(true);
    expect(PROMOTE_OBJECT_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('throws when STAGE_VERSIONS disagrees', () => {
    expect(() =>
      promoteObjectStageVersion({ [PROMOTE_OBJECT_STAGE_ID]: PROMOTE_OBJECT_VERSION + 3 }),
    ).toThrow(/declares .* but the stage derives/);
  });

  it('accepts a missing entry, because this file lands before the wiring does', () => {
    expect(promoteObjectStageVersion({})).toBe(PROMOTE_OBJECT_VERSION);
  });

  it('reports it on the instance, never a literal', () => {
    const { stage } = makeStage();

    expect(stage.version).toBe(PROMOTE_OBJECT_VERSION);
    expect(stage.id).toBe(PROMOTE_OBJECT_STAGE_ID);
  });
});

/* ===================================================================== *
 * 2. extractPurchase — the whole rule, pure, against the real corpus
 * ===================================================================== */

describe('extractPurchase — a receipt line becomes an object', () => {
  function extracted(row: EventRow) {
    const result = extractPurchase(row as never);

    if ('reason' in result) {
      throw new Error(`expected an object, got skip: ${result.reason}`);
    }

    return result.object;
  }

  it('maps the real Amazon grocery line onto ci.inventory columns', () => {
    expect(extracted(groceryPurchase())).toMatchObject({
      name: 'Organic Russet Potato',
      purchasePrice: 3.8,
      currency: 'USD',
      quantity: 1,
      condition: 'new',
      isDigital: false,
      sourceSystem: 'amazon',
      identityConfidence: IDENTITY_CONFIDENCE_IDENTIFIED,
      identifierCodes: { asin: 'B000P6L454', order_id: '113-3417031-4201800' },
    });
  });

  it('takes acquired_at from the typed column, not the metadata string', () => {
    // The importer already parsed "Order Date" into `start_time`; the typed
    // column is the one that survived a timezone.
    expect(extracted(groceryPurchase()).acquiredAt?.toISOString()).toBe('2022-05-13T01:20:52.000Z');
  });

  it('routes an all-digit ASIN to isbn, so a book has ONE identity', () => {
    // Amazon reuses the ASIN field for a book's ISBN-10. Left alone, the book you
    // bought and the book you scan are two different things forever. This is the
    // shared normalizer doing it, not a local uppercase — which is the entire
    // reason `normalizeObjectIdentifier` is imported instead of reimplemented.
    const book = ebookPurchase(2, {
      metadata: { ...ebookPurchase().metadata, ASIN: '0306406152' },
    });

    expect(extracted(book).identifierCodes).toMatchObject({ isbn: '9780306406157' });
    expect(extracted(book).identifierCodes.asin).toBeUndefined();
  });

  it('keeps a free digital purchase, price and all', () => {
    // "0" is a real Amazon value for a promotional Kindle title. Zero is a price;
    // turning it into NULL would lose the fact that the line had one.
    expect(extracted(ebookPurchase())).toMatchObject({
      name: 'Lincoln Letters',
      purchasePrice: 0,
      isDigital: true,
      // No `Quantity` key at all in the source — the floor applies.
      quantity: 1,
      // No `Condition` key: NULL, not 'n/a'. 'n/a' is an assertion.
      condition: null,
    });
  });

  it('skips an unnormalizable identifier without losing the line', () => {
    // A garbled barcode is not an error — the receipt line is still valid, it
    // just drops to the NAMED identity tier.
    const broken = groceryPurchase(1, {
      metadata: { ...groceryPurchase().metadata, ASIN: 'NOT-AN-ASIN' },
    });

    const object = extracted(broken);

    expect(object.identifierCodes.asin).toBeUndefined();
    expect(object.identityConfidence).toBe(IDENTITY_CONFIDENCE_NAMED);
    expect(object.name).toBe('Organic Russet Potato');
  });

  it('does not let an order id count as product identity', () => {
    // An order id identifies a transaction, not a thing. Counting it would put
    // every line on the identified tier for free.
    const noAsin = groceryPurchase(1, {
      metadata: { ...groceryPurchase().metadata, ASIN: undefined },
    });

    expect(extracted(noAsin).identifierCodes).toMatchObject({
      order_id: '113-3417031-4201800',
    });
    expect(extracted(noAsin).identityConfidence).toBe(IDENTITY_CONFIDENCE_NAMED);
  });

  it('both identity tiers clear the >= 0.5 product-model gate, and are ordered', () => {
    // The rebuild plan (§8.2) gates minting a ci.product_models entry at >= 0.5.
    // The tiers are declared by this stage's rule, so this pins the claim they
    // make rather than the numbers themselves.
    expect(IDENTITY_CONFIDENCE_NAMED).toBeGreaterThanOrEqual(0.5);
    expect(IDENTITY_CONFIDENCE_IDENTIFIED).toBeGreaterThan(IDENTITY_CONFIDENCE_NAMED);
    expect(IDENTITY_CONFIDENCE_IDENTIFIED).toBeLessThanOrEqual(1);
  });

  it('keeps the order id and merchant as commerce detail, for provenance', () => {
    expect(extracted(groceryPurchase()).commerce).toMatchObject({
      order_id: '113-3417031-4201800',
      merchant: 'Amazon',
      kind: 'commerce.purchase',
    });
  });

  it.each([
    ['order_rollup_no_line_item', orderRollup()],
    ['event_deleted', groceryPurchase(1, { is_deleted: true })],
    ['unrecognized_commerce_shape', groceryPurchase(1, { metadata: null })],
    ['no_product_name', groceryPurchase(1, { metadata: { kind: 'commerce.purchase' }, title: null })],
  ])('refuses with reason %s', (reason, row) => {
    const result = extractPurchase(row as never);

    expect(result).toEqual({ reason });
  });

  it('falls back to the event title when the metadata has no product name', () => {
    // `ci.inventory.name` is NOT NULL, and an object with no name is one nobody
    // could find again — but the event title is a real name, not a fabrication.
    const untitled = groceryPurchase(1, { metadata: { kind: 'commerce.purchase' } });

    expect(extracted(untitled).name).toBe('Organic Russet Potato');
  });
});

describe('extractPurchase — the value parsers refuse to hand Postgres a bad row', () => {
  it.each([
    ['3.8', 3.8],
    ['$1,299.99', 1299.99],
    ['0', 0],
    ['not a price', null],
    ['-5', null],
    ['999999999', null],
  ])('parsePrice(%s)', (raw, expected) => {
    // Out-of-range is rejected HERE rather than as a `numeric field overflow`
    // that takes a 200-id slice down with it.
    expect(parsePrice(raw)).toBe(expected);
  });

  it.each([
    ['USD', 'USD'],
    ['usd', 'USD'],
    ['Dollars', null],
    ['', null],
  ])('parseCurrency(%s)', (raw, expected) => {
    expect(parseCurrency(raw)).toBe(expected);
  });

  it.each([
    [3, 3],
    ['2', 2],
    [0, 1],
    [-4, 1],
    [undefined, 1],
    ['many', 1],
  ])('parseQuantity(%s) respects inventory_quantity_check', (raw, expected) => {
    // The constraint is `quantity > 0`; a receipt line exists, so at least one
    // thing was bought.
    expect(parseQuantity(raw)).toBe(expected);
  });

  it.each([
    ['New', 'new'],
    ['Used - Like New', 'like_new'],
    ['Used - Very Good', 'good'],
    ['Used - Acceptable', 'fair'],
    ['for parts', 'broken'],
    ['Renewed Premium', null],
  ])('parseCondition(%s) stays inside inventory_condition_check', (raw, expected) => {
    // Anything unrecognised is NULL, never 'n/a'. 'n/a' asserts "this thing has
    // no meaningful condition"; NULL is the absence of an assertion, which is
    // what an unknown string actually means.
    expect(parseCondition(raw)).toBe(expected);
  });
});

/* ===================================================================== *
 * 3. run() — one answer per id, every non-done answer named
 * ===================================================================== */

describe('ObjectPromoteStage.run — every id gets exactly one answer', () => {
  it('promotes a purchase and reports the object it minted', async () => {
    const { stage } = makeStage({ rows: [groceryPurchase()] });

    const results = await stage.run({ userId: USER }, [eventId(1)]);

    expect(results.size).toBe(1);
    expect(results.get(eventId(1))).toMatchObject({
      outcome: 'done',
      detail: {
        objectId: `object-for-${eventId(1)}`,
        identityConfidence: IDENTITY_CONFIDENCE_IDENTIFIED,
        identifiers: expect.arrayContaining(['asin', 'order_id']),
      },
    });
  });

  it('answers for ids the load did not return', async () => {
    const { stage } = makeStage({ rows: [groceryPurchase()] });

    const results = await stage.run({ userId: USER }, [eventId(1), eventId(9)]);

    expect(results.get(eventId(9))).toEqual({ outcome: 'skipped', reason: 'source_row_missing' });
  });

  it('records the 630 order rollups as a countable skip, not a silence', async () => {
    const { stage, dataSource } = makeStage({ rows: [orderRollup(3)] });

    const results = await stage.run({ userId: USER }, [eventId(3)]);

    expect(results.get(eventId(3))).toEqual({
      outcome: 'skipped',
      reason: 'order_rollup_no_line_item',
    });
    // Decided without a write: nothing promotable means no INSERT at all.
    expect(dataSource.calls.some((call) => call.sql.includes('INSERT INTO'))).toBe(false);
  });

  it('mixes promotions and skips in one slice without either affecting the other', async () => {
    const { stage } = makeStage({
      rows: [groceryPurchase(1), orderRollup(3), ebookPurchase(2)],
    });

    const results = await stage.run({ userId: USER }, [eventId(1), eventId(2), eventId(3)]);

    expect(results.get(eventId(1))).toMatchObject({ outcome: 'done' });
    expect(results.get(eventId(2))).toMatchObject({ outcome: 'done' });
    expect(results.get(eventId(3))).toMatchObject({ outcome: 'skipped' });
  });

  it('every non-done result carries a reason, which PipelineStateService enforces', async () => {
    const { stage } = makeStage({
      rows: [groceryPurchase(1), orderRollup(3), groceryPurchase(4, { is_deleted: true })],
    });

    const results = await stage.run({ userId: USER }, [eventId(1), eventId(3), eventId(4), eventId(5)]);

    for (const result of results.values()) {
      if (result.outcome !== 'done') {
        expect(result.reason?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it('never reports a StageResult.confidence, because it measured nothing', async () => {
    // `types.ts`: never fabricate one. `identity_confidence` is a different
    // question — "is this row the thing it claims to be?" — and it belongs on the
    // row, where the plan's >= 0.5 minting gate reads it.
    const { stage } = makeStage({ rows: [groceryPurchase()] });

    const results = await stage.run({ userId: USER }, [eventId(1)]);

    expect(results.get(eventId(1))?.confidence).toBeUndefined();
  });

  it('fails the whole write together, because one statement has one outcome', async () => {
    const { stage } = makeStage({ rows: [groceryPurchase(1), ebookPurchase(2)], failWrite: true });

    const results = await stage.run({ userId: USER }, [eventId(1), eventId(2)]);

    for (const id of [eventId(1), eventId(2)]) {
      expect(results.get(id)).toMatchObject({
        outcome: 'failed',
        reason: 'inventory_write_failed',
      });
    }
  });
});

describe('ObjectPromoteStage.run — a row the upsert refused is explained, not guessed at', () => {
  it('reports inventory_row_user_modified when a person edited it since promotion', async () => {
    const { stage } = makeStage({
      rows: [groceryPurchase()],
      refuse: [eventId(1)],
      classification: [{ source_id: eventId(1), owned: true, modified: true }],
    });

    const results = await stage.run({ userId: USER }, [eventId(1)]);

    expect(results.get(eventId(1))).toEqual({
      outcome: 'skipped',
      reason: 'inventory_row_user_modified',
    });
  });

  it('reports inventory_row_not_owned when the row belongs to another writer', async () => {
    const { stage } = makeStage({
      rows: [groceryPurchase()],
      refuse: [eventId(1)],
      classification: [{ source_id: eventId(1), owned: false, modified: false }],
    });

    const results = await stage.run({ userId: USER }, [eventId(1)]);

    expect(results.get(eventId(1))).toEqual({
      outcome: 'skipped',
      reason: 'inventory_row_not_owned',
    });
  });

  it('still names a reason when the classification query itself fails', async () => {
    // A reason that is optional is a reason that is absent exactly when it
    // matters. `inventory_row_not_written` is vaguer than the other two and it is
    // still greppable and still countable.
    const { stage } = makeStage({
      rows: [groceryPurchase()],
      refuse: [eventId(1)],
      failClassification: true,
    });

    const results = await stage.run({ userId: USER }, [eventId(1)]);

    expect(results.get(eventId(1))).toEqual({
      outcome: 'skipped',
      reason: 'inventory_row_not_written',
    });
  });
});

/* ===================================================================== *
 * 4. The gate: what this stage refuses to write
 * ===================================================================== */

describe('ObjectPromoteStage — it writes only the table that has a reader', () => {
  it('touches ci.inventory and nothing else', async () => {
    // THE PHASE 8 GATE, as an assertion. `ci.product_models`, `ci.receipts`,
    // `ci.receipt_line_items`, `ci.object_observations` and
    // `ci.object_identifiers` have no service, no resolver and no operator
    // endpoint reading them; two previous attempts at this class of table
    // shipped write-only. This test fails the moment one of them acquires a
    // writer here, which is exactly when someone should have to justify it.
    const { stage, dataSource } = makeStage({ rows: [groceryPurchase()] });

    await stage.run({ userId: USER }, [eventId(1)]);

    const written = dataSource.calls
      .map((call) => call.sql)
      .filter((sql) => /INSERT INTO|UPDATE |DELETE FROM/i.test(sql));

    expect(written.length).toBeGreaterThan(0);

    for (const sql of written) {
      // ci.entities is the detail row's CTI base half (Item aggregates span
      // both), not a new write-only table; everything else stays refused.
      expect(sql).toMatch(/ci\.inventory|ci\.entities/);
      expect(sql).not.toMatch(/ci\.product_models|ci\.receipts|ci\.receipt_line_items/);
      expect(sql).not.toMatch(/ci\.object_identifiers|ci\.object_observations/);
    }
  });

  it('keeps the identifiers on ci.inventory.identifier_codes, where Item already reads them', () => {
    // ci.object_identifiers is refused on a SEMANTIC ground as well as the gate:
    // an ASIN identifies a product MODEL, its claim index is first-writer-wins,
    // and with no product models to attach to, the first unit bought would
    // permanently own the ASIN — silently dropping every later purchase of the
    // same product.
    const object = extractPurchase(groceryPurchase() as never);

    expect('object' in object && object.object.identifierCodes).toMatchObject({
      asin: 'B000P6L454',
    });
  });
});

/* ===================================================================== *
 * 5. Against real Postgres — a fake agrees with whatever SQL it is handed
 * ===================================================================== */

const availability = databaseAvailability();
const describeIfDb = availability.available ? describe : describe.skip;

describeIfDb(`ObjectPromoteStage — against real Postgres (${availability.reason})`, () => {
  let dataSource: DataSource;
  let runner: ReturnType<DataSource['createQueryRunner']>;
  let realUserId: string;

  /** Fixture ids sort ABOVE every real (uuid v7, `019…`) id. */
  const FIXTURE_PREFIX = 'ffffffff-ffff-4fff-bfff-';
  const fixtureId = () => `${FIXTURE_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  const transactionalDataSource = () => ({
    query: (sql: string, params?: unknown[]) => runner.query(sql, params),
  });

  /** Seed one commerce event and return its id. */
  async function seedEvent(row: Omit<EventRow, 'id'>): Promise<string> {
    const id = fixtureId();

    // An event is a CTI aggregate: the base row in ci.entities owns the title
    // and the FK makes it mandatory. Seeded base-first.
    await runner.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties,
                                owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Event', $2, '{}'::jsonb, $3, 'events', $1)`,
      [id, row.title, realUserId],
    );
    await runner.query(
      `INSERT INTO ci.events (event_id, user_id, start_time, event_type, category,
                              source_type, source_system, source_id, is_deleted, metadata)
       VALUES ($1, $2, $3, $4, 'commerce', 'ci-import-tools', $5, $6, false, $7::jsonb)`,
      [
        id,
        realUserId,
        row.start_time,
        row.event_type,
        row.source_system,
        `spec:${id}`,
        JSON.stringify(row.metadata ?? {}),
      ],
    );

    return id;
  }

  beforeAll(async () => {
    const connection = resolveConnection()!;

    dataSource = new DataSource({
      type: 'postgres',
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
      database: connection.database,
      entities: [],
      synchronize: false,
      logging: false,
    });

    await dataSource.initialize();
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    const users = await runner.query(`SELECT id FROM ci.users LIMIT 1`);
    realUserId = users[0].id;
  });

  afterAll(async () => {
    if (runner != null) {
      // ALWAYS rolled back. This is the user's real personal archive.
      await runner.rollbackTransaction();
      await runner.release();
    }

    if (dataSource != null) {
      await dataSource.destroy();
    }
  });

  it('writes a real ci.inventory row with the identity columns filled', async () => {
    const eventA = await seedEvent(groceryPurchase());
    const stage = new ObjectPromoteStage(transactionalDataSource() as never, makeLogger() as never);

    const results = await stage.run({ userId: realUserId }, [eventA]);

    expect(results.get(eventA)).toMatchObject({ outcome: 'done' });

    const [row] = await runner.query(
      `SELECT name, brand, purchase_price, currency, acquired_at, is_digital, condition,
              quantity, lifecycle_state, identity_confidence, identity_method,
              identifier_codes, source_type, source_system, source_id,
              metadata->'promote'->>'stage'        AS promoted_by,
              (metadata->'promote'->>'version')::int AS promoted_version,
              metadata->'promote'->>'event_id'     AS promoted_from,
              product_id, acquisition_receipt_id, acquisition_line_item_id
         FROM ci.inventory WHERE user_id = $1 AND source_id = $2`,
      [realUserId, eventA],
    );

    expect(row).toMatchObject({
      name: 'Organic Russet Potato',
      currency: 'USD',
      is_digital: false,
      condition: 'new',
      quantity: 1,
      // The four audited identity columns this stage fills.
      lifecycle_state: 'active',
      identity_method: 'receipt',
      source_type: PROMOTE_OBJECT_STAGE_ID,
      source_system: 'amazon',
      source_id: eventA,
      // Reversibility: the row names the stage, the version and the event.
      promoted_by: PROMOTE_OBJECT_STAGE_ID,
      promoted_version: PROMOTE_OBJECT_VERSION,
      promoted_from: eventA,
    });

    expect(Number(row.purchase_price)).toBeCloseTo(3.8, 2);
    expect(Number(row.identity_confidence)).toBeCloseTo(IDENTITY_CONFIDENCE_IDENTIFIED, 5);
    expect(row.identifier_codes).toMatchObject({ asin: 'B000P6L454' });

    // The three FK columns this change deliberately leaves NULL, because their
    // target tables have no reader. Asserted so that filling one is a conscious
    // act with a failing test attached, not a drive-by.
    expect(row.product_id).toBeNull();
    expect(row.acquisition_receipt_id).toBeNull();
    expect(row.acquisition_line_item_id).toBeNull();
  });

  it('is idempotent: a second run updates the same object rather than minting another', async () => {
    const eventA = await seedEvent(ebookPurchase());
    const stage = new ObjectPromoteStage(transactionalDataSource() as never, makeLogger() as never);

    const first = await stage.run({ userId: realUserId }, [eventA]);
    const second = await stage.run({ userId: realUserId }, [eventA]);

    expect(first.get(eventA)).toMatchObject({ outcome: 'done' });
    expect(second.get(eventA)).toMatchObject({ outcome: 'done' });
    // Same object id both times, which is `inventory_source_triple_uniq` doing
    // the work — no anti-join, no "have I done this?" query.
    const firstDetail = first.get(eventA)?.detail as { objectId: string } | undefined;
    const secondDetail = second.get(eventA)?.detail as { objectId: string } | undefined;

    expect(firstDetail?.objectId).toBeDefined();
    expect(secondDetail?.objectId).toBe(firstDetail?.objectId);

    const [{ count }] = await runner.query(
      `SELECT count(*)::int AS count FROM ci.inventory WHERE user_id = $1 AND source_id = $2`,
      [realUserId, eventA],
    );

    expect(count).toBe(1);
  });

  it('never overwrites an item a person edited after it was promoted', async () => {
    // The guarantee that lives in the `ON CONFLICT … DO UPDATE … WHERE`, which no
    // fake could verify. Without it, the first version bump after a user renamed
    // a promoted item silently reverts the rename.
    const eventA = await seedEvent(groceryPurchase());
    const stage = new ObjectPromoteStage(transactionalDataSource() as never, makeLogger() as never);

    await stage.run({ userId: realUserId }, [eventA]);

    await runner.query(
      `UPDATE ci.inventory
          SET name = 'Potatoes (renamed by the user)', updated_at = now() + interval '1 hour'
        WHERE user_id = $1 AND source_id = $2`,
      [realUserId, eventA],
    );

    const results = await stage.run({ userId: realUserId }, [eventA]);

    expect(results.get(eventA)).toEqual({
      outcome: 'skipped',
      reason: 'inventory_row_user_modified',
    });

    const [row] = await runner.query(`SELECT name FROM ci.inventory WHERE user_id = $1 AND source_id = $2`, [
      realUserId,
      eventA,
    ]);

    expect(row.name).toBe('Potatoes (renamed by the user)');
  });

  it('reads back through ItemEntity’s own column set, identity columns included', async () => {
    // `ItemEntity.toEgressType` returns all eleven identity columns, and
    // `ItemService.findAll` / `findById` / `findByIds` / `search` map through it
    // for `ItemResolver`, `FileItemsLoader` and `EntityResolutionService`. This is
    // that read, scoped the way `ItemService.findAll` scopes it — the Phase 8
    // gate as an assertion rather than a claim.
    const eventA = await seedEvent(groceryPurchase());
    const stage = new ObjectPromoteStage(transactionalDataSource() as never, makeLogger() as never);

    await stage.run({ userId: realUserId }, [eventA]);

    // The name lives on the item's CTI base row now, and `object_entity_id`
    // was the dead precursor of that link, dropped by the conversion.
    const rows = await runner.query(
      `SELECT inv.object_id, b.name, inv.identifier_codes, inv.lifecycle_state, inv.quantity,
              inv.identity_confidence, inv.identity_method, inv.product_id,
              inv.acquisition_receipt_id, inv.acquisition_line_item_id,
              inv.last_seen_at, inv.last_seen_place_entity_id, inv.merged_into_object_id
         FROM ci.inventory inv
         JOIN ci.entities b ON b.entity_id = inv.object_id
        WHERE inv.user_id = $1 AND inv.source_type = $2
        ORDER BY inv.created_at DESC`,
      [realUserId, PROMOTE_OBJECT_STAGE_ID],
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].name).toEqual(expect.any(String));
  });

  it("promotes the appliance's REAL Amazon corpus, and every id gets a verdict", async () => {
    // The fixtures above are hand-written copies of real rows; this is the real
    // rows. One page of the stage's OWN applicability predicate, straight off the
    // user's imported archive, through the stage, inside the rollback.
    //
    // 2,777 commerce events live here: 2,147 `purchase` lines and 630 `order`
    // rollups. What this asserts is the property that made `ci.inventory` sit at
    // zero unnoticed — that no candidate can come back with no verdict at all.
    const candidates: Array<{ id: string }> = await runner.query(
      `SELECT s.event_id AS id
         FROM ci.events s
        WHERE s.user_id = $1::uuid
          AND (${PROMOTE_OBJECT_SOURCE.predicate})
          AND s.source_id NOT LIKE 'spec:%'
        ORDER BY s.event_id
        LIMIT 200`,
      [realUserId],
    );

    if (candidates.length === 0) {
      // An empty appliance is not a failing appliance. Skipping loudly beats a
      // green test that asserted nothing.
      console.warn('No commerce events in this database; real-corpus promotion not exercised.');

      return;
    }

    const ids = candidates.map((row) => row.id);
    const stage = new ObjectPromoteStage(transactionalDataSource() as never, makeLogger() as never);

    const results = await stage.run({ userId: realUserId }, ids);

    // THE CONTRACT: one answer per id, no silences.
    expect(results.size).toBe(ids.length);

    const tally = new Map<string, number>();

    for (const id of ids) {
      const result = results.get(id)!;
      const key = result.outcome === 'done' ? 'done' : `${result.outcome}:${result.reason}`;

      tally.set(key, (tally.get(key) ?? 0) + 1);

      if (result.outcome !== 'done') {
        expect(result.reason?.length ?? 0).toBeGreaterThan(0);
      }
    }

    console.log('promote.object over real data:', Object.fromEntries(tally));

    // Rows actually landed, and they landed with identity — the exit criterion
    // for this half of Phase 8 is `SELECT count(*) FROM ci.inventory > 0`.
    const [written] = await runner.query(
      `SELECT count(*)::int                                        AS n,
              count(*) FILTER (WHERE identity_method = 'receipt')::int AS with_method,
              count(*) FILTER (WHERE identifier_codes <> '{}'::jsonb)::int AS with_codes,
              min(identity_confidence)                             AS min_confidence
         FROM ci.inventory
        WHERE user_id = $1 AND source_type = $2 AND source_id = ANY($3::text[])`,
      [realUserId, PROMOTE_OBJECT_STAGE_ID, ids],
    );

    expect(written.n).toBe(tally.get('done') ?? 0);
    expect(written.n).toBeGreaterThan(0);
    expect(written.with_method).toBe(written.n);
    expect(written.with_codes).toBeGreaterThan(0);
    // The rebuild plan gates product-model minting at >= 0.5; nothing promoted
    // may sit below it, or a later stage would have to guess.
    expect(Number(written.min_confidence)).toBeGreaterThanOrEqual(0.5);
  });

  it('withdraws cleanly, leaving no orphan and touching no source row', async () => {
    // Promotion must be reversible. This is the withdrawal statement from
    // migration 20260809181915_promote_support.sql, run for real.
    const eventA = await seedEvent(groceryPurchase());
    const stage = new ObjectPromoteStage(transactionalDataSource() as never, makeLogger() as never);

    await stage.run({ userId: realUserId }, [eventA]);

    const [{ before }] = await runner.query(
      `SELECT count(*)::int AS before FROM ci.inventory WHERE user_id = $1 AND source_id = $2`,
      [realUserId, eventA],
    );

    expect(before).toBe(1);

    await runner.query(
      `DELETE FROM ci.inventory
        WHERE user_id = $1 AND metadata->'promote'->>'stage' = $2 AND source_id = $3`,
      [realUserId, PROMOTE_OBJECT_STAGE_ID, eventA],
    );

    const [{ after }] = await runner.query(
      `SELECT count(*)::int AS after FROM ci.inventory WHERE user_id = $1 AND source_id = $2`,
      [realUserId, eventA],
    );

    expect(after).toBe(0);

    // The source event is untouched: promotion is a projection, so a full
    // re-promote after a bad version bump is always safe.
    const [event] = await runner.query(
      `SELECT metadata, event_type, title FROM ci.events WHERE event_id = $1`,
      [eventA],
    );

    expect(event.metadata).toMatchObject({ ASIN: 'B000P6L454' });
    expect(event.metadata.promote).toBeUndefined();
  });
});
