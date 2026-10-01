import type { ConflictMergeKind, ProducerPreference } from './bulkUpsert';

/** The entities the importer's bulk-ingest paths write. */
export type IngestEntityKind =
  | 'communication'
  | 'event'
  | 'item'
  | 'content'
  | 'browser_activity'
  | 'product_model'
  | 'receipt'
  | 'receipt_line_item'
  | 'object_observation';

/**
 * Version of the ingest conflict-refresh contract below. Bumping ANY column
 * list in {@link INGEST_REFRESH_COLUMNS} MUST bump this version: a future
 * importer header handshake will compare its compiled-in version against this
 * one to detect that the two sides disagree about which fields a re-sync
 * self-heals (the cross-repo handshake itself is out of scope here — nothing
 * reads this over the wire yet).
 */
export const INGEST_SCHEMA_VERSION = 6;

/**
 * Central, per-entity list of the DB columns a bulk re-ingest of an existing
 * identity pair refreshes (the ON CONFLICT DO UPDATE SET list). The ingest
 * services reference these instead of inline arrays so the refresh contract
 * lives in exactly one place.
 *
 * An EMPTY list means conflicts are DO NOTHING find-or-return: the existing
 * row is left untouched.
 *
 * WHO WINS is not "the newest write". Since the identity index dropped
 * `source_type` (cross-pipeline identity, 2026-09-01) a conflict can come from
 * a DIFFERENT producer delivering the same datum — the browser extension after
 * a Takeout import — not only from the same producer re-syncing. The conflict
 * action (bulkUpsert.ts `conflictUpdateSetClause`) tells them apart by
 * `source_type`: the same producer's re-sync refreshes a listed column (new
 * value unless null); another producer only fills a listed column that is
 * still empty. Version 4 of this contract was a plain `col = EXCLUDED.col`,
 * i.e. last producer wins — measured on a real Brave history, the extension's
 * 30-second default dwell overwrote the History file's real visit durations.
 * {@link INGEST_MERGE_KINDS} declares the columns for which "unless null" is
 * the wrong test, and {@link INGEST_PRODUCER_PREFERENCE} (version 6) the
 * columns where "first arrival keeps it" is the wrong tie-break between two
 * producers that both have a value.
 *
 * List ONLY source-derived mutable columns — never the identity/arbiter
 * columns (id, time, user_id, source_*), and never columns a user may edit
 * server-side (a re-sync would clobber those).
 *
 * Bumping a column list MUST bump {@link INGEST_SCHEMA_VERSION} (see its doc)
 * and the snapshot in ingestRefreshColumns.test.ts.
 *
 * NOT every list is wired yet. `product_model` / `receipt` /
 * `receipt_line_item` are DECLARATIVE for now: their services still take the
 * DO NOTHING find-or-return path and do not pass `conflictUpdateColumns`, so
 * these lists change no behaviour until they do. They live here anyway because
 * the point of this file is that the contract is decided in one place BEFORE
 * three services each invent their own inline array.
 */
