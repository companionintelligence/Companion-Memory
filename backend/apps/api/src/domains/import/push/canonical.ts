/*
 * Canonical ingest mapping: one staged row → what it MEANS, and where it goes.
 *
 * Ported from CI-Import-Tools' `ci-server/mapping.ts`. That whole directory was
 * a remote HTTP client and is dropped by this merge — but this file is the part
 * worth keeping, because it is not transport at all. It is the accumulated
 * judgement about which of a person's records belong on a timeline, which are
 * searchable documents, which are things they own, and which are merely a GPS
 * fix wearing a costume. Every branch in `destinationsFor` is a decision someone
 * made after watching real data land in the wrong place.
 *
 * ## Adapted for staging
 *
 * Upstream this read the standalone app's SQLite `items` table, where `items.id`
 * WAS the parser's own id. Here the source is `ci_import.staged_items`, whose
 * `id` is a run-scoped uuid — so `sourceId` comes from `content_hash`, which
 * holds the parser id (or the content-derived hash) and is what actually stays
 * stable across runs. Using the staging uuid would make every re-import a new
 * record in `ci.*` rather than an idempotent no-op.
 *
 * `startTime` falls back to the row's `created_at` when the source gave no time,
 * and `dated` remembers which of the two it is — the fallback is import time,
 * and a record dated that way must not be presented as a timeline occurrence.
 */
import {
  isGloballyUniqueNamespace,
  normalizeObjectIdentifier,
  type ObjectIdentifierNamespace,
} from '@ci/domains/graph';

import { mimeForFile, type MediaAttachment } from '../datasources/timeline';
import type { StagedItem } from '../entities/StagedItemEntity';

import { readCommerceField } from './commerceKeys';
import { firstRedditMediaLink, redditLinkMedia, type RedditMediaRef } from './redditMedia';

export type { RedditMediaRef } from './redditMedia';

/**
 * The pipeline that produced these records — pure provenance since the
 * cross-pipeline identity change (docs/design/cross-pipeline-identity.md):
 * `source_type` is stored on the row and in ci.record_sources but is no
 * longer part of any unique index, so this constant no longer participates in
 * dedup. Kept as the stable name of the import pipeline in ledgers and logs.
 */
export const SOURCE_TYPE = 'ci-import-tools';

export interface CanonicalRecord {
  /** Producing integration. Always SOURCE_TYPE. */
  sourceType: string;
  /** Importer data source, e.g. "apple_photos", "gpx". From items.data_source. */
  sourceSystem: string;
  /** Stable per-item id (items.id). Idempotency key with sourceType + sourceSystem. */
  sourceId: string;
  /** ISO 8601 start time. From items.timestamp, falling back to items.created_at. */
  startTime: string;
  /**
   * Did the SOURCE give this row a time (items.timestamp), or is `startTime`
   * merely the created_at fallback? The fallback keeps every row ingestable, but
   * it is import time — it says nothing about when anything happened, and a
   * record dated that way must not be presented as a timeline occurrence
   * (destinationsFor routes undated file-bearing records to content alone).
   */
  dated: boolean;
  /** ISO 8601 end time when the item spans a range. From items.timespan_end. */
  endTime: string | null;
  /** Coarse kind. From items.classification. */
  eventType: string | null;
  /** Domain bucket derived from `kind` (e.g. 'communication', 'media'). */
  category: string | null;
  /**
   * G1 capture kind (closed taxonomy, e.g. 'communication.message',
   * 'media.play', 'import.archive_item'). Derived from classification +
   * mediaType. Rides in metadata.kind until CI-Server adds a first-class column.
   */
  kind: string;
  /** Human title — derived per-kind from metadata, falling back to filename. */
  title: string | null;
  /** Human-readable body/description when the text is available in metadata. */
  description: string | null;
  /** WGS84 coordinates when present. From items.latitude / items.longitude. */
  coordinates: { lat: number; lon: number } | null;
  /**
   * Human-readable place text (e.g. a calendar event's venue/address) when the
   * source carries one in metadata. Maps to CreateEventInput.locationName so the
   * server can forward-geocode it to coordinates for the map; without this the
   * location stays stranded in metadata, invisible to geocoding and the map view.
   */
  locationName: string | null;
  /**
   * Calendar event spans a whole day (DTSTART;VALUE=DATE in iCal). Surfaced as
   * a first-class field so CI-Server's events.is_all_day column gets populated
   * instead of sitting unread in metadata. Null when the source doesn't
   * distinguish (most non-calendar sources).
   */
  isAllDay: boolean | null;
  /**
   * Calendar event is the master of a recurring series (RRULE present in iCal).
   * First-class for the same reason as isAllDay — events.is_recurring needs it.
   * Null when the source doesn't distinguish.
   */
  isRecurring: boolean | null;
  /** Media type. From items.media_type. */
  mediaType: string | null;
  /** Content hash, a secondary dedup signal. From items.content_hash. */
  contentHash: string | null;
  /**
   * Filesystem path to the file this row carries — a photo/video/audio item's
   * media, or a plain document a drive walk picked up — from
   * items.intermediate_location or original_location. The push uploads it to
   * CI-Server and links it as content; null for rows that carry no file.
   */
  mediaPath: string | null;
  /**
   * Estimated horizontal accuracy in meters for the coordinate fix. Lifted from
   * source metadata (google_location's `Accuracy`, GPX `<hdop>`, EXIF
   * `GPSHPositioningError`, …) when present, defaulted per source when not (e.g.
   * 30m for EXIF, 200m for forward-geocoded addresses). Undefined when the
   * record has no coordinate fix at all. The position route's primary signal —
   * LocationEstimateService prefers donors with smaller accuracy_meters.
   */
  accuracyMeters: number | undefined;
  /**
   * How the coordinates were obtained: 'gps' for raw GPS tracks (gpx,
   * google_location, kmlgx, geojson, nmea, google_maps_places), 'exif' for
   * camera-derived photo coords (apple_photos, google_photos), 'address' for
   * forward-geocoded textual locations (calendar Location), 'wifi' for
   * Wi-Fi/BLE-derived fixes when a source advertises one. Undefined when the
   * record has no coordinate fix. The position-route sender maps this onto
   * CI-Server's `ci.location_source` enum (gps/wifi/cell_tower/manual/inferred/other).
   */
  locationSource: 'gps' | 'exif' | 'address' | 'wifi' | undefined;
  /** Parsed items.metadata merged with file-location fields. */
  metadata: Record<string, unknown>;
  /**
   * Object identifiers the source stated about the THING this record is about —
   * a book's ISBN, a product's ASIN or barcode, a device's serial.
   *
   * Populated from `metadata.Identifiers` (an array the datasource emits) and
   * normalized through the SHARED {@link normalizeObjectIdentifier} rule — the
   * same one `ci.object_identifiers` is written with — so an ISBN-10 off a
   * Goodreads row and the ISBN-13 printed on the same book's barcode arrive as
   * ONE value. Values the rule cannot make matchable are dropped (a rejected
   * identifier is not an error — see that module).
   *
   * Absent — not `[]` — when the record states none, so `identifiers` on a
   * record always means "the source said something".
   */
  identifiers?: CanonicalIdentifier[];
}

/** One normalized object identifier as it rides on a canonical record. */
export interface CanonicalIdentifier {
  namespace: ObjectIdentifierNamespace;
  value: string;
  /** 0..1, when the source is guessing (OCR off a receipt) rather than stating. */
  confidence?: number;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);

  return parts[parts.length - 1] || p;
}

/** sourceSystem for a row: the importer data source. */
export function sourceSystemFor(row: StagedItem): string {
  return row.dataSource || 'unknown';
}

/**
 * Stable, always-present idempotency id for a row.
 *
 * `content_hash`, not `staged_items.id`. The staging id is a fresh uuid per run,
 * so using it would make an identical re-import a brand new record in `ci.*`
 * instead of the no-op the dedup triple is supposed to produce. `content_hash`
 * is the parser's own id when it had one, and otherwise a hash over
 * content-derived fields — which is precisely what stays stable between runs.
 */
export function sourceIdFor(row: StagedItem): string {
  return row.contentHash;
}

// G1 'kind' taxonomy. Maps the importer's coarse `classification` (+ mediaType
// for generic media) to the closed capture-kind set in the unified-ingest spec,
// so iMessage/WhatsApp/Twitter stop collapsing into one undifferentiated bucket.
const KIND_BY_CLASSIFICATION: Record<string, string> = {
  message: 'communication.message',
  email: 'communication.email',
  call: 'communication.call',
  play: 'media.play',
  watch: 'media.watch',
  // Audiobook/spoken-word sessions (audible) — distinct from 'play' so the
  // consumer can verb the event as "Listened to …" off the type alone.
  listen: 'media.listen',
  // E-book reading sessions (kindle_reading) — same idea, verbed "Read …".
  read: 'media.read',
  // A media artifact saved/followed in a library (amazon_music tracks and
  // albums) — a THING, not an occurrence. The exports record no time the user
  // did anything with it, so it routes to content alone, never events.
  saved_media: 'media.saved',
  page_view: 'web.page_view',
  bookmark: 'web.bookmark',
  search: 'web.search',
  download: 'web.download',
  purchase: 'commerce.purchase',
  transaction: 'commerce.transaction',
  // A record that IS a receipt: an order-confirmation email the gmail/email
  // importer detected (see datasources/receipt_detect.ts), or a receipt
  // document. It is not correspondence and not a money movement — it is the
  // itemised record of a purchase, and routes to `receipts`.
  receipt: 'commerce.receipt',
  // The ACT of placing an order, one per order id — emitted by the Amazon
  // importer alongside its per-line 'purchase' items so a five-item order is
  // one timeline event, not five. Routes via `commerce.*` → events alone; the
  // line items keep their things/content homes.
  order: 'commerce.order',
  // Direction-aware transaction kinds (see paypal.ts): money leaving as cash
  // (withdrawal), arriving (credit), or leaving as spend (payment).
  withdrawal: 'commerce.withdrawal',
  credit: 'commerce.credit',
  payment: 'commerce.payment',
  // Further direction/kind-aware slugs (see coinbase.ts): custody moves
  // (transfer), asset sales (sale), and asset-to-asset converts (conversion).
  transfer: 'commerce.transfer',
  sale: 'commerce.sale',
  conversion: 'commerce.conversion',
  trip: 'travel.trip',
  post: 'social.post',
  social: 'social.post',
  like: 'social.like',
  comment: 'social.comment',
  interaction: 'social.bookmark',
  annotation: 'reading.annotation',
  note: 'note',
  event: 'calendar.event',
  observation: 'wearable.observation',
  health: 'wearable.observation',
  sleep: 'wearable.sleep',
  workout: 'fitness.workout',
  location: 'location.fix',
  place: 'location.fix',
  photo: 'capture.photo',
  // A plain file off a drive walk (timeline.mediaItemFromFile stamps 'file' when
  // the MIME isn't image/video/audio): same kind a non-media mail attachment
  // gets, so documents from either origin land alike.
  file: 'import.archive_item',
  // A vCard / Address Book / contact-list card. Its own kind so the routing
  // below can refuse it a body row; without an entry here it fell to the
  // default and the undated-file rule filed it as `import.archive_item`.
  contact: 'contact.card',
  // NOTE: the generic 'media' classification is intentionally NOT in this map —
  // google_photos (and others) stamp 'media' on photos AND videos AND audio, so
  // the classification alone can't pick the kind. kindFor decides it by MIME.
};

