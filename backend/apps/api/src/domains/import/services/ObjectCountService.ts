import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { WIZARD_SOURCES, type Category } from '../sources/guides';

/**
 * How much of one memory kind an importer has actually put in the appliance —
 * the number the picker's tiles show under "24K Mail", "1.2M Photos".
 *
 * Deliberately the OPPOSITE data source from {@link useSourceUsage}'s
 * `lastImportedAt` (frontend/.../wizard/useSourceUsage.ts), whose long docblock
 * explains why a per-source total canNOT be read off import RUNS: a run
 * records one total for the whole archive, a bundle covers several importers
 * whose totals would be summed twice, and runs are not idempotent so a
 * re-import would double a count the push stage already deduplicated. None of
 * that applies to a live `COUNT(*) … WHERE source_system = X` — a row IS the
 * kind it is, a bundle can safely sum its members' real counts, and re-running
 * the same archive does not inflate `ci.*` because push upserts on the row's
 * natural key. So this counts the DESTINATION tables directly, never a run.
 *
 * `label` is the exact string sources.tsx's `OBJECTS_BY_CATEGORY` renders next
 * to that importer's icon ('Mail', 'Posts', 'Watch history', …) — restated
 * here rather than imported, for the same reason useImportApi.ts restates
 * every other backend shape: this is a NestJS module and that is a Vite one,
 * separate build graphs that cannot import each other. Each side's tests keep
 * the vocabulary honest instead.
 *
 * An importer that shares its parser with another catalog source (`calendar`,
 * `vcard`, `email`, `generic` — see `unambiguousImporters` in
 * useSourceUsage.ts) is deliberately NOT filtered out here: this service
 * answers "what does the `calendar` importer's data look like", which is a
 * true fact about a real `source_system` value, and it is the FRONTEND's job
 * — via that same `unambiguousImporters`, reused rather than reimplemented —
 * to refuse attributing a shared bucket to any one of the tiles that feed it.
 * Keeping that one rule in one place (a pure, already-tested function) beats
 * teaching this SQL layer the wizard's catalog-sharing rules a second time.
 */
export interface ObjectCountEntry {
  readonly importer: string;
  readonly label: string;
  readonly count: number;
}

// ---------------------------------------------------------------------------
// Label vocabulary — must match sources.tsx's OBJECTS_BY_CATEGORY exactly.
// A frontend test (useObjectCounts.test.ts) pins the two against each other.
// ---------------------------------------------------------------------------

const LABEL_MAIL = 'Mail';
const LABEL_MESSAGES = 'Messages';
const LABEL_PHOTOS = 'Photos';
const LABEL_VIDEOS = 'Videos';
const LABEL_WATCH_HISTORY = 'Watch history';
const LABEL_LISTENING = 'Listening';
const LABEL_PLACES = 'Places';
const LABEL_CALENDAR = 'Calendar';
const LABEL_HEALTH = 'Health & activity';
const LABEL_POSTS = 'Posts';
const LABEL_BROWSING = 'Browsing';
const LABEL_BOOKMARKS = 'Bookmarks';
const LABEL_BOOKS = 'Books & highlights';
const LABEL_TRIPS = 'Trips';
const LABEL_CONVERSATIONS = 'Conversations';
const LABEL_NOTES = 'Notes & pages';
const LABEL_ORDERS = 'Orders & payments';
const LABEL_REPOSITORIES = 'Repositories';
const LABEL_CONTACTS = 'Contacts';

