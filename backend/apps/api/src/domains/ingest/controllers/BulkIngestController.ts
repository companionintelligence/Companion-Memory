import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { DataSource } from 'typeorm';

import { Context, type RequestContext, toServiceContext, type UserServiceContext } from '@ci/common/context';
import { CAPTURE_SCOPE, RequireCapability, RequireScopes, WRITE_CAPABILITY } from '@ci/common/decorators';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { BrowserActivityService } from '@ci/domains/browser-activity';
import {
  CommunicationService,
  CommunicationType,
  ContentService,
  EventService,
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
  type IngestEventsRequest,
  bulkBrowserActivityRecordSchema,
  bulkCommunicationRecordSchema,
  bulkContentRecordSchema,
  bulkInventoryRecordSchema,
  bulkPositionRecordSchema,
  ingestBrowserActivitySchema,
  ingestCommunicationsSchema,
  ingestContentsSchema,
  ingestEventsSchema,
  ingestInventorySchema,
  ingestPositionsSchema,
} from '../types';

/** Which table a capture materializes into; part of the raw-log idempotency key. */
type CaptureDestination =
  | 'events'
  | 'communications'
  | 'content'
  | 'inventory'
  | 'browser_activity'
  | 'position';

/** Provenance triple as carried on a wire record or a materialized egress row. */
interface CaptureTriple {
  sourceType: string | null | undefined;
  sourceSystem: string | null | undefined;
  sourceId: string | null | undefined;
}

const hasFullTriple = (t: CaptureTriple): boolean => Boolean(t.sourceType && t.sourceSystem && t.sourceId);

const tripleKey = (t: CaptureTriple): string => `${t.sourceType}\u0000${t.sourceSystem}\u0000${t.sourceId}`;

/** Rows per raw-log INSERT chunk (9 binds/row keeps chunks far under the 65535-param cap). */
const CAPTURE_LOG_CHUNK = 1000;

/**
 * Read the provenance triple off a materialized egress row. The memory-domain
 * egress types spell it camelCase, browser-activity snake_case; positions omit
 * it entirely (their rows log without a link).
 */
function egressTriple(row: unknown): CaptureTriple {
  const r = row as Record<string, unknown>;

  return {
    sourceType: (r.sourceType ?? r.source_type) as string | null | undefined,
    sourceSystem: (r.sourceSystem ?? r.source_system) as string | null | undefined,
    sourceId: (r.sourceId ?? r.source_id) as string | null | undefined,
  };
}

/**
 * Thrown when a pipeline layer fails AFTER the raw log was compensated:
 * carries the accounting the envelope/NDJSON boundary reports per record.
 */
class BulkMaterializeError extends Error {
  constructor(
    message: string,
    readonly duplicate: number,
    readonly rejectedIndexes: number[],
  ) {
    super(message);
    this.name = 'BulkMaterializeError';
  }
}

/**
 * JSON-envelope boundary: a clean flush maps to `{ ingested, duplicate }`; a
 * BulkMaterializeError becomes the per-record `rejected` list (HTTP 200 — the
 * records are safely re-sendable, matching the events contract), and anything
 * else stays an HTTP error.
 */
async function envelopeResponse(
  flush: () => Promise<{ ingested: number; duplicate: number }>,
): Promise<BulkIngestResponse> {
  try {
    const { ingested, duplicate } = await flush();

    return { ingested, duplicate, rejected: [] };
  } catch (err) {
    if (err instanceof BulkMaterializeError) {
      return {
        ingested: 0,
        duplicate: err.duplicate,
        rejected: err.rejectedIndexes.map((index) => ({ index, reason: err.message })),
      };
    }

    throw err;
  }
}