export function kindFor(classification: string | null, mediaType: string | null): string {
  // Generic 'media' means "some media file" — let the MIME decide photo vs video
  // vs audio. Without this a .wmv/.mp4 classified 'media' fell through to
  // capture.photo, so real videos landed on the timeline as photos.
  if (classification === 'media') {
    if (mediaType?.startsWith('video/')) {
      return 'capture.video';
    }

    if (mediaType?.startsWith('audio/')) {
      return 'capture.audio';
    }

    // A MIME that is present and is NOT media contradicts the classification,
    // and the classification loses: it is a coarse label an importer chose,
    // while the mimetype is a statement about the bytes. The Instagram HTML
    // importer used to stamp 'media' on text/plain entries that carried no file
    // at all, and this branch's photo default turned every one of them into a
    // capture.photo event with no photo behind it. 'import.archive_item' is the
    // same kind classification 'file' gets — the honest "a document" answer.
    if (mediaType && !mediaType.startsWith('image/')) {
      return 'import.archive_item';
    }

    return 'capture.photo'; // image/* or no MIME at all → photo (prior behavior)
  }

  if (classification && KIND_BY_CLASSIFICATION[classification]) {
    return KIND_BY_CLASSIFICATION[classification];
  }

  if (mediaType?.startsWith('image/')) {
    return 'capture.photo';
  }

  if (mediaType?.startsWith('video/')) {
    return 'capture.video';
  }

  if (mediaType?.startsWith('audio/')) {
    return 'capture.audio';
  }

  return 'import.archive_item';
}

/**
 * CI-Server object table a record routes to. Each non-`events` destination has a
 * dedicated batch GraphQL mutation (createThings / createCommunications /
 * createBrowserActivities / createContents / createPositions); everything else
 * falls through to `createEvent`.
 *
 * `position` carries the (time, lat, lon, accuracy_meters, location_source)
 * tuples that LocationEstimateService treats as primary donors when inferring
 * locations for events that lack coordinates. Until the route is wired the
 * partition falls back to `createEvents`, which keeps today's behavior unchanged.
 */
export type Destination =
  | 'things'
  | 'communications'
  | 'browser_activity'
  | 'content'
  | 'events'
  | 'position'
  // The commerce plane (`ci.receipts` + `ci.receipt_line_items`,
  // `ci.product_models`, `ci.object_observations`). `receipts` is the
  // merchant/time/total header plus its line items — the thing that gives a
  // purchase a place and a timeline presence; `product_models` is the catalogue
  // entry a line's globally-unique identifier (ISBN/ASIN/GTIN) mints;
  // `observations` records that an object with that identity was observed
  // (here: acquired) at a moment.
  | 'receipts'
  | 'product_models'
  | 'observations';

/**
 * The `entityType` values CI-Server's search-index backfill sweep understands
 * (`BACKFILLABLE_ENTITIES` in CI-Server maintenance/SearchIndexBackfillService).
 * These are the bulk-ingest tables whose `createMany()` no longer emits a per-row
 * `*CreatedEvent`, so their rows must be swept into `ci_search.embeddings` after a
 * push. Until CI-Import-Tools' retirement this was that repo's own mirror of the
 * closed set, kept in sync by hand; now that the importer is native, keep this
 * list in sync with `BACKFILLABLE_ENTITIES` directly instead.
 */
export type BackfillEntityType =
  | 'communication'
  | 'event'
  | 'content'
  | 'item'
  | 'browser-activity'
  | 'file'
  | 'position'
  | 'receipt'
  | 'product';

/**
 * Map an import `Destination` to the CI-Server backfill `entityType` its rows land
 * under, so a push can ask the search-index sweep to embed exactly the types it
 * just wrote instead of the server's full default set. Closes gap G2 (content
 * 0% / event 6.5% embed coverage): the previous empty-body backfill relied on the
 * server default sweeping every type, but content/event rows sat unindexed.
 *
 * Positions are downsampled (hour × 3-decimal cell) by the search listener;
 * unnamed fixes are skipped until reverse-geocode names them.
 */
const DESTINATION_TO_BACKFILL_ENTITY: Record<Destination, BackfillEntityType | null> = {
  events: 'event',
  content: 'content',
  communications: 'communication',
  things: 'item',
  browser_activity: 'browser-activity',
  position: 'position',
  receipts: 'receipt',
  product_models: 'product',
  // An observation is a (object, time, place) sighting with no text of its own
  // — nothing to embed, the same answer `browser_activity` gets from the edge
  // matrix below.
  observations: null,
};

/**
 * Reduce the set of destinations a push actually wrote to into the distinct,
 * ordered list of CI-Server backfill entity types to sweep. Deduplicated and
 * stably ordered so requests are deterministic.
 */
export function backfillEntityTypesFor(destinations: Iterable<Destination>): BackfillEntityType[] {
  const seen = new Set<BackfillEntityType>();
  for (const dest of destinations) {
    const entity = DESTINATION_TO_BACKFILL_ENTITY[dest];
    if (entity) {
      seen.add(entity);
    }
  }

  // Stable order mirroring BACKFILLABLE_ENTITIES for deterministic requests/tests.
  const ORDER: BackfillEntityType[] = [
    'communication',
    'event',
    'content',
    'item',
    'browser-activity',
    'file',
    'position',
    'product',
    'receipt',
  ];

  return ORDER.filter((e) => seen.has(e));
}

/**
 * The `DeterministicEdgeSource` values the graph-edge projection sweeps by —
 * the source-table vocabulary `promote.edge_*` legs are keyed on
 * (`EDGE_STAGES_BY_SOURCE` in the pipeline domain's
 * `GraphEdgeSweepRequestListener`, itself the matrix's own `source` field).
 *
 * Declared as a local union rather than imported for the same reason
 * {@link BackfillEntityType} is: this file is the import domain's canonical
 * routing table and must not depend on the pipeline or maintenance domains.
 * The wire strings are the contract; the listener validates and drops anything
 * it does not recognise.
 */
export type EdgeProjectionSource =
  | 'communications'
  | 'events'
  | 'content'
  | 'objects'
  | 'positions'
  | 'receipts'
  | 'observations';

/**
 * Map an import {@link Destination} to the edge-projection source its rows land
 * under, so a push can ask for exactly the `promote.edge_*` legs whose input it
 * just wrote.
 *
 * `browser_activity` maps to nothing on purpose: `ci.browser_activity` has no
 * rule in the deterministic-edge matrix, so requesting a leg for it would be a
 * sweep that can only ever find zero candidates.
 *
 * Note `positions` — plural, the matrix's spelling — against the `position`
 * destination. The two vocabularies were named independently and this function
 * is the seam; getting it wrong is a silently-dropped source at the listener,
 * which is why `canonical.edgeSources.test.ts` pins every pair.
 */
const DESTINATION_TO_EDGE_SOURCE: Record<Destination, EdgeProjectionSource | null> = {
  events: 'events',
  content: 'content',
  communications: 'communications',
  things: 'objects',
  browser_activity: null,
  position: 'positions',
  // Both spellings are the matrix's own (`EDGE_STAGES_BY_SOURCE`), and both are
  // plural where the destination is not — same seam, same hazard, as `position`
  // → `positions` above.
  receipts: 'receipts',
  observations: 'observations',
  // A catalogue entry is not a sighting and not a possession: `ci.product_models`
  // has no rule in the deterministic-edge matrix, so requesting a leg for it
  // would be a sweep that can only ever find zero candidates.
  product_models: null,
};

/**
 * Reduce the destinations a push actually wrote to into the distinct, ordered
 * list of edge-projection sources to sweep. Deduplicated and stably ordered so
 * requests are deterministic, exactly as {@link backfillEntityTypesFor} is.
 *
 * An empty result is a real answer and the caller must treat it as one: a push
 * that wrote only browser activity has no edges to project, and requesting
 * "every source" in that case would turn a narrow import into a full-corpus
 * pass.
 */
export function edgeProjectionSourcesFor(destinations: Iterable<Destination>): EdgeProjectionSource[] {
  const seen = new Set<EdgeProjectionSource>();
  for (const dest of destinations) {
    const source = DESTINATION_TO_EDGE_SOURCE[dest];
    if (source) {
      seen.add(source);
    }
  }

  // Stable order mirroring the matrix's own rule order for deterministic
  // requests and tests.
  const ORDER: EdgeProjectionSource[] = [
    'communications',
    'events',
    'content',
    'objects',
    'receipts',
    'observations',
    'positions',
  ];

  return ORDER.filter((s) => seen.has(s));
}

