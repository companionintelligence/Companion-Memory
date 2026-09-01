import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { ContextService } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { BodyParserMiddleware } from '@ci/common/middleware';
import { BrowserActivityService } from '@ci/domains/browser-activity';
import {
  CommunicationService,
  ContentService,
  CalendarEventService,
  ItemService,
  ObjectObservationService,
  ProductModelService,
  ReceiptService,
} from '@ci/domains/memory';
import { NoteService } from '@ci/domains/notes';
import { PositionService } from '@ci/domains/position';

import { BulkIngestController } from '../controllers/BulkIngestController';
import { IngestCoalesceService } from '../services/IngestCoalesceService';
import { bulkThingRecordSchema } from '../types';

const mockCanActivate = jest.fn();

class MockJwtAuthGuard {
  canActivate = mockCanActivate;
}

/**
 * Wire the /v1 bulk routes the way production does — `bodyParser: false` (as
 * in main.ts) with BodyParserMiddleware applied manually — so these tests
 * exercise the REAL content-type switch: JSON envelopes parsed by the
 * middleware, NDJSON left as a raw stream for the handler.
 */
describe('Bulk ingest routes (/v1/*)', () => {
  let app: INestApplication;

  const echo = async (_context: unknown, data: unknown[]) => data.map((_, i) => ({ id: `row-${i}` }));

  const communicationService = { createMany: jest.fn(echo) };
  const contentService = { createMany: jest.fn(echo) };
  const itemService = { createMany: jest.fn(echo) };
  const browserActivityService = { createMany: jest.fn(echo) };
  const positionService = { create: jest.fn(echo) };
  const eventEcho = async (_context: unknown, data: unknown): Promise<Record<string, unknown>[]> =>
    (Array.isArray(data) ? data : [data]).map((d, i) => ({
      id: `event-${i}`,
      sourceType: (d as Record<string, unknown>).source_type,
      sourceSystem: (d as Record<string, unknown>).source_system,
      sourceId: (d as Record<string, unknown>).source_id,
    }));

  const eventService = { create: jest.fn(eventEcho) };
  // Notes report per-id outcomes rather than egress rows: they are the one /v1 kind
  // that dedupes on a client-minted primary key instead of a provenance triple.
  const noteEcho = async (
    _context: unknown,
    data: Array<{ id: string }>,
  ): Promise<{ created: string[]; updated: string[]; stale: string[]; conflicted: string[] }> => ({
    created: data.map((note) => note.id),
    updated: [],
    stale: [],
    conflicted: [],
  });
  const noteService = { captureMany: jest.fn(noteEcho) };
  // The object plane. Receipts and product models echo the provenance triple so
  // the materialize->link step has something to stamp; observations report a
  // write RESULT ({written, ...}) rather than a bare array, which is the one
  // shape difference among the bulk services.
  const tripleEcho =
    (prefix: string) =>
    async (_context: unknown, data: Array<Record<string, unknown>>): Promise<Record<string, unknown>[]> =>
      data.map((dto, i) => ({
        id: `${prefix}-${i}`,
        sourceType: dto.sourceType,
        sourceSystem: dto.sourceSystem,
        sourceId: dto.sourceId,
      }));

  const receiptService = {
    createMany: jest.fn(tripleEcho('receipt')),
    replaceLineItems: jest.fn(async () => []),
  };
  const productModelService = { createMany: jest.fn(tripleEcho('product')) };
  const observationEcho = async (_context: unknown, data: Array<Record<string, unknown>>) => ({
    written: await tripleEcho('observation')(_context, data),
    protectedByConfirmation: 0,
    duplicatesInBatch: 0,
    rejectedUnarbitered: 0,
  });
  const objectObservationService = { createMany: jest.fn(observationEcho) };
  // Capture-log INSERT always "inserts" (new capture); the trailing UPDATE
  // returns nothing.
  // The capture-log INSERT is set-based; RETURNING echoes the triple so the
  // controller can map fresh rows back to envelope entries (params flatten 9
  // binds per row: user_id, destination, source_type, source_system,
  // source_id, ...).
  const captureLogEcho = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> =>
    /INSERT INTO\s+ci\.capture_events/.test(sql)
      ? Array.from({ length: params.length / 9 }, (_, r) => ({
          capture_event_id: `cap-${r}`,
          source_type: params[r * 9 + 2],
          source_system: params[r * 9 + 3],
          source_id: params[r * 9 + 4],
        }))
      : [];
  const dataSourceQuery = jest.fn(captureLogEcho);

  beforeEach(() => {
    jest.clearAllMocks();
    mockCanActivate.mockImplementation(() => true);
    communicationService.createMany.mockImplementation(echo);
    itemService.createMany.mockImplementation(echo);
    eventService.create.mockImplementation(eventEcho);
    noteService.captureMany.mockImplementation(noteEcho);
    receiptService.createMany.mockImplementation(tripleEcho('receipt'));
    productModelService.createMany.mockImplementation(tripleEcho('product'));
    objectObservationService.createMany.mockImplementation(observationEcho);
    dataSourceQuery.mockImplementation(captureLogEcho);
  });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BulkIngestController],
      providers: [
        { provide: CommunicationService, useValue: communicationService },
        { provide: ContentService, useValue: contentService },
        { provide: ItemService, useValue: itemService },
        { provide: BrowserActivityService, useValue: browserActivityService },
        { provide: PositionService, useValue: positionService },
        { provide: CalendarEventService, useValue: eventService },
        { provide: NoteService, useValue: noteService },
        { provide: ReceiptService, useValue: receiptService },
        { provide: ProductModelService, useValue: productModelService },
        { provide: ObjectObservationService, useValue: objectObservationService },
        { provide: DataSource, useValue: { query: dataSourceQuery } },
        { provide: IngestCoalesceService, useValue: { schedule: jest.fn(async () => undefined) } },
      ],
    })
      .overrideGuard(JwtOrApiKeyAuthGuard)
      .useClass(MockJwtAuthGuard)
      .compile();

    app = module.createNestApplication({ bodyParser: false });

    // Same shape as production main.ts/application.ts: context middleware,
    // then the selective body parser.
    app.use((req: Request, res: Response, next: NextFunction) => {
      ContextService.run({ traceId: 'test-trace-id', userId: 'test-user-id' }, () => next());
    });

    const bodyParser = new BodyParserMiddleware(new Reflector());
    app.use((req: Request, res: Response, next: NextFunction) => bodyParser.use(req, res, next));

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const commLine = (sourceId: string) =>
    JSON.stringify({
      time: '2026-01-01T00:00:00.000Z',
      communication_type: 'email',
      content: 'hello',
      source_type: 'communication',
      source_system: 'gmail',
      source_id: sourceId,
    });

  /**
   * A thing record shaped EXACTLY the way today's importer sends one —
   * every field it populates, and not one field it does not. The object-identity
   * additions to `bulkThingRecordSchema` are all optional, and this is the
   * fixture that proves the additions cost the existing client nothing.
   */
  const todaysImporterItem = () => ({
    name: 'Sony WH-1000XM5',
    description: 'Noise cancelling headphones',
    category: 'electronics',
    subcategory: 'audio',
    brand: 'Sony',
    model: 'WH-1000XM5',
    purchasePrice: 399.99,
    currency: 'USD',
    acquiredAt: '2026-02-14T18:03:00.000Z',
    identifierCodes: { asin: 'B09XS7JWHH' },
    condition: 'new' as const,
    quantity: 1,
    metadata: { orderNumber: '112-3456789-1234567' },
    sourceType: 'ci-import-tools',
    sourceSystem: 'amazon',
    sourceId: 'order-112-3456789:item-1',
  });

  const receiptLine = (sourceId: string) =>
    JSON.stringify({
      merchant_name: 'Blue Bottle Coffee',
      purchased_at: '2026-03-02T15:20:00.000Z',
      currency: 'USD',
      subtotal_minor: 1850,
      tax_minor: 165,
      total_minor: 2015,
      channel: 'in_store',
      line_items: [
        { line_number: 1, description: 'Bella Donovan 12oz', quantity: 1, total_price_minor: 1850 },
      ],
      source_type: 'ci-import-tools',
      source_system: 'gmail',
      source_id: sourceId,
    });

  const productModelLine = (sourceId: string) =>
    JSON.stringify({
      title: 'Sony WH-1000XM5 Wireless Headphones',
      brand: 'Sony',
      model_number: 'WH-1000XM5',
      msrp_minor: 39999,
      currency: 'USD',
      identity_confidence: 0.7,
      source_type: 'ci-import-tools',
      source_system: 'amazon',
      source_id: sourceId,
    });

  const observationLine = (sourceId: string) =>
    JSON.stringify({
      observed_at: '2026-03-02T15:21:00.000Z',
      label: 'coffee mug',
      label_source: 'yolo',
      detector: 'yolov8n',
      detection_confidence: 0.82,
      bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      coordinates: { lat: 37.7749, lon: -122.4194 },
      source_type: 'ci-import-tools',
      source_system: 'photos',
      source_id: sourceId,
    });

  describe('JSON envelope (unchanged contract)', () => {
    it('POST /v1/communications ingests a { records } envelope', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/communications')
        .send({ records: [JSON.parse(commLine('a')), JSON.parse(commLine('b'))] })
        .expect(201);

      expect(res.body).toEqual({ ingested: 2, duplicate: 0, rejected: [] });
      expect(communicationService.createMany).toHaveBeenCalledTimes(1);
      expect(communicationService.createMany.mock.calls[0][1]).toHaveLength(2);
    });

    it('rejects a bad envelope with the ValidationPipe 400 shape', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/communications')
        .send({ records: [{ content: 'missing everything' }] })
        .expect(400);

      expect(res.body.message).toBe('Validation failed');
      expect(communicationService.createMany).not.toHaveBeenCalled();
    });

    it('POST /v1/events ingests an { events } envelope through the capture log', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/events')
        .send({
          events: [
            {
              source_system: 'gmail',
              source_id: 'msg-1',
              kind: 'communication.email',
              occurred_at: '2026-01-01T00:00:00.000Z',
              payload: { Subject: 'hi' },
            },
          ],
        })
        .expect(201);

      expect(res.body).toEqual({ ingested: 1, duplicate: 0, rejected: [] });
      expect(eventService.create).toHaveBeenCalledTimes(1);
      // Raw-log INSERT + event_id back-link UPDATE.
      expect(dataSourceQuery).toHaveBeenCalledTimes(2);
    });

    it('POST /v1/notes ingests a client-minted note through the real pipeline', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/notes')
        .send({
          records: [
            {
              id: '01920000-0000-7000-8000-000000000001',
              title: 'Groceries',
              content: '<p>Groceries</p>',
              captured_at: '2026-08-13T10:00:00.000Z',
            },
          ],
        })
        .expect(201);

      expect(res.body).toEqual({ ingested: 1, duplicate: 0, rejected: [] });
      expect(noteService.captureMany.mock.calls[0][1]).toEqual([
        {
          id: '01920000-0000-7000-8000-000000000001',
          title: 'Groceries',
          content: '<p>Groceries</p>',
          capturedAt: new Date('2026-08-13T10:00:00.000Z'),
        },
      ]);
      // No provenance triple, so nothing touches the capture raw log.
      expect(dataSourceQuery).not.toHaveBeenCalled();
    });

    it('POST /v1/notes 400s a note with no id, before the service is reached', async () => {
      // Without an id an at-least-once replay would insert a second copy of the note.
      const res = await request(app.getHttpServer())
        .post('/v1/notes')
        .send({ records: [{ content: '<p>a</p>', captured_at: '2026-08-13T10:00:00.000Z' }] })
        .expect(400);

      expect(res.body.message).toBe('Validation failed');
      expect(noteService.captureMany).not.toHaveBeenCalled();
    });

    it('POST /v1/receipts ingests a header with its nested line_items', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/receipts')
        .send({ records: [JSON.parse(receiptLine('receipt-a')), JSON.parse(receiptLine('receipt-b'))] })
        .expect(201);

      expect(res.body).toEqual({ ingested: 2, duplicate: 0, rejected: [] });

      // The header goes through the batched createMany, snake_case mapped onto
      // the camelCase DTO and money left in MINOR units.
      const headers = receiptService.createMany.mock.calls[0][1] as Array<Record<string, unknown>>;
      expect(headers).toHaveLength(2);
      expect(headers[0]).toMatchObject({
        merchantName: 'Blue Bottle Coffee',
        purchasedAt: new Date('2026-03-02T15:20:00.000Z'),
        totalMinor: 2015,
        channel: 'in_store',
        sourceId: 'receipt-a',
      });
      // Lines are NOT part of the header DTO — they land through replaceLineItems,
      // one call per receipt, against the id the header write returned.
      expect(headers[0]).not.toHaveProperty('line_items');
      expect(receiptService.replaceLineItems).toHaveBeenCalledTimes(2);
      expect(receiptService.replaceLineItems.mock.calls[0].slice(1)).toEqual([
        'receipt-0',
        [{ lineNumber: 1, description: 'Bella Donovan 12oz', quantity: 1, totalPriceMinor: 1850 }],
      ]);
    });

    it('POST /v1/receipts leaves stored lines alone when line_items is absent', async () => {
      const { line_items: _lines, ...headerOnly } = JSON.parse(receiptLine('receipt-c'));

      await request(app.getHttpServer())
        .post('/v1/receipts')
        .send({ records: [headerOnly] })
        .expect(201);

      // Absent is not the same claim as `[]`: a header-only push says nothing
      // about the lines, so nothing touches them.
      expect(receiptService.replaceLineItems).not.toHaveBeenCalled();
    });

    it('POST /v1/product-models ingests a { records } envelope', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/product-models')
        .send({ records: [JSON.parse(productModelLine('sku-a'))] })
        .expect(201);

      expect(res.body).toEqual({ ingested: 1, duplicate: 0, rejected: [] });
      expect(productModelService.createMany.mock.calls[0][1]).toEqual([
        {
          id: undefined,
          title: 'Sony WH-1000XM5 Wireless Headphones',
          brand: 'Sony',
          manufacturer: undefined,
          modelNumber: 'WH-1000XM5',
          category: undefined,
          subcategory: undefined,
          productType: undefined,
          description: undefined,
          variantAttributes: undefined,
          spec: undefined,
          msrpMinor: 39999,
          currency: 'USD',
          imageContentId: undefined,
          manualContentIds: undefined,
          isDigital: undefined,
          identityConfidence: 0.7,
          productEntityId: undefined,
          metadata: undefined,
          sourceType: 'ci-import-tools',
          sourceSystem: 'amazon',
          sourceId: 'sku-a',
        },
      ]);
    });

    it('POST /v1/product-models 400s an identity_confidence the table would CHECK-reject', async () => {
      // The column is CHECKed `> 0 AND <= 1`. Catching it at the wire is a 400
      // the caller can act on instead of a 500 from inside a transaction.
      await request(app.getHttpServer())
        .post('/v1/product-models')
        .send({ records: [{ ...JSON.parse(productModelLine('sku-b')), identity_confidence: 0 }] })
        .expect(400);

      expect(productModelService.createMany).not.toHaveBeenCalled();
    });

    it('POST /v1/observations ingests a sighting and keeps lat/lon named', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/observations')
        .send({ records: [JSON.parse(observationLine('sighting-a'))] })
        .expect(201);

      expect(res.body).toEqual({ ingested: 1, duplicate: 0, rejected: [] });
      const dtos = objectObservationService.createMany.mock.calls[0][1] as Array<Record<string, unknown>>;
      expect(dtos[0]).toMatchObject({
        observedAt: new Date('2026-03-02T15:21:00.000Z'),
        label: 'coffee mug',
        labelSource: 'yolo',
        detectionConfidence: 0.82,
        bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        coordinates: { lat: 37.7749, lon: -122.4194 },
      });
    });

    it('POST /v1/observations refuses to accept a resolution or a confirmation', async () => {
      // Resolution is a separate, revisable decision; a detector that could
      // assert it on the way in is the conflation ci.object_observations exists
      // to prevent. Zod strips the keys rather than 400ing, so the assertion is
      // that they never reach the service.
      await request(app.getHttpServer())
        .post('/v1/observations')
        .send({
          records: [
            {
              ...JSON.parse(observationLine('sighting-b')),
              resolved_object_id: '01920000-0000-7000-8000-000000000001',
              resolution_method: 'user',
              confirmed_by_user: true,
              detection_key: 'caller-chosen',
            },
          ],
        })
        .expect(201);

      const dto = (objectObservationService.createMany.mock.calls[0][1] as Record<string, unknown>[])[0];
      expect(dto).not.toHaveProperty('resolvedObjectId');
      expect(dto).not.toHaveProperty('resolutionMethod');
      expect(dto).not.toHaveProperty('confirmedByUser');
      expect(dto).not.toHaveProperty('detectionKey');
    });

    it('POST /v1/notes 409s an ownership conflict, so the flusher parks it instead of dropping it', async () => {
      noteService.captureMany.mockResolvedValueOnce({
        created: [],
        updated: [],
        stale: [],
        conflicted: ['01920000-0000-7000-8000-000000000001'],
      });

      await request(app.getHttpServer())
        .post('/v1/notes')
        .send({
          records: [
            {
              id: '01920000-0000-7000-8000-000000000001',
              content: '<p>a</p>',
              captured_at: '2026-08-13T10:00:00.000Z',
            },
          ],
        })
        .expect(409);
    });
  });

  describe('NDJSON streaming (the default bulk contract)', () => {
    it('POST /v1/communications ingests one record per line', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/communications')
        .set('content-type', 'application/x-ndjson')
        .send(`${commLine('a')}\n${commLine('b')}\n${commLine('c')}\n`)
        .expect(201);

      expect(res.body).toEqual({ ingested: 3, duplicate: 0, rejected: [] });
      const dtos = communicationService.createMany.mock.calls[0][1] as { direction: string }[];
      expect(dtos).toHaveLength(3);
      expect(dtos[0].direction).toBe('inbound');
    });

    it('flushes to the service in batches while the stream arrives', async () => {
      const lines = Array.from({ length: 2500 }, (_, i) => JSON.stringify({ name: `Item ${i}` })).join('\n');

      const res = await request(app.getHttpServer())
        .post('/v1/things')
        .set('content-type', 'application/x-ndjson')
        .send(lines)
        .expect(201);

      expect(res.body).toEqual({ ingested: 2500, duplicate: 0, rejected: [] });
      expect(itemService.createMany).toHaveBeenCalledTimes(3);
      expect(itemService.createMany.mock.calls.map((call) => (call[1] as unknown[]).length)).toEqual([
        1000, 1000, 500,
      ]);
    });

    it('rejects malformed lines by 1-based number without aborting the stream', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/communications')
        .set('content-type', 'application/x-ndjson')
        .send(`${commLine('a')}\nnot json at all\n${commLine('b')}\n`)
        .expect(201);

      expect(res.body.ingested).toBe(2);
      expect(res.body.rejected).toEqual([{ line: 2, reason: expect.stringContaining('invalid JSON') }]);
    });

    it('POST /v1/receipts streams one receipt (lines included) per line', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/receipts')
        .set('content-type', 'application/x-ndjson')
        .send(`${receiptLine('r-a')}\n${receiptLine('r-b')}\n`)
        .expect(201);

      expect(res.body).toEqual({ ingested: 2, duplicate: 0, rejected: [] });
      expect(receiptService.createMany.mock.calls[0][1]).toHaveLength(2);
      expect(receiptService.replaceLineItems).toHaveBeenCalledTimes(2);
    });

    it('POST /v1/product-models streams one record per line', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/product-models')
        .set('content-type', 'application/x-ndjson')
        .send(`${productModelLine('p-a')}\n${productModelLine('p-b')}\n${productModelLine('p-c')}\n`)
        .expect(201);

      expect(res.body).toEqual({ ingested: 3, duplicate: 0, rejected: [] });
      expect(productModelService.createMany.mock.calls[0][1]).toHaveLength(3);
    });

    it('POST /v1/observations streams one record per line', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/observations')
        .set('content-type', 'application/x-ndjson')
        .send(`${observationLine('o-a')}\n${observationLine('o-b')}\n`)
        .expect(201);

      expect(res.body).toEqual({ ingested: 2, duplicate: 0, rejected: [] });
      expect(objectObservationService.createMany.mock.calls[0][1]).toHaveLength(2);
    });

    it('rejects a label-less observation by line number without aborting the stream', async () => {
      const bad = JSON.stringify({ observed_at: '2026-03-02T15:21:00.000Z', label: '' });

      const res = await request(app.getHttpServer())
        .post('/v1/observations')
        .set('content-type', 'application/x-ndjson')
        .send(`${observationLine('o-a')}\n${bad}\n${observationLine('o-b')}\n`)
        .expect(201);

      expect(res.body.ingested).toBe(2);
      expect(res.body.rejected).toEqual([{ line: 2, reason: expect.any(String) }]);
    });

    it('exceeds the 10mb JSON envelope limit without a 413 (NDJSON has no overall cap)', async () => {
      // ~15 MB of NDJSON — over the envelope path's 10mb body limit. The
      // middleware bypass means no parser buffers it; batches flush as the
      // stream arrives.
      const filler = 'x'.repeat(1024);
      const count = 15 * 1024;
      const body = Array.from(
        { length: count },
        (_, i) => `${JSON.stringify({ name: `Item ${i}`, description: filler })}\n`,
      ).join('');

      const res = await request(app.getHttpServer())
        .post('/v1/things')
        .set('content-type', 'application/x-ndjson')
        .send(body)
        .expect(201);

      expect(res.body.ingested).toBe(count);
      expect(res.body.rejected).toEqual([]);
    });
  });

  /**
   * The object-identity fields added to `bulkThingRecordSchema` are all
   * optional, and the whole point is that adding them changed NOTHING for the
   * client already pushing things. These are the tests that would fail if
   * someone later made one of them required, renamed one, or let one leak into
   * the DTO.
   */
  describe("today's importer payload (the additive-only guarantee)", () => {
    it('validates byte-identically — nothing added, nothing dropped, nothing renamed', () => {
      const record = todaysImporterItem();

      const parsed = bulkThingRecordSchema.parse(record);

      // Deep equality BOTH ways: `toEqual` alone would pass if the schema had
      // grown a defaulted key, because it ignores undefined-valued properties.
      expect(parsed).toEqual(record);
      expect(Object.keys(parsed).sort()).toEqual(Object.keys(record).sort());
    });

    it('produces the same ItemService DTO it always did', async () => {
      const record = todaysImporterItem();

      await request(app.getHttpServer())
        .post('/v1/things')
        .send({ records: [record] })
        .expect(201);

      const dtos = itemService.createMany.mock.calls[0][1] as Array<Record<string, unknown>>;

      expect(dtos).toEqual([
        {
          ...record,
          // The one transformation this route has ever done: ISO string -> Date.
          acquiredAt: new Date('2026-02-14T18:03:00.000Z'),
          manufacturedAt: undefined,
          expiresAt: undefined,
        },
      ]);
      // No object-identity key appeared out of nowhere. A resolved-to-nothing
      // reference must be ABSENT, not an explicit null — `productId: null` would
      // clear a link a previous push had established.
      expect(dtos[0]).not.toHaveProperty('productId');
      expect(dtos[0]).not.toHaveProperty('acquisitionReceiptId');
      expect(dtos[0]).not.toHaveProperty('acquisitionLineItemId');
      // And no reference lookup ran at all: the pre-pass costs a batch with no
      // refs exactly zero queries.
      expect(
        dataSourceQuery.mock.calls.filter(([sql]) => /ci\.product_models|ci\.receipt_line_items/.test(sql)),
      ).toHaveLength(0);
    });

    it('keeps `identifiers` out of the DTO but inside the capture payload', async () => {
      // CI-Import-Tools already sends these. Undeclared, zod stripped them
      // before the raw log ever saw them, so the claim was unrecoverable;
      // declared, they survive in ci.capture_events.payload for a later
      // promotion pass. They are still not a column on ci.objects, so they
      // must not reach ItemService either.
      const identifiers = [{ namespace: 'asin', value: 'B09XS7JWHH', confidence: 0.9 }];

      await request(app.getHttpServer())
        .post('/v1/things')
        .send({ records: [{ ...todaysImporterItem(), identifiers }] })
        .expect(201);

      const dtos = itemService.createMany.mock.calls[0][1] as Array<Record<string, unknown>>;
      expect(dtos[0]).not.toHaveProperty('identifiers');

      // 9 binds per raw-log row; the payload is the 9th (index 8).
      const insert = dataSourceQuery.mock.calls.find(([sql]) =>
        /INSERT INTO\s+ci\.capture_events/.test(sql as string),
      );
      expect(insert).toBeDefined();
      const payload = (insert as [string, unknown[]])[1][8] as { identifiers?: unknown };
      expect(payload.identifiers).toEqual(identifiers);
    });

    it('resolves productRef / acquisitionLineItem in ONE batched pre-pass', async () => {
      dataSourceQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (/ci\.product_models/.test(sql)) {
          return [
            {
              product_id: '01920000-0000-7000-8000-0000000000aa',
              source_type: 'ci-import-tools',
              source_system: 'amazon',
              source_id: 'sku-1',
            },
          ];
        }

        if (/ci\.receipt_line_items/.test(sql)) {
          return [
            {
              line_item_id: '01920000-0000-7000-8000-0000000000bb',
              receipt_id: '01920000-0000-7000-8000-0000000000cc',
              source_type: 'ci-import-tools',
              source_system: 'gmail',
              source_id: 'receipt-1',
              line_number: 2,
            },
          ];
        }

        return captureLogEcho(sql, params);
      });

      const ref = {
        productRef: { sourceType: 'ci-import-tools', sourceSystem: 'amazon', sourceId: 'sku-1' },
        acquisitionLineItem: {
          receipt: { sourceType: 'ci-import-tools', sourceSystem: 'gmail', sourceId: 'receipt-1' },
          lineNumber: 2,
        },
      };

      await request(app.getHttpServer())
        .post('/v1/things')
        .send({
          records: [
            { ...todaysImporterItem(), sourceId: 'item-1', ...ref },
            { ...todaysImporterItem(), sourceId: 'item-2', ...ref },
          ],
        })
        .expect(201);

      const dtos = itemService.createMany.mock.calls[0][1] as Array<Record<string, unknown>>;
      expect(dtos[0]).toMatchObject({
        productId: '01920000-0000-7000-8000-0000000000aa',
        acquisitionLineItemId: '01920000-0000-7000-8000-0000000000bb',
        // The receipt comes free with the line — it is the line's own receipt.
        acquisitionReceiptId: '01920000-0000-7000-8000-0000000000cc',
      });
      expect(dtos[1]).toMatchObject({ productId: '01920000-0000-7000-8000-0000000000aa' });

      // TWO rows sharing one reference pair still cost ONE lookup per kind: the
      // pre-pass keys on distinct references, not on records.
      const lookups = dataSourceQuery.mock.calls.filter(([sql]) =>
        /ci\.product_models|ci\.receipt_line_items/.test(sql as string),
      );
      expect(lookups).toHaveLength(2);
      // And nothing undeclared rode along into the DTO.
      expect(dtos[0]).not.toHaveProperty('productRef');
      expect(dtos[0]).not.toHaveProperty('acquisitionLineItem');
    });

    it('writes the unit UNLINKED when a reference misses, never rejecting it', async () => {
      // The receipt may simply be in a later batch of the same load. Dropping a
      // thing the user owns to protect a pointer a repair pass can still fill in
      // is the wrong trade.
      const res = await request(app.getHttpServer())
        .post('/v1/things')
        .send({
          records: [
            {
              ...todaysImporterItem(),
              productRef: { sourceType: 'ci-import-tools', sourceSystem: 'amazon', sourceId: 'never-pushed' },
            },
          ],
        })
        .expect(201);

      expect(res.body).toEqual({ ingested: 1, duplicate: 0, rejected: [] });
      const dtos = itemService.createMany.mock.calls[0][1] as Array<Record<string, unknown>>;
      expect(dtos).toHaveLength(1);
      expect(dtos[0]).not.toHaveProperty('productId');
    });
  });

  describe('auth', () => {
    beforeEach(() => {
      mockCanActivate.mockImplementation(() => {
        throw new UnauthorizedException();
      });
    });

    it('401s an NDJSON stream before any batch is flushed (guard runs before the handler streams)', async () => {
      await request(app.getHttpServer())
        .post('/v1/communications')
        .set('content-type', 'application/x-ndjson')
        .send(`${commLine('a')}\n`)
        .expect(401);

      expect(communicationService.createMany).not.toHaveBeenCalled();
    });

    it('401s the JSON envelope path too', async () => {
      await request(app.getHttpServer())
        .post('/v1/communications')
        .send({ records: [JSON.parse(commLine('a'))] })
        .expect(401);

      expect(communicationService.createMany).not.toHaveBeenCalled();
    });
  });
});
