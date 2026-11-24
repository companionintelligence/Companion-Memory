import { z } from 'zod/v3';

import { MAX_BULK_INPUT_SIZE } from '@ci/common/pipes';
import { createBrowserActivitySchemaRoot } from '@ci/domains/browser-activity';
import { BACKFILLABLE_ENTITIES, ORCHESTRATE_STAGES } from '@ci/domains/maintenance';
import { createPositionSchemaRoot } from '@ci/domains/position';

/**
 * REST bulk-ingest envelopes for the `/v1/*` machine-ingest plane.
 *
 * Every kind shares ONE request shape — `{ records: [...] }` — mirroring
 * `POST /v1/events`' earlier `{ events: [...] }` batch style (captureEventSchema
 * above), and ONE response shape ({@link BulkIngestResponse}).
 *
 * Wire records are snake_case (matching the rest of this envelope) and match
 * each destination DTO field-for-field in MEANING, but casing is NOT uniform
 * across DTOs, so the controller's job differs per lane:
 *
 *   - communications / contents / browser-activity / positions → the DTO
 *     (CreateCommunicationDto / CreateContentDto / CreateBrowserActivityDto /
 *     CreatePositionDto) is ALSO snake_case, so the controller hands the
 *     parsed records straight through with only type coercions (ISO string →
 *     Date) and no field renaming;
 *   - receipts / product-models / observations → the DTO (CreateReceiptDto /
 *     CreateProductModelDto / CreateObjectObservationDto) is camelCase, so
 *     the controller renames every field snake_case → camelCase on the way
 *     in (a lossless 1:1 case conversion, not a semantic reshape);
 *   - things → camelCase on the wire too (CreateItemDto is the one ingest DTO
 *     whose wire records are already camelCase, matching the DTO directly —
 *     the object tables added alongside it stay snake_case like every other
 *     kind's wire records).
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

/**
 * A reference to a row identified by its PROVENANCE TRIPLE rather than by a
 * server-assigned uuid.
 *
 * The bulk plane's one cross-kind referencing problem: an importer pushing a
 * receipt and then the thing it produced does not know the uuid the server
 * minted for either — it only knows its own `(source_type, source_system,
 * source_id)` for each. All three parts are required: the partial unique
 * indexes these resolve against are `WHERE source_id IS NOT NULL` and treat the
 * triple as a whole, so a two-part reference cannot address a row.
 *
 * Resolution is BEST-EFFORT by contract — see the pre-pass in
 * `BulkIngestController.flushThings`. A reference that misses (the receipt
 * has not been pushed yet, or arrived in a later batch of the same load)
 * resolves to NULL and the row is written without the link, never rejected:
 * push order is the client's business, and a rejected row is data lost, while a
 * missing link is data a later repair pass can still fill in.
 */
const provenanceRefSchema = z.object({
  sourceType: z.string().min(1),
  sourceSystem: z.string().min(1),
  sourceId: z.string().min(1),
});

export type ProvenanceRef = z.infer<typeof provenanceRefSchema>;

// ---------------------------------------------------------------------------
// POST /v1/events → capture raw log + CalendarEventService.create
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
  /**
   * Per-tick correlator: CI-Capture mints one UUID per worker tick and sends
   * it on BOTH this event and the screenshot uploaded via the same tick
   * (POST /files/upload's `captureTickId` field), so CI-Server can link a
   * `ci.files` row back to the desktop-activity event it was captured
   * alongside. Unrelated to the provenance triple above — that's this row's
   * own dedup key; this is a cross-table link.
   */
  capture_tick_id: z.string().uuid().optional(),
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
  // Provenance triple for idempotent re-ingest (communications_source_identity_uniq).
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
  // What external_id references. Accepted rather than dropped: a client that
  // knows (the importer stamps 'file' for an uploaded blob, 'external_uri' for
  // a source-native URI — see push/inputs.ts toContentInput) must be able to
  // say so over the wire. Zod strips unknown keys, so omitting this field here
  // silently discarded the classification and left the row to depend on the
  // shape fallback in ContentService.toDetailFields, which cannot recognise a
  // bare platform id. Omitted by a client that does not know: still optional.
  external_id_kind: z.enum(['file', 'external_uri']).optional(),
  source_url: z.string().optional(),
  source_data: z.record(z.unknown()).optional(),
  event_id: z.string().uuid().optional(),
  // Provenance triple for idempotent re-ingest + event auto-linking
  // (content_source_identity_uniq).
  source_type: z.string().optional(),
  source_system: z.string().optional(),
  source_id: z.string().optional(),
});