// Object kinds this service deliberately does NOT compute, and why — see
// ObjectCountService.test.ts's "disclosed gaps" describe block, which pins
// each absence to the reason rather than letting it silently regress into
// "someone forgot":
//
//  - Playlists (audio): no table records "this row is a playlist" as a unit
//    distinct from "this row is a track" for any audio importer — Spotify
//    detects but never parses its playlist files, Amazon Music folds playlist
//    membership into a metadata array on the TRACK row (a different count
//    unit entirely). No predicate exists to fabricate.
//  - Games & playtime (gaming): Roblox's Right-to-Access export has no
//    session-duration concept anywhere, so the only real numbers available
//    (chat rows + purchases + login-history "social" rows) would answer a
//    question the tile does not ask. Counting them under "playtime" would
//    itself be the over-claim this feature exists to avoid.
//  - Commits (code): no importer in this codebase has ever read a git log —
//    github.ts only ingests STARRED repos. There is no table this could come
//    from, for any archive a user could upload today.
//  - Files (misc): the only classification that becomes `ci.content.type =
//    'file'` is a non-media file from a plain drive walk, and every misc
//    importer that does that (onedrive, dropbox, backblaze, koofr, synology,
//    media) shares the ambiguous `generic` parser — excluded importer-side by
//    the frontend's `unambiguousImporters`. The importers that ARE unambiguous
//    in this category (letterboxd, microsoft_account, google_my_activity)
//    never emit classification `'file'` at all. No currently-catalogued
//    source can ever produce a non-zero, attributable Files count.

/** Effective importer name — same fallback `DataSourceCatalogService` uses. */
function importerName(source: { readonly id: string; readonly importer?: string }): string {
  return source.importer ?? source.id;
}

/** Every importer authored under one wizard category, de-duplicated. */
function importersFor(category: Category, exclude: readonly string[] = []): readonly string[] {
  const excluded = new Set(exclude);

  return [
    ...new Set(
      WIZARD_SOURCES.filter((source) => source.category === category)
        .map(importerName)
        .filter((name) => !excluded.has(name)),
    ),
  ];
}

const MAIL_IMPORTERS = importersFor('mail');
const MESSAGE_IMPORTERS = importersFor('messages');
const AI_IMPORTERS = importersFor('ai');
const HEALTH_IMPORTERS = importersFor('health');
const BROWSER_IMPORTERS = importersFor('browser');
const FINANCE_IMPORTERS = importersFor('finance');
const AUDIO_IMPORTERS = importersFor('audio');
const VIDEO_IMPORTERS = importersFor('video');
const PRODUCTIVITY_IMPORTERS = importersFor('productivity');
const CODE_IMPORTERS = importersFor('code');
const CALENDAR_IMPORTERS = importersFor('calendar');
const READING_IMPORTERS = importersFor('reading');

/**
 * Reading importers whose classification is `'read'` (a SESSION — kind
 * `media.read`, `ci.content.type = 'media'`) rather than `'annotation'` (a
 * highlight — kind `reading.annotation`, `type = 'annotation'`). Currently
 * just `kindle_reading`, distinct from `kindle`'s own highlights-only export.
 */
const READING_MEDIA_STYLE_IMPORTERS = new Set(['kindle_reading']);

/**
 * `flighty` is excluded from Trips for a real bug, not a style choice:
 * flighty.ts never stamps `item.classification`, so `kindFor(null, null)`
 * falls through to `import.archive_item` and every flight lands in `ci.events`
 * with `category = 'import'`, never `'travel'` — meaning the predicate below
 * already excludes it structurally, with or without this line. It is kept
 * explicit anyway so a future partial fix (one that gives flighty SOME
 * `category = 'travel'` classification without specifically producing
 * `travel.trip`) does not silently start counting rows nobody has verified
 * are actually one-per-flight and not double-counted by its separate "one
 * pipeline item per flight, plus one more when Notes is non-empty" gotcha.
 */
const TRIP_IMPORTERS = importersFor('travel', ['flighty']);

