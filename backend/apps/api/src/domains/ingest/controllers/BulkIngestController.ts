import { Body, ConflictException, Controller, Post, Req, UseGuards } from '@nestjs/common';
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
  CalendarEventService,
  ItemService,
  ObjectObservationService,
  ProductModelService,
  ReceiptService,
  type CreateCommunicationDto,
  type CreateItemDto,
  type CreateObjectObservationDto,
  type CreateProductModelDto,
  type CreateReceiptDto,
  type ReceiptLineItemInput,
  adoptIngestIdentity,
} from '@ci/domains/memory';
import { NoteService } from '@ci/domains/notes';
import { PositionService } from '@ci/domains/position';

import { ingestNdjsonStream, isNdjsonRequest, type NdjsonIngestResponse } from '../ndjson';
import { IngestCoalesceService } from '../services/IngestCoalesceService';
import {
  type BulkBrowserActivityRecord,
  type BulkCommunicationRecord,
  type BulkContentRecord,
  type BulkIngestResponse,
  type BulkThingRecord,
  type BulkNoteRecord,
  type BulkObservationRecord,
  type BulkPositionRecord,
  type BulkProductModelRecord,
  type BulkReceiptRecord,
  type IngestEventsRequest,
  type ProvenanceRef,
  bulkBrowserActivityRecordSchema,
  bulkCommunicationRecordSchema,
  bulkContentRecordSchema,
  bulkThingRecordSchema,
  bulkObservationRecordSchema,
  bulkPositionRecordSchema,
  bulkProductModelRecordSchema,
  bulkReceiptRecordSchema,
  ingestBrowserActivitySchema,
  ingestCommunicationsSchema,
  ingestContentsSchema,
  ingestEventsSchema,
  ingestThingsSchema,
  ingestNotesSchema,
  ingestObservationsSchema,
  ingestPositionsSchema,
  ingestProductModelsSchema,
  ingestReceiptsSchema,
} from '../types';

/**
 * Which table a capture materializes into; part of the raw-log idempotency key.
 *
 * `ci.capture_events.destination` is unconstrained `text` — the column was
 * added `NOT NULL DEFAULT 'events'` with the default dropped and no CHECK (see
 * 20260716131500_capture_events_capture_key.sql), and no later migration adds
 * one. Widening this union therefore needs NO migration; the only contract the
 * new values participate in is the `(user_id, destination, source_type,
 * source_system, source_id)` unique index, which treats `destination` as
 * opaque text.
 */
type CaptureDestination =
  | 'events'
  | 'communications'
  | 'content'
  | 'things'
  | 'browser_activity'
  | 'position'
  | 'receipts'
  | 'product_models'
  | 'observations';

/** Provenance triple as carried on a wire record or a materialized egress row. */
interface CaptureTriple {
  sourceType: string | null | undefined;
  sourceSystem: string | null | undefined;
  sourceId: string | null | undefined;
}

const hasFullTriple = (t: CaptureTriple): boolean => Boolean(t.sourceType && t.sourceSystem && t.sourceId);

const tripleKey = (t: CaptureTriple): string => `${t.sourceType}\u0000${t.sourceSystem}\u0000${t.sourceId}`;

/** A wire {@link ProvenanceRef} (all three parts required) as a {@link CaptureTriple}. */
const refTriple = (ref: ProvenanceRef): CaptureTriple => ({
  sourceType: ref.sourceType,
  sourceSystem: ref.sourceSystem,
  sourceId: ref.sourceId,
});

/**
 * Lookup key for a receipt-line reference: the receipt's triple plus the line
 * number, which together are the line's natural key.
 */
