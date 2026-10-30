import type { UserServiceContext } from '@ci/common/context';
import { ReceiptUpdatedEvent } from '@ci/domains/memory/events';

import type { ReceiptLineItem } from '../entities/ReceiptLineItemEntity';
import { platformIdentity } from '../identity';
import type { ReceiptExtraction } from '../types';

import {
  OCR_IDENTIFIER_CONFIDENCE,
  ReceiptService,
  STRUCTURED_IDENTIFIER_CONFIDENCE,
} from './ReceiptService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const RECEIPT = '00000000-0000-0000-0000-0000000000b1';
const LINE_1 = '00000000-0000-0000-0000-0000000000c1';
const PRODUCT = '00000000-0000-0000-0000-0000000000d1';
const OBJECT = '00000000-0000-0000-0000-0000000000e1';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

function persistedLine(overrides: Partial<ReceiptLineItem> = {}): ReceiptLineItem {
  return {
    id: LINE_1,
    receiptId: RECEIPT,
    userId: USER,
    ownerUserId: USER,
    lineNumber: 1,
    description: 'Sony WH-1000XM5',
    quantity: 1,
    unitPriceMinor: 39900,
    totalPriceMinor: 39900,
    currency: 'USD',
    productId: null,
    brand: 'Sony',
    modelNumber: 'WH-1000XM5',
    category: null,
    isPhysical: true,
    mintedObjectId: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ReceiptLineItem;
}

interface Harness {
  service: ReceiptService;
  statements: Array<{ sql: string; params: unknown[] }>;
  saveHeader: jest.Mock;
  upsertForSubjects: jest.Mock;
  resolveIdentifier: jest.Mock;
  findOrCreateByBrandModel: jest.Mock;
  mintFromLines: jest.Mock;
  lines: ReceiptLineItem[];
  warn: jest.Mock;
  update: jest.Mock;
  send: jest.Mock;
}

function makeHarness(options: { lines?: ReceiptLineItem[]; strandedLineNumbers?: number[] } = {}): Harness {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const lines = options.lines ?? [persistedLine()];

  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });

    if (sql.includes('DELETE FROM ci.receipt_line_items')) {
      return [];
    }

    if (sql.includes('SELECT line_number')) {
      return (options.strandedLineNumbers ?? []).map((line_number) => ({ line_number }));
    }

    return [];
  });

  const lineRepository: Record<string, unknown> = {
    metadata: { columns: { length: 18 } },
    find: jest.fn(async () => lines),
  };
  // A real repository's `.manager` is a full EntityManager, so replaceLineItems
  // can hand it straight back to findLines.
  lineRepository.manager = { query, withRepository: () => lineRepository };

  const receiptEntity = {
    id: RECEIPT,
    sourceSystem: 'amazon',
    purchasedAt: new Date('2026-03-02T10:00:00Z'),
    placeEntityId: null,
    merchantName: 'Amazon',
    merchantEntityId: null,
    currency: 'USD',
  };

  const saveHeader = jest.fn(async () => receiptEntity);
  const em = {
    query,
    withRepository: (repo: unknown) =>
      repo === lineRepository ? lineRepository : { findOne: jest.fn(async () => null), save: saveHeader },
  };

  const update = jest.fn(async () => undefined);

  const receiptRepository = {
    manager: {
      query,
      transaction: jest.fn(async (cb: (m: typeof em) => Promise<unknown>) => cb(em)),
    },
    findOne: jest.fn(async () => receiptEntity),
    create: (row: unknown) => row,
    save: jest.fn(async (row: unknown) => row),
    update,
    metadata: { columns: { length: 30 } },
  };

  const upsertForSubjects = jest.fn(async () => 1);
  const resolveIdentifier = jest.fn(async () => null);
  const findOrCreateByBrandModel = jest.fn(async () => ({ id: PRODUCT }));
  const mintFromLines = jest.fn(async () => [{ lineItemId: LINE_1, objectIds: [OBJECT], inserted: 1 }]);
  const warn = jest.fn();
  const send = jest.fn(async () => []);
  const logger = { setContext: jest.fn(), log: jest.fn(), warn, error: jest.fn() };

  const service = new ReceiptService(
    receiptRepository as never,
    lineRepository as never,
    { findOrCreateByBrandModel } as never,
    { upsertForSubjects, resolve: resolveIdentifier } as never,
    { mintFromLines } as never,
    { send } as never,
    logger as never,
  );

  return {
    service,
    statements,
    saveHeader,
    upsertForSubjects,
    resolveIdentifier,
    findOrCreateByBrandModel,
    mintFromLines,
    lines,
    warn,
    update,
    send,
  };
}

function statement(harness: Harness, fragment: string) {
  return harness.statements.find(({ sql }) => sql.includes(fragment));
}