/**
 * The five location-category importers whose rows ONLY ever reach
 * `ci.position` (raw GPS fixes, `RAW_GPS_SOURCES` in push/canonical.ts) —
 * `google_maps_places` is excluded on purpose. It is the one location
 * importer whose visits are COMPLETE in `ci.events` (every visit lands there,
 * with or without coordinates) and only PARTIALLY duplicated into
 * `ci.position` for the subset that has them. Summing both tables for it would
 * double-count exactly the visits that have coordinates — confirmed live: 31
 * `ci.events` rows against 9 `ci.position` rows for the same import. Its
 * Places count comes ONLY from the events leg, below.
 */
const RAW_GPS_IMPORTERS = importersFor('location', ['google_maps_places']);

/**
 * How each Social-category importer's real, authored POSTS are found — never
 * a blanket "this row's category is 'social'" rule, because `linkedin`'s only
 * `social.post`-shaped rows (`ci.events`, `event_type = 'social'`) are
 * CONNECTIONS, not posts (`isSocialAffiliation` in push/canonical.ts gates on
 * exactly `sourceSystem === 'linkedin' && Kind === 'connection'`) — 1,975 of
 * them, live, all connections, zero posts. The same query shape that correctly
 * isolates posts for facebook/instagram would show a fabricated "2.0K Posts"
 * on a tile that has never parsed a single one, which is precisely the
 * over-claiming bug this feature exists to not repeat. So linkedin gets no
 * rule at all, and neither do snapchat/pinterest/tumblr, which have no
 * post-capable parser to begin with — the raw queries already return nothing
 * for all four; this table is what stops facebook's or twitter's shape from
 * being reused for them by accident.
 */
interface PostRule {
  readonly importer: string;
  readonly eventType?: string;
  readonly communicationType?: string;
}

const POST_RULES: readonly PostRule[] = [
  // post.txt is built from the real caption/post text — genuine authored posts.
  { importer: 'facebook', eventType: 'social' },
  { importer: 'instagram', eventType: 'social' },
  // Same semantic kind (`social.post`) as facebook/instagram, but mastodon.ts
  // stamps the RAW classification `'post'` rather than `'social'`, and
  // `ci.events.event_type` stores that raw string verbatim — a different
  // literal for the identical meaning.
  { importer: 'mastodon', eventType: 'post' },
  // Reddit's posts/comments are special-cased into ci.communications
  // regardless of kind (isRedditPost/isRedditComment in push/canonical.ts);
  // the 2 live `ci.events` rows for reddit are subscribed-subreddit
  // affiliations, not posts, and must stay excluded.
  { importer: 'reddit', communicationType: 'post' },
  // Twitter splits across BOTH tables: authored tweets get classification
  // 'message' + metadata.CommunicationType 'post' (communications), retweets
  // get classification 'social' (events) — a single-table query would
  // arbitrarily omit whichever half it did not query. Summed together below.
  { importer: 'twitter', eventType: 'social', communicationType: 'post' },
];

// ---------------------------------------------------------------------------
// Raw grouped rows — one query per backing table, each scoped to the caller.
// ---------------------------------------------------------------------------

interface CommRow {
  readonly source_system: string | null;
  readonly communication_type: string;
  readonly count: string;
}

interface EventRow {
  readonly source_system: string | null;
  readonly event_type: string | null;
  readonly category: string | null;
  readonly count: string;
}

interface ContentRow {
  readonly source_system: string | null;
  readonly type: string | null;
  readonly mimetype: string | null;
  readonly count: string;
}

interface SourceCountRow {
  readonly source_system: string | null;
  readonly count: string;
}

/** Everything {@link assembleObjectCounts} needs, already scoped to one user. */
export interface RawObjectCountData {
  readonly communications: readonly CommRow[];
  readonly events: readonly EventRow[];
  readonly content: readonly ContentRow[];
  readonly browserActivity: readonly SourceCountRow[];
  readonly receipts: readonly SourceCountRow[];
  readonly position: readonly SourceCountRow[];
  /** `ci.entities` rows under `linked_table = 'import:contact_list'` — see {@link ObjectCountService.contactsCount}. */
  readonly contacts: number;
}