/**
 * Last-resort heuristic: is a purchased good DIGITAL (→ content) vs PHYSICAL
 * (→ things)? Amazon's oldest "Your Orders" CSVs carry no product-type
 * field, so the product NAME is all there is. Kept as the final step of
 * {@link isDigitalGood} — it is a guess, and every stated fact outranks it.
 */
const DIGITAL_GOOD_RE =
  /\b(kindle|e-?book|audiobook|audible|\[digital\]|digital (?:download|code|copy)|app store|in-app|software|subscription|prime video|mp3|gift\s?card|download)\b/i;

/**
 * Source category/product-type tokens that STATE the good is digital. Matched
 * against the CATEGORY field (Category / Product Category / Product Type /
 * Type) as whole words, so `ELECTRONIC_CABLE` and `Home & Kitchen` can never
 * match while `DIGITAL_VIDEO_DOWNLOAD`, `Mobile Application` and `eBook` do.
 *
 * Deliberately NARROW. `music`, `game(s)` and `app` are excluded: Amazon files
 * a physical CD under ABIS_MUSIC and a board game under TOYS_AND_GAMES, so a
 * looser pattern would send real objects to `content` and lose them from
 * things — the exact failure this ordering exists to fix, inverted.
 */
const DIGITAL_CATEGORY_RE =
  /(?:^|[^a-z])(digital|ebook|e-book|kindle|audiobook|software|subscription|membership|streaming|download|mobile[_\s-]?application|in-app)(?:[^a-z]|$)/i;

/**
 * Merchants whose goods are digital by definition. A hint, not a fact: it
 * outranks the name regex (a Steam purchase called "Portal 2" matches no
 * keyword) but yields to anything the source stated.
 */
const DIGITAL_MERCHANT_RE =
  /\b(app\s?store|google\s?play|play\s?store|steam|itunes|kindle\s?store|audible|epic\s?games|nintendo\s?eshop|playstation\s?store|xbox\s?(?:live|store)|humble\s?bundle|reddit)\b/i;

/** An explicitly-declared boolean out of metadata ('true'/'yes'/'1' count), or null. */
function declaredBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') {
    return v;
  }

  if (typeof v === 'string' && v.trim()) {
    if (/^(true|yes|1)$/i.test(v.trim())) {
      return true;
    }

    if (/^(false|no|0)$/i.test(v.trim())) {
      return false;
    }
  }

  return null;
}

/**
 * Is a purchased good DIGITAL (→ content) vs PHYSICAL (→ things)?
 *
 * Evidence order, strongest first — each step only fires when it has something
 * to say, so a source that states nothing still reaches the name guess:
 *
 *   1. An explicit `IsDigital` (or the legacy `Digital`) flag from an importer
 *      that KNOWS — Amazon files digital purchases in their own export file,
 *      where "Prime Membership Fee" matches no keyword and used to land in
 *      a physical thing; Uber Eats states that a dish is not one. A
 *      DECLARATION IS NOT A HEURISTIC: it outranks every guess below, in BOTH
 *      directions.
 *   2. A stated product type / category that names a digital class. Amazon's
 *      `DIGITAL_VIDEO_DOWNLOAD`, an app store's `Mobile Application`.
 *   3. The merchant, when it sells nothing physical.
 *   4. {@link DIGITAL_GOOD_RE} over the product name — the old whole rule, now
 *      the last resort.
 *
 * ── Why the order is load-bearing ──────────────────────────────────────────
 *
 * The first attempt at this in the retired importer put the category guess
 * FIRST, and an explicit `Digital: false` on a row categorised "Subscription"
 * was overridden — moving a physical good out of `ci.objects` and into
 * `ci.content` on the next push, the same thing in two tables, with no
 * migration to undo it. A declaration wins.
 *
 * Steps 2 and 3 are NEW evidence (the rule used to be the declaration and the
 * name regex), so they re-route record shapes that state a digital category or
 * a digital-only merchant and nothing else: those move from `ci.objects` to
 * `ci.content`. That is the correct home, but there is no migration for rows
 * already pushed under the old rule — see `docs/import/etl-agent-guide.md` §2.2.
 *
 * The verdict is written onto each receipt line as `isPhysical` (see
 * `toReceiptLineItemInputs`) so it is a recorded, auditable decision rather than
 * something silently re-derived on every push.
 */
export function isDigitalGood(rec: CanonicalRecord): boolean {
  const m = rec.metadata;
  const declared = declaredBool(m.IsDigital) ?? declaredBool(m.Digital);

  if (declared !== null) {
    return declared;
  }

  const category = str(readCommerceField(m, 'CATEGORY'));

  if (category && DIGITAL_CATEGORY_RE.test(category)) {
    return true;
  }

  const merchant = str(readCommerceField(m, 'MERCHANT'));

  if (merchant && DIGITAL_MERCHANT_RE.test(merchant)) {
    return true;
  }

  const name = str(readCommerceField(m, 'PRODUCT')) || rec.title || '';

  return DIGITAL_GOOD_RE.test(name);
}

/**
 * Route a record to its natural destination table(s). Most kinds land in one
 * table; a handful of text-bearing event types FAN OUT to both `events` (their
 * timeline home) and `content` (so the title/body is searchable in the corpus —
 * otherwise tweets, calendar agendas, and trip summaries are visible on the
 * timeline but invisible to search). `events` stays the default/load-bearing
 * arm so an unrecognised kind is never dropped.
 *
 *   commerce.purchase   -> receipts + (things | content)  every purchase gets a receipt (the
 *                                                merchant/money/moment), plus the good's own home:
 *                                                things for a physical thing, content for a
 *                                                digital one. A subscription fee keeps only its
 *                                                receipt. An identified physical good also donates
 *                                                an observation. A line rolled up into a
 *                                                per-order receipt (metadata.ReceiptRollupId)
 *                                                skips the receipt — it is already on that one.
 *   commerce.receipt    -> receipts (+ communications when the mail gate had passed it anyway)
 *   commerce.transaction / .withdrawal / .credit / .payment
 *                       -> events (+ receipts when the record carries LineItems)
 *                                                a money movement is an occurrence, not content
 *   commerce.order      -> events                  one timeline event per Amazon order id
 *   commerce.*          -> events
 *   any record whose identifiers include a globally-unique one
 *                       -> + product_models       the catalogue entry an ISBN/ASIN/GTIN mints
 *   communication.*     -> communications | communications+position  a geotagged
 *                                                message donates its fix too
 *   web.bookmark        -> content
 *   web.page_view       -> browser_activity
 *   web.download        -> browser_activity
 *   calendar.event      -> events | events+content  content ONLY when the event carries
 *                                                   a file (attachment on disk / media MIME)
 *   media.play|watch|listen -> events + content  timeline occurrence (when watched/played) +
 *                                                searchable content row (the thing watched/played)
 *   media.saved         -> content              a library's saved/followed track or album — a
 *                                                thing with no occurrence, so no event

 *   note|annotation     -> content
 *   social.*            -> events + content      timeline + searchable post/comment body
 *                          (+ position when geotagged)
 *   social.* undated    -> content               a record whose source gave it no time (a reddit
 *                                                saved post: id + permalink only) stays
 *                                                searchable but never wears import time on the
 *                                                timeline; affiliations are exempt (see below)
 *   social affiliation  -> events                 a LinkedIn connection / a moderated or
 *                                                 subscribed subreddit is an edge or a
 *                                                 membership, not a body: content would be an
 *                                                 empty row (see isSocialAffiliation)
 *   reddit post/comment -> communications (+ content only for attached media);
 *                          content ALONE when undated (saved posts/comments)
 *                                                posts and comments are authored communications,
 *                                                not events; the content row (if any) is the
 *                                                linked image/video (posts) or the first
 *                                                image/video link in the body (comments), titled
 *                                                by the truncated text with the full body as its
 *                                                text
 *   travel.trip         -> events                a ride is an event; its route is the title,
 *                                                so a content row would only duplicate it
 *   location.fix        -> position | events+position  raw GPS tracks go ONLY to position
 *                                                     (out of the events timeline they previously
 *                                                     cluttered); place visits keep their event
 *                                                     home AND donate to position
 *   capture.photo(+GPS) -> events + position     photo's home is events; its EXIF GPS also donates
 *   everything else (incl. fitness.*, wearable.*) -> events
 */
/**
 * A Reddit post (authored or saved) — the reddit importer stamps metadata.Kind;
 * votes/subreddits carry other Kind values and keep the generic social.*
 * routing.
 */
export function isRedditPost(rec: CanonicalRecord): boolean {
  return (
    rec.sourceSystem === 'reddit' && (rec.metadata.Kind === 'post' || rec.metadata.Kind === 'saved_post')
  );
}

/**
 * A Facebook post from the Meta archive. Routed to /communications like
 * Reddit posts (and like the Facebook CONNECTION, whose TransformFacebookPosts
 * writes posts as communications) — the two pipelines must land the same post
 * in the same table before any identity can converge them
 * (docs/design/cross-pipeline-identity.md). Other Facebook social records
 * (likes, reactions) keep the generic social.* routing.
 */
export function isFacebookPost(rec: CanonicalRecord): boolean {
  return rec.sourceSystem === 'facebook' && rec.kind === 'social.post';
}

/**
 * The attachment links a Discord message carries. A Discord package ships NO
 * attachment bytes — every upload survives only as a signed
 * cdn.discordapp.com URL in the message's `Attachments` field, space-separated
 * when a message carries several.
 *
 * These become ci.content rows (see {@link discordAttachmentContentInputs}),
 * created by the communications lane so their ids can ride in the message's
 * `attachments` column. There is no bytes lane for them: nothing to upload.
 */
