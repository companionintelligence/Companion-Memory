import type { UserServiceContext } from '@ci/common/context';

import {
  MINT_ACQUISITION_METHOD,
  MINT_IDENTITY_CONFIDENCE,
  MINT_IDENTITY_METHOD,
  MINT_LIFECYCLE_STATE,
  MINT_SOURCE_TYPE,
  type MintLineInput,
  type MintReceiptContext,
  ObjectMintService,
} from './ObjectMintService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const RECEIPT = '00000000-0000-0000-0000-0000000000b1';
const LINE_A = '00000000-0000-0000-0000-0000000000c1';
const LINE_B = '00000000-0000-0000-0000-0000000000c2';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

const RECEIPT_CONTEXT: MintReceiptContext = {
  receiptId: RECEIPT,
  sourceSystem: 'amazon',
  purchasedAt: new Date('2026-03-02T10:00:00Z'),
  placeEntityId: '00000000-0000-0000-0000-0000000000d1',
  merchantName: 'Amazon',
  merchantEntityId: '00000000-0000-0000-0000-0000000000e1',
  currency: 'USD',
};

function line(overrides: Partial<MintLineInput> = {}): MintLineInput {
  return {
    lineItemId: LINE_A,
    description: 'AA battery, 6 pack',
    quantity: 1,
    unitPriceMinor: 1299,
    totalPriceMinor: 1299,
    currency: 'USD',
    productId: null,
    brand: null,
    modelNumber: null,
    category: null,
    isPhysical: true,
    ...overrides,
  };
}

interface Harness {
  service: ObjectMintService;
  statements: Array<{ sql: string; params: unknown[] }>;
  recordMany: jest.Mock;
}

function makeHarness(): Harness {
  const statements: Array<{ sql: string; params: unknown[] }> = [];

  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });

    if (sql.includes('INSERT INTO ci.objects')) {
      // Every generated object id comes back as a genuine insert.
      const objectIds = params[7] as string[];

      return objectIds.map((objectId) => ({ object_id: objectId, inserted: true }));
    }

    if (sql.includes('SELECT object_id, source_id')) {
      // The DB agrees with the ids we generated (no pre-existing rows).
      const sourceIds = params[3] as string[];
      const insert = statements.find((s) => s.sql.includes('INSERT INTO ci.objects'));
      const objectIds = (insert?.params[7] ?? []) as string[];

      return sourceIds.map((sourceId, index) => ({
        object_id: objectIds[index],
        source_id: sourceId,
      }));
    }

    return [];
  });

  const em = { query };
  const dataSource = { transaction: jest.fn(async (cb: (m: typeof em) => Promise<unknown>) => cb(em)) };
  const recordMany = jest.fn(async () => undefined);
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new ObjectMintService(dataSource as never, { recordMany } as never, logger as never);

  return { service, statements, recordMany };
}

function objectInsert(harness: Harness) {
  const found = harness.statements.find(({ sql }) => sql.includes('INSERT INTO ci.objects'));

  if (found == null) {
    throw new Error('no ci.objects INSERT was issued');
  }

  return found;
}