export const ingestContentsSchema = bulkEnvelope(bulkContentRecordSchema);

export type BulkContentRecord = z.infer<typeof bulkContentRecordSchema>;
export type IngestContentsRequest = z.infer<typeof ingestContentsSchema>;

// ---------------------------------------------------------------------------
// POST /v1/notes → NoteService.captureMany
// ---------------------------------------------------------------------------

/**
 * The one bulk kind whose `id` is REQUIRED rather than optional.
 *
 * Notes are the outbox's interactive-capture kind: the client mints the id
 * before the note is queued, so the note has a stable identity from the instant
 * it is written and nothing has to be reconciled when it drains. That id is
 * also the idempotency key — notes carry no provenance triple, so the primary
 * key is what makes an at-least-once replay free (NoteService.captureMany).
 * Accepting a note without one would mean a replay inserting a second copy,
 * which is precisely the failure this route exists to avoid.
 *
 * `captured_at` is required for the same reason: it is the last-write-wins
 * discriminator against whatever is already stored, so a snapshot that sat in
 * the queue while the note was edited elsewhere loses instead of clobbering.
 */
export const bulkNoteRecordSchema = z.object({
  id: z.string().uuid(),
  title: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  captured_at: z.string().datetime(),
});

export const ingestNotesSchema = bulkEnvelope(bulkNoteRecordSchema);

export type BulkNoteRecord = z.infer<typeof bulkNoteRecordSchema>;
export type IngestNotesRequest = z.infer<typeof ingestNotesSchema>;

// ---------------------------------------------------------------------------
// POST /v1/things → ItemService.createMany
// ---------------------------------------------------------------------------

