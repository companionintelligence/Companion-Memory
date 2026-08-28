import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ReceiptEntity } from '../../entities/ReceiptEntity';
import { ReceiptLineItemEntity } from '../../entities/ReceiptLineItemEntity';
import { ReceiptService } from '../ReceiptService';

/**
 * The provenance lookup and the line-item upsert, EXECUTED against Postgres.
 *
 * `ReceiptService.spec.ts` mocks the repository, so it cannot see either of the
 * two things that actually go wrong here:
 *
 *  1. WHICH ROW a `where` clause matches. TypeORM 0.3.30 drops an `undefined`
 *     (and a bare `null`) where-value from the generated SQL — the default
 *     `invalidWhereValuesBehavior` is `"ignore"` and this repo sets no
 *     override — so `sourceSystem: extraction.sourceSystem ?? undefined` did
 *     not mean "match NULL", it meant "do not constrain source_system". A mock
 *     repository returns whatever the test told it to and never notices. The
 *     live arbiter is `receipts_source_triple_uniq (owner_user_id, source_type,
 *     source_system, source_id) NULLS NOT DISTINCT`, so NULL is a real key
 *     value and the lookup has to say so.
 *  2. WHAT SURVIVES a save on a matched row. `toEntity` materialises every
 *     header column with `?? null`; saving its output over a matched row
 *     silently nulls merchant, totals, payment_last4, order_number, channel and
 *     metadata. Only a read-back proves the patch preserved them.
 *
 * Opt-in: set `MEMORY_TEST_DATABASE_URL` (or `DATABASE_URL`) to a database with
 * the migrations applied; this suite SKIPS legibly when nothing is reachable.
 *
 *   MEMORY_TEST_DATABASE_URL=postgres://companion:pw@localhost:5432/companion \
 *     yarn workspace @ci/be-api jest ReceiptService.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/ReceiptService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`ReceiptService — provenance and line upserts, in Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: ReceiptService;

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
      entities: [ReceiptEntity, ReceiptLineItemEntity],
    });
    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/ReceiptService.integration');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [owner.userId, 'Receipt spec fixture', `receipt.${owner.userId}@example.invalid`],
    );

    // Only the header/line halves are under test; product resolution, identifier
    // promotion and minting each have their own suite, and every extraction here
    // sets `skipMint`.
    service = new ReceiptService(
      dataSource.getRepository(ReceiptEntity),
      dataSource.getRepository(ReceiptLineItemEntity),
      { findOrCreateByBrandModel: async () => null } as never,
      { resolve: async () => null, upsertForSubjects: async () => 0 } as never,
      { mintFromLines: async () => [] } as never,
      { send: async () => [] } as never,
      noopLogger,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.receipt_line_items WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.receipts WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [owner.userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  const rawReceipt = async (id: string) => {
    const [row] = await dataSource.query(
      `SELECT merchant_name, purchased_at, total_minor, tax_minor, payment_last4, order_number,
              channel, currency, metadata, source_type, source_system, source_id, extraction_state
         FROM ci.receipts WHERE receipt_id = $1`,
      [id],
    );

    return row as Record<string, unknown> | undefined;
  };

  // ── F4, first half: the dropped predicate ───────────────────────────────

  it('does NOT match a receipt imported under a source_system when the extraction carries none', async () => {
    const sourceId = `order-${uuidv7()}`;

    const imported = await service.create(owner, {
      merchantName: 'Amazon',
      sourceType: 'order',
      sourceSystem: 'amazon',
      sourceId,
    });

    // Same source_type and source_id, NO source_system — a different row under
    // `receipts_source_triple_uniq`, because NULLS NOT DISTINCT makes NULL a key
    // value rather than a wildcard.
    const result = await service.upsertFromExtraction(owner, {
      sourceType: 'order',
      sourceId,
      merchantName: 'Some other importer',
      lines: [],
      skipMint: true,
    });

    expect(result.receipt.id).not.toBe(imported.id);

    // The row the extraction must not have touched still carries its identity.
    const untouched = await rawReceipt(imported.id);
    expect(untouched).toMatchObject({
      source_system: 'amazon',
      merchant_name: 'Amazon',
    });

    // …and the new one really is NULL-keyed, i.e. the insert did not quietly
    // inherit the other row's system.
    const minted = await rawReceipt(result.receipt.id);
    expect(minted?.source_system).toBeNull();
  });

  it('DOES match the same triple on a re-extraction, rather than forking a second row', async () => {
    const sourceId = `order-${uuidv7()}`;

    const first = await service.upsertFromExtraction(owner, {
      sourceType: 'order',
      sourceSystem: 'amazon',
      sourceId,
      merchantName: 'Amazon',
      lines: [{ lineNumber: 1, description: 'USB-C cable' }],
      skipMint: true,
    });

    const second = await service.upsertFromExtraction(owner, {
      sourceType: 'order',
      sourceSystem: 'amazon',
      sourceId,
      lines: [{ lineNumber: 1, description: 'USB-C cable, 2m' }],
      skipMint: true,
    });

    expect(second.receipt.id).toBe(first.receipt.id);

    const [{ count }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM ci.receipts WHERE user_id = $1 AND source_id = $2`,
      [owner.userId, sourceId],
    );
    expect(count).toBe(1);
  });

  it('matches a NULL-source_system row on re-extraction (the predicate is present, not absent)', async () => {
    const sourceId = `scan-${uuidv7()}`;

    const first = await service.upsertFromExtraction(owner, {
      sourceType: 'scan',
      sourceId,
      merchantName: 'Corner Shop',
      lines: [],
      skipMint: true,
    });

    const second = await service.upsertFromExtraction(owner, {
      sourceType: 'scan',
      sourceId,
      lines: [],
      skipMint: true,
    });

    expect(second.receipt.id).toBe(first.receipt.id);
  });

  // ── F4, second half: the unconditional overwrite ────────────────────────

  it('leaves every header field the re-extraction did not mention exactly as it was', async () => {
    const sourceId = `order-${uuidv7()}`;

    const first = await service.upsertFromExtraction(owner, {
      sourceType: 'order',
      sourceSystem: 'amazon',
      sourceId,
      merchantName: 'Amazon',
      purchasedAt: new Date('2026-03-04T12:00:00.000Z'),
      currency: 'USD',
      totalMinor: 4599,
      taxMinor: 399,
      paymentLast4: '4242',
      orderNumber: '112-3456789-0000000',
      channel: 'online',
      metadata: { importer: 'gmail' },
      lines: [{ lineNumber: 1, description: 'USB-C cable' }],
      skipMint: true,
    });

    // A partial re-read: the OCR pass recovered the lines and the merchant and
    // nothing else. Every other header column is silent, not cleared.
    await service.upsertFromExtraction(owner, {
      sourceType: 'order',
      sourceSystem: 'amazon',
      sourceId,
      merchantName: 'Amazon.com',
      lines: [{ lineNumber: 1, description: 'USB-C cable, 2m' }],
      skipMint: true,
    });

    const row = await rawReceipt(first.receipt.id);

    // The field the extraction DID supply is updated…
    expect(row?.merchant_name).toBe('Amazon.com');
    // …and every field it did not is untouched.
    expect(row).toMatchObject({
      total_minor: '4599',
      tax_minor: '399',
      payment_last4: '4242',
      order_number: '112-3456789-0000000',
      channel: 'online',
      currency: 'USD',
      metadata: { importer: 'gmail' },
      // Nulling this would move the row off its own arbiter key.
      source_system: 'amazon',
    });
    expect(row?.purchased_at).toEqual(new Date('2026-03-04T12:00:00.000Z'));
  });

  it('still clears a field the re-extraction explicitly nulls', async () => {
    const sourceId = `order-${uuidv7()}`;

    const first = await service.upsertFromExtraction(owner, {
      sourceType: 'order',
      sourceSystem: 'amazon',
      sourceId,
      merchantName: 'Amazon',
      orderNumber: '112-3456789-0000000',
      lines: [],
      skipMint: true,
    });

    await service.upsertFromExtraction(owner, {
      sourceType: 'order',
      sourceSystem: 'amazon',
      sourceId,
      orderNumber: null,
      lines: [],
      skipMint: true,
    });

    const row = await rawReceipt(first.receipt.id);
    expect(row?.order_number).toBeNull();
    // Absent ≠ null: the merchant was silent, so it stayed.
    expect(row?.merchant_name).toBe('Amazon');
  });

  // ── replaceLineItems ────────────────────────────────────────────────────

  it('replaceLineItems is idempotent on (receipt_id, line_number) — same call twice, same rows', async () => {
    const receipt = await service.create(owner, { merchantName: 'Hardware store' });

    const lines = [
      { lineNumber: 1, description: 'Hammer', quantity: 1, unitPriceMinor: 1999 },
      { lineNumber: 2, description: 'Nails', quantity: 2, unitPriceMinor: 499 },
    ];

    const first = await service.replaceLineItems(owner, receipt.id, lines);
    const second = await service.replaceLineItems(owner, receipt.id, lines);

    expect(first).toHaveLength(2);
    // Same rows, not a second set: the line_item_ids survive the re-run.
    expect(second.map((line) => line.id)).toEqual(first.map((line) => line.id));

    const [{ count }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM ci.receipt_line_items WHERE receipt_id = $1`,
      [receipt.id],
    );
    expect(count).toBe(2);
  });

  it('replaceLineItems updates a line in place and drops one the re-extraction no longer has', async () => {
    const receipt = await service.create(owner, { merchantName: 'Hardware store' });

    const [line1] = await service.replaceLineItems(owner, receipt.id, [
      { lineNumber: 1, description: 'Hammer' },
      { lineNumber: 2, description: 'Nails' },
    ]);

    const after = await service.replaceLineItems(owner, receipt.id, [
      { lineNumber: 1, description: 'Claw hammer' },
    ]);

    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(line1.id);
    expect(after[0].description).toBe('Claw hammer');
  });

  it('replaceLineItems keeps a dropped line that already minted a unit', async () => {
    const receipt = await service.create(owner, { merchantName: 'Hardware store' });

    const lines = await service.replaceLineItems(owner, receipt.id, [
      { lineNumber: 1, description: 'Hammer' },
      { lineNumber: 2, description: 'Nails' },
    ]);

    // Stand in for a mint: the pointer is all `replaceLineItems` reads. It has
    // to be a real ci.objects row, because minted_object_id is a FK.
    const objectId = uuidv7();
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Item', 'Nails', '{}'::jsonb, $2, 'objects', $1)`,
      [objectId, owner.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.objects (object_id, user_id, owner_user_id, lifecycle_state)
       VALUES ($1, $2, $2, 'active')`,
      [objectId, owner.userId],
    );
    await dataSource.query(`UPDATE ci.receipt_line_items SET minted_object_id = $2 WHERE line_item_id = $1`, [
      lines[1].id,
      objectId,
    ]);

    const after = await service.replaceLineItems(owner, receipt.id, [
      { lineNumber: 1, description: 'Claw hammer' },
    ]);

    // Deleting line 2 would fire ON DELETE SET NULL on
    // ci.objects.acquisition_line_item_id and cut the possession's provenance.
    expect(after.map((line) => line.lineNumber)).toEqual([1, 2]);

    await dataSource.query(
      `UPDATE ci.receipt_line_items SET minted_object_id = NULL WHERE line_item_id = $1`,
      [lines[1].id],
    );
    await dataSource.query('DELETE FROM ci.objects WHERE object_id = $1', [objectId]);
    await dataSource.query('DELETE FROM ci.entities WHERE entity_id = $1', [objectId]);
  });

  it('replaceLineItems collapses a within-batch duplicate line_number instead of aborting the chunk', async () => {
    const receipt = await service.create(owner, { merchantName: 'Grocer' });

    // Two rows sharing a conflict target abort the WHOLE statement with
    // "ON CONFLICT DO UPDATE command cannot affect row a second time", so a
    // source that emitted line 1 twice would lose every line in the slice.
    const lines = await service.replaceLineItems(owner, receipt.id, [
      { lineNumber: 1, description: 'Milk' },
      { lineNumber: 1, description: 'Milk, semi-skimmed' },
      { lineNumber: 2, description: 'Bread' },
    ]);

    expect(lines).toHaveLength(2);
    expect(lines[0].description).toBe('Milk, semi-skimmed');
  });
});
