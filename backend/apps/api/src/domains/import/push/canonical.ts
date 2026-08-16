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
import type { MediaAttachment } from '../datasources/timeline';
import type { StagedItem } from '../entities/StagedItemEntity';

/**
 * The integration that produced these records.
 *
 * Deliberately unchanged from upstream. It is one third of the dedup triple, so
 * a row this appliance imports must carry the same `sourceType` the standalone
 * importer wrote historically, or every previously-imported record duplicates
 * the first time someone re-imports the same export here.
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
  purchase: 'commerce.purchase',
  transaction: 'commerce.transaction',
  // The ACT of placing an order, one per order id — emitted by the Amazon
  // importer alongside its per-line 'purchase' items so a five-item order is
  // one timeline event, not five. Routes via `commerce.*` → events alone; the
  // line items keep their inventory/content homes.
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

    return 'capture.photo'; // no/unknown MIME → default to photo (prior behavior)
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
 * dedicated batch GraphQL mutation (createInventoryItems / createCommunications /
 * createBrowserActivities / createContents / createPositions); everything else
 * falls through to `createEvent`.
 *
 * `position` carries the (time, lat, lon, accuracy_meters, location_source)
 * tuples that LocationEstimateService treats as primary donors when inferring
 * locations for events that lack coordinates. Until the route is wired the
 * partition falls back to `createEvents`, which keeps today's behavior unchanged.
 */
export type Destination =
  | 'inventory'
  | 'communications'
  | 'browser_activity'
  | 'content'
  | 'events'
  | 'position';

/**
 * The `entityType` values CI-Server's search-index backfill sweep understands
 * (`BACKFILLABLE_ENTITIES` in CI-Server maintenance/SearchIndexBackfillService).
 * These are the bulk-ingest tables whose `createMany()` no longer emits a per-row
 * `*CreatedEvent`, so their rows must be swept into `ci_search.embeddings` after a
 * push. This is the CI-Import-Tools-side mirror of that closed set — keep the two
 * in sync when CI-Server adds a backfillable type.
 */
export type BackfillEntityType = 'communication' | 'event' | 'content' | 'item' | 'browser-activity' | 'file';

/**
 * Map an import `Destination` to the CI-Server backfill `entityType` its rows land
 * under, so a push can ask the search-index sweep to embed exactly the types it
 * just wrote instead of the server's full default set. Closes gap G2 (content
 * 0% / event 6.5% embed coverage): the previous empty-body backfill relied on the
 * server default sweeping every type, but content/event rows sat unindexed.
 *
 * `position` maps to nothing — GPS fixes have no embeddable text and are not a
 * `BACKFILLABLE_ENTITIES` type, so a position-only push triggers no backfill.
 */
const DESTINATION_TO_BACKFILL_ENTITY: Record<Destination, BackfillEntityType | null> = {
  events: 'event',
  content: 'content',
  communications: 'communication',
  inventory: 'item',
  browser_activity: 'browser-activity',
  position: null,
};

/**
 * Reduce the set of destinations a push actually wrote to into the distinct,
 * ordered list of CI-Server backfill entity types to sweep. Destinations with no
 * backfillable counterpart (e.g. `position`) are dropped; the result is
 * deduplicated and stably ordered so requests are deterministic.
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
  ];

  return ORDER.filter((e) => seen.has(e));
}

/**
 * Heuristic: is a purchased good DIGITAL (→ content) vs PHYSICAL (→ inventory)?
 * Amazon's "Your Orders" CSV carries no product-type field, so we sniff the
 * product name. Best-effort; defaults to physical.
 */
const DIGITAL_GOOD_RE =
  /\b(kindle|e-?book|audiobook|audible|\[digital\]|digital (?:download|code|copy)|app store|in-app|software|subscription|prime video|mp3|gift\s?card|download)\b/i;

