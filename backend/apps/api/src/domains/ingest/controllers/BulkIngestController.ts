import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { Context, type RequestContext, toServiceContext, type UserServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { BrowserActivityService } from '@ci/domains/browser-activity';
import {
  CommunicationService,
  CommunicationType,
  ContentService,
  ItemService,
  type CreateCommunicationDto,
} from '@ci/domains/memory';
import { PositionService } from '@ci/domains/position';

import { ingestNdjsonStream, isNdjsonRequest, type NdjsonIngestResponse } from '../ndjson';
import {
  type BulkBrowserActivityRecord,
  type BulkCommunicationRecord,
  type BulkContentRecord,
  type BulkIngestResponse,
  type BulkInventoryRecord,
  type BulkPositionRecord,
  bulkBrowserActivityRecordSchema,
  bulkCommunicationRecordSchema,
  bulkContentRecordSchema,
  bulkInventoryRecordSchema,
  bulkPositionRecordSchema,
  ingestBrowserActivitySchema,
  ingestCommunicationsSchema,
  ingestContentsSchema,
  ingestInventorySchema,
  ingestPositionsSchema,
} from '../types';

/**
 * REST bulk-ingest plane: `/v1/*` batch endpoints for every bulk kind the
 * set-based ingest services support, so a machine client (importer, capture
 * device, migration script) can drive a full bulk load over plain REST without
 * touching GraphQL. Mirrors `POST /v1/events` (EventsIngestController): same
 * auth (JwtOrApiKeyAuthGuard), same batch envelope style, same response shape.
 *
 * Every route accepts TWO request encodings, switched on Content-Type:
 *
 *   - `application/x-ndjson` (the DEFAULT bulk contract): one record per line,
 *     validated against the SAME per-kind record schema, parsed incrementally
 *     off the raw request stream (BodyParserMiddleware bypasses NDJSON on
 *     `/v1/*`, so the handler receives `req` unconsumed) and flushed to the
 *     bulk service in batches of 1,000 as the stream arrives. No overall size
 *     cap — memory is bounded by the batch, a 1 MB per-line ceiling, and a
 *     capped rejection list. Responds `{ ingested, duplicate, rejected:
 *     [{line, reason}] }` (1-based lines); malformed lines and failed batches
 *     are rejected without aborting the stream. See `../ndjson.ts`.
 *   - `application/json`: the `{ records: [...] }` envelope, validated as one
 *     document (max 10,000 records; 10mb `/v1/*` body limit in
 *     BodyParserMiddleware) — unchanged from the original contract.
 *
 * All five routes delegate to the EXISTING chunk-safe bulk services
 * (CommunicationService.createMany, ContentService.createMany,
 * ItemService.createMany, BrowserActivityService.createMany,
 * PositionService.create) — idempotent on the provenance triple
 * (source_type, source_system, source_id) via INSERT … ON CONFLICT, internally
 * chunked under the 65535 bind-param limit, and `emitCreated: false`
 * throughout: no per-row *CreatedEvent fan-out, so search indexing and
 * enrichment are DEFERRED until the client calls `POST /v1/ingest/finish`
 * (see IngestLifecycleController).
 */
@Controller('v1')
export class BulkIngestController {
  constructor(
    private readonly communicationService: CommunicationService,
    private readonly contentService: ContentService,
    private readonly itemService: ItemService,
    private readonly browserActivityService: BrowserActivityService,
    private readonly positionService: PositionService,
  ) {}

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('communications')
  async ingestCommunications(
    @Context() context: RequestContext,
    @Req() req: Request,
    @Body() body?: unknown,
  ): Promise<BulkIngestResponse | NdjsonIngestResponse> {
    const serviceContext = toServiceContext(context);

    if (isNdjsonRequest(req)) {
      return ingestNdjsonStream(req, bulkCommunicationRecordSchema, (records) =>
        this.flushCommunications(serviceContext, records),
      );
    }

    const { records } = communicationsEnvelopePipe.transform(body) as { records: BulkCommunicationRecord[] };

    return toBulkResponse(records.length, await this.flushCommunications(serviceContext, records));
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('contents')
  async ingestContents(
    @Context() context: RequestContext,
    @Req() req: Request,
    @Body() body?: unknown,
  ): Promise<BulkIngestResponse | NdjsonIngestResponse> {
    const serviceContext = toServiceContext(context);

    if (isNdjsonRequest(req)) {
      return ingestNdjsonStream(req, bulkContentRecordSchema, (records) =>
        this.flushContents(serviceContext, records),
      );
    }

    const { records } = contentsEnvelopePipe.transform(body) as { records: BulkContentRecord[] };

    return toBulkResponse(records.length, await this.flushContents(serviceContext, records));
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('inventory')
  async ingestInventory(
    @Context() context: RequestContext,
    @Req() req: Request,
    @Body() body?: unknown,
  ): Promise<BulkIngestResponse | NdjsonIngestResponse> {
    const serviceContext = toServiceContext(context);

    if (isNdjsonRequest(req)) {
      return ingestNdjsonStream(req, bulkInventoryRecordSchema, (records) =>
        this.flushInventory(serviceContext, records),
      );
    }

    const { records } = inventoryEnvelopePipe.transform(body) as { records: BulkInventoryRecord[] };

    return toBulkResponse(records.length, await this.flushInventory(serviceContext, records));
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('browser-activity')
  async ingestBrowserActivity(
    @Context() context: RequestContext,
    @Req() req: Request,
    @Body() body?: unknown,
  ): Promise<BulkIngestResponse | NdjsonIngestResponse> {
    const serviceContext = toServiceContext(context);

    if (isNdjsonRequest(req)) {
      return ingestNdjsonStream(req, bulkBrowserActivityRecordSchema, (records) =>
        this.flushBrowserActivity(serviceContext, records),
      );
    }

    const { records } = browserActivityEnvelopePipe.transform(body) as {
      records: BulkBrowserActivityRecord[];
    };

    return toBulkResponse(records.length, await this.flushBrowserActivity(serviceContext, records));
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('positions')
  async ingestPositions(
    @Context() context: RequestContext,
    @Req() req: Request,
    @Body() body?: unknown,
  ): Promise<BulkIngestResponse | NdjsonIngestResponse> {
    const serviceContext = toServiceContext(context);

    if (isNdjsonRequest(req)) {
      return ingestNdjsonStream(req, bulkPositionRecordSchema, (records) =>
        this.flushPositions(serviceContext, records),
      );
    }

    const { records } = positionsEnvelopePipe.transform(body) as { records: BulkPositionRecord[] };

    return toBulkResponse(records.length, await this.flushPositions(serviceContext, records));
  }

  // -------------------------------------------------------------------------
  // Per-kind flush: ONE mapping per kind, shared verbatim by the JSON-envelope
  // and NDJSON-batch paths. Each returns how many records the service ACCEPTED
  // (created now or found pre-existing); the caller derives `duplicate` from
  // the shortfall (intra-request provenance/time collisions the service
  // collapsed).
  // -------------------------------------------------------------------------

  private async flushCommunications(
    serviceContext: UserServiceContext,
    records: BulkCommunicationRecord[],
  ): Promise<number> {
    const rows = await this.communicationService.createMany(
      serviceContext,
      records.map(
        (record): CreateCommunicationDto => ({
          ...record,
          // The zod enum vocabulary IS the CommunicationType value set; the
          // cast bridges string-literal union → TS enum (same as the GraphQL
          // createCommunications resolver).
          communication_type: record.communication_type as CommunicationType,
          time: new Date(record.time),
          // Stored verbatim; default to 'inbound' when omitted — mirrors the
          // GraphQL createCommunications resolver.
          direction: record.direction ?? 'inbound',
        }),
      ),
    );

    return rows.length;
  }

  private async flushContents(
    serviceContext: UserServiceContext,
    records: BulkContentRecord[],
  ): Promise<number> {
    const rows = await this.contentService.createMany(
      serviceContext,
      records.map(({ event_id, ...record }) => ({
        ...record,
        // ContentEntity carries the event FK only via the relation, so a flat
        // event_id maps to `event: { id }` (same as the GraphQL resolver). An
        // explicit event wins; otherwise rows auto-link by provenance triple.
        event: event_id ? { id: event_id } : undefined,
      })),
      // Bulk default anyway; explicit for symmetry with the deferred-indexing
      // contract (index via POST /v1/ingest/finish).
      { emitCreated: false },
    );

    return rows.length;
  }

  private async flushInventory(
    serviceContext: UserServiceContext,
    records: BulkInventoryRecord[],
  ): Promise<number> {
    const rows = await this.itemService.createMany(
      serviceContext,
      records.map((record) => ({
        ...record,
        acquiredAt: record.acquiredAt !== undefined ? new Date(record.acquiredAt) : undefined,
      })),
    );

    return rows.length;
  }

  private async flushBrowserActivity(
    serviceContext: UserServiceContext,
    records: BulkBrowserActivityRecord[],
  ): Promise<number> {
    // CreateBrowserActivityDto keeps `time` as an ISO string (the service does
    // its own new Date(...)), so the parsed records pass through unchanged.
    const rows = await this.browserActivityService.createMany(serviceContext, records);

    return rows.length;
  }

  private async flushPositions(
    serviceContext: UserServiceContext,
    records: BulkPositionRecord[],
  ): Promise<number> {
    // Same bulk path POST /position uses; CreatePositionDto keeps `time` as an
    // ISO string. PositionService collapses intra-batch same-time records and
    // returns existing + created rows, so `duplicate` counts the in-batch
    // time collisions. emitCreated:false (#1672): no per-row event fan-out on
    // the bulk plane — clients close the loop via POST /v1/ingest/finish.
    const rows = await this.positionService.create(serviceContext, records, {
      emitCreated: false,
    });

    return rows.length;
  }
}

// Envelope validation happens INSIDE the handlers (not as @Body param pipes)
// because the same route also serves NDJSON, where `req.body` is intentionally
// never populated — a param pipe would 400 the streaming path before the
// handler could branch on Content-Type. Same ValidationPipe, same
// `{ message: 'Validation failed', errors: [...] }` 400 shape as before.
const communicationsEnvelopePipe = new ValidationPipe(ingestCommunicationsSchema);
const contentsEnvelopePipe = new ValidationPipe(ingestContentsSchema);
const inventoryEnvelopePipe = new ValidationPipe(ingestInventorySchema);
const browserActivityEnvelopePipe = new ValidationPipe(ingestBrowserActivitySchema);
const positionsEnvelopePipe = new ValidationPipe(ingestPositionsSchema);

/**
 * Shared response derivation (see {@link BulkIngestResponse} for the exact
 * duplicate-counting contract): the services return one row per ACCEPTED record
 * — created now or found pre-existing — and silently collapse intra-request
 * duplicates (same provenance triple / same position time), so the collapsed
 * remainder is reported as `duplicate`. Whole-batch failures surface as HTTP
 * errors, so a 200 always has an empty `rejected`.
 */
function toBulkResponse(received: number, accepted: number): BulkIngestResponse {
  return {
    ingested: accepted,
    duplicate: Math.max(0, received - accepted),
    rejected: [],
  };
}
