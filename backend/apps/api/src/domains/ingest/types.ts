import { z } from 'zod';

import { MAX_BULK_INPUT_SIZE } from '@ci/common/pipes';
import { createBrowserActivitySchemaRoot } from '@ci/domains/browser-activity';
import { BACKFILLABLE_ENTITIES, ORCHESTRATE_STAGES } from '@ci/domains/maintenance';
import { createPositionSchemaRoot } from '@ci/domains/position';

/**
 * REST bulk-ingest envelopes for the `/v1/*` machine-ingest plane.
 *
 * Every kind shares ONE request shape — `{ records: [...] }` — mirroring
 * `POST /v1/events`' earlier `{ events: [...] }` batch style (captureEventSchema
 * above), and ONE response shape ({@link BulkIngestResponse}). Record schemas match each destination service's
 * create DTO EXACTLY (field names and casing included), so the controller can
 * hand the parsed records to the service with only type coercions (ISO string →
 * Date) and no field renaming:
 *
 *   - communications / contents / browser-activity / positions → snake_case
 *     (CreateCommunicationDto / CreateContentDto / CreateBrowserActivityDto /
 *     CreatePositionDto);
 *   - inventory → camelCase (CreateItemDto is the one camelCase ingest DTO).
 *
 * The per-request cap reuses {@link MAX_BULK_INPUT_SIZE} (10,000) — the same
 * ceiling MaxArraySizePipe enforces on the GraphQL bulk-create mutations. The
 * services chunk internally (computeChunkSize / bulkInsertIdempotent), so the
 * cap bounds request size and lock scope, not bind-param count.
 */

/** Wraps a per-kind record schema in the shared `{ records: [...] }` envelope. */
const bulkEnvelope = <T extends z.ZodTypeAny>(record: T) =>
  z.object({
    records: z.array(record).min(1).max(MAX_BULK_INPUT_SIZE),
  });

// ---------------------------------------------------------------------------
// POST /v1/events → capture raw log + EventService.create
// ---------------------------------------------------------------------------

// G1 unified-capture ingest envelope (event-ingest-spec §4.2), pragmatic v1
// subset. Every capture source — importer, browser ext, pipe — POSTs this shape
// to /v1/events. `kind` is open text for v1; a closed enum + per-kind payload
// schema registry is a follow-up. Predates the `{ records: [...] }` bulk
// envelope below, hence the `{ events: [...] }` key and 1,000-record cap.
export const captureEventSchema = z.object({
  // Provenance source_type, defaulted to 'capture' by the handler when absent
  // (the value this endpoint always stamped). Lets a bulk importer present its
  // real triple — e.g. ci-import-tools sends ('ci-import-tools', '<dataSource>',
  // items.id) — so materialized events dedup against rows the same importer
  // created over GraphQL createEvents, and content rows auto-link by the
  // matching triple. Capture sources that omit it are unchanged.
  source_type: z.string().min(1).optional(),
  source_system: z.string().min(1),
  source_id: z.string().min(1),
  kind: z.string().min(1),
  occurred_at: z.string().datetime(),
  /** ISO 8601, when the event ended — for sources that know the span (viewing
   *  sessions, calendar events, flights). Materializes as events.end_time. */
  ended_at: z.string().datetime().optional(),
  observed_at: z.string().datetime().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  payload: z.record(z.unknown()).default({}),
  confidence_score: z.number().min(0).max(1).optional(),
});

export const ingestEventsSchema = z.object({
  events: z.array(captureEventSchema).min(1).max(1000),
});

export type CaptureEvent = z.infer<typeof captureEventSchema>;
export type IngestEventsRequest = z.infer<typeof ingestEventsSchema>;

// ---------------------------------------------------------------------------
// POST /v1/communications → CommunicationService.createMany
// ---------------------------------------------------------------------------

