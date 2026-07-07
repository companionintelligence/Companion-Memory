import { Readable } from 'node:stream';

import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';

import type { RequestContext } from '@ci/common/context';
import { ValidationPipe } from '@ci/common/pipes';
import type { BrowserActivityService } from '@ci/domains/browser-activity';
import type { CommunicationService, ContentService, ItemService } from '@ci/domains/memory';
import type { PositionService } from '@ci/domains/position';

import {
  ingestBrowserActivitySchema,
  ingestCommunicationsSchema,
  ingestContentsSchema,
  ingestInventorySchema,
  ingestPositionsSchema,
} from '../../types';
import { BulkIngestController } from '../BulkIngestController';

const ctx = { userId: 'user-1' } as RequestContext;

/** Fake request for the JSON-envelope path (only headers are consulted). */
const jsonReq = () => ({ headers: { 'content-type': 'application/json' } }) as unknown as Request;

/** Fake request for the NDJSON path: a real byte stream + the switching header. */
function ndjsonReq(body: string): Request {
  const req = Readable.from([Buffer.from(body, 'utf8')], { objectMode: false });

  return Object.assign(req, { headers: { 'content-type': 'application/x-ndjson' } }) as unknown as Request;
}

/** Mock every bulk service to echo one row per record it was handed. */
function makeController() {
  const echo = jest.fn(async (_context: unknown, data: unknown[]) =>
    data.map((_, i) => ({ id: `row-${i}` })),
  );

  const communicationService = { createMany: echo } as unknown as CommunicationService;
  const contentService = {
    createMany: jest.fn(async (_context: unknown, data: unknown[]) =>
      data.map((_, i) => ({ id: `row-${i}` })),
    ),
  } as unknown as ContentService;
  const itemService = { createMany: echo } as unknown as ItemService;
  const browserActivityService = { createMany: echo } as unknown as BrowserActivityService;
  const positionService = {
    create: jest.fn(async (_context: unknown, data: unknown[]) => data.map((_, i) => ({ id: `row-${i}` }))),
  } as unknown as PositionService;

  const controller = new BulkIngestController(
    communicationService,
    contentService,
    itemService,
    browserActivityService,
    positionService,
  );

  return {
    controller,
    communicationService,
    contentService,
    itemService,
    browserActivityService,
    positionService,
  };
}

const communicationRecord = (sourceId: string) => ({
  time: '2026-01-01T00:00:00.000Z',
  communication_type: 'email' as const,
  content: 'hello',
  source_type: 'communication',
  source_system: 'gmail',
  source_id: sourceId,
});