const lineRefKey = (ref: { receipt: ProvenanceRef; lineNumber: number }): string =>
  `${tripleKey(refTriple(ref.receipt))}\u0000${ref.lineNumber}`;

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
 * `ci.browser_activity`; `/v1/contents` and `/v1/things` are their own
 * tables (content may link to an event via `event_id` / shared provenance);
 * positions stay sensor hypertables; communications stay the dedicated plain
 * table; and the object plane keeps the product/instance split intact —
 * `/v1/product-models` writes the CATALOG (`ci.product_models`), `/v1/things`
 * the owned UNITS, `/v1/receipts` the purchase EVIDENCE (header +
 * `ci.receipt_line_items`), `/v1/observations` mere SIGHTINGS
 * (`ci.object_observations`), which is the one that most needs saying: an
 * observation is "a mug is visible in this photo", never "the user owns this
 * mug", and no route here promotes one into the other. Wave D's rule — fold anything "activity-in-time" onto `ci.events` —
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
 * three-layer capture→materialize→link pipeline ({@link captureAndMaterialize}),
 * with ONE exception: `POST /v1/notes`, whose records carry no provenance
 * triple and so dedupe on their client-minted primary key instead (see
 * {@link ingestNotes}):
 * an append-only raw-log capture (`ci.capture_events`, idempotent on
 * (user_id, destination, triple)), ONE batched call into the kind's EXISTING
 * chunk-safe bulk service (CommunicationService.createMany,
 * ContentService.createMany, ItemService.createMany,
 * BrowserActivityService.createMany, PositionService.create,
 * CalendarEventService.create[]) — idempotent on the service's own key, internally
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
    private readonly eventService: CalendarEventService,
    private readonly noteService: NoteService,
    private readonly receiptService: ReceiptService,
    private readonly productModelService: ProductModelService,
    private readonly objectObservationService: ObjectObservationService,
    private readonly dataSource: DataSource,
    private readonly ingestCoalesceService: IngestCoalesceService,
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
              ...(e.observed_at ? { observed_at: new Date(e.observed_at) } : {}),
              event_type: e.kind,
              source_type: e.source_type ?? 'capture',
              // Adopted, not minted: capture sources own their namespace; the
              // registry canonicalizes the system spelling
              // (docs/design/cross-pipeline-identity.md).
              source_system: adoptIngestIdentity(e.source_system, e.source_id).system,
              source_id: adoptIngestIdentity(e.source_system, e.source_id).id,
              confidence_score: e.confidence_score,
              capture_tick_id: e.capture_tick_id,
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

    if (toMaterialize.length > 0) {
      void this.ingestCoalesceService.schedule(userId).catch(() => undefined);
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
  @Post('things')
  async ingestThings(
    @Context() context: RequestContext,
    @Req() req: Request,
    @Body() body?: unknown,
  ): Promise<BulkIngestResponse | NdjsonIngestResponse> {
    const serviceContext = toServiceContext(context);

    if (isNdjsonRequest(req)) {
      return ingestNdjsonStream(req, bulkThingRecordSchema, (records) =>
        this.flushThings(serviceContext, records),
      );
    }

    const { records } = thingsEnvelopePipe.transform(body) as { records: BulkThingRecord[] };

    return envelopeResponse(() => this.flushThings(serviceContext, records));
  }

  /**
   * DEPRECATED alias of `POST /v1/things`, kept because the retired inventory
   * feature shipped this path and capture clients live in other repos — a
   * sweep of THIS repo found no caller, which is not the same as none existing.
   * Same handler, same schema, same response; nothing behind it says inventory
   * any more.
   *
   * Removable in the release after every first-party capture client
   * (CI-Capture, CI-Browser-Extension, CI-Connect) has shipped a build that
   * posts `/v1/things`, and no earlier: an unrecognised path is a 404 the
   * client's outbox will retry forever.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('inventory')
  async ingestThingsLegacyAlias(
    @Context() context: RequestContext,
    @Req() req: Request,
    @Body() body?: unknown,
  ): Promise<BulkIngestResponse | NdjsonIngestResponse> {
    return this.ingestThings(context, req, body);
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

  /**
   * The durable capture outbox's replay target for notes.
   *
   * **The one route here that does not run {@link captureAndMaterialize}**, and
   * deliberately: that pipeline's raw log is keyed on a provenance triple, and
   * a note has none. Every note would take the triple-less lane and skip the
   * log entirely, so the pipeline would contribute nothing but indirection. A
   * note dedupes on its own primary key instead — a client-minted id, which is
   * a stronger handle than a triple, not a weaker one. See
   * `NoteService.captureMany` for the three guards that make the write safe.
   *
   * JSON envelope only, like `/v1/events` and unlike the five bulk kinds. Notes
   * arrive from the outbox a few at a time; nothing streams them, and NDJSON's
   * per-batch response has no way to carry the ownership conflict below.
   *
   * **409 on an ownership conflict.** A per-record `rejected` entry rides an
   * HTTP 200, which the client flusher reads as success — it would report the
   * flush as delivered and the sidecar would drop the row, losing a note the
   * user wrote. A conflict is instead a hard status, which
   * `isPermanentFlushFailure` classifies permanent, so the item is parked in
   * `needs_attention` where the user can see it. Nothing is silently discarded.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('notes')
  async ingestNotes(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(ingestNotesSchema)) body: { records: BulkNoteRecord[] },
  ): Promise<BulkIngestResponse> {
    const serviceContext = toServiceContext(context);

    const outcome = await this.noteService.captureMany(
      serviceContext,
      body.records.map((record) => ({
        id: record.id,
        title: record.title,
        content: record.content,
        capturedAt: new Date(record.captured_at),
      })),
    );

    if (outcome.conflicted.length > 0) {
      throw new ConflictException(
        `${outcome.conflicted.length} note id(s) belong to another user and were not written.`,
      );
    }

    return {
      // A capture that lands is `ingested` whether it created the row or
      // advanced it; both mean the user's content is now on the appliance.
      ingested: outcome.created.length + outcome.updated.length,
      // Snapshots the appliance already had at or ahead of — the same "we have
      // this already" the other kinds report from their dedup keys.
      duplicate: outcome.stale.length,
      rejected: [],
    };
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

  /**
   * Purchase evidence: the receipt header AND its lines, as one record.
   *
   * Nested rather than a second `/v1/receipt-line-items` route because a line
   * has no identity apart from its receipt — its natural key is
   * `(receipt_id, line_number)` — so a separate route would need the client to
   * know a `receipt_id` the server had not minted yet.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('receipts')
  async ingestReceipts(
    @Context() context: RequestContext,
    @Req() req: Request,
    @Body() body?: unknown,
  ): Promise<BulkIngestResponse | NdjsonIngestResponse> {
    const serviceContext = toServiceContext(context);

    if (isNdjsonRequest(req)) {
      return ingestNdjsonStream(req, bulkReceiptRecordSchema, (records) =>
        this.flushReceipts(serviceContext, records),
      );
    }

    const { records } = receiptsEnvelopePipe.transform(body) as { records: BulkReceiptRecord[] };

    return envelopeResponse(() => this.flushReceipts(serviceContext, records));
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('product-models')
  async ingestProductModels(
    @Context() context: RequestContext,
    @Req() req: Request,
    @Body() body?: unknown,
  ): Promise<BulkIngestResponse | NdjsonIngestResponse> {
    const serviceContext = toServiceContext(context);

    if (isNdjsonRequest(req)) {
      return ingestNdjsonStream(req, bulkProductModelRecordSchema, (records) =>
        this.flushProductModels(serviceContext, records),
      );
    }

    const { records } = productModelsEnvelopePipe.transform(body) as { records: BulkProductModelRecord[] };

    return envelopeResponse(() => this.flushProductModels(serviceContext, records));
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('observations')
  async ingestObservations(
    @Context() context: RequestContext,
    @Req() req: Request,
    @Body() body?: unknown,
  ): Promise<BulkIngestResponse | NdjsonIngestResponse> {
    const serviceContext = toServiceContext(context);

    if (isNdjsonRequest(req)) {
      return ingestNdjsonStream(req, bulkObservationRecordSchema, (records) =>
        this.flushObservations(serviceContext, records),
      );
    }

    const { records } = observationsEnvelopePipe.transform(body) as { records: BulkObservationRecord[] };

    return envelopeResponse(() => this.flushObservations(serviceContext, records));
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
              source_system: adoptIngestIdentity(record.source_system, record.source_id).system,
              source_id: adoptIngestIdentity(record.source_system, record.source_id).id,
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
            source_system: adoptIngestIdentity(record.source_system, record.source_id).system,
            source_id: adoptIngestIdentity(record.source_system, record.source_id).id,
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

  private flushThings(
    serviceContext: UserServiceContext,
    records: BulkThingRecord[],
  ): Promise<{ ingested: number; duplicate: number }> {
    return this.captureAndMaterialize({
      serviceContext,
      records,
      destination: 'things',
      kindOf: () => 'thing.item',
      // Things is the one camelCase /v1 kind (CreateItemDto vocabulary).
      tripleOf: (r) => ({ sourceType: r.sourceType, sourceSystem: r.sourceSystem, sourceId: r.sourceId }),
      occurredAtOf: (r) => r.acquiredAt ?? null,
      // The WHOLE wire record, including the object-identity fields the DTO has
      // no column for (`identifiers`). The raw log is the only place they
      // survive, so a later repair pass can promote them without a re-push.
      payloadOf: (r) => r,
      materialize: async (recs) => {
        // ONE batched pre-pass for the whole slice, before a single row is
        // written: two queries total, not two per record.
        const resolved = await this.resolveObjectRefs(serviceContext, recs);

        return this.itemService.createMany(
          serviceContext,
          recs.map((record): CreateItemDto => {
            // `identifiers` / `productRef` / `acquisitionLineItem` are WIRE
            // fields with no DTO counterpart — destructured out rather than
            // spread through, so nothing undeclared reaches ItemService.
            const { identifiers: _identifiers, productRef, acquisitionLineItem, ...item } = record;
            const link = resolved.forRecord(productRef, acquisitionLineItem);

            return {
              ...item,
              sourceSystem: adoptIngestIdentity(item.sourceSystem, item.sourceId).system,
              sourceId: adoptIngestIdentity(item.sourceSystem, item.sourceId).id,
              // The three item timestamps arrive as ISO strings and the DTO takes
              // Dates. Units are NOT converted here — ItemService owns that, once.
              acquiredAt: record.acquiredAt !== undefined ? new Date(record.acquiredAt) : undefined,
              manufacturedAt:
                record.manufacturedAt != null ? new Date(record.manufacturedAt) : record.manufacturedAt,
              expiresAt: record.expiresAt != null ? new Date(record.expiresAt) : record.expiresAt,
              // A reference the pre-pass could not resolve stays undefined, so
              // the row is written UNLINKED rather than rejected — see
              // resolveObjectRefs.
              ...link,
            };
          }),
        );
      },
    });
  }

  /**
   * Resolve the batch's `productRef` / `acquisitionLineItem` references to row
   * ids, in ONE query per reference kind for the whole slice.
   *
   * ── Why references at all ─────────────────────────────────────────────────
   *
   * An importer pushing a receipt and then the things it bought knows its OWN
   * ids for both, and neither of the uuids this server minted. So the wire
   * carries provenance triples and the server does the lookup — which is a
   * batched join here, not the N+1 of resolving each row as it is built.
   *
   * ── Why a miss is never a rejection ───────────────────────────────────────
   *
   * A reference misses for reasons that are entirely the client's business:
   * the receipt is in a later batch of the same load, or the push order is
   * receipts-after-things, or the receipt failed extraction and was never
   * sent. Rejecting the row would discard a thing the user owns to protect a
   * pointer that a later repair pass can fill in from the very same triples,
   * which are preserved in `ci.capture_events.payload`. So a miss resolves to
   * NULL (the field is simply not set) and the unit is written unlinked.
   */
  private async resolveObjectRefs(
    serviceContext: UserServiceContext,
    records: BulkThingRecord[],
  ): Promise<{
    forRecord: (
      productRef: ProvenanceRef | undefined,
      acquisitionLineItem: BulkThingRecord['acquisitionLineItem'],
    ) => Pick<CreateItemDto, 'productId' | 'acquisitionReceiptId' | 'acquisitionLineItemId'>;
  }> {
    const userId = serviceContext.userId;

    // Distinct keys only: a 5,000-row batch of one product is one lookup key.
    const productRefs = new Map<string, ProvenanceRef>();
    const lineRefs = new Map<string, NonNullable<BulkThingRecord['acquisitionLineItem']>>();

    for (const record of records) {
      if (record.productRef) {
        productRefs.set(tripleKey(refTriple(record.productRef)), record.productRef);
      }

      if (record.acquisitionLineItem) {
        lineRefs.set(lineRefKey(record.acquisitionLineItem), record.acquisitionLineItem);
      }
    }

    const productIdByKey = new Map<string, string>();
    const lineByKey = new Map<string, { lineItemId: string; receiptId: string }>();

    if (productRefs.size > 0) {
      const refs = [...productRefs.values()];
      const rows: Array<{
        product_id: string;
        source_type: string;
        source_system: string;
        source_id: string;
      }> = await this.dataSource.query(
        `SELECT p.product_id, p.source_type, p.source_system, p.source_id
           FROM unnest($2::text[], $3::text[], $4::text[]) AS k(source_type, source_system, source_id)
           JOIN ci.product_models AS p
             ON p.owner_user_id = $1::uuid
            AND p.source_type = k.source_type
            AND p.source_system = k.source_system
            AND p.source_id = k.source_id
          -- A tombstoned model lost a merge; pointing a new unit at it would
          -- recreate the duplicate the merge just removed.
          WHERE p.merged_into_product_id IS NULL`,
        [
          userId,
          refs.map((ref) => ref.sourceType),
          refs.map((ref) => ref.sourceSystem),
          refs.map((ref) => ref.sourceId),
        ],
      );

      for (const row of rows) {
        productIdByKey.set(
          tripleKey({
            sourceType: row.source_type,
            sourceSystem: row.source_system,
            sourceId: row.source_id,
          }),
          row.product_id,
        );
      }
    }

    if (lineRefs.size > 0) {
      const refs = [...lineRefs.values()];
      const rows: Array<{
        line_item_id: string;
        receipt_id: string;
        source_type: string;
        source_system: string;
        source_id: string;
        line_number: number;
      }> = await this.dataSource.query(
        `SELECT li.line_item_id, li.receipt_id, r.source_type, r.source_system, r.source_id, li.line_number
           FROM unnest($2::text[], $3::text[], $4::text[], $5::int[])
                  AS k(source_type, source_system, source_id, line_number)
           JOIN ci.receipts AS r
             ON r.owner_user_id = $1::uuid
            AND r.source_type = k.source_type
            AND r.source_system = k.source_system
            AND r.source_id = k.source_id
           JOIN ci.receipt_line_items AS li
             ON li.receipt_id = r.receipt_id
            AND li.line_number = k.line_number`,
        [
          userId,
          refs.map((ref) => ref.receipt.sourceType),
          refs.map((ref) => ref.receipt.sourceSystem),
          refs.map((ref) => ref.receipt.sourceId),
          refs.map((ref) => ref.lineNumber),
        ],
      );

      for (const row of rows) {
        lineByKey.set(
          lineRefKey({
            receipt: {
              sourceType: row.source_type,
              sourceSystem: row.source_system,
              sourceId: row.source_id,
            },
            lineNumber: Number(row.line_number),
          }),
          { lineItemId: row.line_item_id, receiptId: row.receipt_id },
        );
      }
    }

    return {
      forRecord: (productRef, acquisitionLineItem) => {
        const productId = productRef ? productIdByKey.get(tripleKey(refTriple(productRef))) : undefined;
        const line = acquisitionLineItem ? lineByKey.get(lineRefKey(acquisitionLineItem)) : undefined;

        return {
          ...(productId != null && { productId }),
          // The receipt comes free with the line — it is the line's own
          // receipt, so it cannot disagree with it.
          ...(line != null && {
            acquisitionLineItemId: line.lineItemId,
            acquisitionReceiptId: line.receiptId,
          }),
        };
      },
    };
  }

  private flushReceipts(
    serviceContext: UserServiceContext,
    records: BulkReceiptRecord[],
  ): Promise<{ ingested: number; duplicate: number }> {
    return this.captureAndMaterialize({
      serviceContext,
      records,
      destination: 'receipts',
      kindOf: () => 'commerce.receipt',
      tripleOf: (r) => ({ sourceType: r.source_type, sourceSystem: r.source_system, sourceId: r.source_id }),
      occurredAtOf: (r) => r.purchased_at ?? null,
      payloadOf: (r) => r,
      materialize: async (recs) => {
        const receipts = await this.receiptService.createMany(
          serviceContext,
          recs.map(
            (record): CreateReceiptDto => ({
              id: record.id,
              merchantName: record.merchant_name,
              merchantEntityId: record.merchant_entity_id,
              placeEntityId: record.place_entity_id,
              purchasedAt: record.purchased_at != null ? new Date(record.purchased_at) : record.purchased_at,
              currency: record.currency,
              subtotalMinor: record.subtotal_minor,
              taxMinor: record.tax_minor,
              tipMinor: record.tip_minor,
              shippingMinor: record.shipping_minor,
              discountMinor: record.discount_minor,
              totalMinor: record.total_minor,
              paymentMethod: record.payment_method,
              paymentLast4: record.payment_last4,
              orderNumber: record.order_number,
              channel: record.channel,
              documentContentId: record.document_content_id,
              sourceFileId: record.source_file_id,
              sourceMessageId: record.source_message_id,
              extractionState: record.extraction_state,
              extractionConfidence: record.extraction_confidence,
              extractionModel: record.extraction_model,
              extractionError: record.extraction_error,
              rawText: record.raw_text,
              eventId: record.event_id,
              metadata: record.metadata,
              sourceType: record.source_type,
              sourceSystem: adoptIngestIdentity(record.source_system, record.source_id).system,
              sourceId: adoptIngestIdentity(record.source_system, record.source_id).id,
            }),
          ),
        );

        // `bulkInsertIdempotent` returns ONE entry per input entity IN INPUT
        // ORDER (its documented contract), including for rows that deduped onto
        // an existing receipt — so index-zipping the lines back onto their
        // header is safe here in a way it is not for the services that collapse
        // or reorder.
        //
        // One `replaceLineItems` per receipt, not one statement for the batch:
        // the natural key is `(receipt_id, line_number)` and the "keep a line
        // that already minted a unit" rule is per receipt, so there is no
        // batched line API to call. Receipts arrive in the tens per batch, not
        // the thousands (a Gmail order-confirmation sweep, not a position
        // firehose), so the per-header round trip is the right trade for
        // reusing the one path that knows the mint rule. If that stops being
        // true, the fix is a batched writer in ReceiptService, not a second
        // copy of the rule here.
        for (const [index, record] of recs.entries()) {
          const receipt = receipts[index];

          // Absent lines leave the stored ones alone; an explicit `[]` is a
          // caller saying the receipt has none, and `replaceLineItems` keeps
          // any line that already minted a unit either way.
          if (receipt == null || record.line_items === undefined) {
            continue;
          }

          await this.receiptService.replaceLineItems(
            serviceContext,
            receipt.id,
            record.line_items.map(
              (line): ReceiptLineItemInput => ({
                lineNumber: line.line_number,
                description: line.description,
                quantity: line.quantity,
                unitPriceMinor: line.unit_price_minor,
                totalPriceMinor: line.total_price_minor,
                currency: line.currency,
                productId: line.product_id,
                brand: line.brand,
                modelNumber: line.model_number,
                category: line.category,
                isPhysical: line.is_physical,
                identifierCodes: line.identifier_codes,
                serials: line.serials,
                metadata: line.metadata,
              }),
            ),
          );
        }

        return receipts;
      },
    });
  }

  private flushProductModels(
    serviceContext: UserServiceContext,
    records: BulkProductModelRecord[],
  ): Promise<{ ingested: number; duplicate: number }> {
    return this.captureAndMaterialize({
      serviceContext,
      records,
      destination: 'product_models',
      kindOf: () => 'catalog.product_model',
      tripleOf: (r) => ({ sourceType: r.source_type, sourceSystem: r.source_system, sourceId: r.source_id }),
      // A catalog model is not an event: it has no time of its own, so the
      // capture time is the best-known occurred_at (same as contents).
      occurredAtOf: () => null,
      payloadOf: (r) => r,
      materialize: (recs) =>
        this.productModelService.createMany(
          serviceContext,
          recs.map(
            (record): CreateProductModelDto => ({
              id: record.id,
              title: record.title,
              brand: record.brand,
              manufacturer: record.manufacturer,
              modelNumber: record.model_number,
              category: record.category,
              subcategory: record.subcategory,
              productType: record.product_type,
              description: record.description,
              variantAttributes: record.variant_attributes,
              spec: record.spec,
              msrpMinor: record.msrp_minor,
              currency: record.currency,
              imageContentId: record.image_content_id,
              manualContentIds: record.manual_content_ids,
              isDigital: record.is_digital,
              identityConfidence: record.identity_confidence,
              productEntityId: record.product_entity_id,
              metadata: record.metadata,
              sourceType: record.source_type,
              sourceSystem: adoptIngestIdentity(record.source_system, record.source_id).system,
              sourceId: adoptIngestIdentity(record.source_system, record.source_id).id,
            }),
          ),
        ),
    });
  }

  private flushObservations(
    serviceContext: UserServiceContext,
    records: BulkObservationRecord[],
  ): Promise<{ ingested: number; duplicate: number }> {
    return this.captureAndMaterialize({
      serviceContext,
      records,
      destination: 'observations',
      kindOf: () => 'object.observation',
      tripleOf: (r) => ({ sourceType: r.source_type, sourceSystem: r.source_system, sourceId: r.source_id }),
      occurredAtOf: (r) => r.observed_at,
      observedAtOf: (r) => r.observed_at,
      payloadOf: (r) => r,
      // ObjectObservationService reports more than the rows it wrote — how many
      // were folded as within-batch repeats, how many an existing CONFIRMED row
      // protected from being overwritten, how many carried no usable arbiter.
      // The pipeline's accounting is capture-keyed, so only the written rows
      // matter here (they are what the materialized_id link is stamped from).
      materialize: async (recs) =>
        (
          await this.objectObservationService.createMany(
            serviceContext,
            recs.map(
              (record): CreateObjectObservationDto => ({
                id: record.id,
                observedAt: new Date(record.observed_at),
                sourceKind: record.source_kind,
                label: record.label,
                labelSource: record.label_source,
                detector: record.detector,
                detectorVersion: record.detector_version,
                detectionConfidence: record.detection_confidence,
                bbox: record.bbox,
                contentId: record.content_id,
                fileId: record.file_id,
                eventId: record.event_id,
                cropContentId: record.crop_content_id,
                placeEntityId: record.place_entity_id,
                coordinates: record.coordinates,
                attributes: record.attributes,
                metadata: record.metadata,
                sourceType: record.source_type,
                sourceSystem: adoptIngestIdentity(record.source_system, record.source_id).system,
                sourceId: adoptIngestIdentity(record.source_system, record.source_id).id,
              }),
            ),
          )
        ).written,
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
const thingsEnvelopePipe = new ValidationPipe(ingestThingsSchema);
const browserActivityEnvelopePipe = new ValidationPipe(ingestBrowserActivitySchema);
const positionsEnvelopePipe = new ValidationPipe(ingestPositionsSchema);
const receiptsEnvelopePipe = new ValidationPipe(ingestReceiptsSchema);
const productModelsEnvelopePipe = new ValidationPipe(ingestProductModelsSchema);
const observationsEnvelopePipe = new ValidationPipe(ingestObservationsSchema);