export function discordAttachmentUrls(rec: CanonicalRecord): string[] {
  if (rec.sourceSystem !== 'discord') {
    return [];
  }

  const raw = str(rec.metadata.Attachments);
  if (!raw) {
    return [];
  }

  return raw.split(/\s+/).filter((u) => /^https?:\/\//i.test(u));
}

/**
 * The original filename an attachment URL ends in — the last path segment, e.g.
 * `…/699846306788671588/message_3.txt?ex=…` → `message_3.txt`. It is both the
 * row's title and its only type signal. The URL is signed (`?ex=…&is=…&hm=…`),
 * so the query string has to come off before the basename, and the path segment
 * is percent-encoded (`Screenshot%20from%202020.png`).
 */
export function discordAttachmentFilename(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }

  const base = pathname.split('/').filter(Boolean).pop();
  if (!base) {
    return undefined;
  }

  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

/**
 * A Discord message whose ONLY payload is its attachments (an image posted with
 * no caption). It still gets a communication row — the attachments column is
 * the payload — but `content` stays empty: the title fallbacks in
 * toCommunicationInput would otherwise fill it with a synthesized
 * "Message — <sender>" label the user never wrote.
 */
export function isDiscordAttachmentOnly(rec: CanonicalRecord): boolean {
  return rec.sourceSystem === 'discord' && !str(rec.metadata.Text) && discordAttachmentUrls(rec).length > 0;
}

/**
 * The metadata keys `descriptionFor` draws a body from, in its exact order —
 * so a placeholder check can inspect the RAW value the body would have come
 * from, before sanitizeText() strips U+FFFC out of it.
 */
const BODY_METADATA_KEYS = [
  'Text',
  'Body',
  'Message',
  'Description',
  'Notes',
  'Note',
  'Highlight',
  'Comment',
  'Caption',
] as const;

/**
 * A body that consists ENTIRELY of placeholder glyphs and whitespace — no
 * letters, no digits, no punctuation the user typed.
 *
 * U+FFFC (OBJECT REPLACEMENT CHARACTER) is what macOS stores in
 * `message.text` where an inline attachment sits, so an attachment sent with
 * no caption has a body of exactly "\uFFFC". U+FFFD (REPLACEMENT CHARACTER)
 * is what a mis-decoded byte run collapses to; a body that is nothing but
 * those carries no recoverable text either.
 */
const PLACEHOLDER_ONLY_BODY = /^[\uFFFC\uFFFD\s]+$/;

/**
 * A record whose source body existed but held nothing except attachment /
 * mojibake placeholder glyphs.
 *
 * Same contract as {@link isDiscordAttachmentOnly}, generalised: the row is
 * still worth keeping (its attachments, participants and timestamp are the
 * payload) but `content` must stay EMPTY. Without this, `toCommunicationInput`
 * falls through `rec.description ?? rec.title`, and `titleFor` synthesizes
 * "Message — <sender>" (or, with no sender, the `message_<id>.txt` source
 * filename) — a label the user never wrote, presented as the message they
 * sent. A live appliance database held 21,781 iMessage rows whose entire
 * `content` was a single U+FFFC, plus 313 that were only U+FFFD.
 *
 * Two cases, in this order:
 *
 *  - the description SURVIVED sanitization but is still nothing but glyphs —
 *    that is the U+FFFD mojibake case, which sanitizeText deliberately leaves
 *    alone (it mints U+FFFD itself for lone surrogates);
 *  - the description came back null, and a raw body key held only U+FFFC —
 *    the attachment case, invisible after the fact because sanitizeText has
 *    already stripped the glyph, so it has to be read off the raw metadata.
 *
 * Checking the description FIRST is what keeps a record with real prose under
 * a lower-priority key (Text a placeholder, Body actual text) from being
 * blanked.
 */
export function isAttachmentPlaceholderOnly(rec: CanonicalRecord): boolean {
  if (rec.description !== null) {
    return PLACEHOLDER_ONLY_BODY.test(rec.description);
  }

  return BODY_METADATA_KEYS.some((k) => {
    const raw = rec.metadata[k];

    return typeof raw === 'string' && PLACEHOLDER_ONLY_BODY.test(raw);
  });
}

/** A Reddit comment (a reply authored on a post, or a saved one). */
export function isRedditComment(rec: CanonicalRecord): boolean {
  return (
    rec.sourceSystem === 'reddit' &&
    (rec.metadata.Kind === 'comment' || rec.metadata.Kind === 'saved_comment')
  );
}

/**
 * A social record that states an AFFILIATION — who someone is connected to, or
 * what they belong to — rather than something they wrote.
 *
 * A LinkedIn connection ("Connected with Morgan Spadone") and a moderated or
 * subscribed subreddit ("r/bitscoop") are both this shape: an edge, or a
 * membership. Neither carries a body, and neither importer gives the record a
 * `Text`/`Body`/`URL` to become one — the LinkedIn profile URL rides on the
 * PERSON entity the same parser emits, not on the item.
 *
 * That matters because the generic `social.*` route sends every record to
 * `content` as well as `events`, and `toContentInput` fills a content row from
 * exactly those three keys. With none of them present the row lands typed
 * `post` with a NULL `text` and a NULL `url` — and `ci.content` has no title
 * column, so nothing about it renders anywhere. A real clean-room import of one
 * person's corpus produced 1,977 such rows (1,975 LinkedIn connections, 2
 * moderated subreddits), i.e. 100% of what those two sources sent to content.
 *
 * The facts are not lost by skipping the row: a connection is already a
 * `ci.entities` Person carrying the profile URL plus a dated `social` event,
 * and a moderated subreddit is already an event titled with the subreddit.
 * The content row was a third, empty copy of both.
 */
export function isSocialAffiliation(rec: CanonicalRecord): boolean {
  // Optional-chained: toCanonical always supplies metadata, but this is also
  // called on hand-built records (destinationOrder.test) where it may be absent.
  const kind = str(rec.metadata?.Kind);

  if (rec.sourceSystem === 'linkedin') {
    return kind === 'connection';
  }

  if (rec.sourceSystem === 'reddit') {
    return kind === 'moderated_subreddit' || kind === 'subscribed_subreddit';
  }

  return false;
}

/**
 * The media a Reddit record carries, or null. A link post's media is its URL
 * field (the link target) when it points at an image or video. A comment has
 * no URL field pointing at media (metadata.URL is the comment's own
 * permalink), so its media is the first direct image/video link found in the
 * body markdown. The classification itself lives in ./redditMedia so the
 * connection transform applies the identical rule.
 */
export function redditMediaUrl(rec: CanonicalRecord): RedditMediaRef | null {
  if (isRedditPost(rec)) {
    return redditLinkMedia(str(rec.metadata.URL));
  }

  if (isRedditComment(rec)) {
    return firstRedditMediaLink(str(rec.metadata.Body));
  }

  return null;
}

/**
 * The line items a record carries (`metadata.LineItems`), or `[]` — the raw
 * objects as the datasource emitted them, before `toReceiptLineItemInputs` maps
 * them. A record with lines is a receipt whatever else it is: the lines are
 * what a receipt IS.
 */
export function commerceLineItems(rec: CanonicalRecord): Array<Record<string, unknown>> {
  const raw = readCommerceField(rec.metadata, 'LINE_ITEMS');

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.filter((l): l is Record<string, unknown> => !!l && typeof l === 'object' && !Array.isArray(l));
}

/**
 * Can a product-model (catalogue) row be minted from this record? Only a
 * GLOBALLY-UNIQUE identifier qualifies — an ISBN, ASIN, GTIN, IMEI or VIN
 * identifies the same product for everyone, whereas a SKU or an order id is
 * unique only inside one retailer's scope and would mint a catalogue entry
 * nobody else can ever match (see `normalizeObjectIdentifier.computeQualifier`).
 */
export function mintsProductModel(rec: CanonicalRecord): boolean {
  return (rec.identifiers ?? []).some((i) => isGloballyUniqueNamespace(i.namespace));
}

/**
 * Is this line's receipt carried by an ITEMISED aggregate elsewhere? The
 * emitting datasource says so by stamping `metadata.ReceiptRollupId` with the
 * aggregate record's id (see `amazon.ts` pushOrders). Without the marker a
 * five-item Amazon order would produce five single-line receipts on top of the
 * itemised one.
 */
function isRolledUp(rec: CanonicalRecord): boolean {
  return typeof rec.metadata.ReceiptRollupId === 'string' && rec.metadata.ReceiptRollupId.length > 0;
}

/**
 * Route a record to its destination table(s). Thin wrapper over
 * {@link baseDestinationsFor} that adds `product_models` for any record
 * carrying a globally-unique identifier: minting the catalogue entry is a
 * property of the IDENTIFIER, not of the kind, so a Goodreads book (an
 * annotation) and an Amazon line (a purchase) both mint one.
 *
 * FIRST in the list, not appended. The catalogue row is the identity everything
 * else in the batch points at — `ReceiptService` resolves a line's product by
 * looking up its identifier claim — and `PushStage.DESTINATION_ORDER` writes
 * destinations in its own fixed order, which this list has to stay a
 * subsequence of (see stages/__tests__/destinationOrder.test.ts).
 */
export function destinationsFor(rec: CanonicalRecord): Destination[] {
  const dests = withoutFabricatedPositionFix(rec, baseDestinationsFor(rec));

  if (!mintsProductModel(rec) || dests.includes('product_models')) {
    return dests;
  }

  return ['product_models', ...dests];
}

/**
 * Strip the `position` donation from an UNDATED record, whatever branch of
 * {@link baseDestinationsFor} put it there.
 *
 * A `ci.position` row is not a description of a place — it is the assertion
 * *"the user's body was at (lat, lon) at time T"*. Every other field is
 * optional; the time is the claim. So when `startTime` is the created_at
 * fallback (`dated === false`), the row is not an approximate fix or a
 * low-confidence fix, it is a **fabricated** one, and there is no degraded form
 * of it that would be honest: `ci.position` has no `time_source` column to
 * mark it with, and `time` is the hypertable's partition key, so it cannot be
 * NULL either.
 *
 * That matters more than the timeline noise it sits next to.
 * `LocationEstimateService` treats position rows as its PRIMARY donors when
 * inferring where an un-geotagged event happened, so one fabricated fix does
 * not merely display wrong — it pulls every neighbouring inference toward a
 * place the user was not, at a time they were not there. Live proof on this
 * appliance: one row, `google_maps_places` / "Gym", `time =
 * 2026-08-21T04:56:01.296Z`, i.e. the second the run parsed
 * `Labeled places.json`, asserting the user was at their gym in the middle of
 * the night.
 *
 * Applied HERE rather than in each branch on purpose. The per-kind branches
 * below reason about what a record IS; this is a property of the *table*, true
 * of every kind that donates to it, and a branch added next year gets it for
 * free instead of re-introducing the bug. Nothing is lost by dropping it: the
 * coordinates still ride on whatever home the kind gives the record (a saved
 * place keeps its `events` row, and that row is what puts the pin on the map).
 */
function withoutFabricatedPositionFix(rec: CanonicalRecord, dests: Destination[]): Destination[] {
  return rec.dated ? dests : dests.filter((d) => d !== 'position');
}

function baseDestinationsFor(rec: CanonicalRecord): Destination[] {
  const kind = rec.kind;
  // Reddit posts and comments are authored communications, not timeline
  // events: they go to /communications only. A content row rides along ONLY
  // when the record carries media (see toContentInput for the row's shape).
  //
  // UNLESS the record has no date. Reddit's saved_posts/saved_comments CSVs
  // carry only `id, permalink` — no post date, no saved-at date — and
  // `communications.time` is NOT NULL, so an undated one would land wearing
  // the import moment as if it were real (verified live: eight saved
  // posts/comments all timestamped the second they were parsed). Content
  // alone: the title, permalink and any body stay searchable, and nothing
  // pretends to know when it happened. Same rule as undated files below.
  if (isRedditPost(rec) || isRedditComment(rec)) {
    if (!rec.dated) {
      return ['content'];
    }

    return redditMediaUrl(rec) ? ['communications', 'content'] : ['communications'];
  }

  // Facebook posts: same shape as Reddit above, same reasons — an authored
  // communication, not a timeline event, and the same table the connection
  // uses so the tuple identity can converge the two copies. Undated posts
  // keep content-only for the same NOT NULL `communications.time` reason.
  if (isFacebookPost(rec)) {
    return rec.dated ? ['communications'] : ['content'];
  }

  if (kind === 'commerce.purchase') {
    // EVERY purchase produces a receipt. The receipt is what carries the
    // merchant, the money and the moment — a purchase without one has no
    // place, no timeline presence and no way to answer "where did I buy this?".
    // The good's OWN home (the thing bought) rides alongside: things for a
    // physical object, content for a digital one.
    //
    // A subscription fee (Prime, Kindle Unlimited, an Audible plan — the
    // amazon importer stamps metadata.Subscription from the export's own
    // Subscription Order Type) is a service, not a thing, so it still gets no
    // things/content row — but it is a real purchase and now keeps its
    // receipt, where before it pushed NOWHERE and the money was invisible.
    if (rec.metadata.Subscription === true) {
      return isRolledUp(rec) ? [] : ['receipts'];
    }

    const good: Destination = isDigitalGood(rec) ? 'content' : 'things';
    // ...unless the receipt is over THERE. A source that emits both per-line
    // purchases and a per-order aggregate (amazon.ts) stamps the line with the
    // aggregate's id: the itemised order receipt already contains this line, so
    // minting a second single-line receipt for it would double every order.
    const receipt: Destination[] = isRolledUp(rec) ? [] : ['receipts'];

    // A physical good with a globally-unique identifier also donates an
    // OBSERVATION: this object, identified, was in the user's hands at this
    // moment. That is the (object, time, place) evidence
    // `ci.object_observations` exists for, and a receipt is the most reliable
    // producer of it.
    return good === 'things' && mintsProductModel(rec)
      ? [...receipt, good, 'observations']
      : [...receipt, good];
  }

  // A record the source already calls a receipt (a detected order-confirmation
  // email, a scanned receipt document) IS the receipt.
  //
  // It ALSO stays a communication when it was mail the importer would have kept
  // anyway — `metadata.HumanCorrespondence` is the parser stating that its own
  // human-correspondence gate passed this message. Without that distinction,
  // reclassifying an order confirmation that Gmail filed under Category
  // Personal would REMOVE it from ci.communications, where it lands today: the
  // receipt lane must only ever add. A receipt rescued FROM the bulk filter has
  // no such history — it was being dropped entirely — so it goes to receipts
  // alone rather than adding tens of thousands of no-reply notifications to the
  // correspondence table.
  if (kind === 'commerce.receipt') {
    // `communications` first only because this list must stay a subsequence of
    // PushStage.DESTINATION_ORDER; the two writes are independent.
    return rec.metadata.HumanCorrespondence === true ? ['communications', 'receipts'] : ['receipts'];
  }

  // A transaction (any direction: transaction/withdrawal/credit/payment) is a
  // timeline occurrence (money moved at a moment), not a piece of content —
  // there is no document/media "thing" behind it worth a searchable corpus
  // row. Events only... UNLESS it carries line items: an Uber Eats order or an
  // Amazon order aggregate knows WHAT was bought, and that itemisation is a
  // receipt whether or not the money movement is also an event.
  if (kind.startsWith('commerce.')) {
    return commerceLineItems(rec).length > 0 ? ['events', 'receipts'] : ['events'];
  }

  if (kind.startsWith('communication.')) {
    // A geotagged message (a tweet posted with coordinates, a location-stamped
    // chat) is as good a GPS donor as a geotagged photo: its home stays
    // communications, and the fix also lands in the position table.
    return rec.coordinates ? ['communications', 'position'] : ['communications'];
  }

  if (kind === 'web.bookmark') {
    return ['content'];
  }

  // A web search is a browsing action, not a timeline event: ci.browser_activity
  // models it natively via action_type='search'. Without this branch web.search
  // fell through to the default 'events' bucket (~96k Google/YouTube searches
  // landed in ci.events instead of ci.browser_activity).
  // Browse/search rows can carry a coordinate fix (the Microsoft privacy export
  // stamps Latitude/Longitude on search and browse CSVs) — those donate a
  // position row alongside their browser_activity home, same as geotagged
  // captures, so the fix reaches /v1/positions and the location estimator.
  // A download is a browsing action for the same reason a search is:
  // `ci.browser_activity` models it natively via action_type='download', and it
  // is the only table that records the file was fetched at all — a download's
  // own URL is usually never a page visit (255 of 278 in the reference profile
  // appear nowhere in the browser's `urls`).
  if (kind === 'web.page_view' || kind === 'web.search' || kind === 'web.download') {
    // An UNDATED browsing action has no honest row in `ci.browser_activity`.
    // The table models "the user visited/searched/downloaded X **at time T**":
    // `time` is NOT NULL, it is the hypertable's partition key, and unlike
    // `ci.events` there is no `time_source` column in which to say the instant
    // is not evidence. So an undated visit would land wearing the import wall
    // clock with nothing anywhere contradicting it, and every "what was I
    // reading last night?" query would answer with it.
    //
    // Content instead — the same answer the undated-file rule below gives, and
    // for the same reason: whatever the record has (a URL, a title, or just a
    // title) stays searchable, and nothing claims a moment. Live producer:
    // Instagram's `shopping/recently_viewed_items.html`, whose entries carry no
    // date at all (instagram.ts processHtmlActivity passes `timestamp: ent.ts`,
    // undefined here) — and, verified against the corpus, no URL either: Meta
    // never links a viewed product to a page, so `firstWebLink` returns
    // undefined and the resulting content row is title-only. One of its rows
    // sat in `ci.browser_activity` dated 2026-08-21T04:13:51Z — the second the
    // run parsed the file.
    if (!rec.dated) {
      return ['content'];
    }

    return rec.coordinates ? ['browser_activity', 'position'] : ['browser_activity'];
  }

  if (kind === 'calendar.event') {
    // A calendar event's home is the events timeline. A content row rides
    // along ONLY when the event carries an actual file (an extracted
    // attachment on disk, or a media MIME) — a content row per text-only
    // event duplicated every agenda into ci.content as a phantom document.
    const hasFile = rec.mediaPath != null || isMediaType(rec.mediaType);

    return hasFile ? ['events', 'content'] : ['events'];
  }

  // A watch/play is a timeline OCCURRENCE (when Netflix/Spotify/etc. say it
  // happened) as well as a searchable content row (the played/watched thing).
  // Previously content-only, so per-viewing/per-listen occurrences never
  // reached the timeline — only the deduped "thing" did.
  if (kind === 'media.play' || kind === 'media.watch' || kind === 'media.listen' || kind === 'media.read') {
    return ['events', 'content'];
  }

  // A library artifact (a saved/followed track or album) is a THING with no
  // occurrence — its source records no time the user did anything, so an event
  // would pin it to import time. Content alone, same reasoning as the undated
  // file-bearing rule below.
  if (kind === 'media.saved') {
    return ['content'];
  }

  if (kind === 'note' || kind === 'reading.annotation') {
    return ['content'];
  }

  // A contact card is a PERSON, and the parser already emits it as one on the
  // entity lane (vcard.ts, contactlist.ts, applecontacts.ts each push an entity
  // beside the item). It is not a document, and being undated it is not an
  // occurrence either, so neither `content` nor `events` is a home for it.
  //
  // Routing it nowhere is the same answer `isSocialAffiliation` gives a LinkedIn
  // connection, and for the same reason: the row records a thing that already
  // exists somewhere honest, so a body row is a second, empty copy of it.
  // `NO_DESTINATION_REASON` counts these as routed-nowhere rather than hiding
  // them in `deduped`, so the decision stays visible in the run.
  //
  // Measured on a fresh full-corpus import carrying every fix merged 2026-08-19:
  // 4,870 `ci.content` rows with `type='file'` from vcard, 2,085 of them with no
  // text AND no url — a "file" pointing at no file. #2152 removed the LinkedIn
  // half of this shape; this is the other half.
  if (kind === 'contact.card') {
    return [];
  }

  if (kind.startsWith('social.')) {
    // An affiliation (a LinkedIn connection, a moderated subreddit) has no body
    // to make searchable, so it keeps its event home and skips content —
    // see isSocialAffiliation for why the row was empty and what still carries
    // the facts. Everything else authored keeps both homes.
    const homes: Destination[] = isSocialAffiliation(rec) ? ['events'] : ['events', 'content'];

    // An UNDATED authored record loses its event home: its startTime is the
    // import-moment fallback, which would sit on the timeline as a real date
    // (the undated-file rule below, applied to social kinds). The content row
    // alone keeps it searchable. Affiliations are exempt — they model current
    // state, their event title carries the whole fact, and their content row
    // is the empty one isSocialAffiliation exists to prevent. No position
    // donation either: a position row is a fix at a TIME, and there isn't one
    // (now enforced structurally — withoutFabricatedPositionFix).
    //
    // An undated AFFILIATION therefore keeps an event row it cannot date, and
    // that is the one place in this function where the import instant survives
    // by choice rather than by oversight. The tradeoff, stated so the next
    // reader does not "fix" it: routing it to `content` would file an empty row
    // (no Text, no Body, no URL — isSocialAffiliation exists because 1,977 such
    // rows were measured), and routing it nowhere would delete the fact that
    // the user moderates r/bitscoop, which is the only place that fact is
    // recorded. So the row stays, and `toEventInput` stamps it
    // `time_source = 'ingest'` / `time_precision = 'unknown'` plus
    // `metadata.undated`, which is what makes "the UI says today" into "the UI
    // says date unknown".
    if (!rec.dated && !isSocialAffiliation(rec)) {
      return ['content'];
    }

    // Same rule as geotagged captures and messages: a post made from a place
    // (a geotagged retweet) keeps its timeline + searchable homes AND donates
    // its fix to the position table.
    return rec.coordinates ? [...homes, 'position'] : homes;
  }

  // A ride is an event, not a document: its "body" was only the route string
  // already carried by the event's own title, so the content row duplicated the
  // event and added nothing searchable.
  if (kind === 'travel.trip') {
    return ['events'];
  }

  if (kind === 'location.fix') {
    // Place visits (google_maps_places: classification='place') keep their event
    // home — the visit time + name has semantic value on the timeline — AND
    // donate a position row. Raw GPS tracks (gpx, google_location, kmlgx, …)
    // are pure donor data with no useful event narrative, so they leave events
    // entirely. Without this branch the timeline drowned in millions of trkpt
    // rows that nothing rendered usefully.
    //
    // An UNDATED place keeps `events` and loses `position`
    // (withoutFabricatedPositionFix strips it above). That asymmetry is the
    // whole decision, so it is worth stating plainly:
    //
    //  - `ci.position` cannot hold it honestly — see that function.
    //  - `ci.events` CAN. `start_time` is NOT NULL, but the table carries
    //    `time_source`/`time_precision`, and `toEventInput` now stamps
    //    `ingest`/`unknown` at insert for exactly these rows. The instant is
    //    still the import moment (nothing can change that; the column is NOT
    //    NULL and there is no date to recover) but the row now SAYS so.
    //  - And the event row is the only thing that carries the coordinates onto
    //    the map. Four of this appliance's five labeled places ("Home", "Work",
    //    "Gym", "Gheric") have real coordinates; routing them to `content`
    //    alone — the treatment undated files get — would be the honest answer
    //    about time and the wrong answer about place, taking four pins off a
    //    map that has 121 located events in total.
    //
    // A raw GPS fix with no time is a different thing entirely: it IS
    // (lat, lon, time), so without the time there is nothing left to file
    // anywhere, and it routes nowhere (PushStage counts that as
    // NO_DESTINATION_REASON, so the decision stays visible in the run rather
    // than being hidden in `deduped`).
    if (rec.eventType === 'place') {
      return ['events', 'position'];
    }

    return rec.dated ? ['position'] : [];
  }

  // A file whose source never gave it a time — a drive-walk document with no
  // embedded date, a photo stripped of its EXIF — has no place on a timeline.
  // Its `startTime` would be the created_at fallback, i.e. the moment of import,
  // which reads as a real date on the timeline and is pure noise next to the
  // EXIF-dated items around it. The file is still worth having, so it goes to
  // content ALONE: the bytes upload, the row is searchable, nothing pretends to
  // know when it happened. (Same reasoning that keeps the reddit importer from
  // emitting undated subscriptions and votes at all.) Scoped to file-bearing
  // kinds — social kinds apply the same rule in their own branches above, and
  // other undated rows keep whatever home their kind gives them.
  if (!rec.dated && (kind.startsWith('capture.') || kind === 'import.archive_item')) {
    return ['content'];
  }

  if (kind.startsWith('capture.')) {
    // A dated photo/video/audio ALWAYS takes a content row alongside its event
    // — same pattern as media.play/watch/listen/read above, and for the same
    // reason: EventMediaLoader resolves an event's thumbnail/attachment by
    // INNER-JOINing ci.content on ci.events through the shared (source_type,
    // source_system, source_id) triple (see ContentService.findMediaFilesByEventIds).
    // A destination list of just ['events'] never creates that content row, so
    // the join finds nothing — every dated capture rendered as a blank tile,
    // gallery-wide, regardless of how many files MediaStage actually uploaded.
    // Verified on a real import: 2,098 photo/video events (Apple Photos,
    // WhatsApp, Instagram, Facebook), 0 with a linked content row.
    //
    // Geotagged captures keep donating a position row too, same as before —
    // this only adds 'content' to what was already being returned.
    return rec.coordinates ? ['events', 'content', 'position'] : ['events', 'content'];
  }

  return ['events'];
}

/** Coarse domain bucket (the prefix of the kind), for `category`. */
function categoryForKind(kind: string): string {
  const dot = kind.indexOf('.');

  return dot === -1 ? kind : kind.slice(0, dot);
}

// Postgres TEXT/JSONB reject NUL bytes and any invalid UTF-8, and lone UTF-16
// surrogates serialize to invalid UTF-8 — all of which appear in real mail/SMS
// bodies (old mbox encodings, binary cruft). Strip them so an ingest insert
// never fails with "invalid byte sequence for encoding UTF8". Keeps \t \n \r.
function sanitizeText(s: string): string {
  // Drop NUL + C0 control chars (keep tab/newline/CR); replace lone UTF-16
  // surrogates with U+FFFD. Otherwise Postgres TEXT/JSONB ingest fails with
  // "invalid byte sequence for encoding UTF8" on real mbox/SMS cruft.
  //
  // U+FFFC OBJECT REPLACEMENT CHARACTER goes too. It is not text — it is the
  // placeholder macOS writes into `message.text` at the position an inline
  // attachment sits, so a photo sent with no caption arrives as a body of
  // exactly "\uFFFC" and a captioned one as "\uFFFC look at this". Keeping it
  // put a bare control glyph in `ci.communications.content` for 21,781 iMessage
  // rows (and a leading glyph on ~6k captioned ones). Stripping it here —
  // rather than at one importer — means every str()/descriptionFor()/titleFor()
  // caller sees the caption alone, and an attachment-only body collapses to
  // null so isAttachmentPlaceholderOnly can blank the content outright.
  //
  // U+FFFD is deliberately NOT stripped: the two replaces below MINT it for
  // lone surrogates, so removing it would undo the repair this function
  // exists to do. Bodies that are nothing BUT U+FFFD are handled by
  // isAttachmentPlaceholderOnly instead, which reads the raw value.
  return (
    s
      // eslint-disable-next-line no-control-regex -- stripping control bytes is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD')
      .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, '$1\uFFFD')
      // Last, so removing it can never splice two lone surrogates into a
      // valid pair and fabricate a character that was not in the source.
      .replace(/\uFFFC/g, '')
  );
}