/**
 * REST bulk-ingest plane: `/v1/*` batch endpoints for every bulk kind the
 * set-based ingest services support, so a machine client (importer, capture
 * device, migration script) can drive a full bulk load over plain REST without
 * touching GraphQL.
 *
 * Also hosts `POST /v1/events`, the G1 unified capture ingest (the original
 * `/v1` endpoint whose auth and response shape the bulk routes mirror). Events
 * follow a different contract from the bulk kinds — JSON envelope only
 * (`{ events: [...] }`, max 1,000), a capture raw log ahead of materialization,
 * and per-record rejection — see {@link ingest}.
 *
 * Destination rule: each kind writes its own table and only its own table.
 * `/v1/events` is the `ci.events` timeline; `/v1/browser-activity` is
 * `ci.browser_activity`; `/v1/contents` and `/v1/inventory` are their own
 * tables (content may link to an event via `event_id` / shared provenance);
 * positions stay sensor hypertables; communications stay the dedicated plain
 * table. Wave D's rule — fold anything "activity-in-time" onto `ci.events` —
 * was reverted in 20260812144811: it put browser page views on the schedule
 * calendar and into HBPE's training corpus, neither of which reads ci.events
 * with an event-kind filter. A record belongs on the timeline when a caller
 * posts it to `/v1/events`, not because another route decided it qualified.
 *
 * Every bulk route accepts TWO request encodings, switched on Content-Type:
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
 * Every route — events and the five bulk kinds alike — runs the same
 * three-layer capture→materialize→link pipeline ({@link captureAndMaterialize}):
 * an append-only raw-log capture (`ci.capture_events`, idempotent on
 * (user_id, destination, triple)), ONE batched call into the kind's EXISTING
 * chunk-safe bulk service (CommunicationService.createMany,
 * ContentService.createMany, ItemService.createMany,
 * BrowserActivityService.createMany, PositionService.create,
 * EventService.create[]) — idempotent on the service's own key, internally
 * chunked under the 65535 bind-param limit, `emitCreated: false` semantics
 * throughout: no per-row *CreatedEvent fan-out, so search indexing and
 * enrichment are DEFERRED until the client calls `POST /v1/ingest/finish`
 * (see IngestLifecycleController) — then a set-based `materialized_id`
 * backfill onto the log.
 */
// Class-level grant: every route here is a capture agent writing observations,
// so `capture` opens the whole `/v1` plane rather than being repeated per route.
// Both decorators resolve via reflector.getAllAndOverride([handler, class]), so
// an individual route can still narrow this if one ever needs to.
//
// This only ever WIDENS access: empty-scope keys (the bulk importer, CI-Ingest)
// and session/JWT callers were never subject to scope enforcement, and no scope
// reached these routes before `capture` existed.
@Controller('v1')
@RequireScopes(CAPTURE_SCOPE)
@RequireCapability(WRITE_CAPABILITY)
export class BulkIngestController {
  constructor(
    private readonly communicationService: CommunicationService,
    private readonly contentService: ContentService,
    private readonly itemService: ItemService,
    private readonly browserActivityService: BrowserActivityService,
    private readonly positionService: PositionService,
    private readonly eventService: EventService,
    private readonly dataSource: DataSource,
  ) {}