export const INGEST_REFRESH_COLUMNS: Record<IngestEntityKind, readonly string[]> = {
  // CommunicationService.createMany self-heal set: a re-sync corrects e.g. the
  // importer's fixed email `direction` or a newly-populated
  // `participants_metadata`. The UPDATE ... FROM (VALUES ...) statement there
  // binds parameters in THIS order — keep them in lockstep.
  //
  // Three columns are ABSENT deliberately, because each looks like it belongs:
  //
  //  * `thread_id` is genuinely source-derived and genuinely mutable, so the
  //    rule above would admit it — and it is left out anyway. The conflict
  //    action is `col = EXCLUDED.col` (bulkUpsert.ts), which is a straight
  //    overwrite in BOTH directions, and for this column the import-time value
  //    is not always the better one. Two repair migrations
  //    (20260819000746 from staged ChatId, 20260819000941 from 1:1
  //    correspondent evidence) wrote thread ids the parser cannot always
  //    re-derive: imessage.ts builds its `oneToOneChatIdentifiers` index from
  //    `chat` / `chat_handle_join`, and CATCHES the failure to read them — an
  //    older or partial chat.db degrades to "no thread key at all" rather than
  //    aborting. Refreshing on that import would null every repaired row.
  //    Version 5 made the same-producer refresh null-guarded (a re-import
  //    that cannot derive a thread key no longer nulls a repaired one), but a
  //    re-import that derives a DIFFERENT, worse key would still overwrite the
  //    repair — so thread_id stays out and is repaired by migration only,
  //    which is what the `comms-missing-thread-id` doctor remedy says.
  //  * `from_entity_id` / `to_entity_ids` are RESOLVED server-side by the
  //    enrich.person_link leg from `participants_metadata` (which IS refreshed,
  //    so the raw handles still self-heal and re-linking still improves the
  //    row). The importer sends nulls there; a refresh would un-link every
  //    communication enrichment had already attributed to a person.
  communication: ['direction', 'participants_metadata', 'metadata', 'content', 'preview', 'subject'],
  // EMPTY, and `status`, the times and the title deliberately not in it. A
  // re-delivered event's status, time and title ARE refreshed — by the per-row
  // door, CalendarEventService.createOne, which the calendar connections use —
  // but not as refresh columns: each is also the user's (updateEvent writes
  // them all, rescheduleEvent the times), and a same-producer re-push takes a
  // listed column's new value whenever it is not null, so it would put a
  // meeting the user moved back where the organizer last had it. createOne
  // instead merges three ways against what the source delivered last time
  // (`source_status`, `source_start_time` …, `source_title`;
  // sourceStatusMerge.ts, sourceFieldMerge.ts). The bulk path records those
  // bases on INSERT, but still refreshes nothing on conflict: a re-push of a
  // row already stored leaves it as it was. Closing that needs the same merge
  // as a conflict action (a merge kind that reads the base), not a column in
  // this list. The title is on the CTI base row besides, out of this table's
  // reach.
  event: [],
  // EMPTY ON PURPOSE, and load-bearing: ci.objects is the one ingest table a
  // user edits directly (renaming a thing, correcting its condition, recording
  // what it is worth now). A refresh list here would let the next re-sync of
  // the same triple overwrite those edits with whatever the importer still
  // believes. Object identity did not change that — the identity columns
  // (product_id, acquisition_*) are resolved server-side, so they are not the
  // importer's to refresh either.
  item: [],
  content: [],
  // BrowserActivityResolver.updateBrowserActivity exposes exactly two
  // user-editable fields — `title`, `url` — nothing else on the entity is
  // reachable from a direct edit. That makes every other capture-derived
  // column a safe self-heal candidate, unlike event/item/content, whose
  // update mutations already expose nearly every plausible column (a refresh
  // there would routinely clobber a user's edit).
  //
  // `page_summary` / `category` / `productivity_score` are excluded even
  // though they are not user-editable: BrowserActivityEntity comments them as
  // "AI-generated insights" — enrichment output, not something the importer
  // ever populates from the source. Refreshing them on a bulk re-sync would
  // overwrite whatever an enrichment listener already computed with
  // whatever (usually null) the importer sends.
  browser_activity: [
    'action_type',
    'properties',
    'duration_seconds',
    'scroll_depth_percent',
    'is_incognito',
    'contains_sensitive',
  ],
  // The catalog data a product feed owns. Excluded: the resolved links
  // (product_entity_id, image_content_id, manual_content_ids) and
  // identity_confidence, which say what the SERVER concluded — a re-sync that
  // reset identity_confidence would silently re-promote a downgraded guess back
  // to ground truth.
  product_model: [
    'title',
    'brand',
    'manufacturer',
    'model_number',
    'category',
    'subcategory',
    'product_type',
    'description',
    'variant_attributes',
    'spec',
    'msrp_minor',
    'currency',
    'is_digital',
  ],
  // What is PRINTED on the receipt, which a better read of the same document
  // legitimately corrects. Excluded: every resolved pointer
  // (merchant_entity_id, place_entity_id, event_id, document_content_id) —
  // those are enrichment's, and clobbering them un-links a receipt the graph
  // already placed.
  receipt: [
    'merchant_name',
    'purchased_at',
    'currency',
    'subtotal_minor',
    'tax_minor',
    'tip_minor',
    'shipping_minor',
    'discount_minor',
    'total_minor',
    'payment_method',
    'payment_last4',
    'order_number',
    'channel',
    'extraction_state',
    'extraction_confidence',
    'extraction_model',
    'extraction_error',
    'raw_text',
  ],
  // Same rule one level down. `minted_object_id` is absent for the reason
  // ReceiptService.replaceLineItems already gives: the link to the owned unit
  // is ObjectMintService's to write, and erasing it strands a possession whose
  // provenance pointer just disappeared. `product_id` is absent because it is
  // RESOLVED (by barcode, else find-or-create), not transcribed.
  receipt_line_item: [
    'description',
    'quantity',
    'unit_price_minor',
    'total_price_minor',
    'currency',
    'brand',
    'model_number',
    'category',
    'is_physical',
  ],
  // EMPTY, and the strongest case for it: ObjectObservationService's own
  // ON CONFLICT already refuses to overwrite a row a human confirmed, and keeps
  // the resolution columns out of its update list so even an unconfirmed
  // sighting survives re-detection with whatever it was resolved to. A refresh
  // list here would be a second, weaker copy of that rule.
  object_observation: [],
};