// Field-for-field CreateCommunicationDto (snake_case), plus the provenance
// triple the dedup path keys on. `communication_type` covers the FULL
// CommunicationType enum (the legacy single-row createCommunicationSchema only
// allows email/sms/call). `direction` is optional here and defaulted to
// 'inbound' in the controller, mirroring the GraphQL createCommunications
// resolver.
export const bulkCommunicationRecordSchema = z.object({
  id: z.string().uuid().optional(),
  time: z.string().datetime(),
  communication_type: z.enum(['email', 'sms', 'call', 'chat', 'video_call', 'voice_note', 'post']),
  direction: z.enum(['inbound', 'outbound']).optional(),
  thread_id: z.string().optional(),
  device_id: z.string().optional(),
  from_entity_id: z.string().optional(),
  to_entity_ids: z.array(z.string()).optional(),
  participants_metadata: z.record(z.unknown()).optional(),
  subject: z.string().optional(),
  content: z.string(),
  attachments: z.array(z.unknown()).optional(),
  duration_seconds: z.number().optional(),
  sentiment_score: z.number().optional(),
  importance_score: z.number().optional(),
  urgency_score: z.number().optional(),
  category: z.string().optional(),
  summary: z.string().optional(),
  connection_id: z.string().optional(),
  is_encrypted: z.boolean().optional(),
  is_archived: z.boolean().optional(),
  preview: z.string().optional(),
  // Provenance triple for idempotent re-ingest (communications_source_dedup).
  source_type: z.string().optional(),
  source_system: z.string().optional(),
  source_id: z.string().optional(),
});

export const ingestCommunicationsSchema = bulkEnvelope(bulkCommunicationRecordSchema);

export type BulkCommunicationRecord = z.infer<typeof bulkCommunicationRecordSchema>;
export type IngestCommunicationsRequest = z.infer<typeof ingestCommunicationsSchema>;

// ---------------------------------------------------------------------------
// POST /v1/contents → ContentService.createMany
// ---------------------------------------------------------------------------

// Field-for-field CreateContentDto (snake_case). `event_id` is accepted flat
// and mapped to the DTO's `event: { id }` relation in the controller (the
// ContentEntity has no scalar event FK property) — same mapping the GraphQL
// createContents resolver does. Rows carrying a provenance triple but no
// explicit event auto-link to the event with the SAME triple (see
// ContentService.createMany).
export const bulkContentRecordSchema = z.object({
  id: z.string().uuid().optional(),
  type: z.string().min(1),
  title: z.string().optional(),
  text: z.string().optional(),
  url: z.string().optional(),
  mimetype: z.string().optional(),
  external_id: z.string().optional(),
  source_url: z.string().optional(),
  source_data: z.record(z.unknown()).optional(),
  event_id: z.string().uuid().optional(),
  // Provenance triple for idempotent re-ingest + event auto-linking
  // (content_source_triple_uniq).
  source_type: z.string().optional(),
  source_system: z.string().optional(),
  source_id: z.string().optional(),
});

export const ingestContentsSchema = bulkEnvelope(bulkContentRecordSchema);

export type BulkContentRecord = z.infer<typeof bulkContentRecordSchema>;
export type IngestContentsRequest = z.infer<typeof ingestContentsSchema>;

// ---------------------------------------------------------------------------
// POST /v1/inventory → ItemService.createMany
// ---------------------------------------------------------------------------

// Field-for-field CreateItemDto — the one camelCase ingest DTO (the entity and
// GraphQL CreateInventoryInput are camelCase too, so the whole inventory path
// shares one vocabulary). `acquiredAt` arrives as an ISO string and is coerced
// to Date in the controller.
export const bulkInventoryRecordSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  brand: z.string().optional(),
  model: z.string().optional(),
  purchasePrice: z.number().optional(),
  currentValue: z.number().optional(),
  currency: z.string().optional(),
  acquiredAt: z.string().datetime().optional(),
  identifierCodes: z.record(z.unknown()).optional(),
  condition: z.enum(['new', 'like_new', 'good', 'fair', 'poor', 'broken', 'n/a']).optional(),
  metadata: z.record(z.unknown()).optional(),
  // Provenance triple for idempotent re-ingest (inventory_source_triple_uniq).
  sourceType: z.string().optional(),
  sourceSystem: z.string().optional(),
  sourceId: z.string().optional(),
});

export const ingestInventorySchema = bulkEnvelope(bulkInventoryRecordSchema);

export type BulkInventoryRecord = z.infer<typeof bulkInventoryRecordSchema>;
export type IngestInventoryRequest = z.infer<typeof ingestInventorySchema>;

// ---------------------------------------------------------------------------
// POST /v1/browser-activity → BrowserActivityService.createMany
// ---------------------------------------------------------------------------