  // G1 unified capture ingest — the `/v1` route for timeline events, and the
  // only route that writes ci.events. Instance of the shared
  // capture->materialize->link pipeline (see captureAndMaterialize;
  // event-ingest-spec). Re-POSTing the same (source_type, source_system,
  // source_id) returns `duplicate +1`, not an error.
  //
  // Unlike the bulk routes below, events are JSON-envelope only (no NDJSON), so
  // the envelope validates as a @Body param pipe rather than in the handler.
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('events')
  async ingest(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(ingestEventsSchema)) body: IngestEventsRequest,
  ): Promise<BulkIngestResponse> {
    const serviceContext = toServiceContext(context);

    return envelopeResponse(() =>
      this.captureAndMaterialize({
        serviceContext,
        records: body.events,
        destination: 'events',
        kindOf: (e) => e.kind,
        // Optional provenance passthrough: a bulk importer presents its real
        // source_type; plain capture sources omit it and keep the historical
        // 'capture' stamp — same defaulting style as flushCommunications'
        // direction.
        tripleOf: (e) => ({
          sourceType: e.source_type ?? 'capture',
          sourceSystem: e.source_system,
          sourceId: e.source_id,
        }),
        occurredAtOf: (e) => e.occurred_at,
        observedAtOf: (e) => e.observed_at ?? null,
        payloadOf: (e) => e.payload,
        materialize: (events) =>
          this.eventService.create(
            serviceContext,
            events.map((e) => ({
              title: e.title ?? e.kind,
              description: e.description,
              start_time: new Date(e.occurred_at),
              ...(e.ended_at ? { end_time: new Date(e.ended_at) } : {}),
              event_type: e.kind,
              source_type: e.source_type ?? 'capture',
              source_system: e.source_system,
              source_id: e.source_id,
              confidence_score: e.confidence_score,
              metadata: { kind: e.kind, ...e.payload },
            })),
          ),
      }),
    );
  }

  /**
   * The shared three-layer bulk-ingest pipeline (G1 unified capture, extended
   * from events to every `/v1` kind):
   *
   *   1. CAPTURE — records carrying a full provenance triple append to the raw
   *      log (`ci.capture_events`) in chunked multi-row INSERTs, idempotent on
   *      (user_id, destination, triple). `destination` is part of the key
   *      because one source item may legitimately present the same triple to
   *      two destinations (the importer's fan-out kinds send one item to both
   *      /v1/events and /v1/contents). RETURNING identifies the captures THIS
   *      request created; the remainder (already captured, or a within-request
   *      repeat) counts as `duplicate`. Triple-less records carry no capture
   *      identity and skip straight to materialization — mirroring the
   *      services' own non-dedupable lane, which always inserts.
   *   2. MATERIALIZE — ONE batched call into the kind's set-based service path
   *      (idempotent on its own key, `emitCreated:false` semantics: no per-row
   *      *CreatedEvent, no live indexing — clients index via
   *      POST /v1/ingest/finish). On failure the fresh raw-log rows are
   *      compensated away so a re-send materializes them instead of misreading
   *      its own stranded captures as duplicates; a BulkMaterializeError then
   *      carries the per-record accounting up to the envelope/NDJSON boundary.
   *   3. LINK — one set-based UPDATE stamps `materialized_id` onto the log
   *      rows, matched by TRIPLE (the services may collapse or reorder, so
   *      index-zipping is unsafe; every egress type except positions echoes
   *      its triple — positions log their capture without a link).
   */
  private async captureAndMaterialize<R>(opts: {
    serviceContext: UserServiceContext;
    records: R[];
    destination: CaptureDestination;
    kindOf: (r: R) => string;
    tripleOf: (r: R) => CaptureTriple;
    /** Record's own time; null/undefined falls back to the capture time. */
    occurredAtOf: (r: R) => string | Date | null | undefined;
    observedAtOf?: (r: R) => string | Date | null | undefined;
    payloadOf: (r: R) => unknown;
    /** Batched service call; returns the materialized egress rows. */
    materialize: (records: R[]) => Promise<unknown[]>;
  }): Promise<{ ingested: number; duplicate: number }> {
    const { serviceContext, records, destination } = opts;
    const userId = serviceContext.userId;

    const candidates: { r: R; index: number; triple: CaptureTriple }[] = [];
    const direct: { r: R; index: number }[] = [];
    let duplicate = 0;
    const seen = new Set<string>();
    records.forEach((r, index) => {
      const triple = opts.tripleOf(r);
      if (!hasFullTriple(triple)) {
        direct.push({ r, index });

        return;
      }

      const key = tripleKey(triple);
      if (seen.has(key)) {
        duplicate++;

        return;
      }

      seen.add(key);
      candidates.push({ r, index, triple });
    });

    const captureIdByKey = new Map<string, string>();
    const allIndexes = [...candidates, ...direct].map(({ index }) => index).sort((a, b) => a - b);
    try {
      for (let at = 0; at < candidates.length; at += CAPTURE_LOG_CHUNK) {
        const chunk = candidates.slice(at, at + CAPTURE_LOG_CHUNK);
        const params: unknown[] = [];
        const values = chunk.map(({ r, triple }) => {
          params.push(
            userId,
            destination,
            triple.sourceType,
            triple.sourceSystem,
            triple.sourceId,
            opts.kindOf(r),
            opts.occurredAtOf(r) ?? new Date(),
            opts.observedAtOf?.(r) ?? null,
            opts.payloadOf(r),
          );
          const base = params.length - 9;

          return `(${Array.from({ length: 9 }, (_, c) => `$${base + c + 1}`).join(', ')})`;
        });
        const inserted: {
          capture_event_id: string;
          source_type: string;
          source_system: string;
          source_id: string;
        }[] = await this.dataSource.query(
          `INSERT INTO ci.capture_events
             (user_id, destination, source_type, source_system, source_id, kind, occurred_at, observed_at, payload)
           VALUES ${values.join(', ')}
           ON CONFLICT (user_id, destination, source_type, source_system, source_id) DO NOTHING
           RETURNING capture_event_id, source_type, source_system, source_id`,
          params,
        );
        for (const row of inserted) {
          captureIdByKey.set(
            tripleKey({
              sourceType: row.source_type,
              sourceSystem: row.source_system,
              sourceId: row.source_id,
            }),
            row.capture_event_id,
          );
        }
      }
    } catch (err) {
      // A failed chunk captured nothing, but earlier chunks may have; undo them
      // so every record is safely re-sendable.
      await this.compensateCaptures(captureIdByKey);
      throw new BulkMaterializeError((err as Error).message, duplicate, allIndexes);
    }

    const fresh = candidates.filter(({ triple }) => captureIdByKey.has(tripleKey(triple)));
    duplicate += candidates.length - fresh.length;

    const toMaterialize: { r: R; index: number }[] = [...fresh, ...direct];
    if (toMaterialize.length === 0) {
      return { ingested: 0, duplicate };
    }

    let rows: unknown[];
    try {
      rows = await opts.materialize(toMaterialize.map(({ r }) => r));
    } catch (err) {
      await this.compensateCaptures(captureIdByKey);
      throw new BulkMaterializeError(
        (err as Error).message,
        duplicate,
        toMaterialize.map(({ index }) => index).sort((a, b) => a - b),
      );
    }

    const linkParams: unknown[] = [];
    const linkValues: string[] = [];
    for (const row of rows) {
      const triple = egressTriple(row);
      if (!hasFullTriple(triple)) {
        continue;
      }

      const captureId = captureIdByKey.get(tripleKey(triple));
      const id = (row as { id?: string }).id;
      if (!captureId || !id) {
        continue;
      }

      linkParams.push(captureId, id);
      linkValues.push(`($${linkParams.length - 1}::uuid, $${linkParams.length}::uuid)`);
    }

    if (linkValues.length) {
      await this.dataSource.query(
        `UPDATE ci.capture_events AS c
           SET materialized_id = v.materialized_id
          FROM (VALUES ${linkValues.join(', ')}) AS v(capture_event_id, materialized_id)
         WHERE c.capture_event_id = v.capture_event_id`,
        linkParams,
      );
    }

    return { ingested: toMaterialize.length, duplicate };
  }

  /** Best-effort undo of this request's raw-log inserts (see layer 2 failure). */
  private async compensateCaptures(captureIdByKey: Map<string, string>): Promise<void> {
    if (captureIdByKey.size === 0) {
      return;
    }

    try {
      await this.dataSource.query(`DELETE FROM ci.capture_events WHERE capture_event_id = ANY($1)`, [
        [...captureIdByKey.values()],
      ]);
    } catch {
      /* best-effort: a failed compensation leaves stranded log rows, the pre-fix behaviour */
    }
  }

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

    return envelopeResponse(() => this.flushCommunications(serviceContext, records));
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

    return envelopeResponse(() => this.flushContents(serviceContext, records));
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

    return envelopeResponse(() => this.flushInventory(serviceContext, records));
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

    return envelopeResponse(() => this.flushBrowserActivity(serviceContext, records));
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

    return envelopeResponse(() => this.flushPositions(serviceContext, records));
  }

  // -------------------------------------------------------------------------
  // Per-kind flush: ONE capture->materialize->link pipeline invocation per
  // kind (see captureAndMaterialize), shared verbatim by the JSON-envelope and
  // NDJSON-batch paths. Each returns { ingested, duplicate } — `ingested`
  // counts captures accepted THIS request (fresh log rows + triple-less
  // records), `duplicate` counts already-captured keys and within-request
  // repeats. The materialize closures keep the exact record→DTO mappings the
  // pre-pipeline flushes used.
  // -------------------------------------------------------------------------

  private flushCommunications(
    serviceContext: UserServiceContext,
    records: BulkCommunicationRecord[],
  ): Promise<{ ingested: number; duplicate: number }> {
    return this.captureAndMaterialize({
      serviceContext,
      records,
      destination: 'communications',
      kindOf: (r) => `communication.${r.communication_type}`,
      tripleOf: (r) => ({ sourceType: r.source_type, sourceSystem: r.source_system, sourceId: r.source_id }),
      occurredAtOf: (r) => r.time,
      payloadOf: (r) => r,
      materialize: (recs) =>
        this.communicationService.createMany(
          serviceContext,
          recs.map(
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
        ),
    });
  }

  private flushContents(
    serviceContext: UserServiceContext,
    records: BulkContentRecord[],
  ): Promise<{ ingested: number; duplicate: number }> {
    return this.captureAndMaterialize({
      serviceContext,
      records,
      destination: 'content',
      kindOf: (r) => (r.type ? `content.${r.type}` : 'content'),
      tripleOf: (r) => ({ sourceType: r.source_type, sourceSystem: r.source_system, sourceId: r.source_id }),
      // Content records carry no event time of their own; the capture time is
      // the best-known occurred_at.
      occurredAtOf: () => null,
      payloadOf: (r) => r,
      materialize: (recs) =>
        this.contentService.createMany(
          serviceContext,
          recs.map(({ event_id, ...record }) => ({
            ...record,
            // ContentEntity carries the event FK only via the relation, so a flat
            // event_id maps to `event: { id }` (same as the GraphQL resolver). An
            // explicit event wins; otherwise rows auto-link by provenance triple.
            event: event_id ? { id: event_id } : undefined,
          })),
          // Bulk default anyway; explicit for symmetry with the deferred-indexing
          // contract (index via POST /v1/ingest/finish).
          { emitCreated: false },
        ),
    });
  }

  private flushInventory(
    serviceContext: UserServiceContext,
    records: BulkInventoryRecord[],
  ): Promise<{ ingested: number; duplicate: number }> {
    return this.captureAndMaterialize({
      serviceContext,
      records,
      destination: 'inventory',
      kindOf: () => 'inventory.item',
      // Inventory is the one camelCase /v1 kind (CreateItemDto vocabulary).
      tripleOf: (r) => ({ sourceType: r.sourceType, sourceSystem: r.sourceSystem, sourceId: r.sourceId }),
      occurredAtOf: (r) => r.acquiredAt ?? null,
      payloadOf: (r) => r,
      materialize: (recs) =>
        this.itemService.createMany(
          serviceContext,
          recs.map((record) => ({
            ...record,
            acquiredAt: record.acquiredAt !== undefined ? new Date(record.acquiredAt) : undefined,
          })),
        ),
    });
  }

  private flushBrowserActivity(
    serviceContext: UserServiceContext,
    records: BulkBrowserActivityRecord[],
  ): Promise<{ ingested: number; duplicate: number }> {
    // ci.browser_activity is the only destination. The Wave D fold into
    // ci.events + ci.content was reverted (20260812144811).
    return this.captureAndMaterialize({
      serviceContext,
      records,
      destination: 'browser_activity',
      kindOf: (r) => `web.${r.action_type ?? 'page_view'}`,
      tripleOf: (r) => ({ sourceType: r.source_type, sourceSystem: r.source_system, sourceId: r.source_id }),
      occurredAtOf: (r) => r.time,
      payloadOf: (r) => r,
      // CreateBrowserActivityDto keeps `time` as an ISO string (the service does
      // its own new Date(...)), so the parsed records pass through unchanged.
      materialize: (recs) => this.browserActivityService.createMany(serviceContext, recs),
    });
  }

  private flushPositions(
    serviceContext: UserServiceContext,
    records: BulkPositionRecord[],
  ): Promise<{ ingested: number; duplicate: number }> {
    return this.captureAndMaterialize({
      serviceContext,
      records,
      destination: 'position',
      kindOf: () => 'location.fix',
      // The position triple is optional (#1672) — triple-less fixes skip the
      // log and materialize directly, deduped by the service on (user_id, time).
      tripleOf: (r) => ({ sourceType: r.source_type, sourceSystem: r.source_system, sourceId: r.source_id }),
      occurredAtOf: (r) => r.time,
      payloadOf: (r) => r,
      // Same bulk path POST /position uses. emitCreated:false (#1672): no
      // per-row event fan-out on the bulk plane — clients close the loop via
      // POST /v1/ingest/finish. NOTE: position egress rows carry no triple, so
      // their captures log without a materialized_id link.
      materialize: (recs) => this.positionService.create(serviceContext, recs, { emitCreated: false }),
    });
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