/**
 * Merge kind per refreshed column where the default 'value' rule ("the other
 * side wins only when this side is null") cannot express the right answer —
 * see `ConflictMergeKind` in bulkUpsert.ts. Every column listed here MUST be
 * in the entity's INGEST_REFRESH_COLUMNS list (the snapshot test checks), and
 * a 'json' column must be object-valued jsonb, never an array.
 *
 * Declarative-only lists (product_model, receipt, receipt_line_item) declare
 * nothing until their services are wired; classify their booleans and bags
 * then, not now.
 */
export const INGEST_MERGE_KINDS: Record<IngestEntityKind, Readonly<Record<string, ConflictMergeKind>>> = {
  // Both bags are object-valued: participants_metadata is `{ from, to, ... }`
  // (the shared contract shape), metadata the parser's catch-all. Merged so a
  // connection's labels and an archive's headers end up on one row.
  communication: { participants_metadata: 'json', metadata: 'json' },
  event: {},
  item: {},
  content: {},
  // properties is the capture bag (the importer's metadata, the extension's
  // observed_at / description / scroll data) — merge, do not replace. The two
  // privacy flags are NOT NULL DEFAULT false, so a producer that defaulted them
  // must not out-vote one that knows: OR across producers.
  browser_activity: { properties: 'json', is_incognito: 'flag', contains_sensitive: 'flag' },
  product_model: {},
  receipt: {},
  receipt_line_item: {},
  object_observation: {},
};

/**
 * Which producer wins a refreshed column when two DIFFERENT producers both
 * hold a value — see `ProducerPreference` in bulkUpsert.ts. Without an entry
 * the first arrival keeps its value and the other only fills gaps, which is
 * order-DEPENDENT: the same two arrivals in the other order leave a different
 * row. An entry makes the column order-independent for the producers it
 * names. Every column listed here MUST be in the entity's
 * INGEST_REFRESH_COLUMNS list (the snapshot test checks), and a 'flag' column
 * cannot be listed (OR is symmetric; there is nothing to prefer).
 *
 * The `source_type` values are the producers' own pipeline constants:
 * `'ci-import-tools'` is the importer (import/push/canonical.ts SOURCE_TYPE),
 * `'capture'` the browser extension, `'ETL'` a connection sync. Spelled as
 * literals because this module sits below the domains that define them; the
 * snapshot test pins the spelling.
 *
 * Keep this SHORT. A preference is a claim that one producer's reading of a
 * column is better than another's whatever the row — add one only for a
 * measured case, and say what was measured.
 */
export const INGEST_PRODUCER_PREFERENCE: Record<IngestEntityKind, ProducerPreference> = {
  // Both a Gmail fetch and a Takeout mbox carry the whole message; neither
  // reading is better across the board, so arrival order stands.
  communication: {},
  event: {},
  item: {},
  content: {},
  // Measured on a real Brave history after the browser pair converged: the
  // History file records the dwell Chrome itself measured (visit_duration),
  // while the extension's history re-sync sends a 30-second DEFAULT for every
  // visit it did not observe live. Whichever arrived second stood. The
  // importer's value now stands in either order; the extension still fills a
  // duration the file lacks (a visit still open when it was copied).
  browser_activity: { duration_seconds: ['ci-import-tools', 'capture'] },
  product_model: {},
  receipt: {},
  receipt_line_item: {},
  object_observation: {},
};
