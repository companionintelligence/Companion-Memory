import { Readable } from 'node:stream';

import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import type { DataSource } from 'typeorm';

import type { RequestContext } from '@ci/common/context';
import { ValidationPipe } from '@ci/common/pipes';
import type { BrowserActivityService } from '@ci/domains/browser-activity';
import type { CommunicationService, ContentService, EventService, ItemService } from '@ci/domains/memory';
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

/**
 * Mock every bulk service to echo one row per record it was handed. For the
 * events route, `captureInserted` scripts the set-based capture-log INSERT per
 * candidate row (in statement order): true → the row inserted (new capture),
 * false → ON CONFLICT hit (duplicate). The mock reconstructs the RETURNING
 * triple from the statement's flattened 8-params-per-row bind list.
 */
function makeController(opts: { captureInserted?: boolean[] } = {}) {
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

  // Batched create: one egress row per input DTO, echoing the triple — the
  // controller's materialized_id backfill matches log rows by triple.
  const eventService = {
    create: jest.fn(async (_context: unknown, data: unknown) =>
      (Array.isArray(data) ? data : [data]).map((d, i) => ({
        id: `event-${i}`,
        sourceType: (d as Record<string, unknown>).source_type,
        sourceSystem: (d as Record<string, unknown>).source_system,
        sourceId: (d as Record<string, unknown>).source_id,
      })),
    ),
  } as unknown as EventService;

  const dataSource = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (/INSERT INTO\s+ci\.capture_events/.test(sql)) {
        // 9 binds per row: user_id, destination, source_type, source_system,
        // source_id, kind, occurred_at, observed_at, payload.
        const rows: Record<string, unknown>[] = [];
        for (let r = 0; r * 9 < params.length; r++) {
          const isNew = (opts.captureInserted ?? [])[r] ?? true;
          if (!isNew) {
            continue;
          }

          rows.push({
            capture_event_id: `cap-${r}`,
            source_type: params[r * 9 + 2],
            source_system: params[r * 9 + 3],
            source_id: params[r * 9 + 4],
          });
        }

        return rows;
      }

      return []; // UPDATE / DELETE
    }),
  } as unknown as DataSource;

  const controller = new BulkIngestController(
    communicationService,
    contentService,
    itemService,
    browserActivityService,
    positionService,
    eventService,
    dataSource,
  );

  return {
    controller,
    communicationService,
    contentService,
    itemService,
    browserActivityService,
    positionService,
    eventService,
    dataSource,
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

const ev = (id: string) => ({
  source_system: 'gmail',
  source_id: id,
  kind: 'communication.email',
  occurred_at: '2026-01-01T00:00:00.000Z',
  payload: { Subject: 'hi' },
});

describe('BulkIngestController', () => {
  describe('POST /v1/events (G1 capture ingest)', () => {
    it('materializes new captures as ONE batched create and counts them as ingested', async () => {
      const { controller, eventService } = makeController({ captureInserted: [true, true] });
      const res = await controller.ingest(ctx, { events: [ev('a'), ev('b')] });
      expect(res.ingested).toBe(2);
      expect(res.duplicate).toBe(0);
      expect(res.rejected).toEqual([]);
      // The ARRAY form takes EventService's set-based path, which emits no
      // per-row EventCreatedEvent — bulk loads must not trigger live indexing.
      expect(eventService.create).toHaveBeenCalledTimes(1);
      const dtos = (eventService.create as jest.Mock).mock.calls[0][1];
      expect(Array.isArray(dtos)).toBe(true);
      expect(dtos).toHaveLength(2);
    });

    it('appends the whole envelope to the raw log with ONE multi-row INSERT', async () => {
      const { controller, dataSource } = makeController({ captureInserted: [true, true, true] });
      await controller.ingest(ctx, { events: [ev('a'), ev('b'), ev('c')] });
      const inserts = (dataSource.query as jest.Mock).mock.calls.filter(([sql]) =>
        /INSERT INTO\s+ci\.capture_events/.test(sql),
      );
      expect(inserts).toHaveLength(1);
      expect(inserts[0][1]).toHaveLength(3 * 9); // 9 binds per row, flattened
    });

    it('counts an already-seen (source_type, source_system, source_id) as duplicate, no event created', async () => {
      const { controller, eventService } = makeController({ captureInserted: [false] });
      const res = await controller.ingest(ctx, { events: [ev('a')] });
      expect(res.duplicate).toBe(1);
      expect(res.ingested).toBe(0);
      expect(eventService.create).not.toHaveBeenCalled();
    });

    it('collapses within-request repeats of a source key as duplicates', async () => {
      const { controller, eventService } = makeController({ captureInserted: [true] });
      const res = await controller.ingest(ctx, { events: [ev('a'), ev('a')] });
      expect(res.ingested).toBe(1);
      expect(res.duplicate).toBe(1);
      expect((eventService.create as jest.Mock).mock.calls[0][1]).toHaveLength(1);
    });

    it('routes capture events to EventService.create with the source triple + kind', async () => {
      const { controller, eventService } = makeController({ captureInserted: [true] });
      await controller.ingest(ctx, { events: [ev('a')] });
      const dto = (eventService.create as jest.Mock).mock.calls[0][1][0];
      expect(dto).toMatchObject({
        source_type: 'capture',
        source_system: 'gmail',
        source_id: 'a',
        event_type: 'communication.email',
      });
    });

    it('materializes ended_at as the event end_time, omitted when absent', async () => {
      const { controller, eventService } = makeController({ captureInserted: [true, true] });
      await controller.ingest(ctx, {
        events: [{ ...ev('a'), ended_at: '2026-01-01T01:30:00.000Z' }, ev('b')],
      });
      const dtos = (eventService.create as jest.Mock).mock.calls[0][1];
      expect(dtos[0].end_time).toEqual(new Date('2026-01-01T01:30:00.000Z'));
      expect(dtos[1]).not.toHaveProperty('end_time');
    });

    it('backfills event_id onto the raw log with ONE set-based UPDATE', async () => {
      const { controller, dataSource } = makeController({ captureInserted: [true, true] });
      await controller.ingest(ctx, { events: [ev('a'), ev('b')] });
      const updates = (dataSource.query as jest.Mock).mock.calls.filter(([sql]) =>
        /UPDATE ci\.capture_events/.test(sql),
      );
      expect(updates).toHaveLength(1);
      // (capture_event_id, event_id) pairs, zipped in input order.
      expect(updates[0][1]).toEqual(['cap-0', 'event-0', 'cap-1', 'event-1']);
    });

    it('passes a client source_type through to the raw log and the materialized event', async () => {
      const { controller, eventService, dataSource } = makeController({ captureInserted: [true] });
      await controller.ingest(ctx, {
        events: [{ ...ev('a'), source_type: 'ci-import-tools' }],
      });

      // Raw log INSERT: the first row's source_type rides as $3 (after
      // user_id and destination).
      const insertCall = (dataSource.query as jest.Mock).mock.calls.find(([sql]) =>
        /INSERT INTO\s+ci\.capture_events/.test(sql),
      );
      expect(insertCall?.[1]?.[2]).toBe('ci-import-tools');

      // Materialized event: the same triple, so it dedups against rows the
      // importer previously created over GraphQL createEvents.
      const dto = (eventService.create as jest.Mock).mock.calls[0][1][0];
      expect(dto).toMatchObject({
        source_type: 'ci-import-tools',
        source_system: 'gmail',
        source_id: 'a',
      });
    });

    it("defaults an absent source_type to 'capture' (pre-passthrough behavior)", async () => {
      const { controller, dataSource } = makeController({ captureInserted: [true] });
      await controller.ingest(ctx, { events: [ev('a')] });
      const insertCall = (dataSource.query as jest.Mock).mock.calls.find(([sql]) =>
        /INSERT INTO\s+ci\.capture_events/.test(sql),
      );
      expect(insertCall?.[1]?.[2]).toBe('capture');
    });

    it('rejects the fresh captures when the batched materialization throws, compensating the raw log', async () => {
      const { controller, eventService, dataSource } = makeController({ captureInserted: [true, true] });
      (eventService.create as jest.Mock).mockImplementation(async () => {
        throw new Error('boom');
      });
      const res = await controller.ingest(ctx, { events: [ev('a'), ev('b')] });
      expect(res.ingested).toBe(0);
      expect(res.rejected).toEqual([
        { index: 0, reason: 'boom' },
        { index: 1, reason: 'boom' },
      ]);
      // The raw-log rows are deleted so a re-send materializes instead of
      // reading its own stranded captures back as duplicates.
      const del = (dataSource.query as jest.Mock).mock.calls.find(([sql]) =>
        /DELETE FROM ci\.capture_events/.test(sql),
      );
      expect(del?.[1]?.[0]).toEqual(['cap-0', 'cap-1']);
    });
  });

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
    it('counts a repeated triple as duplicate; triple-less fixes materialize directly', async () => {
      const { controller, positionService } = makeController();
      (positionService.create as jest.Mock).mockResolvedValueOnce([{ id: 'p-1' }, { id: 'p-2' }]);

      const tripled = {
        time: '2026-01-01T00:00:00.000Z',
        source: 'gps' as const,
        source_type: 'ci-import-tools',
        source_system: 'gpx',
        source_id: 'fix-1',
      };
      const bare = { time: '2026-01-01T00:01:00.000Z', source: 'gps' as const };
      const res = await controller.ingestPositions(ctx, jsonReq(), {
        // The same capture key twice → duplicate; the triple-less fix skips the
        // log (no capture identity) and materializes directly.
        records: [tripled, tripled, bare],
      });

      expect(res).toEqual({ ingested: 2, duplicate: 1, rejected: [] });
      expect((positionService.create as jest.Mock).mock.calls[0][1]).toHaveLength(2);
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

    it('reports a repeated capture key as duplicate (positions, same as the envelope path)', async () => {
      const { controller, positionService } = makeController();
      (positionService.create as jest.Mock).mockResolvedValueOnce([{ id: 'p-1' }]);

      const record = {
        time: '2026-01-01T00:00:00.000Z',
        source: 'gps',
        source_type: 'ci-import-tools',
        source_system: 'gpx',
        source_id: 'fix-1',
      };
      const res = await controller.ingestPositions(
        ctx,
        ndjsonReq(`${JSON.stringify(record)}\n${JSON.stringify(record)}\n`),
        undefined,
      );

      expect(res).toEqual({ ingested: 1, duplicate: 1, rejected: [] });
      expect((positionService.create as jest.Mock).mock.calls[0][1]).toHaveLength(1);
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