function isDigitalGood(rec: CanonicalRecord): boolean {
  // An importer that KNOWS the good is digital says so outright, and that
  // outranks the guess below: Amazon files digital purchases in their own
  // export file, where "Prime Membership Fee" and most game titles match no
  // keyword and were landing in physical inventory.
  const declared = rec.metadata.Digital;
  if (typeof declared === 'boolean') {
    return declared;
  }

  if (typeof declared === 'string' && declared.trim()) {
    return /^(true|yes|1)$/i.test(declared.trim());
  }

  const name = str(rec.metadata.Product) || rec.title || '';

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
 *   commerce.purchase   -> inventory | content | nothing   physical good vs digital good (home =
 *                                                the thing); a subscription fee is neither and
 *                                                pushes nowhere (its order event marks the purchase)
 *   commerce.transaction / .withdrawal / .credit / .payment
 *                       -> events                a money movement is an occurrence, not content
 *   commerce.order      -> events                  one timeline event per Amazon order id
 *   commerce.*          -> events
 *   communication.*     -> communications | communications+position  a geotagged
 *                                                message donates its fix too
 *   web.bookmark        -> content
 *   web.page_view       -> browser_activity
 *   calendar.event      -> events | events+content  content ONLY when the event carries
 *                                                   a file (attachment on disk / media MIME)
 *   media.play|watch|listen -> events + content  timeline occurrence (when watched/played) +
 *                                                searchable content row (the thing watched/played)
 *   media.saved         -> content              a library's saved/followed track or album — a
 *                                                thing with no occurrence, so no event

 *   note|annotation     -> content
 *   social.*            -> events + content      timeline + searchable post/comment body
 *                          (+ position when geotagged)
 *   reddit post/comment -> communications (+ content only for attached media)
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

/** A Reddit comment (a reply authored on a post, or a saved one). */
export function isRedditComment(rec: CanonicalRecord): boolean {
  return (
    rec.sourceSystem === 'reddit' &&
    (rec.metadata.Kind === 'comment' || rec.metadata.Kind === 'saved_comment')
  );
}

// Reddit's GDPR export is CSV-only — media exists solely as URLs. Direct-media
// hosts, or any URL whose path ends in a media extension, count; imgur PAGE
// links (imgur.com/abc) don't. .gifv is imgur's video wrapper, hence video.
const REDDIT_IMAGE_HOSTS = /^https?:\/\/(i\.redd\.it|preview\.redd\.it|i\.imgur\.com)\//i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|heic)$/i;
const REDDIT_VIDEO_HOSTS = /^https?:\/\/v\.redd\.it\//i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v|gifv)$/i;

function mediaUrlKind(url: string): 'image' | 'video' | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }

  if (REDDIT_VIDEO_HOSTS.test(url) || VIDEO_EXT.test(pathname)) {
    return 'video';
  }

  if (REDDIT_IMAGE_HOSTS.test(url) || IMAGE_EXT.test(pathname)) {
    return 'image';
  }

  return null;
}

export interface RedditMediaRef {
  url: string;
  kind: 'image' | 'video';
}

/**
 * The media a Reddit record carries, or null. A link post's media is its URL
 * field (the link target) when it points at an image or video. A comment has
 * no URL field pointing at media (metadata.URL is the comment's own
 * permalink), so its media is the first direct image/video link found in the
 * body markdown.
 */
export function redditMediaUrl(rec: CanonicalRecord): RedditMediaRef | null {
  if (isRedditPost(rec)) {
    const url = str(rec.metadata.URL);
    if (!url) {
      return null;
    }

    const kind = mediaUrlKind(url);

    return kind ? { url, kind } : null;
  }

  if (isRedditComment(rec)) {
    const body = str(rec.metadata.Body) ?? '';
    for (const m of body.matchAll(/https?:\/\/[^\s)\]<>"']+/g)) {
      const url = m[0].replace(/[.,;!?]+$/, '');
      const kind = mediaUrlKind(url);
      if (kind) {
        return { url, kind };
      }
    }
  }

  return null;
}