describe('ReceiptService.replaceLineItems', () => {
  it('upserts on the (receipt_id, line_number) natural key', async () => {
    const harness = makeHarness();

    await harness.service.replaceLineItems(CONTEXT, RECEIPT, [
      { lineNumber: 1, description: 'Sony WH-1000XM5' },
    ]);

    const insert = statement(harness, 'INSERT INTO ci.receipt_line_items');
    expect(insert?.sql).toContain('ON CONFLICT (receipt_id, line_number)');
    expect(insert?.sql).toContain('DO UPDATE SET');
  });

  it('never clobbers minted_object_id on a re-extraction', async () => {
    const harness = makeHarness();

    await harness.service.replaceLineItems(CONTEXT, RECEIPT, [{ lineNumber: 1, description: 'x' }]);

    // The link to the owned unit belongs to ObjectMintService; overwriting it
    // here would strand a possession whose provenance had just been erased.
    expect(statement(harness, 'INSERT INTO ci.receipt_line_items')?.sql).not.toContain('minted_object_id');
  });

  it('collapses a duplicated line number instead of aborting the whole chunk', async () => {
    const harness = makeHarness();

    await harness.service.replaceLineItems(CONTEXT, RECEIPT, [
      { lineNumber: 1, description: 'first read' },
      { lineNumber: 1, description: 'corrected read' },
      { lineNumber: 2, description: 'second line' },
    ]);

    const insert = statement(harness, 'INSERT INTO ci.receipt_line_items');
    // Two rows, not three: Postgres raises 21000 for an ON CONFLICT DO UPDATE
    // that would touch one arbiter row twice, taking the whole slice with it.
    expect(insert?.params[3]).toEqual([1, 2]);
    expect(insert?.params[4]).toEqual(['corrected read', 'second line']);
  });

  it('deletes only the dropped lines that never minted anything', async () => {
    const harness = makeHarness({ strandedLineNumbers: [7] });

    await harness.service.replaceLineItems(CONTEXT, RECEIPT, [{ lineNumber: 1, description: 'x' }]);

    const del = statement(harness, 'DELETE FROM ci.receipt_line_items');
    expect(del?.sql).toContain('minted_object_id IS NULL');
    expect(del?.params[2]).toEqual([1]);

    // A dropped line that DID mint is kept and reported, because deleting it
    // would SET NULL the owned unit's acquisition_line_item_id.
    expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining('minted owned units'), {
      receiptId: RECEIPT,
      lineNumbers: [7],
    });
  });

  it('deletes every unminted line when the extraction produced none at all', async () => {
    const harness = makeHarness();

    await harness.service.replaceLineItems(CONTEXT, RECEIPT, []);

    expect(statement(harness, 'INSERT INTO ci.receipt_line_items')).toBeUndefined();
    expect(statement(harness, 'DELETE FROM ci.receipt_line_items')?.params[2]).toEqual([]);
  });
});

