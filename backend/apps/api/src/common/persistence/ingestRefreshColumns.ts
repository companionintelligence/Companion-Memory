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
export const INGEST_SCHEMA_VERSION = 3;

/**
 * Central, per-entity list of the DB columns a bulk re-ingest of an existing
 * provenance triple refreshes (the ON CONFLICT DO UPDATE SET / self-heal
 * list). The ingest services reference these instead of inline arrays so the
 * refresh contract lives in exactly one place.
 *
 * An EMPTY list means conflicts are DO NOTHING find-or-return: the existing
 * row is left untouched.
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
  //    A heal that can only run in the safe direction (COALESCE the existing
  //    value) is a different conflict action than this map can express, so
  //    until bulkUpsert grows one, thread_id is repaired by migration only —
  //    which is what the `comms-missing-thread-id` doctor remedy now says.
  //  * `from_entity_id` / `to_entity_ids` are RESOLVED server-side by the
  //    enrich.person_link leg from `participants_metadata` (which IS refreshed,
  //    so the raw handles still self-heal and re-linking still improves the
  //    row). The importer sends nulls there; a refresh would un-link every
  //    communication enrichment had already attributed to a person.
  communication: ['direction', 'participants_metadata', 'metadata', 'content', 'preview', 'subject'],
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
  browser_activity: [],
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
