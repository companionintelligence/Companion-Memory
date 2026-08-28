import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { GraphDeltaWriter } from '../GraphDeltaWriter';
import { type MintLineInput, type MintReceiptContext, ObjectMintService } from '../ObjectMintService';

/**
 * What a RE-MINT does to a unit the user has since renamed, executed against
 * Postgres.
 *
 * `ObjectMintService.spec.ts` stubs `query`, so the `DO UPDATE … WHERE
 * inv.metadata->'mint'->>'service' = 'ObjectMintService'` guard is only ever
 * read as text. A mock cannot enforce a guard, and it cannot notice that the
 * NEXT statement — an unconditional
 * `INSERT INTO ci.entities … ON CONFLICT (entity_id) DO UPDATE SET name =
 * excluded.name` — undoes what the guard just protected. `name` lives ONLY on
 * the CTI base row, and `name` is the field a user edits, so that pair of
 * statements meant "the rename is safe in ci.objects and overwritten in
 * ci.entities one statement later".
 *
 * These cases need real rows: a guard that holds, a base row that keeps its
 * name, and a `graph_deltas` row that says `updated` rather than claiming the
 * user acquired the same possession twice.
 *
 * Opt-in: set `MEMORY_TEST_DATABASE_URL` (or `DATABASE_URL`); this suite SKIPS
 * legibly when nothing is reachable.
 *
 *   MEMORY_TEST_DATABASE_URL=postgres://companion:pw@localhost:5432/companion \
 *     yarn workspace @ci/be-api jest ObjectMintService.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/ObjectMintService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`ObjectMintService — re-minting, in Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: ObjectMintService;

  const owner = { userId: uuidv7() } as UserServiceContext;
  const receiptId = uuidv7();

  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as LoggerService;

  const receipt = (): MintReceiptContext => ({
    receiptId,
    sourceSystem: 'amazon',
    purchasedAt: new Date('2026-02-01T09:00:00.000Z'),
    placeEntityId: null,
    merchantName: 'Amazon',
    merchantEntityId: null,
    currency: 'USD',
  });

  const line = (overrides: Partial<MintLineInput> = {}): MintLineInput => ({
    lineItemId: uuidv7(),
    description: 'Sony WH-1000XM5 headphones',
    quantity: 1,
    unitPriceMinor: 34999,
    totalPriceMinor: 34999,
    currency: 'USD',
    productId: null,
    brand: 'Sony',
    modelNumber: 'WH-1000XM5',
    category: 'electronics',
    isPhysical: true,
    ...overrides,
  });

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

    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/ObjectMintService.integration');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [owner.userId, 'Mint spec fixture', `mint.${owner.userId}@example.invalid`],
    );
    await dataSource.query(
      `INSERT INTO ci.receipts (receipt_id, user_id, owner_user_id, merchant_name)
       VALUES ($1, $2, $2, 'Amazon')`,
      [receiptId, owner.userId],
    );

    // The real GraphDeltaWriter, so the `created`/`updated` claim is checked in
    // ci.graph_deltas rather than against a spy's arguments.
    service = new ObjectMintService(dataSource, new GraphDeltaWriter(dataSource, noopLogger), noopLogger);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.receipt_line_items WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.objects WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.receipts WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [owner.userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  const insertLineItem = async (lineNumber: number, description: string): Promise<string> => {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.receipt_line_items
         (line_item_id, receipt_id, user_id, owner_user_id, line_number, description)
       VALUES ($1, $2, $3, $3, $4, $5)`,
      [id, receiptId, owner.userId, lineNumber, description],
    );

    return id;
  };

  const baseRow = async (objectId: string) => {
    const [row] = await dataSource.query(`SELECT name FROM ci.entities WHERE entity_id = $1`, [objectId]);

    return row as { name: string } | undefined;
  };

  const deltasFor = async (objectId: string): Promise<string[]> => {
    const rows = await dataSource.query(
      `SELECT change_type FROM ci.graph_deltas WHERE entity_id = $1 ORDER BY delta_id ASC`,
      [objectId],
    );

    return rows.map((row: { change_type: string }) => row.change_type);
  };

  it('mints a unit with its base row, then re-mints onto the SAME unit', async () => {
    const lineItemId = await insertLineItem(1, 'Sony WH-1000XM5 headphones');

    const [first] = await service.mintFromLines(owner, receipt(), [line({ lineItemId })]);
    expect(first.inserted).toBe(1);
    expect(first.objectIds).toHaveLength(1);

    const objectId = first.objectIds[0];
    expect(await baseRow(objectId)).toMatchObject({ name: 'Sony WH-1000XM5 headphones' });

    const [second] = await service.mintFromLines(owner, receipt(), [line({ lineItemId })]);

    // Same unit, and this call inserted nothing.
    expect(second.objectIds).toEqual([objectId]);
    expect(second.inserted).toBe(0);

    const [{ count }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM ci.objects WHERE user_id = $1 AND source_id = $2`,
      [owner.userId, lineItemId],
    );
    expect(count).toBe(1);

    // One `created`, then one `updated` — not two `created`s.
    expect(await deltasFor(objectId)).toEqual(['created', 'updated']);
  });

  it('does NOT overwrite a user-edited name when the same receipt is re-extracted', async () => {
    const lineItemId = await insertLineItem(2, 'HEADPHONES SONY BLK');

    const [minted] = await service.mintFromLines(owner, receipt(), [
      line({ lineItemId, description: 'HEADPHONES SONY BLK' }),
    ]);
    const objectId = minted.objectIds[0];

    // The user renames the thing and edits the unit, which takes the row out of
    // this service's ownership: the mint provenance bag is what the guard reads.
    await dataSource.query(`UPDATE ci.entities SET name = $2 WHERE entity_id = $1`, [
      objectId,
      'My noise-cancelling headphones',
    ]);
    await dataSource.query(
      `UPDATE ci.objects
          SET metadata = metadata || '{"mint": {"service": "user"}}'::jsonb,
              condition = 'good'
        WHERE object_id = $1`,
      [objectId],
    );

    await service.mintFromLines(owner, receipt(), [
      line({ lineItemId, description: 'HEADPHONES SONY BLK', category: 'audio' }),
    ]);

    // The unit upsert's guard held…
    const [unit] = await dataSource.query(`SELECT category, condition FROM ci.objects WHERE object_id = $1`, [
      objectId,
    ]);
    expect(unit).toMatchObject({ category: 'electronics', condition: 'good' });

    // …and so did the base row, which is where the rename actually lives.
    expect(await baseRow(objectId)).toMatchObject({ name: 'My noise-cancelling headphones' });
  });

  it('refreshes the base-row name for a unit this service still owns', async () => {
    // The other side of the guard: a row nobody edited MUST still track the
    // corrected description, or "skip the write" would be a data freeze rather
    // than a protection.
    const lineItemId = await insertLineItem(3, 'USB C CBL');

    const [minted] = await service.mintFromLines(owner, receipt(), [
      line({ lineItemId, description: 'USB C CBL', brand: null, modelNumber: null }),
    ]);
    const objectId = minted.objectIds[0];

    await service.mintFromLines(owner, receipt(), [
      line({ lineItemId, description: 'USB-C cable, 2 m', brand: null, modelNumber: null }),
    ]);

    expect(await baseRow(objectId)).toMatchObject({ name: 'USB-C cable, 2 m' });
  });

  it('links the line item back to the unit it minted', async () => {
    const lineItemId = await insertLineItem(4, 'Kettle');

    const [minted] = await service.mintFromLines(owner, receipt(), [
      line({ lineItemId, description: 'Kettle', brand: 'Breville', modelNumber: 'BKE820XL' }),
    ]);

    const [row] = await dataSource.query(
      `SELECT minted_object_id FROM ci.receipt_line_items WHERE line_item_id = $1`,
      [lineItemId],
    );
    expect(row.minted_object_id).toBe(minted.objectIds[0]);
  });
});