describe('ReceiptService.upsertFromExtraction', () => {
  const extraction = (overrides: Partial<ReceiptExtraction> = {}): ReceiptExtraction => ({
    sourceType: 'importer',
    ...(() => {
      const identity = platformIdentity('amazon', 'order-1');

      return { sourceSystem: identity.system, sourceId: identity.id };
    })(),
    merchantName: 'Amazon',
    lines: [
      {
        lineNumber: 1,
        description: 'Sony WH-1000XM5',
        brand: 'Sony',
        modelNumber: 'WH-1000XM5',
        identifierCodes: { asin: 'B09XS7JWHH', serial: 'SN-1' },
      },
    ],
    ...overrides,
  });

  it('runs the whole extraction inside ONE transaction', async () => {
    const harness = makeHarness();

    await harness.service.upsertFromExtraction(CONTEXT, extraction());

    // Every step writes a pointer into the step before it; committing them
    // separately can strand a first-writer-wins identifier claim forever.
    expect(harness.upsertForSubjects.mock.calls.every((call) => call[2] != null)).toBe(true);
    expect(harness.findOrCreateByBrandModel.mock.calls[0][2]).toBeDefined();
    expect(harness.mintFromLines.mock.calls[0][3]).toBeDefined();
  });

  it('tries the identifier before guessing from brand+model', async () => {
    const harness = makeHarness();
    harness.resolveIdentifier.mockResolvedValue({ subjectType: 'product_model', subjectId: PRODUCT });

    await harness.service.upsertFromExtraction(CONTEXT, extraction());

    expect(harness.resolveIdentifier).toHaveBeenCalled();
    // A barcode is an answer; there is nothing left to guess.
    expect(harness.findOrCreateByBrandModel).not.toHaveBeenCalled();
  });

  it('falls back to find-or-create and writes the product back onto the line', async () => {
    const harness = makeHarness();

    const result = await harness.service.upsertFromExtraction(CONTEXT, extraction());

    expect(harness.findOrCreateByBrandModel).toHaveBeenCalled();
    expect(statement(harness, 'SET product_id = u.product_id')?.params[2]).toEqual([PRODUCT]);
    expect(result.productsResolved).toBe(1);
  });

  it('files a product code on the model and a serial on the unit', async () => {
    const harness = makeHarness();

    await harness.service.upsertFromExtraction(CONTEXT, extraction());

    const [productBatch] = harness.upsertForSubjects.mock.calls[0][1];
    expect(productBatch.subjectType).toBe('product_model');
    expect(productBatch.identifiers.map((i: { namespace: string }) => i.namespace)).toEqual(['asin']);

    const [instanceBatch] = harness.upsertForSubjects.mock.calls[1][1];
    expect(instanceBatch.subjectType).toBe('object_instance');
    expect(instanceBatch.subjectId).toBe(OBJECT);
    // A GTIN claimed by ONE unit makes every other unit of that model
    // unfindable by barcode — the index is first-writer-wins.
    expect(instanceBatch.identifiers.map((i: { namespace: string }) => i.namespace)).toEqual(['serial']);
  });

  it('grades identifier confidence by how the receipt was read', async () => {
    const ocr = makeHarness();
    await ocr.service.upsertFromExtraction(CONTEXT, extraction({ extractionSource: 'ocr' }));
    expect(ocr.upsertForSubjects.mock.calls[0][1][0].identifiers[0].confidence).toBe(
      OCR_IDENTIFIER_CONFIDENCE,
    );

    const feed = makeHarness();
    await feed.service.upsertFromExtraction(CONTEXT, extraction({ extractionSource: 'structured' }));
    expect(feed.upsertForSubjects.mock.calls[0][1][0].identifiers[0].confidence).toBe(
      STRUCTURED_IDENTIFIER_CONFIDENCE,
    );

    expect(OCR_IDENTIFIER_CONFIDENCE).toBeLessThan(STRUCTURED_IDENTIFIER_CONFIDENCE);
  });

  it('drops identifier keys it has no grammar for rather than filing them as custom', async () => {
    const harness = makeHarness();

    await harness.service.upsertFromExtraction(
      CONTEXT,
      extraction({
        lines: [
          {
            lineNumber: 1,
            description: 'x',
            brand: 'Sony',
            modelNumber: 'WH-1000XM5',
            identifierCodes: { some_vendor_key: 'ZZZ' },
          },
        ],
      }),
    );

    // No claim was promoted: a 'custom' row would take a slot in a
    // first-writer-wins index on the strength of a key nobody can parse.
    expect(harness.upsertForSubjects).not.toHaveBeenCalled();
  });

  it('honours skipMint, leaving the evidence without minting possessions', async () => {
    const harness = makeHarness();

    const result = await harness.service.upsertFromExtraction(CONTEXT, extraction({ skipMint: true }));

    expect(harness.mintFromLines).not.toHaveBeenCalled();
    expect(result.mints).toEqual([]);
  });

  it('marks the receipt extracted so it leaves the pending drain queue', async () => {
    const harness = makeHarness();

    await harness.service.upsertFromExtraction(CONTEXT, extraction());

    // Leaving it 'pending' would put the row straight back on the receipts_
    // extraction_pending_idx queue that just processed it.
    expect(harness.saveHeader).toHaveBeenCalledWith(
      expect.objectContaining({ extractionState: 'extracted' }),
    );
  });

  it('lets an explicit extraction state through — a failed read is not "extracted"', async () => {
    const harness = makeHarness();

    await harness.service.upsertFromExtraction(
      CONTEXT,
      extraction({ extractionState: 'failed', extractionError: 'unreadable' }),
    );

    expect(harness.saveHeader).toHaveBeenCalledWith(
      expect.objectContaining({ extractionState: 'failed', extractionError: 'unreadable' }),
    );
  });
});

describe('ReceiptService.update', () => {
  it('emits ReceiptUpdatedEvent after a genuine field mutation, so search re-indexes it', async () => {
    const harness = makeHarness();

    await harness.service.update(CONTEXT, RECEIPT, { merchantName: 'Amazon Fresh' });

    expect(harness.update).toHaveBeenCalled();
    expect(harness.send).toHaveBeenCalledWith(ReceiptUpdatedEvent, { receiptId: RECEIPT });
  });

  it('does not emit when the patch is empty — nothing changed, nothing to re-index', async () => {
    const harness = makeHarness();

    await harness.service.update(CONTEXT, RECEIPT, {});

    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });
});