describe('ObjectMintService', () => {
  it('mints ONE unit carrying the quantity, not one unit per count', async () => {
    const harness = makeHarness();

    const [result] = await harness.service.mintFromLines(CONTEXT, RECEIPT_CONTEXT, [line({ quantity: 6 })]);

    expect(result.objectIds).toHaveLength(1);

    const insert = objectInsert(harness);
    // params[19] is the quantity array (see the unnest column order).
    expect(insert.params[18]).toEqual([6]);
    // The arbiter is the bare line id: no serial split happened.
    expect(insert.params[9]).toEqual([LINE_A]);
  });

  it('mints one unit PER SERIAL when the line distinguishes them', async () => {
    const harness = makeHarness();

    const [result] = await harness.service.mintFromLines(CONTEXT, RECEIPT_CONTEXT, [
      line({ quantity: 3, serials: ['SN-1', 'SN-2', 'SN-3'] }),
    ]);

    expect(result.objectIds).toHaveLength(3);

    const insert = objectInsert(harness);
    expect(insert.params[9]).toEqual([`${LINE_A}#SN-1`, `${LINE_A}#SN-2`, `${LINE_A}#SN-3`]);
    // Each row is one unit now — the count does not travel with them.
    expect(insert.params[18]).toEqual([1, 1, 1]);
  });

  it('de-duplicates repeated serials rather than minting the same unit twice', async () => {
    const harness = makeHarness();

    const [result] = await harness.service.mintFromLines(CONTEXT, RECEIPT_CONTEXT, [
      line({ serials: ['SN-1', 'SN-1'] }),
    ]);

    expect(result.objectIds).toHaveLength(1);
  });

  it('never mints for a digital line', async () => {
    const harness = makeHarness();

    const results = await harness.service.mintFromLines(CONTEXT, RECEIPT_CONTEXT, [
      line({ lineItemId: LINE_A, isPhysical: false }),
      line({ lineItemId: LINE_B, isPhysical: true }),
    ]);

    expect(results.find((r) => r.lineItemId === LINE_A)?.objectIds).toEqual([]);
    expect(results.find((r) => r.lineItemId === LINE_B)?.objectIds).toHaveLength(1);
    expect(objectInsert(harness).params[9]).toEqual([LINE_B]);
  });

  it('issues no statement at all when every line is digital', async () => {
    const harness = makeHarness();

    const results = await harness.service.mintFromLines(CONTEXT, RECEIPT_CONTEXT, [
      line({ isPhysical: false }),
    ]);

    expect(results).toEqual([{ lineItemId: LINE_A, objectIds: [], inserted: 0 }]);
    expect(harness.statements).toHaveLength(0);
  });

  it('writes the lifecycle/identity constants the CHECK constraints actually accept', async () => {
    const harness = makeHarness();

    await harness.service.mintFromLines(CONTEXT, RECEIPT_CONTEXT, [line()]);

    const insert = objectInsert(harness);
    expect(insert.params[2]).toBe(MINT_LIFECYCLE_STATE);
    expect(insert.params[3]).toBe(MINT_IDENTITY_CONFIDENCE);
    expect(insert.params[4]).toBe(MINT_IDENTITY_METHOD);
    expect(insert.params[5]).toBe(MINT_SOURCE_TYPE);
    expect(insert.params[22]).toBe(MINT_ACQUISITION_METHOD);

    // 'owned' is not in objects_lifecycle_state_check and would fail every row.
    expect(MINT_LIFECYCLE_STATE).toBe('active');
    // 'purchase' is not in objects_acquisition_method_check.
    expect(MINT_ACQUISITION_METHOD).toBe('purchased');
    // Receipt-derived identity must stay below the 1.0 ground-truth tier.
    expect(MINT_IDENTITY_CONFIDENCE).toBeLessThan(1);
  });

  it('keys idempotency on the receipt source system plus the line id', async () => {
    const harness = makeHarness();

    await harness.service.mintFromLines(CONTEXT, RECEIPT_CONTEXT, [line()]);

    const insert = objectInsert(harness);
    expect(insert.sql).toContain('ON CONFLICT (owner_user_id, source_system, source_id)');
    expect(insert.sql).toContain('WHERE source_id IS NOT NULL');
    expect(insert.params[6]).toBe('amazon');
  });

  it('refuses to refresh a row another writer owns', async () => {
    const harness = makeHarness();

    await harness.service.mintFromLines(CONTEXT, RECEIPT_CONTEXT, [line()]);

    const insert = objectInsert(harness);
    expect(insert.sql).toContain("inv.metadata->'mint'->>'service' = 'ObjectMintService'");
    // A re-extraction must not resurrect a thing the user threw away.
    expect(insert.sql).not.toContain('lifecycle_state     = excluded');
  });

  it('writes the CTI base row and links the line back to the unit', async () => {
    const harness = makeHarness();

    await harness.service.mintFromLines(CONTEXT, RECEIPT_CONTEXT, [line()]);

    const base = harness.statements.find(({ sql }) => sql.includes('INSERT INTO ci.entities'));
    expect(base?.sql).toContain("'Item'");
    expect(base?.params[2]).toEqual(['AA battery, 6 pack']);

    const link = harness.statements.find(({ sql }) => sql.includes('UPDATE ci.receipt_line_items'));
    expect(link?.sql).toContain('minted_object_id');
    expect(link?.params[1]).toEqual([LINE_A]);

    expect(harness.recordMany).toHaveBeenCalledTimes(1);
  });

  it('converts minor units to the legacy decimal column with the currency exponent', async () => {
    const harness = makeHarness();

    await harness.service.mintFromLines(CONTEXT, { ...RECEIPT_CONTEXT, currency: 'JPY' }, [
      line({ currency: 'JPY', unitPriceMinor: 1200, totalPriceMinor: 1200 }),
    ]);

    // JPY has no minor unit: ¥1,200 is 1200, not 12.
    expect(objectInsert(harness).params[14]).toEqual([1200]);
  });

  it('rounds a fractional quantity up rather than violating quantity > 0', async () => {
    const harness = makeHarness();

    await harness.service.mintFromLines(CONTEXT, RECEIPT_CONTEXT, [line({ quantity: 1.5 })]);

    expect(objectInsert(harness).params[18]).toEqual([2]);
  });
});