// Field-for-field CreateItemDto — the one camelCase ingest DTO (the entity and
// GraphQL CreateThingInput are camelCase too, so the whole things path
// shares one vocabulary). `acquiredAt` arrives as an ISO string and is coerced
// to Date in the controller.
//
// The object-identity fields at the bottom (`identifiers`, `productRef`,
// `acquisitionLineItem`, `lifecycleState`) are STRICTLY ADDITIVE and every one
// of them is optional: a payload from today's importer — which sends none of
// them — must validate byte-identically and produce the same row it always
// did. `Routes.e2e.test.ts` asserts exactly that against a recorded
// today-shaped record, so the additions cannot quietly change the existing
// contract.
export const bulkThingRecordSchema = z.object({
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
  quantity: z.number().int().positive().optional(),
  metadata: z.record(z.unknown()).optional(),
  // Physical properties. Measurements accept a canonical SI number OR a
  // unit-bearing string ('12 in', '2.5 lb'), because a product feed rarely
  // publishes millimetres — ItemService resolves them through the one
  // normalizer before the write, and rejects the batch with a 400 naming the
  // field if it cannot. Everything the schema does NOT check here (bounds,
  // colour hygiene, composition sums) is checked there, so this stays a shape
  // guard and does not become a second, drifting copy of those rules.
  lengthMm: z.union([z.number(), z.string()]).nullable().optional(),
  widthMm: z.union([z.number(), z.string()]).nullable().optional(),
  heightMm: z.union([z.number(), z.string()]).nullable().optional(),
  massG: z.union([z.number(), z.string()]).nullable().optional(),
  volumeMl: z.union([z.number(), z.string()]).nullable().optional(),
  /** '12 x 8 x 2 in' — fills only the axes not sent individually. */
  dimensions: z.string().nullable().optional(),
  unitSystem: z.enum(['metric', 'imperial']).nullable().optional(),
  colors: z
    .union([z.array(z.string()), z.string()])
    .nullable()
    .optional(),
  colorHex: z.string().nullable().optional(),
  materials: z
    .union([z.array(z.string()), z.string()])
    .nullable()
    .optional(),
  composition: z
    .record(z.union([z.number(), z.string()]))
    .nullable()
    .optional(),
  acquisitionMethod: z.string().nullable().optional(),
  acquiredFrom: z.string().nullable().optional(),
  manufacturedAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  isDigital: z.boolean().optional(),

  // -------------------------------------------------------------------------
  // Object identity (migration 20260803223025). ALL OPTIONAL — see the note on
  // the schema above.
  // -------------------------------------------------------------------------

  /**
   * Identifiers printed on or attached to the unit — `[{namespace: 'serial',
   * value: 'F2LX…'}]`. CI-Import-Tools has been sending these for a while and
   * zod, which strips undeclared keys, was throwing them away BEFORE the
   * capture raw log saw them: the claim was not merely unwritten, it was
   * unrecoverable. Declaring the field keeps it in `ci.capture_events.payload`,
   * so a later pass can promote it into `ci.object_identifiers` without asking
   * the client to re-push.
   *
   * NOT yet written to `ci.object_identifiers` by this route — promotion is
   * `ObjectIdentifierService`'s and needs a subject that exists, which is a
   * post-materialize step this plane does not run yet.
   */
  identifiers: z
    .array(
      z.object({
        namespace: z.enum([
          'gtin',
          'isbn',
          'asin',
          'mpn',
          'sku',
          'serial',
          'imei',
          'vin',
          'order_id',
          'rfid',
          'qr',
          'custom',
        ]),
        value: z.string().min(1),
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .optional(),
  /** The catalog model this unit instantiates, by the model's provenance triple. */
  productRef: provenanceRefSchema.optional(),
  /**
   * The receipt line this unit was bought on: the RECEIPT's provenance triple
   * plus the 1-based line number, which is the line's natural key
   * (`receipt_line_items(receipt_id, line_number)`). Lines carry no triple of
   * their own — they are identified through their receipt.
   */
  acquisitionLineItem: z
    .object({
      receipt: provenanceRefSchema,
      lineNumber: z.number().int().positive(),
    })
    .optional(),
  /**
   * Queryable ownership state; the schema defaults it to 'active'. The
   * vocabulary mirrors `ObjectLifecycleState`, which itself mirrors the
   * `objects_lifecycle_state_check` constraint — all three move together.
   */
  lifecycleState: z
    .enum(['active', 'stored', 'lent_out', 'lost', 'disposed', 'consumed', 'returned', 'archived'])
    .optional(),

  // Provenance triple for idempotent re-ingest (objects_source_identity_uniq).
  sourceType: z.string().optional(),
  sourceSystem: z.string().optional(),
  sourceId: z.string().optional(),
});

export const ingestThingsSchema = bulkEnvelope(bulkThingRecordSchema);

export type BulkThingRecord = z.infer<typeof bulkThingRecordSchema>;
export type IngestThingsRequest = z.infer<typeof ingestThingsSchema>;

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
// POST /v1/receipts → ReceiptService.createMany (+ replaceLineItems)
// ---------------------------------------------------------------------------

/**
 * One line on a receipt — field-for-field `ReceiptLineItemInput`, snake_case.
 *
 * `line_number` is 1-based and STABLE: it is half of the natural key
 * `(receipt_id, line_number)`, so re-pushing the same receipt updates each line
 * IN PLACE. A source that renumbers its lines between pushes forks them.
 */
export const bulkReceiptLineItemRecordSchema = z.object({
  line_number: z.number().int().positive(),
  description: z.string().min(1),
  /** NUMERIC(12,3) — fractional quantities are real (1.5 kg of coffee). */
  quantity: z.number().optional(),
  unit_price_minor: z.number().int().nullable().optional(),
  total_price_minor: z.number().int().nullable().optional(),
  currency: z.string().nullable().optional(),
  product_id: z.string().uuid().nullable().optional(),
  brand: z.string().nullable().optional(),
  model_number: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  /** FALSE for ebooks, subscriptions and gift cards. Only physical lines mint units. */
  is_physical: z.boolean().optional(),
  /** `{gtin: '0123…', asin: 'B0…'}` — promoted into ci.object_identifiers, never stored verbatim. */
  identifier_codes: z.record(z.string().nullable()).optional(),
  /** Distinct serial numbers supplied by the line. N serials mint N units. */
  serials: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * Field-for-field `CreateReceiptDto` (snake_case), plus the nested
 * `line_items[]` — because a receipt without its lines is not a receipt, it is
 * a total. The header and its lines are ONE record on the wire so the client
 * cannot push half a purchase, and so lines need no provenance triple of their
 * own (they are addressed through the header's, by `line_number`).
 *
 * Money is INTEGER MINOR UNITS throughout (`total_minor: 1299`, never
 * `12.99`) — the entities store bigint minor units and a float of dollars is
 * how a cent goes missing.
 */
export const bulkReceiptRecordSchema = z.object({
  id: z.string().uuid().optional(),
  merchant_name: z.string().nullable().optional(),
  merchant_entity_id: z.string().uuid().nullable().optional(),
  place_entity_id: z.string().uuid().nullable().optional(),
  purchased_at: z.string().datetime().nullable().optional(),
  currency: z.string().nullable().optional(),
  subtotal_minor: z.number().int().nullable().optional(),
  tax_minor: z.number().int().nullable().optional(),
  tip_minor: z.number().int().nullable().optional(),
  shipping_minor: z.number().int().nullable().optional(),
  discount_minor: z.number().int().nullable().optional(),
  total_minor: z.number().int().nullable().optional(),
  payment_method: z.string().nullable().optional(),
  /** Last four digits ONLY. A full card number is never accepted or stored. */
  payment_last4: z.string().max(4).nullable().optional(),
  order_number: z.string().nullable().optional(),
  channel: z.enum(['online', 'in_store', 'app', 'phone', 'unknown']).nullable().optional(),
  document_content_id: z.string().uuid().nullable().optional(),
  source_file_id: z.string().uuid().nullable().optional(),
  source_message_id: z.string().nullable().optional(),
  extraction_state: z.enum(['pending', 'extracted', 'failed', 'manual', 'not_applicable']).optional(),
  extraction_confidence: z.number().min(0).max(1).nullable().optional(),
  extraction_model: z.string().nullable().optional(),
  extraction_error: z.string().nullable().optional(),
  raw_text: z.string().nullable().optional(),
  event_id: z.string().uuid().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  /** Absent and `[]` mean different things: absent leaves the stored lines alone. */
  line_items: z.array(bulkReceiptLineItemRecordSchema).optional(),
  // Provenance triple for idempotent re-ingest (receipts_source_identity_uniq).
  source_type: z.string().optional(),
  source_system: z.string().optional(),
  source_id: z.string().optional(),
});

export const ingestReceiptsSchema = bulkEnvelope(bulkReceiptRecordSchema);

export type BulkReceiptLineItemRecord = z.infer<typeof bulkReceiptLineItemRecordSchema>;
export type BulkReceiptRecord = z.infer<typeof bulkReceiptRecordSchema>;
export type IngestReceiptsRequest = z.infer<typeof ingestReceiptsSchema>;

// ---------------------------------------------------------------------------
// POST /v1/product-models → ProductModelService.createMany
// ---------------------------------------------------------------------------

/**
 * Field-for-field `CreateProductModelDto` (snake_case).
 *
 * `identity_confidence` is deliberately NOT defaulted here. The column defaults
 * to 1.0, which HBPE and RAG read as ground truth, so a feed that INFERRED the
 * model (a receipt line, a vision guess) has to say so explicitly — see
 * `FIND_OR_CREATE_IDENTITY_CONFIDENCE`. Defaulting it in the wire schema would
 * silently promote every guess to a fact.
 */
export const bulkProductModelRecordSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1),
  brand: z.string().nullable().optional(),
  manufacturer: z.string().nullable().optional(),
  model_number: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  subcategory: z.string().nullable().optional(),
  product_type: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  /** Variant AXES only ({color, capacity, size}) — never descriptive specs. */
  variant_attributes: z.record(z.unknown()).optional(),
  spec: z.record(z.unknown()).optional(),
  /** Integer MINOR units of `currency`. Never a float of dollars. */
  msrp_minor: z.number().int().nullable().optional(),
  currency: z.string().nullable().optional(),
  image_content_id: z.string().uuid().nullable().optional(),
  manual_content_ids: z.array(z.string().uuid()).nullable().optional(),
  is_digital: z.boolean().optional(),
  /** CHECKed `> 0 AND <= 1` by the table; rejected here so it 400s, not 500s. */
  identity_confidence: z.number().gt(0).max(1).optional(),
  product_entity_id: z.string().uuid().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  // Provenance triple for idempotent re-ingest (product_models_source_identity_uniq).
  source_type: z.string().optional(),
  source_system: z.string().optional(),
  source_id: z.string().optional(),
});

export const ingestProductModelsSchema = bulkEnvelope(bulkProductModelRecordSchema);

export type BulkProductModelRecord = z.infer<typeof bulkProductModelRecordSchema>;
export type IngestProductModelsRequest = z.infer<typeof ingestProductModelsSchema>;

// ---------------------------------------------------------------------------
// POST /v1/observations → ObjectObservationService.createMany
// ---------------------------------------------------------------------------

/**
 * Field-for-field `CreateObjectObservationDto` (snake_case) — a SIGHTING, and
 * only a sighting.
 *
 * There is deliberately no way to assert `resolved_object_id`,
 * `resolution_method` or `confirmed_by_user` over this route, exactly as there
 * is none on the DTO: resolution is a separate, revisable decision, and a
 * detector that could write it on the way in is the conflation
 * `ci.object_observations` exists to prevent. `detection_key` is absent for the
 * same reason — it is DERIVED by the service, and a caller-chosen idempotency
 * key is how the same detector run lands twice.
 */
export const bulkObservationRecordSchema = z.object({
  id: z.string().uuid().optional(),
  /** When the PIXELS were captured — not when the detector ran. */
  observed_at: z.string().datetime(),
  source_kind: z.enum(['photo', 'video_frame', 'live_camera', 'screenshot', 'manual']).optional(),
  /** What the detector said, verbatim. Required: a label-less sighting carries no information. */
  label: z.string().min(1),
  label_source: z.enum(['yolo', 'ollama_vision', 'clip', 'user', 'import']).nullable().optional(),
  detector: z.string().nullable().optional(),
  detector_version: z.string().nullable().optional(),
  detection_confidence: z.number().min(0).max(1).nullable().optional(),
  /** Normalized to 0..1 of the source image, origin top-left. */
  bbox: z
    .object({
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
    })
    .nullable()
    .optional(),
  content_id: z.string().uuid().nullable().optional(),
  file_id: z.string().uuid().nullable().optional(),
  event_id: z.string().uuid().nullable().optional(),
  crop_content_id: z.string().uuid().nullable().optional(),
  place_entity_id: z.string().uuid().nullable().optional(),
  /** Named lat/lon rather than TypeORM's `{x, y}`: transposing them is the one bug here. */
  coordinates: z
    .object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
    })
    .nullable()
    .optional(),
  /** Observed STATE ({color, condition, count}) — not identity. */
  attributes: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
  // Provenance triple. When present the row is keyed on it and `detection_key`
  // stays NULL; when absent the service derives a detection key instead. A row
  // has one arbiter or the other, never both.
  source_type: z.string().optional(),
  source_system: z.string().optional(),
  source_id: z.string().optional(),
});

export const ingestObservationsSchema = bulkEnvelope(bulkObservationRecordSchema);

export type BulkObservationRecord = z.infer<typeof bulkObservationRecordSchema>;
export type IngestObservationsRequest = z.infer<typeof ingestObservationsSchema>;

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