export function str(v: unknown): string | null {
  if (typeof v !== 'string') {
    return null;
  }

  const cleaned = sanitizeText(v).trim();

  return cleaned ? cleaned : null;
}

// Parse a numeric metadata value that may arrive as a number or a string with
// currency/grouping cruft (e.g. "$19.99", "1,299.00"). Returns null when there
// is no finite number to extract.
export function num(v: unknown): number | null {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null;
  }

  if (typeof v === 'string') {
    const cleaned = v.replace(/[^0-9.+-]/g, '');
    if (!cleaned) {
      return null;
    }

    const n = Number(cleaned);

    return Number.isFinite(n) ? n : null;
  }

  return null;
}

export function isMediaType(mediaType: string | null): boolean {
  return !!mediaType && /^(image|video|audio)\//.test(mediaType);
}

// Classifications whose rows are backed by a file on disk. 'file' is the
// non-media half of a directory walk (a PDF, an archive, a key) — its bytes are
// as uploadable as a photo's, and leaving it out meant a generic import shipped
// documents with mediaPath null, so nothing ever pushed the file itself.
export const FILE_CLASSIFICATIONS = new Set(['media', 'photo', 'image', 'video', 'audio', 'file']);
/** A row carries a file if its MIME is binary media, or it's classified as one. */
export function isMediaItem(row: StagedItem): boolean {
  return isMediaType(row.mediaType) || FILE_CLASSIFICATIONS.has(row.classification ?? '');
}