/**
 * What this appliance has actually put in your memory, per importer.
 *
 * Six queries, each a single `GROUP BY` over one destination table plus one
 * indexed lookup for contacts — not one query per importer, which at ~67
 * unambiguous importers would be 67 round trips for a picker step that loads
 * on every wizard open.
 */
@Injectable()
export class ObjectCountService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async countsForUser(userId: string): Promise<ObjectCountEntry[]> {
    const [communications, events, content, browserActivity, receipts, position, contacts] =
      await Promise.all([
        this.communicationsByImporter(userId),
        this.eventsByImporter(userId),
        this.contentByImporter(userId),
        this.browserActivityByImporter(userId),
        this.receiptsByImporter(userId),
        this.positionByImporter(userId),
        this.contactsCount(userId),
      ]);

    return assembleObjectCounts({
      communications,
      events,
      content,
      browserActivity,
      receipts,
      position,
      contacts,
    });
  }

  private communicationsByImporter(userId: string): Promise<CommRow[]> {
    return this.dataSource.query<CommRow[]>(
      `SELECT source_system, communication_type::text AS communication_type, count(*)::text AS count
         FROM ci.communications
        WHERE user_id = $1
        GROUP BY source_system, communication_type`,
      [userId],
    );
  }

  private eventsByImporter(userId: string): Promise<EventRow[]> {
    return this.dataSource.query<EventRow[]>(
      `SELECT source_system, event_type, category, count(*)::text AS count
         FROM ci.events
        WHERE user_id = $1 AND is_deleted = false
        GROUP BY source_system, event_type, category`,
      [userId],
    );
  }

  private contentByImporter(userId: string): Promise<ContentRow[]> {
    return this.dataSource.query<ContentRow[]>(
      `SELECT source_system, type, mimetype, count(*)::text AS count
         FROM ci.content
        WHERE user_id = $1
        GROUP BY source_system, type, mimetype`,
      [userId],
    );
  }

  private browserActivityByImporter(userId: string): Promise<SourceCountRow[]> {
    return this.dataSource.query<SourceCountRow[]>(
      `SELECT source_system, count(*)::text AS count
         FROM ci.browser_activity
        WHERE user_id = $1
        GROUP BY source_system`,
      [userId],
    );
  }

  private receiptsByImporter(userId: string): Promise<SourceCountRow[]> {
    // `user_id`, NOT `owner_user_id` — the latter is a nullable household-
    // attribution field, not the auth scope (ReceiptEntity, migration
    // 20260803223019).
    return this.dataSource.query<SourceCountRow[]>(
      `SELECT source_system, count(*)::text AS count
         FROM ci.receipts
        WHERE user_id = $1
        GROUP BY source_system`,
      [userId],
    );
  }

  private positionByImporter(userId: string): Promise<SourceCountRow[]> {
    return this.dataSource.query<SourceCountRow[]>(
      `SELECT source_system, count(*)::text AS count
         FROM ci.position
        WHERE user_id = $1
        GROUP BY source_system`,
      [userId],
    );
  }

  /**
   * `ci.entities` has no `source_system` column — provenance lives in
   * `linked_table`, stamped `'import:' || sourceSystem` by GraphIngestService
   * and namespaced per-source by design (a refresh only overwrites what that
   * same source wrote last time; it cannot clobber another source's rows —
   * GraphIngestService.ts:349-353), which is what makes it a safe, non-
   * overwritten provenance marker. Only `outlook_contacts` (importer
   * `contact_list`) is unambiguous; `google_contacts`/`apple_contacts` share
   * `vcard` and sit under `linked_table = 'import:vcard'` with no way to split
   * them, so they are not queried here — the frontend's ambiguity filter would
   * discard them anyway, but there is also no honest number to hand it.
   */
  private async contactsCount(userId: string): Promise<number> {
    const rows = await this.dataSource.query<Array<{ count: string }>>(
      `SELECT count(*)::text AS count
         FROM ci.entities
        WHERE owner_user_id = $1
          AND entity_type = 'Person'
          AND linked_table = 'import:contact_list'
          AND merged_into_entity_id IS NULL`,
      [userId],
    );

    return Number(rows[0]?.count ?? 0);
  }
}