describe('BulkIngestController', () => {
  describe('POST /v1/communications', () => {
    it('hands the whole batch to CommunicationService.createMany and reports it ingested', async () => {
      const { controller, communicationService } = makeController();

      const res = await controller.ingestCommunications(ctx, jsonReq(), {
        records: [communicationRecord('a'), communicationRecord('b')],
      });

      expect(res).toEqual({ ingested: 2, duplicate: 0, rejected: [] });
      expect(communicationService.createMany).toHaveBeenCalledTimes(1);
      const [passedContext, passedRecords] = (communicationService.createMany as jest.Mock).mock.calls[0];
      expect(passedContext).toEqual({ userId: 'user-1' });
      expect(passedRecords).toHaveLength(2);
    });

    it('coerces time to Date and defaults direction to inbound (mirroring the GraphQL resolver)', async () => {
      const { controller, communicationService } = makeController();

      await controller.ingestCommunications(ctx, jsonReq(), { records: [communicationRecord('a')] });

      const dto = (communicationService.createMany as jest.Mock).mock.calls[0][1][0];
      expect(dto.time).toEqual(new Date('2026-01-01T00:00:00.000Z'));
      expect(dto.direction).toBe('inbound');
      expect(dto).toMatchObject({
        communication_type: 'email',
        source_type: 'communication',
        source_system: 'gmail',
        source_id: 'a',
      });
    });

    it('keeps an explicit direction', async () => {
      const { controller, communicationService } = makeController();

      await controller.ingestCommunications(ctx, jsonReq(), {
        records: [{ ...communicationRecord('a'), direction: 'outbound' as const }],
      });

      const dto = (communicationService.createMany as jest.Mock).mock.calls[0][1][0];
      expect(dto.direction).toBe('outbound');
    });
  });

  describe('POST /v1/contents', () => {
    it('maps event_id to the event relation and defers indexing (emitCreated: false)', async () => {
      const { controller, contentService } = makeController();

      const res = await controller.ingestContents(ctx, jsonReq(), {
        records: [
          {
            type: 'media',
            title: 'photo',
            event_id: '01936b2a-0000-7000-8000-000000000001',
            source_type: 'content',
            source_system: 'photos',
            source_id: 'p-1',
          },
          { type: 'note', text: 'no event' },
        ],
      });

      expect(res).toEqual({ ingested: 2, duplicate: 0, rejected: [] });
      const [, passedRecords, options] = (contentService.createMany as jest.Mock).mock.calls[0];
      expect(passedRecords[0].event).toEqual({ id: '01936b2a-0000-7000-8000-000000000001' });
      expect(passedRecords[0].event_id).toBeUndefined();
      expect(passedRecords[1].event).toBeUndefined();
      expect(options).toEqual({ emitCreated: false });
    });
  });

  describe('POST /v1/inventory', () => {
    it('hands the batch to ItemService.createMany, coercing acquiredAt to Date', async () => {
      const { controller, itemService } = makeController();

      const res = await controller.ingestInventory(ctx, jsonReq(), {
        records: [
          {
            name: 'Laptop',
            acquiredAt: '2025-05-01T12:00:00.000Z',
            sourceType: 'inventory',
            sourceSystem: 'amazon',
            sourceId: 'order-1',
          },
          { name: 'Desk' },
        ],
      });

      expect(res).toEqual({ ingested: 2, duplicate: 0, rejected: [] });
      const dtos = (itemService.createMany as jest.Mock).mock.calls[0][1];
      expect(dtos[0].acquiredAt).toEqual(new Date('2025-05-01T12:00:00.000Z'));
      expect(dtos[1].acquiredAt).toBeUndefined();
    });
  });

  describe('POST /v1/browser-activity', () => {
    it('passes records through unchanged (the service coerces time itself)', async () => {
      const { controller, browserActivityService } = makeController();

      const records = [
        {
          time: '2026-01-01T00:00:00.000Z',
          url: 'https://example.com',
          source_type: 'browser_activity',
          source_system: 'chrome',
          source_id: 'v-1',
        },
      ];

      const res = await controller.ingestBrowserActivity(ctx, jsonReq(), { records });

      expect(res).toEqual({ ingested: 1, duplicate: 0, rejected: [] });
      expect((browserActivityService.createMany as jest.Mock).mock.calls[0][1]).toEqual(records);
    });
  });

  describe('POST /v1/positions', () => {
    it('reports rows the service collapsed intra-batch as duplicate', async () => {
      const { controller, positionService } = makeController();
      // PositionService dedupes same-time records within the batch: 3 in, 2 out.
      (positionService.create as jest.Mock).mockResolvedValueOnce([{ id: 'p-1' }, { id: 'p-2' }]);

      const record = { time: '2026-01-01T00:00:00.000Z', source: 'gps' as const };
      const res = await controller.ingestPositions(ctx, jsonReq(), {
        records: [record, record, { ...record, time: '2026-01-01T00:01:00.000Z' }],
      });

      expect(res).toEqual({ ingested: 2, duplicate: 1, rejected: [] });
      expect((positionService.create as jest.Mock).mock.calls[0][1]).toHaveLength(3);
    });

    it('suppresses per-row created events and forwards the provenance triple (#1672)', async () => {
      const { controller, positionService } = makeController();
      (positionService.create as jest.Mock).mockResolvedValueOnce([{ id: 'p-1' }]);

      const record = {
        time: '2026-01-01T00:00:00.000Z',
        source: 'gps' as const,
        source_type: 'ci-import-tools',
        source_system: 'google_photos',
        source_id: 'IMG_1.jpg',
      };
      await controller.ingestPositions(ctx, jsonReq(), { records: [record] });

      const [, records, options] = (positionService.create as jest.Mock).mock.calls[0];
      // The bulk plane must not fan out one PositionCreatedEvent per GPS fix.
      expect(options).toEqual({ emitCreated: false });
      // The triple survives validation instead of being stripped by zod.
      expect(records[0]).toMatchObject({
        source_type: 'ci-import-tools',
        source_system: 'google_photos',
        source_id: 'IMG_1.jpg',
      });
    });
  });

  describe('envelope validation inside the handler (moved off the @Body pipe for NDJSON)', () => {
    it('rejects a bad envelope with the same ValidationPipe 400 shape', async () => {
      const { controller, communicationService } = makeController();

      let caught: BadRequestException | undefined;
      try {
        await controller.ingestCommunications(ctx, jsonReq(), { records: 'not-an-array' });
      } catch (err) {
        caught = err as BadRequestException;
      }

      expect(caught).toBeInstanceOf(BadRequestException);
      expect((caught!.getResponse() as { message: string }).message).toBe('Validation failed');
      expect(communicationService.createMany).not.toHaveBeenCalled();
    });

    it('rejects a missing body (e.g. no content-type, so no parser ran) with a 400', async () => {
      const { controller, communicationService } = makeController();

      await expect(
        controller.ingestCommunications(ctx, { headers: {} } as never, undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(communicationService.createMany).not.toHaveBeenCalled();
    });
  });

  describe('NDJSON streaming path (Content-Type: application/x-ndjson)', () => {
    it('streams communications lines through the SAME mapping as the envelope path', async () => {
      const { controller, communicationService } = makeController();

      const body = [
        JSON.stringify(communicationRecord('a')),
        JSON.stringify({ ...communicationRecord('b'), direction: 'outbound' }),
      ].join('\n');

      const res = await controller.ingestCommunications(ctx, ndjsonReq(body), undefined);

      expect(res).toEqual({ ingested: 2, duplicate: 0, rejected: [] });
      const dtos = (communicationService.createMany as jest.Mock).mock.calls[0][1];
      expect(dtos[0].time).toEqual(new Date('2026-01-01T00:00:00.000Z'));
      expect(dtos[0].direction).toBe('inbound');
      expect(dtos[1].direction).toBe('outbound');
    });

    it('streams contents lines with event_id mapping and emitCreated: false per batch', async () => {
      const { controller, contentService } = makeController();

      const body = [
        JSON.stringify({ type: 'media', event_id: '01936b2a-0000-7000-8000-000000000001' }),
        JSON.stringify({ type: 'note', text: 'plain' }),
      ].join('\n');

      const res = await controller.ingestContents(ctx, ndjsonReq(body), undefined);

      expect(res).toEqual({ ingested: 2, duplicate: 0, rejected: [] });
      const [, passedRecords, options] = (contentService.createMany as jest.Mock).mock.calls[0];
      expect(passedRecords[0].event).toEqual({ id: '01936b2a-0000-7000-8000-000000000001' });
      expect(passedRecords[0].event_id).toBeUndefined();
      expect(options).toEqual({ emitCreated: false });
    });

    it('rejects invalid lines with 1-based line numbers and keeps streaming', async () => {
      const { controller, itemService } = makeController();

      const body = [
        JSON.stringify({ name: 'Laptop' }),
        'this is not json',
        JSON.stringify({ description: 'missing required name' }),
        JSON.stringify({ name: 'Desk' }),
      ].join('\n');

      const res = await controller.ingestInventory(ctx, ndjsonReq(body), undefined);

      expect(res.ingested).toBe(2);
      expect(res.rejected).toEqual([
        { line: 2, reason: expect.stringContaining('invalid JSON') },
        { line: 3, reason: expect.stringContaining('name') },
      ]);
      expect((itemService.createMany as jest.Mock).mock.calls[0][1]).toHaveLength(2);
    });

    it('reports service-collapsed rows as duplicate (positions, same as the envelope path)', async () => {
      const { controller, positionService } = makeController();
      (positionService.create as jest.Mock).mockResolvedValueOnce([{ id: 'p-1' }]);

      const record = { time: '2026-01-01T00:00:00.000Z', source: 'gps' };
      const res = await controller.ingestPositions(
        ctx,
        ndjsonReq(`${JSON.stringify(record)}\n${JSON.stringify(record)}\n`),
        undefined,
      );

      expect(res).toEqual({ ingested: 1, duplicate: 1, rejected: [] });
    });
  });
});

describe('bulk envelope validation (the shapes the route ValidationPipes enforce)', () => {
  const schemas = [
    ['communications', ingestCommunicationsSchema, communicationRecord('a')],
    ['contents', ingestContentsSchema, { type: 'note', text: 'x' }],
    ['inventory', ingestInventorySchema, { name: 'Lamp' }],
    [
      'browser-activity',
      ingestBrowserActivitySchema,
      { time: '2026-01-01T00:00:00.000Z', url: 'https://example.com' },
    ],
    ['positions', ingestPositionsSchema, { time: '2026-01-01T00:00:00.000Z', source: 'gps' }],
  ] as const;

  it.each(schemas)('%s: rejects a batch over the 10,000-record cap with a 400', (_kind, schema, record) => {
    const pipe = new ValidationPipe(schema);
    const records = Array.from({ length: 10001 }, () => record);

    expect(() => pipe.transform({ records })).toThrow(BadRequestException);
    // 10,000 exactly is allowed.
    expect(schema.safeParse({ records: records.slice(0, 10000) }).success).toBe(true);
  });

  it.each(schemas)('%s: rejects an empty batch', (_kind, schema) => {
    expect(schema.safeParse({ records: [] }).success).toBe(false);
  });

  it('rejects a record failing its kind schema, reporting the zod issue path', () => {
    const pipe = new ValidationPipe(ingestCommunicationsSchema);

    let caught: BadRequestException | undefined;
    try {
      pipe.transform({ records: [{ ...communicationRecord('a'), communication_type: 'letter' }] });
    } catch (err) {
      caught = err as BadRequestException;
    }

    expect(caught).toBeInstanceOf(BadRequestException);
    const body = caught!.getResponse() as { message: string; errors: Array<{ path: (string | number)[] }> };
    expect(body.message).toBe('Validation failed');
    expect(body.errors[0].path).toEqual(['records', 0, 'communication_type']);
  });
});