/**
 * `String.prototype.slice` cuts UTF-16 code units, so a cut through an astral
 * character (emoji) strands half a surrogate pair. JSON.stringify encodes the
 * lone half as a `\ud83d`-style escape — legal in JS, but PostgreSQL's json
 * parser rejects it ("Unicode low surrogate must follow a high surrogate"),
 * failing the whole row server-side. Back off one unit when the cut would
 * land mid-pair.
 */
function sliceSafe(s: string, n: number): string {
  if (s.length <= n) {
    return s;
  }

  const cut = s.charCodeAt(n - 1);

  return s.slice(0, cut >= 0xd800 && cut <= 0xdbff ? n - 1 : n);
}

export function clip(s: string, n = 120): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();

  return oneLine.length > n ? sliceSafe(oneLine, n - 1) + '…' : oneLine;
}

// A meaningful human title from the metadata the importers already record,
// instead of the source filename (every gmail row was titled
// "All mail Including Spam and Trash.mbox"). Kind-aware: a handful of kinds
// have a better title than the generic metadata-key chain would pick (email
// subject, annotation book + excerpt, location place name); everything else —
// including media, which keeps its filename — falls through to the generic
// chain unchanged.
function titleFor(m: Record<string, unknown>, row: StagedItem, kind: string): string | null {
  if (kind === 'communication.email') {
    const subject = str(m.Subject);
    if (subject) {
      return clip(subject);
    }
  }

  if (kind === 'reading.annotation') {
    // Kindle-style highlight: the book is the anchor; append a short excerpt
    // when the importer persisted the highlighted text into metadata.
    const book = str(m.Book) || str(m.Title);
    const excerpt = str(m.Text) || str(m.Highlight) || str(m.Body);
    if (book) {
      return excerpt ? clip(`${book} — ${excerpt}`) : clip(book);
    }
  }

  if (kind === 'location.fix') {
    // Place name over the source filename (a bare "track.gpx" title says
    // nothing; google_maps_places' Name/Address does).
    const place = str(m.Name) || str(m.Place) || str(m.Venue) || str(m.Address);
    if (place) {
      return clip(place);
    }
  }

  const track = str(m.Track);
  if (track) {
    const artist = str(m.Artist);

    return artist ? `${track} — ${artist}` : track;
  }

  // Podcast episode / audiobook chapter plays (Spotify): anchor on the show or
  // book, not the constant content filename (episode.txt / chapter.txt).
  const episode = str(m.Episode);
  if (episode) {
    const show = str(m.Show);

    return clip(show ? `${show} — ${episode}` : episode);
  }

  const chapter = str(m.Chapter);
  if (chapter) {
    const book = str(m.Book);

    // Some audiobook rows repeat the book title as the chapter — don't double it.
    return clip(book && chapter !== book ? `${book} — ${chapter}` : (book ?? chapter));
  }

  const show = str(m.Show);
  if (show) {
    return clip(show);
  }

  const direct =
    str(m.Subject) ||
    str(m.Title) ||
    str(m.Summary) ||
    str(m.Name) ||
    str(m.Person) ||
    str(m.Product) ||
    str(m.Book);
  if (direct) {
    return clip(direct);
  }

  const text = str(m.Text) || str(m.Body) || str(m.Message);
  if (text) {
    return clip(text, 80);
  }

  const sender = str(m.Sender) || str(m.From) || str(m.Contact);
  if (sender) {
    return `Message — ${sender}`;
  }

  return row.filename ? basename(row.filename) : null;
}