/** Records the predicates a query builder was handed, and returns fixed rows. */
function makeQueryBuilderHarness(rows: Array<{ id: string; purchasedAt: Date | null }>) {
  const wheres: Array<{ sql: string; params?: Record<string, unknown> }> = [];
  const orders: Array<[string, string, string | undefined]> = [];
  let limit = 0;

  const qb: Record<string, unknown> = {};
  qb.andWhere = (sql: string, params?: Record<string, unknown>) => {
    wheres.push({ sql, params });

    return qb;
  };

  qb.orderBy = (col: string, dir: string, nulls?: string) => {
    orders.push([col, dir, nulls]);

    return qb;
  };

  qb.addOrderBy = (col: string, dir: string) => {
    orders.push([col, dir, undefined]);

    return qb;
  };

  qb.limit = (value: number) => {
    limit = value;

    return qb;
  };

  qb.getMany = async () => rows;

  const receiptRepository = { createQueryBuilder: () => qb };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new ReceiptService(
    receiptRepository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { send: jest.fn(async () => []) } as never,
    logger as never,
  );

  return { service, wheres, orders, getLimit: () => limit };
}

describe('ReceiptService.find', () => {
  it('orders by the index the migration added, NULLS LAST', async () => {
    const harness = makeQueryBuilderHarness([]);

    await harness.service.find(CONTEXT);

    expect(harness.orders).toEqual([
      ['receipt.purchased_at', 'DESC', 'NULLS LAST'],
      ['receipt.receipt_id', 'DESC', undefined],
    ]);
  });

  it('fetches one sentinel row past the page instead of a second COUNT', async () => {
    const harness = makeQueryBuilderHarness([]);

    await harness.service.find(CONTEXT, { limit: 10 });

    expect(harness.getLimit()).toBe(11);
  });

  it('keeps the undated tail reachable when the cursor has a timestamp', async () => {
    const harness = makeQueryBuilderHarness([]);
    const after = new Date('2026-03-02T10:00:00Z');

    await harness.service.find(CONTEXT, { limit: 10, afterPurchasedAt: after, afterId: RECEIPT });

    const seek = harness.wheres.find(({ sql }) => sql.includes('afterPurchasedAt'));
    // NULLS LAST puts undated receipts AFTER every dated one, so a bare
    // `purchased_at < :cursor` drops all of them from every page but the first.
    expect(seek?.sql).toContain('receipt.purchased_at IS NULL');
    expect(seek?.sql).toContain('receipt.purchased_at < :afterPurchasedAt');
    expect(seek?.sql).toContain('receipt.receipt_id < :afterId');
  });

  it('breaks ties on the id alone once the cursor is inside the undated tail', async () => {
    const harness = makeQueryBuilderHarness([]);

    await harness.service.find(CONTEXT, { limit: 10, afterPurchasedAt: null, afterId: RECEIPT });

    const seek = harness.wheres.find(({ sql }) => sql.includes('afterId'));
    expect(seek?.sql).toBe('receipt.purchased_at IS NULL AND receipt.receipt_id < :afterId');
  });

  it('matches part of the merchant name, in any case', async () => {
    const harness = makeQueryBuilderHarness([]);

    await harness.service.find(CONTEXT, { merchantName: ' amaz ' });

    expect(harness.wheres).toContainEqual({
      sql: 'receipt.merchant_name ILIKE :merchantPattern',
      params: { merchantPattern: '%amaz%' },
    });
  });

  it('matches LIKE wildcards in the search literally', async () => {
    const harness = makeQueryBuilderHarness([]);

    await harness.service.find(CONTEXT, { merchantName: '100%_off\\' });

    expect(harness.wheres).toContainEqual({
      sql: 'receipt.merchant_name ILIKE :merchantPattern',
      params: { merchantPattern: '%100\\%\\_off\\\\%' },
    });
  });

  it('does not filter on a blank search', async () => {
    const harness = makeQueryBuilderHarness([]);

    await harness.service.find(CONTEXT, { merchantName: '   ' });

    expect(harness.wheres.some(({ sql }) => sql.includes('merchant_name'))).toBe(false);
  });

  it('reports hasMore and a cursor only when the sentinel row came back', async () => {
    const rows = [
      { id: 'r1', purchasedAt: new Date('2026-03-02T10:00:00Z') },
      { id: 'r2', purchasedAt: new Date('2026-03-01T10:00:00Z') },
    ];

    const full = makeQueryBuilderHarness(rows);
    const page = await full.service.find(CONTEXT, { limit: 1 });
    expect(page.receipts).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual({ purchasedAt: rows[0].purchasedAt, id: 'r1' });

    const last = makeQueryBuilderHarness([rows[0]]);
    const lastPage = await last.service.find(CONTEXT, { limit: 1 });
    expect(lastPage.hasMore).toBe(false);
    expect(lastPage.nextCursor).toBeNull();
  });
});