// Reuses the browser-activity domain's own record schema verbatim (it already
// matches CreateBrowserActivityDto, provenance triple included) + the optional
// client-supplied id the DTO allows.
export const bulkBrowserActivityRecordSchema = createBrowserActivitySchemaRoot.extend({
  id: z.string().uuid().optional(),
});

export const ingestBrowserActivitySchema = bulkEnvelope(bulkBrowserActivityRecordSchema);

export type BulkBrowserActivityRecord = z.infer<typeof bulkBrowserActivityRecordSchema>;
export type IngestBrowserActivityRequest = z.infer<typeof ingestBrowserActivitySchema>;

// ---------------------------------------------------------------------------
// POST /v1/positions → PositionService.create (bulk; also behind POST /position)
// ---------------------------------------------------------------------------

// Reuses the position domain's own record schema verbatim (it already matches
// CreatePositionDto — CreatePositionDto has no client-supplied id).
export const bulkPositionRecordSchema = createPositionSchemaRoot;

export const ingestPositionsSchema = bulkEnvelope(bulkPositionRecordSchema);

export type BulkPositionRecord = z.infer<typeof bulkPositionRecordSchema>;
export type IngestPositionsRequest = z.infer<typeof ingestPositionsSchema>;

// ---------------------------------------------------------------------------
// Shared response
// ---------------------------------------------------------------------------

/**
 * Shared bulk-ingest response — one shape for POST /v1/events and every
 * `{ records: [...] }` bulk kind. Every kind runs the same three-layer
 * capture→materialize→link pipeline (BulkIngestController.captureAndMaterialize),
 * so the accounting is uniform:
 *
 *   - `ingested` counts captures accepted THIS request: records whose
 *     provenance triple appended a fresh raw-log row, plus triple-less records
 *     (no capture identity — they materialize directly, deduped only by their
 *     service's own key, e.g. positions on (user_id, time));
 *   - `duplicate` counts records whose (destination, triple) capture key
 *     already existed in the raw log — an idempotent re-send lands HERE — plus
 *     within-request repeats of a key;
 *   - `rejected` is per-record failures. Validation rejects individually
 *     (NDJSON lines / envelope 400s); materialization is all-or-nothing per
 *     batch, so a service failure rejects the batch's records together after
 *     compensating their raw-log rows (they are safely re-sendable).
 */
export interface BulkIngestResponse {
  ingested: number;
  duplicate: number;
  rejected: { index: number; reason: string }[];
}

// ---------------------------------------------------------------------------
// POST /v1/ingest/finish + GET /v1/ingest/status
// ---------------------------------------------------------------------------

/**
 * Body for POST /v1/ingest/finish — the explicit end-of-bulk-load lifecycle
 * call. Default (empty body): run the FULL enrichment orchestration (all nine
 * legs, canonical order — see MaintenanceOrchestratorService). `stages` narrows
 * it to a subset of the canonical vocabulary. `searchIndexOnly: true` skips the
 * orchestrator entirely and runs just the search-index embed backfill sweep
 * (the cheapest "make my rows searchable" path); `entityTypes` scopes that
 * sweep to the types the bulk load actually touched, so a client that pushed
 * only communications doesn't pay a full-table LEFT JOIN over every other
 * backfillable type (#1671). The knobs compose as: `stages` XOR
 * (`searchIndexOnly` [+ `entityTypes`]) — `stages` with either of the other
 * two is a 400 (use `stages: ["search_index"]` to orchestrate only that leg,
 * or `searchIndexOnly` to bypass the orchestrator).
 */
export const ingestFinishSchema = z
  .object({
    stages: z.array(z.enum(ORCHESTRATE_STAGES)).min(1).optional(),
    searchIndexOnly: z.boolean().optional(),
    entityTypes: z.array(z.enum(BACKFILLABLE_ENTITIES)).min(1).optional(),
  })
  .refine((body) => !(body.searchIndexOnly === true && body.stages !== undefined), {
    message: 'stages and searchIndexOnly are mutually exclusive',
  })
  .refine((body) => !(body.entityTypes !== undefined && body.searchIndexOnly !== true), {
    message: 'entityTypes requires searchIndexOnly: true',
  });

export type IngestFinishRequest = z.infer<typeof ingestFinishSchema>;