/** Description length cap: keeps embeddings/metadata sane if an importer ever
 *  persists an uncapped body (gmail already caps its Text snippet at 4000). */
const DESCRIPTION_MAX = 4000;

// Body/description when the importer persisted the text into metadata (e.g.
// iMessage Text, gmail's capped body snippet, tweet Text, Google Keep Note,
// place-review Comment, Instagram Caption). This is the single cheapest
// search-quality lever: events without a description embed on title alone.
function descriptionFor(m: Record<string, unknown>): string | null {
  const text =
    str(m.Text) ||
    str(m.Body) ||
    str(m.Message) ||
    str(m.Description) ||
    str(m.Notes) ||
    str(m.Note) ||
    str(m.Highlight) ||
    str(m.Comment) ||
    str(m.Caption);

  return text ? sliceSafe(text, DESCRIPTION_MAX) : null;
}

// Raw-GPS sources whose `location` rows are real GPS fixes (as opposed to
// google_maps_places' place-visit rows, which are also classified `location` /
// kind `location.fix` but carry semantic place info on top). Used to default
// locationSource='gps' and to keep the routing rule (raw GPS → position only,
// place visits → events AND position) data-driven.
const RAW_GPS_SOURCES = new Set([
  'gpx',
  'google_location',
  'kmlgx',
  'geojson',
  'nmea',
  // Google Fit's TCX <Trackpoint><Position> fixes — a real receiver track,
  // same provenance as the .gpx a watch would have written.
  'google_fit',
]);

/**
 * Best-effort horizontal accuracy in meters from whatever the source carried.
 * Most importers stash a numeric `Accuracy` (google_location's raw `accuracy`
 * field, future EXIF GPSHPositioningError) so prefer that, falling back to
 * `AccuracyMeters` / `HDOP * 5` (an HDOP→meters rule-of-thumb with consumer GPS
 * receivers ≈ 5m per HDOP unit). Returns undefined for sources that don't
 * publish any uncertainty estimate so the position route can apply a per-source
 * default instead of inventing one here.
 */
function accuracyMetersFor(m: Record<string, unknown>): number | undefined {
  // AccuracyRadius (Microsoft privacy export) is meters: Microsoft follows the
  // W3C Geolocation convention (accuracy in meters) regardless of device type —
  // NOT MaxMind GeoIP2's accuracy_radius, which the name resembles but which is
  // in kilometers.
  const direct = num(m.AccuracyMeters) ?? num(m.Accuracy) ?? num(m.accuracy) ?? num(m.AccuracyRadius);
  if (direct != null && direct > 0) {
    return direct;
  }

  const hdop = num(m.HDOP) ?? num(m.hdop);
  if (hdop != null && hdop > 0) {
    return hdop * 5;
  }

  return undefined;
}

/**
 * Classify how the coordinates were obtained, for the position route. A pure-GPS
 * fix (gpx/google_location/etc.) is the gold-standard donor; EXIF-derived photo
 * coords are gps-quality but worth keeping distinct (so a future provenance
 * audit can split them out); a textual address that the server forward-geocodes
 * is much weaker and gets a coarse default accuracy. Undefined when the record
 * carries no coordinate fix at all.
 */
function locationSourceFor(
  sourceSystem: string,
  kind: string,
  hasCoords: boolean,
  hasLocationName: boolean,
): CanonicalRecord['locationSource'] {
  if (hasCoords) {
    // Photo/video/audio coords come from the file's embedded metadata (EXIF /
    // QuickTime location atom) — gps-quality but kept distinct for provenance.
    if (kind.startsWith('capture.')) {
      return 'exif';
    }

    if (RAW_GPS_SOURCES.has(sourceSystem)) {
      return 'gps';
    }

    if (sourceSystem === 'google_maps_places') {
      return 'gps';
    }

    return 'gps';
  }

  if (hasLocationName) {
    return 'address';
  }

  return undefined;
}

// A geocodable place string when the source carries one (e.g. ICS calendar
// `Location`). Deliberately an allowlist of place-like keys — NOT a fuzzy
// `*location*` match — so it never picks up filesystem-path metadata like
// `intermediateLocation`/`originalLocation`. Clipped so a stray long value
// doesn't blow up the geocode query.
function locationNameFor(m: Record<string, unknown>): string | null {
  const loc =
    str(m.Location) ||
    str(m.location) ||
    str(m.Place) ||
    str(m.place) ||
    str(m.Venue) ||
    str(m.venue) ||
    str(m.Address) ||
    str(m.address);

  return loc ? clip(loc) : null;
}

/** Map a raw timeline row to the transport-agnostic canonical record. */
/** The object-identifier namespaces the shared normalizer knows. */
const IDENTIFIER_NAMESPACES: ReadonlySet<string> = new Set<ObjectIdentifierNamespace>([
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
]);

/**
 * The normalized object identifiers a metadata bag states, from
 * `metadata.Identifiers`.
 *
 * Shape emitted by datasources: `[{ namespace, value, confidence? }]`. Each
 * value goes through `normalizeObjectIdentifier` — the SAME rule
 * `ObjectIdentifierService` writes `ci.object_identifiers` with, which is what
 * makes the importer's pre-normalized value and the server's re-normalization
 * of the same barcode land on one row. A value the rule rejects is SKIPPED (a
 * receipt line with an unreadable barcode is still a valid line), and so is an
 * unknown namespace: inventing one would write a claim nothing can ever look up.
 *
 * NOTE the namespace can CHANGE during normalization — an all-digit "ASIN" is
 * an ISBN-10 and a Bookland GTIN is an ISBN — which is the entire point: one
 * book, one identity, however it arrived.
 *
 * Exported because a receipt LINE carries its own identifiers, in the same
 * shape, inside `metadata.LineItems[]`.
 */