export function destinationsFor(rec: CanonicalRecord): Destination[] {
  const kind = rec.kind;
  // Reddit posts and comments are authored communications, not timeline
  // events: they go to /communications only. A content row rides along ONLY
  // when the record carries media (see toContentInput for the row's shape).
  if (isRedditPost(rec) || isRedditComment(rec)) {
    return redditMediaUrl(rec) ? ['communications', 'content'] : ['communications'];
  }

  if (kind === 'commerce.purchase') {
    // A subscription fee (Prime, Kindle Unlimited, an Audible plan — the
    // amazon importer stamps metadata.Subscription from the export's own
    // Subscription Order Type) is a service, not a thing: it is neither
    // content nor inventory, so the line pushes nowhere. The purchase itself
    // is still marked — the importer's per-order aggregate (commerce.order)
    // carries it to events.
    if (rec.metadata.Subscription === true) {
      return [];
    }

    return [isDigitalGood(rec) ? 'content' : 'inventory'];
  }

  // A transaction (any direction: transaction/withdrawal/credit/payment) is a
  // timeline occurrence (money moved at a moment), not a piece of content —
  // there is no document/media "thing" behind it worth a searchable corpus
  // row. Events only. This also covers future commerce.* kinds; only purchase
  // (above) has a different home.
  if (kind.startsWith('commerce.')) {
    return ['events'];
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
  if (kind === 'web.page_view' || kind === 'web.search') {
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

  if (kind.startsWith('social.')) {
    // Same rule as geotagged captures and messages: a post made from a place
    // (a geotagged retweet) keeps its timeline + searchable homes AND donates
    // its fix to the position table.
    return rec.coordinates ? ['events', 'content', 'position'] : ['events', 'content'];
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
    return rec.eventType === 'place' ? ['events', 'position'] : ['position'];
  }

  // A file whose source never gave it a time — a drive-walk document with no
  // embedded date, a photo stripped of its EXIF — has no place on a timeline.
  // Its `startTime` would be the created_at fallback, i.e. the moment of import,
  // which reads as a real date on the timeline and is pure noise next to the
  // EXIF-dated items around it. The file is still worth having, so it goes to
  // content ALONE: the bytes upload, the row is searchable, nothing pretends to
  // know when it happened. (Same reasoning that keeps the reddit importer from
  // emitting undated subscriptions and votes at all.) Scoped to file-bearing
  // kinds — other undated rows keep whatever home their kind gives them.
  if (!rec.dated && (kind.startsWith('capture.') || kind === 'import.archive_item')) {
    return ['content'];
  }

  if (kind.startsWith('capture.') && rec.coordinates) {
    // Any geotagged capture — photo, video, or audio — keeps its home in events
    // (where its media file is linked) and also donates a position row so the
    // estimator can interpolate nearby coordinate-less events. A geotagged phone
    // video is as good a GPS donor as a photo.
    return ['events', 'position'];
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
  return (
    s
      // eslint-disable-next-line no-control-regex -- stripping control bytes is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD')
      .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, '$1\uFFFD')
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
  const v = (rec.metadata as Record<string, unknown> | undefined)?.MediaFilePaths;

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
 * Should this record's attachments (see {@link mmsMediaFilePaths}) also get a
 * ci.content row each, or are the stored files enough? Set by the importer as
 * metadata.AttachmentContent — Messenger opts in (a shared photo is a thing you
 * want to find by itself, not only by reading the thread it arrived in), MMS
 * does not. Drives the lane split in graphql.ts withCommunicationMedia.
 */
export function wantsAttachmentContent(rec: CanonicalRecord): boolean {
  return (rec.metadata as Record<string, unknown> | undefined)?.AttachmentContent === true;
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
  const v = (rec.metadata as Record<string, unknown> | undefined)?.MediaAttachments;
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
      // content row over it should say file, not media.
      type: type === 'image' || type === 'video' || type === 'audio' || type === 'file' ? type : 'media',
      mimetype: str(a.mimetype) ?? undefined,
      url: str(a.url) ?? undefined,
    });
  }

  return out;
}
