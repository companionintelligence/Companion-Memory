import type { Request } from 'express';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { RequestContext } from '@ci/common/context';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ingestEventsSchema } from '../../types';
import { BulkIngestController } from '../BulkIngestController';

/**
 * `/v1/things` and `/v1/events` cannot link to another account's rows, in Postgres.
 *
 * Neither route takes a row id for a link. A thing names its product and the
 * receipt line it came from by provenance triple, and the controller looks
 * those up among the caller's own rows. An event record has no link field at
 * all, and the schema drops keys it does not declare. These cases pin that, so
 * the routes stay out of the writers `refuseForeignLinks` has to guard. The
 * services behind them are stand-ins that record what they were handed.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database of your OWN, or run `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[ingest/BulkIngestController.foreignLinks.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`/v1 routes that name links by triple, in Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let controller: BulkIngestController;

  const ownerId = uuidv7();
  const otherId = uuidv7();
  const context = { userId: ownerId } as RequestContext;
  const request = { headers: {} } as Request;

  const myProduct = uuidv7();
  const theirProduct = uuidv7();
  const theirReceipt = uuidv7();
  const theirPlace = uuidv7();
  const productTriple = { sourceType: 'catalog', sourceSystem: 'acme', sourceId: 'kettle-1' };
  const receiptTriple = { sourceType: 'receipt', sourceSystem: 'acme', sourceId: 'order-1' };

  const things: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'ingest/BulkIngestController.foreignLinks');

    for (const userId of [ownerId, otherId]) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'IngestLinks', userId);
    }

    // The same triple in both accounts: only the caller's may resolve.
    await dataSource.query(
      `INSERT INTO ci.product_models (product_id, owner_user_id, user_id, title, source_type, source_system, source_id)
       VALUES ($1, $2, $2, 'Their kettle', $5, $6, $7), ($3, $4, $4, 'My kettle', $5, $6, $7)`,
      [
        theirProduct,
        otherId,
        myProduct,
        ownerId,
        productTriple.sourceType,
        productTriple.sourceSystem,
        productTriple.sourceId,
      ],
    );
    await dataSource.query(
      `INSERT INTO ci.receipts (receipt_id, owner_user_id, user_id, source_type, source_system, source_id)
       VALUES ($1, $2, $2, $3, $4, $5)`,
      [theirReceipt, otherId, receiptTriple.sourceType, receiptTriple.sourceSystem, receiptTriple.sourceId],
    );
    await dataSource.query(
      `INSERT INTO ci.receipt_line_items (receipt_id, owner_user_id, user_id, line_number, description)
       VALUES ($1, $2, $2, 1, 'Kettle')`,
      [theirReceipt, otherId],
    );
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name) VALUES ($1, 'Location', $2, 'Their home')`,
      [theirPlace, otherId],
    );

    const recording =
      (into: Array<Record<string, unknown>>) =>
      async (_context: unknown, rows: Array<Record<string, unknown>>) => {
        into.push(...rows);

        return rows.map(() => ({ id: uuidv7() }));
      };

    controller = new BulkIngestController(
      {} as never,
      {} as never,
      { createMany: jest.fn(recording(things)) } as never,
      {} as never,
      {} as never,
      { create: jest.fn(recording(events)) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      dataSource,
      { schedule: jest.fn(async () => undefined) } as never,
    );
  });

  beforeEach(() => {
    things.length = 0;
    events.length = 0;
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      const users = [ownerId, otherId];

      await dataSource.query('DELETE FROM ci.capture_events WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.receipt_line_items WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.receipts WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.product_models WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [users]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it("links a thing to the caller's product only, and never to another account's receipt line", async () => {
    await controller.ingestThings(context, request, {
      records: [
        {
          name: 'Kettle',
          productRef: productTriple,
          acquisitionLineItem: { receipt: receiptTriple, lineNumber: 1 },
          sourceType: 'thing',
          sourceSystem: 'acme',
          sourceId: `unit-${uuidv7()}`,
        },
      ],
    });

    expect(things).toHaveLength(1);
    expect(things[0].productId).toBe(myProduct);
    expect(things[0].acquisitionReceiptId).toBeUndefined();
    expect(things[0].acquisitionLineItemId).toBeUndefined();
  });

  it('drops link fields an event record does not declare', async () => {
    const body = ingestEventsSchema.parse({
      events: [
        {
          source_system: 'capture',
          source_id: `event-${uuidv7()}`,
          kind: 'visit',
          occurred_at: '2026-10-20T09:00:00Z',
          location_entity_id: theirPlace,
          participant_entity_ids: [theirPlace],
        },
      ],
    });

    await controller.ingest(context, body);

    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty('location_entity_id');
    expect(events[0]).not.toHaveProperty('participant_entity_ids');
    expect(events[0]).not.toHaveProperty('organizer_entity_id');
  });
});