// ---------------------------------------------------------------------------
// Pure assembly — every predicate above, applied to already-fetched rows.
// Exported so ObjectCountService.test.ts can pin the rules with plain
// fixtures, no database required.
// ---------------------------------------------------------------------------

function sumRows<T extends { readonly count: string }>(
  rows: readonly T[],
  matches: (row: T) => boolean,
): number {
  let total = 0;

  for (const row of rows) {
    if (matches(row)) {
      total += Number(row.count);
    }
  }

  return total;
}

export function assembleObjectCounts(raw: RawObjectCountData): ObjectCountEntry[] {
  const entries: ObjectCountEntry[] = [];
  const add = (importer: string, label: string, count: number) => {
    // A `GROUP BY` never emits a row for zero matches, so `count` is already
    // > 0 whenever a rule found anything — this guard only protects against a
    // rule (like the Posts union) that summed two zero legs into a real zero.
    if (count > 0) {
      entries.push({ importer, label, count });
    }
  };

  // --- ci.communications: Mail / Messages / Conversations ------------------
  // No `communication_type` filter for any of the three: gmail's rare
  // HumanCorrespondence receipt-email is stored with `communication_type =
  // 'chat'` (COMMUNICATION_TYPE_BY_KIND has no 'commerce.receipt' entry), and
  // filtering it out would silently undercount Mail by excluding a row that
  // IS mail. Messages sources emit both 'chat' and 'call' under one label by
  // the same logic, and the four AI sources only ever emit 'chat' anyway.
  for (const importer of MAIL_IMPORTERS) {
    add(
      importer,
      LABEL_MAIL,
      sumRows(raw.communications, (row) => row.source_system === importer),
    );
  }

  for (const importer of MESSAGE_IMPORTERS) {
    add(
      importer,
      LABEL_MESSAGES,
      sumRows(raw.communications, (row) => row.source_system === importer),
    );
  }

  for (const importer of AI_IMPORTERS) {
    add(
      importer,
      LABEL_CONVERSATIONS,
      sumRows(raw.communications, (row) => row.source_system === importer),
    );
  }

  // --- Posts: per-source dispatch, see POST_RULES's docblock ---------------
  for (const rule of POST_RULES) {
    let count = 0;

    if (rule.eventType != null) {
      count += sumRows(
        raw.events,
        (row) => row.source_system === rule.importer && row.event_type === rule.eventType,
      );
    }

    if (rule.communicationType != null) {
      count += sumRows(
        raw.communications,
        (row) => row.source_system === rule.importer && row.communication_type === rule.communicationType,
      );
    }

    add(rule.importer, LABEL_POSTS, count);
  }

  // --- ci.events: Calendar / Places / Health / Trips / Listening -----------
  for (const importer of CALENDAR_IMPORTERS) {
    add(
      importer,
      LABEL_CALENDAR,
      sumRows(raw.events, (row) => row.source_system === importer && row.event_type === 'event'),
    );
  }

  // Places, leg 1: google_maps_places is COMPLETE in ci.events — every visit
  // lands here whether or not it has coordinates. See RAW_GPS_IMPORTERS'
  // docblock for why its leg 2 (ci.position) is deliberately never added.
  add(
    'google_maps_places',
    LABEL_PLACES,
    sumRows(
      raw.events,
      (row) =>
        row.source_system === 'google_maps_places' &&
        row.event_type === 'place' &&
        row.category === 'location',
    ),
  );

  for (const importer of HEALTH_IMPORTERS) {
    add(
      importer,
      LABEL_HEALTH,
      sumRows(
        raw.events,
        (row) =>
          row.source_system === importer && (row.category === 'fitness' || row.category === 'wearable'),
      ),
    );
  }

  for (const importer of TRIP_IMPORTERS) {
    add(
      importer,
      LABEL_TRIPS,
      sumRows(raw.events, (row) => row.source_system === importer && row.category === 'travel'),
    );
  }

  for (const importer of AUDIO_IMPORTERS) {
    add(
      importer,
      LABEL_LISTENING,
      sumRows(raw.events, (row) => row.source_system === importer && row.event_type === 'listen'),
    );
  }

  // --- ci.position: Places, leg 2 (raw GPS tracks) --------------------------
  for (const importer of RAW_GPS_IMPORTERS) {
    add(
      importer,
      LABEL_PLACES,
      sumRows(raw.position, (row) => row.source_system === importer),
    );
  }

  // --- ci.content: Photos / Videos / Watch history / Bookmarks / Books /
  //     Notes & pages / Repositories ----------------------------------------
  // Photos/Videos are computed for every source_system the content table
  // actually has media rows for, not just the photos/social categories —
  // harmless for a source whose tile never renders that label (the frontend
  // only looks up labels an item's own `objects` declares), and it is what
  // lets a social importer's incidental photo/video rows (facebook, instagram)
  // get a correct count without a second, category-specific rule.
  const contentSources = new Set(
    raw.content.map((row) => row.source_system).filter((s): s is string => s != null),
  );

  for (const importer of contentSources) {
    add(
      importer,
      LABEL_PHOTOS,
      sumRows(
        raw.content,
        (row) =>
          row.source_system === importer &&
          row.type === 'media' &&
          (row.mimetype?.startsWith('image/') ?? false),
      ),
    );
    add(
      importer,
      LABEL_VIDEOS,
      sumRows(
        raw.content,
        (row) =>
          row.source_system === importer &&
          row.type === 'media' &&
          (row.mimetype?.startsWith('video/') ?? false),
      ),
    );
  }

  for (const importer of VIDEO_IMPORTERS) {
    add(
      importer,
      LABEL_WATCH_HISTORY,
      sumRows(raw.content, (row) => row.source_system === importer && row.type === 'media'),
    );
  }

  for (const importer of BROWSER_IMPORTERS) {
    add(
      importer,
      LABEL_BOOKMARKS,
      sumRows(raw.content, (row) => row.source_system === importer && row.type === 'bookmark'),
    );
  }

  for (const importer of READING_IMPORTERS) {
    const wantedType = READING_MEDIA_STYLE_IMPORTERS.has(importer) ? 'media' : 'annotation';

    add(
      importer,
      LABEL_BOOKS,
      sumRows(raw.content, (row) => row.source_system === importer && row.type === wantedType),
    );
  }

  for (const importer of PRODUCTIVITY_IMPORTERS) {
    add(
      importer,
      LABEL_NOTES,
      sumRows(raw.content, (row) => row.source_system === importer && row.type === 'note'),
    );
  }

  for (const importer of CODE_IMPORTERS) {
    add(
      importer,
      LABEL_REPOSITORIES,
      sumRows(raw.content, (row) => row.source_system === importer && row.type === 'post'),
    );
  }

  // --- ci.browser_activity: Browsing ----------------------------------------
  for (const importer of BROWSER_IMPORTERS) {
    add(
      importer,
      LABEL_BROWSING,
      sumRows(raw.browserActivity, (row) => row.source_system === importer),
    );
  }

  // --- ci.receipts: Orders & payments ---------------------------------------
  for (const importer of FINANCE_IMPORTERS) {
    add(
      importer,
      LABEL_ORDERS,
      sumRows(raw.receipts, (row) => row.source_system === importer),
    );
  }

  // --- ci.entities: Contacts --------------------------------------------------
  add('contact_list', LABEL_CONTACTS, raw.contacts);

  return entries;
}