export function identifiersFrom(metadata: Record<string, unknown> | undefined | null): CanonicalIdentifier[] {
  const raw = readCommerceField(metadata, 'IDENTIFIERS');

  if (!Array.isArray(raw)) {
    return [];
  }

  const out: CanonicalIdentifier[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }

    const e = entry as Record<string, unknown>;
    const ns = str(e.namespace)?.toLowerCase();
    const value = str(e.value) ?? str(e.valueRaw);

    if (!ns || !value || !IDENTIFIER_NAMESPACES.has(ns)) {
      continue;
    }

    const normalized = normalizeObjectIdentifier(ns as ObjectIdentifierNamespace, value);

    if (!normalized) {
      continue;
    }

    const key = `${normalized.namespace}|${normalized.valueNormalized}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    const confidence = num(e.confidence);

    out.push({
      namespace: normalized.namespace,
      value: normalized.valueNormalized,
      ...(confidence != null ? { confidence } : {}),
    });
  }

  return out;
}

export function toCanonical(row: StagedItem): CanonicalRecord {
  const metadata: Record<string, unknown> = { ...(row.metadata ?? {}) };
  if (row.filename) {
    metadata.filename = row.filename;
  }

  if (row.originalLocation) {
    metadata.originalLocation = row.originalLocation;
  }

  if (row.intermediateLocation) {
    metadata.intermediateLocation = row.intermediateLocation;
  }

  const hasCoords = row.latitude != null && row.longitude != null;
  const kind = kindFor(row.classification, row.mediaType);
  metadata.kind = kind; // ride in metadata until CI-Server adds a first-class column

  const sourceSystem = sourceSystemFor(row);
  const locationName = locationNameFor(metadata);
  const locationSource = locationSourceFor(sourceSystem, kind, hasCoords, !!locationName);
  // Per-source default for the accuracy estimate when the row itself didn't
  // carry one. Picked from real-world rule-of-thumb: ~30m for EXIF GPS (older
  // phones with weak GPS), ~200m for forward-geocoded addresses (street-level).
  const ACCURACY_DEFAULT_BY_SOURCE: Partial<Record<NonNullable<CanonicalRecord['locationSource']>, number>> =
    {
      exif: 30,
      address: 200,
    };
  const accuracyMeters =
    accuracyMetersFor(metadata) ?? (locationSource ? ACCURACY_DEFAULT_BY_SOURCE[locationSource] : undefined);
  const identifiers = identifiersFrom(metadata);

  return {
    sourceType: SOURCE_TYPE,
    sourceSystem,
    sourceId: sourceIdFor(row),
    // A start time is required; fall back to the row's own creation so a record
    // without a parsed timestamp is still ingestable. `dated` remembers which of
    // the two it is — the fallback is import time, not the file's time.
    startTime: (row.occurredAt ?? row.createdAt).toISOString(),
    dated: row.occurredAt != null,
    endTime: row.timespanEnd?.toISOString() ?? null,
    eventType: row.classification,
    category: categoryForKind(kind),
    kind,
    title: titleFor(metadata, row, kind),
    description: descriptionFor(metadata),
    coordinates: hasCoords ? { lat: row.latitude as number, lon: row.longitude as number } : null,
    locationName,
    isAllDay: typeof metadata.isAllDay === 'boolean' ? metadata.isAllDay : null,
    isRecurring: typeof metadata.isRecurring === 'boolean' ? metadata.isRecurring : null,
    mediaType: row.mediaType,
    contentHash: row.contentHash,
    // Source file path for media items, so the push can upload + link the bytes.
    mediaPath: isMediaItem(row) ? row.intermediateLocation || row.originalLocation || null : null,
    accuracyMeters,
    locationSource,
    metadata,
    // Absent (not []) when the source states none — see CanonicalRecord.
    ...(identifiers.length ? { identifiers } : {}),
  };
}

/**
 * The temp-file paths of MMS-style attachments an item carries, written to disk
 * during ingest (see datasources/sms_backup_restore.ts → metadata.MediaFilePaths).
 * Unlike `mediaPath` (a single media *item*'s own file), a communication row can
 * carry SEVERAL attachments, so they ride as an array in metadata rather than in
 * the single-valued intermediate_location column. Returns the validated string
 * paths, or [] when the record has none.
 */
export function mmsMediaFilePaths(rec: CanonicalRecord): string[] {
  return mmsMediaFilePathsFrom(rec.metadata as Record<string, unknown> | undefined);
}

/**
 * {@link mmsMediaFilePaths} against a raw metadata object.
 *
 * The media leg runs BEFORE the push, over `ci_import.staged_items` rows rather
 * than canonical records, so it has a metadata jsonb and no `CanonicalRecord`
 * to read it out of. Splitting the accessor in two — rather than building a
 * throwaway record around the metadata — keeps ONE definition of what the key
 * holds, which is the whole point: these keys are a contract between a parser
 * and a consumer two stages apart, and a second reader that drifted is exactly
 * how this lane came to have a reader with no producer.
 */
export function mmsMediaFilePathsFrom(metadata: Record<string, unknown> | undefined): string[] {
  const v = metadata?.MediaFilePaths;

  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

/**
 * The name the file had when the user had it — `items.filename`, carried into
 * metadata by {@link toCanonical}. NOT the basename of `mediaPath`: by push time
 * that path points into the media store, whose files are named
 * `<sha1-of-item-hash><ext>` (persistence.retainOneFile is content-addressed).
 * Uploading under that name is how every OneDrive document arrived in CI-Server
 * titled `d41d8cd98f…pdf`. Falls back to the path's basename only when the row
 * has no filename at all.
 */
export function sourceFilename(rec: CanonicalRecord): string | undefined {
  const name = str(rec.metadata.filename);
  if (name) {
    return basename(name);
  }

  return rec.mediaPath ? basename(rec.mediaPath) : undefined;
}

/**
 * The CI-Server file id a prior upload leg stamped on this record (graphql.ts
 * withContentMedia), so the content row can reference the stored bytes. Kept in
 * metadata for the same reason as AttachmentFileIds: the canonical record is
 * built before any upload happens.
 */
export function contentFileRef(rec: CanonicalRecord): { id?: string; url?: string } {
  const m = rec.metadata as Record<string, unknown>;

  return { id: str(m.FileId) ?? undefined, url: str(m.FileUrl) ?? undefined };
}

/**
 * The SHA-256 the object store computed for the bytes {@link contentFileRef}
 * points at (MediaStage.markUploaded stamps `FileSha256` beside `FileId`), or
 * undefined when nothing was uploaded or the store did not hash. Validated as
 * 64 hex characters so a stray value cannot become a `file` identity.
 */
export function fileSha256Ref(rec: CanonicalRecord): string | undefined {
  const value = str((rec.metadata as Record<string, unknown>).FileSha256);

  return value && /^[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : undefined;
}

/**
 * Should this record's attachments (see {@link mmsMediaFilePaths}) also get a
 * ci.content row each, or are the stored files enough? Set by the importer as
 * metadata.AttachmentContent — Messenger opts in (a shared photo is a thing you
 * want to find by itself, not only by reading the thread it arrived in), MMS
 * does not. Drives the lane split in graphql.ts withCommunicationMedia.
 */
export function wantsAttachmentContent(rec: CanonicalRecord): boolean {
  return wantsAttachmentContentFrom(rec.metadata as Record<string, unknown> | undefined);
}

/** {@link wantsAttachmentContent} against a raw metadata object. */
export function wantsAttachmentContentFrom(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.AttachmentContent === true;
}

/**
 * The described media a communication carries (datasources/twitter.ts →
 * metadata.MediaAttachments).
 *
 * The richer sibling of {@link mmsMediaFilePaths}: where an MMS part is bare
 * bytes on disk, these descriptors also know what the media IS (image/video)
 * and where it lives on the source service — enough to catalogue each one as a
 * content row alongside the uploaded file, so the communication's `attachments`
 * can point at both. Entries without a usable local path are dropped: the push
 * uploads bytes, and there are none to upload.
 */
export function communicationMediaAttachments(rec: CanonicalRecord): MediaAttachment[] {
  return communicationMediaAttachmentsFrom(rec.metadata as Record<string, unknown> | undefined);
}

/** {@link communicationMediaAttachments} against a raw metadata object. */
export function communicationMediaAttachmentsFrom(
  metadata: Record<string, unknown> | undefined,
): MediaAttachment[] {
  const v = metadata?.MediaAttachments;
  if (!Array.isArray(v)) {
    return [];
  }

  const out: MediaAttachment[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }

    const a = raw as Record<string, unknown>;
    const filePath = str(a.path);
    if (!filePath) {
      continue;
    }

    const type = str(a.type);
    out.push({
      path: filePath,
      filename: str(a.filename) ?? undefined,
      // 'file' passes through for non-media attachments (an email's PDF): the
      // content row over it should say file, not media. 'receipt_document' is
      // the receipt-aware refinement of 'file' (see
      // datasources/timeline.AttachmentDescriptor).
      type:
        type === 'image' ||
        type === 'video' ||
        type === 'audio' ||
        type === 'file' ||
        type === 'receipt_document'
          ? type
          : 'media',
      mimetype: str(a.mimetype) ?? undefined,
      url: str(a.url) ?? undefined,
    });
  }

  return out;
}

/**
 * Every attachment a communication carries, in ONE list, whichever key its
 * parser chose to write.
 *
 * Two shapes reached staging independently and neither was ever read:
 * `MediaAttachments` (twitter, gmail, imessage, the LLM chat exports — a
 * descriptor that knows its filename and MIME) and `MediaFilePaths` (facebook,
 * sms_backup_restore — a bare absolute path). They describe the same thing at
 * different resolutions, so the media leg takes them as one list and lets the
 * poorer shape fill its gaps from the path: `filename` is the basename, and the
 * MIME is whatever the extension says.
 *
 * De-duplicated on the path, because a parser is allowed to write both keys for
 * the same bytes (facebook writes `MediaFilePaths` today and would gain nothing
 * by dropping it if it ever also wrote descriptors), and uploading one file
 * twice would put two entries in `attachments` for one photo.
 *
 * Order is the parser's, descriptors first — it is what the index alignment in
 * {@link attachmentsFor}'s `AttachmentFileIds`/`AttachmentContentIds` pairing is
 * relative to, so it has to be deterministic.
 */
export function communicationAttachmentsFrom(
  metadata: Record<string, unknown> | undefined,
): MediaAttachment[] {
  const out = communicationMediaAttachmentsFrom(metadata);
  const seen = new Set(out.map((a) => a.path));

  for (const filePath of mmsMediaFilePathsFrom(metadata)) {
    if (seen.has(filePath)) {
      continue;
    }

    seen.add(filePath);
    const filename = basename(filePath);
    const mimetype = mimeForFile(filePath) ?? undefined;
    out.push({
      path: filePath,
      filename,
      // Same rule the descriptor lane uses: a media MIME is media, and anything
      // an extension cannot type stays the honest 'file' rather than being
      // guessed into a gallery.
      type: isMediaType(mimetype ?? null) ? 'media' : 'file',
      ...(mimetype ? { mimetype } : {}),
    });
  }

  return out;
}
