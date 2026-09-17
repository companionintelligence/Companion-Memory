import { UseGuards } from '@nestjs/common';
import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { type FindOptionsOrder } from 'typeorm';

import { Context, type RequestContext, type UserServiceContext, toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { SHARE_DISCLOSURE, SharedSearchConsentService, applySearchCeiling } from '@ci/domains/asks';
import { BrowserActivityEntity, BrowserActivityService } from '@ci/domains/browser-activity';
import { EntityResolutionService, type ResolvedEntity } from '@ci/domains/entity-resolution';
import { FileService, SavedSearchService, resolveSavedSearchDateRange } from '@ci/domains/files';
import { AnswerService } from '@ci/domains/intelligence';
import {
  CommunicationService,
  ConceptService,
  ContentService,
  CalendarEventService,
  EventEntity,
  CommunicationEntity,
  ItemService,
  PersonService,
  PlaceService,
  ProductModelService,
  ReceiptService,
} from '@ci/domains/memory';
import { NoteService } from '@ci/domains/notes';
import { FileChunkService } from '@ci/domains/parsing';
import {
  SearchService,
  TagService,
  type EntityIdentifier,
  type IndexableEntity,
  type TaggableEntity,
} from '@ci/domains/search-next';

import { ActionType } from '../types/ActionType';
import { AnswerType } from '../types/AnswerType';
import { BrowserActivityType } from '../types/BrowserActivityType';
import { CommunicationType } from '../types/CommunicationType';
import { ConceptType } from '../types/ConceptType';
import { ContentType } from '../types/ContentType';
import { EventType } from '../types/EventType';
import { FileChunkType } from '../types/FileChunkType';
import { FileType } from '../types/FileType';
import { GlobalUID } from '../types/GlobalUID';
import { ItemType } from '../types/ItemType';
import { MapPinsType } from '../types/MapPinType';
import { NoteType } from '../types/NoteType';
import { PersonType } from '../types/PersonType';
import { PlaceType } from '../types/PlaceType';
import { ProductModelType } from '../types/ProductModelType';
import { ReceiptType } from '../types/ReceiptType';
import { SearchInput } from '../types/SearchInput';
import { SearchResultConnection } from '../types/SearchResultConnection';
import { type SearchResult } from '../types/SearchResultType';
import { TagType } from '../types/TagType';
import { TaskType } from '../types/TaskType';
import { ThreadType } from '../types/ThreadType';
import { Paginator } from '../utils/Paginator';

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
// Over-fetch per type so the merged page is guaranteed to contain the globally
// newest `first` rows even when one type dominates a time window (a single type
// can contribute at most `first` of them, so any multiplier >= 1 is correct;
// the margin also absorbs same-timestamp boundary ties).
const FETCH_MULTIPLIER = 4;
// Candidate pool for the ranked query path. Unlike the timed path (true cursor
// paging pushed down to SQL), the query path is paged in-memory: the Paginator
// slices this ranked list against the time::id cursor, so the pool must hold
// enough rows to (a) span several client pages and (b) survive the tags/date/
// event post-filters that shrink it further. Must stay >= a full client page so
// a single page is never truncated — the old 25 cap fell short of the 30-row
// client page, capping plain-text search and disabling load-more.
const QUERY_CANDIDATE_LIMIT = 300;
/**
 * Pin caps for the map read (`mapPins`).
 *
 * The map is capped by row count rather than paged: it draws a whole located
 * set at once, and a pin is ~150 bytes on the wire against a hydrated search
 * node's several kilobytes. Ten thousand covers a full personal library
 * (measured: 11,297 located events on the QA appliance) in one ~630ms read; the
 * hard ceiling keeps a pathological library from serialising unbounded.
 * Truncation is reported (`MapPinsType.truncated`) rather than hidden.
 */
const MAP_PIN_DEFAULT_LIMIT = 10_000;
const MAP_PIN_MAX_LIMIT = 20_000;

/**
 * Types the unfiltered timed browse leaves OUT unless the caller names them in
 * `includeTypes`.
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 * The browse is a CHRONOLOGY. Every type it merges is ordered by whatever
 * timestamp it has, and for these types that timestamp is `updated_at` — the
 * row's last-WRITE time (equal to `created_at` until something changes it),
 * not the time the thing happened. A bulk import writes the whole corpus at
 * once, so every one of these rows is stamped "now" and lands ahead of the
 * entire real timeline. Measured on the QA appliance, rows sitting
 * ahead of the newest genuinely-dated memory (2026-08-18 18:41:33Z) in the
 * unfiltered browse:
 *
 *   content (media, event-linked)  11,211   gated (see below)
 *   file                           10,521   NOT gated — see the NOTE
 *   person                          9,753   gated here
 *   place                           1,178   gated here
 *   concept / item                      0   gated here
 *   content (everything else)           3   not gated (has nowhere else to go)
 *
 * — the undated import artifacts a user had to scroll past before reaching
 * their first real memory, which is what made the timeline unreachable rather
 * than merely untidy. `person`, `place`, `concept` and `item` are gated here.
 * The event-linked content rows leave by a different door (they are facets of
 * events the same merge already returns — see
 * ContentService.getEntitiesForContents). Together that takes the head from
 * 32,666 rows to 10,524, all but 3 of which are files.
 *
 * A person, place, concept or item is not a moment: it is a thing moments refer
 * to, and it has no domain time at all. It belongs on the timeline only when
 * the user asks for it, exactly like `file-chunk` (which was already opt-in for
 * the same reason: a file's many same-timestamp chunks buried the feed).
 *
 * They stay fully reachable — by naming the type, by searching, by tag, and
 * through the graph/explorer. Only the *unfiltered chronological browse* drops
 * them.
 *
 * NOTE `file` is deliberately NOT in this list. It carries the same row-write
 * problem, but #2110 just made it an explicit opt-OUT (`includeFiles`) to fix
 * the File type picker, and that decision is left standing — see
 * {@link SearchResolver.browseWants}. Files are therefore the residual undated
 * head this gate does not address.
 */
const BROWSE_OPT_IN_TYPES: ReadonlySet<IndexableEntity> = new Set([
  'file-chunk',
  'person',
  'place',
  'concept',
  'item',
  // A catalog model is not a moment at all: `ci.product_models` has only row
  // stamps, so a product on the chronology is an import artifact wearing a
  // date, exactly like `person` and `place` above.
  'product',
  // A receipt IS a moment — `purchased_at` is when the purchase happened, and
  // the browse orders by it (see ReceiptService.getEntitiesForReceipts). It is
  // still opt-in because that column is NULLABLE: an OCR backlog is mostly
  // undated, falls back to `updated_at`, and would land the whole backlog at
  // import time ahead of the real timeline — the head this gate exists to keep
  // clear.
  'receipt',
]);

/**
 * The result types whose rows carry a `source_system` column, and so can be
 * narrowed by the How filter (`connectors`). Mirrors SOURCED_BROWSE_TABLES in
 * SourceSystemService, which is where the picker's option list comes from —
 * a source offered there must be filterable here, on the same set of kinds.
 * Files, notes, people, places, concepts, answers and document chunks have no
 * such column; while a source is selected they are left unfetched (timed
 * path) or dropped (query / tags path).
 */
const SOURCED_TYPES: ReadonlySet<IndexableEntity> = new Set<IndexableEntity>([
  'event',
  'communication',
  'content',
  'browser-activity',
  'receipt',
  'product',
  'item',
]);

/**
 * The kinds whose rows link to Person entities, and so can be narrowed by the
 * Who filter (`people`): an event through its participants / organizer, a
 * communication through its sender / recipients (`from_entity_id` /
 * `to_entity_ids`). Every other kind sets itself aside while Who is set, the
 * way SOURCED_TYPES works for How.
 */
const PEOPLE_LINKED_TYPES: ReadonlySet<IndexableEntity> = new Set<IndexableEntity>([
  'event',
  'communication',
]);

/** The structured event-side predicates: Who (shared with communications) and the Where family (event-only). */
interface EventFilter {
  people?: string[];
  places?: string[];
  hasLocation?: boolean;
  bbox?: number[];
}

/** Where / located-only / map viewport: only events carry a place, so these pin the browse to events. */
function isPlaceScoped(filter: EventFilter): boolean {
  return filter.places != null || filter.hasLocation != null || filter.bbox != null;
}

/**
 * The message directions the Who toggle can ask for. `ci.communication_direction`
 * also holds internal / async / ongoing, which no toggle names; anything else
 * on the input is ignored rather than matched. Beside a Who pattern the
 * direction also fixes the person's role (CommunicationService.applyPeopleFilter):
 * inbound is *from* them, outbound is *to* them.
 */
const MESSAGE_DIRECTIONS: ReadonlySet<string> = new Set(['inbound', 'outbound']);

function messageDirection(value: string | undefined): string | undefined {
  return value != null && MESSAGE_DIRECTIONS.has(value) ? value : undefined;
}

/**
 * Entity ids behind a page of search results, for the disclosure audit.
 *
 * `node` is a GraphQL union (`SearchResultType`) whose members all carry an
 * `id`, but the union itself declares none — so this reads defensively rather
 * than casting to a member type. An edge with no readable id is dropped instead
 * of audited as `undefined`: a wrong id in a disclosure record is worse than a
 * missing one, and the count that sits beside it comes from the same array.
 */
function searchResultIds(edges: readonly { node: unknown }[]): string[] {
  return edges
    .map((edge) => (edge.node as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** PageInfo for an empty connection (e.g. an unknown/revoked share token). */
const EMPTY_PAGE_INFO = {
  hasNextPage: false,
  hasPreviousPage: false,
  startCursor: null,
  endCursor: null,
};

/**
 * A result paired with the exact timestamp {@link SearchResolver.sortEntries}
 * ordered it by.
 *
 * The cursor is minted from `sortTime` rather than re-derived from the GraphQL
 * result, because the two are not the same thing: the sort reads the *domain
 * entity* (getEntityTimestamp), while a GraphQL type only exposes the fields it
 * declares. ContentType/PersonType/PlaceType/ConceptType declare no time field
 * at all, so re-deriving produced an epoch cursor for a row the sort had placed
 * by its 2026 updatedAt. That epoch then travelled back as `afterTime` and
 * windowed every sibling type's query to "before 1970", emptying the browse.
 * Carrying the sort key forward makes the two identical by construction.
 */
interface OrderedResult {
  result: SearchResult;
  sortTime: Date;
}

/** Opaque, time-ordered cursor: base64(`<iso-time>::<id>`). */
function searchCursorOf({ result, sortTime }: OrderedResult): string {
  return Buffer.from(`${sortTime.toISOString()}::${result.id}`).toString('base64');
}

/**
 * Decode a cursor back to the (time, id) keyset used to window the next DB page.
 * The id portion is the result's GlobalUID (`type:uuid`, base64); we decode it to
 * the raw uuid so the timed path can break same-timestamp ties on the underlying
 * primary key. Ids are uuidv7 (time-ordered) so a single raw-uuid tiebreak is a
 * consistent total order across the merged entity types. `id` is null when the
 * cursor predates this format or its GlobalUID can't be decoded — callers then
 * fall back to the legacy time-only window.
 */
function decodeSearchCursor(cursor?: string | null): { time: Date; id: string | null } | null {
  if (!cursor) {
    return null;
  }

  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const separator = decoded.indexOf('::');
    const iso = separator >= 0 ? decoded.slice(0, separator) : decoded;
    const globalId = separator >= 0 ? decoded.slice(separator + 2) : '';
    const time = new Date(iso);

    if (Number.isNaN(time.getTime())) {
      return null;
    }

    let id: string | null = null;
    if (globalId) {
      try {
        id = GlobalUID.decode(globalId).id;
      } catch {
        id = null;
      }
    }

    return { time, id };
  } catch {
    return null;
  }
}

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver()
export class SearchResolver {
  constructor(
    private readonly browserActivityService: BrowserActivityService,
    private readonly communicationService: CommunicationService,
    private readonly conceptService: ConceptService,
    private readonly contentService: ContentService,
    private readonly entityResolutionService: EntityResolutionService,
    private readonly eventService: CalendarEventService,
    private readonly fileService: FileService,
    private readonly fileChunkService: FileChunkService,
    private readonly itemService: ItemService,
    private readonly noteService: NoteService,
    private readonly personService: PersonService,
    private readonly placeService: PlaceService,
    private readonly productModelService: ProductModelService,
    private readonly receiptService: ReceiptService,
    private readonly answerService: AnswerService,
    private readonly savedSearchService: SavedSearchService,
    private readonly sharedSearchConsentService: SharedSearchConsentService,
    private readonly searchService: SearchService,
    private readonly tagService: TagService,
    private readonly featureService: FeatureService,
  ) {}

  @Query(() => SearchResultConnection)
  async search(
    @Context() context: RequestContext,
    @Args('input') input: SearchInput,
  ): Promise<SearchResultConnection> {
    // Shared-search path: a signed-in viewer presents a capability token; the
    // search is resolved from the owner's public saved search and run as the
    // owner, ignoring all viewer-supplied filters (only pagination/sort carry
    // over). The guard above still requires the viewer to be authenticated.
    //
    // Gated behind the 'shared.search' feature flag: while the access model is
    // being hardened the shared-URL surface stays dark. When disabled a token
    // resolves to an empty result — identical to an unknown/revoked token — so
    // the viewer falls into the tidy "link unavailable" state rather than an error.
    if (input.shareToken != null && input.shareToken.length > 0) {
      if (!(await this.featureService.isFeatureEnabled('shared.search'))) {
        return { edges: [], pageInfo: EMPTY_PAGE_INFO, totalCount: 0, matchingTags: [] };
      }

      return this.runSharedSearch(toServiceContext(context), input);
    }

    return this.executeSearch(toServiceContext(context), input, { matchTags: true });
  }

  /**
   * Every located event for the current filters, as map markers.
   *
   * The map used to render the explorer's `search` feed, whose page size is 30
   * for every view: plotting a library of ten thousand located events took some
   * three hundred and fifty presses of "Load more pins", and each press
   * hydrated thirty full nodes to draw thirty dots. A map is not a feed — it
   * shows a whole set at once, and the client clusters it — so this query
   * returns the whole located set in one bounded read, projected down to a
   * point and a label ({@link MapPinType}).
   *
   * Filter parity with `search` is deliberate and is why this lives on the
   * search resolver rather than growing its own filter language:
   *   - who / where / connector / when / activity go straight down to SQL
   *     through the same {@link CalendarEventService} filters the timed search path uses;
   *   - a free-text query and tags are resolved by the same search/tag services
   *     `search` uses, then intersected in SQL via the `ids` filter.
   * `hasLocation` is forced on regardless of input — an unlocated event has no
   * pin — and the result is events-only, exactly as `?view=map` already was.
   *
   * `totalCount` is a real COUNT(*) of the matching located set, so a truncated
   * response can say how much of the map it is showing instead of quietly
   * drawing a partial world.
   */
  @Query(() => MapPinsType, {
    description:
      'Located events as map markers for the given filters. Events-only and located-only; ' +
      'returns the whole matching set in one read (capped at ' +
      `${MAP_PIN_MAX_LIMIT} pins), not a page.`,
  })
  async mapPins(
    @Context() context: RequestContext,
    @Args('input') input: SearchInput,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<MapPinsType> {
    // Shared saved searches stay on the `search` feed: their result set is the
    // owner's, resolved through runSharedSearch, and this query resolves the
    // caller's own memories. Returning nothing here keeps the two from being
    // silently crossed — the read-only viewer never calls it.
    if (input.shareToken != null && input.shareToken.length > 0) {
      return { pins: [], totalCount: 0, truncated: false };
    }

    const serviceContext = toServiceContext(context);
    const pinLimit = Math.min(Math.max(limit ?? MAP_PIN_DEFAULT_LIMIT, 1), MAP_PIN_MAX_LIMIT);

    // The map plots events. An entity-type filter that excludes them (e.g. the
    // explorer narrowed to People) empties the map — the same outcome the
    // events-only `search` path produces, surfaced without a round trip.
    if (!this.matchesTypeFilter('event', input.includeTypes, input.excludeTypes)) {
      return { pins: [], totalCount: 0, truncated: false };
    }

    const query = input.query != null && input.query.length > 0 ? input.query : undefined;
    const tags = input.tags && input.tags.length > 0 ? input.tags : undefined;

    // Free text and tags are candidate sets, not SQL predicates: resolve them
    // with the same services `search` uses, then hand the surviving event ids to
    // the SQL filter so both halves AND together (LifeScope parity).
    let ids: string[] | undefined;

    if (query != null) {
      const identifiers = await this.searchByQuery(serviceContext, {
        query,
        includeTypes: input.includeTypes,
        excludeTypes: input.excludeTypes,
        semantic: input.semantic === true,
        maxResults: Math.max(pinLimit, QUERY_CANDIDATE_LIMIT),
      });

      ids = identifiers.filter((identifier) => identifier.type === 'event').map(({ id }) => id);
    }

    if (tags != null) {
      const tagged = await this.searchByTags(serviceContext, tags);
      const taggedEventIds = new Set(
        tagged.filter((identifier) => identifier.type === 'event').map(({ id }) => id),
      );

      ids = ids == null ? [...taggedEventIds] : ids.filter((id) => taggedEventIds.has(id));
    }

    const filters = {
      startTime: input.startTime ? new Date(input.startTime) : undefined,
      endTime: input.endTime ? new Date(input.endTime) : undefined,
      eventTypes: input.eventTypes && input.eventTypes.length > 0 ? input.eventTypes : undefined,
      connectors: input.connectors && input.connectors.length > 0 ? input.connectors : undefined,
      people: input.people && input.people.length > 0 ? input.people : undefined,
      places: input.places && input.places.length > 0 ? input.places : undefined,
      bbox:
        input.bbox && input.bbox.length === 4 && input.bbox.every((value) => Number.isFinite(value))
          ? input.bbox
          : undefined,
      // Forced: a pin is a coordinate. See MapPinsType / findMapPins.
      hasLocation: true,
      ids,
    };

    const [pins, totalCount] = await Promise.all([
      this.eventService.findMapPins(serviceContext, { ...filters, limit: pinLimit }),
      this.eventService.countEntitiesForEvents(serviceContext, filters),
    ]);

    return {
      pins: pins.map((pin) => ({ ...pin, id: GlobalUID.encode('event', pin.id) })),
      totalCount,
      truncated: pins.length < totalCount,
    };
  }

  /**
   * Run a shared saved search as its owner, under the reader's standing grant.
   *
   * The viewer cannot influence which data is returned beyond paging/sort — the
   * query, entity-type and tag filters are taken verbatim from the stored saved
   * search, so a leaked token can only ever surface exactly what the owner chose
   * to share.
   *
   * ═══ THE TOKEN IS NO LONGER THE WHOLE AUTHORIZATION ═══
   *
   * It used to be: holding the string got you the owner's full result set,
   * forever, anonymously, and unrecorded. The token is now the INVITATION, and
   * {@link SharedSearchConsentService.authorize} exchanges it for a
   * `ci.ask_grants` row naming THIS reader — which is what makes a ceiling, an
   * expiry, a per-reader revocation and a Disclosure History entry expressible
   * at all. See that service for why each of those was impossible before.
   *
   * FOUR OUTCOMES, ONE RESPONSE. An unknown token, a revoked link, a lapsed
   * link, and a reader the owner specifically revoked all return the same empty
   * connection. The viewer gets the same tidy "link unavailable" state for all
   * four, which is the `PEER_ASK_PENDING` rule applied here: which of the four
   * it was is a fact about the owner's posture, and a refused reader does not
   * need it in order to be refused.
   */
  private async runSharedSearch(
    context: UserServiceContext,
    input: SearchInput,
  ): Promise<SearchResultConnection> {
    const saved = await this.savedSearchService.findByShareToken(input.shareToken ?? '');

    if (saved == null || saved.userId == null) {
      return { edges: [], pageInfo: EMPTY_PAGE_INFO, totalCount: 0, matchingTags: [] };
    }

    const authorization = await this.sharedSearchConsentService.authorize({
      ownerUserId: saved.userId,
      viewerUserId: context.userId,
      savedSearchId: saved.id,
      declaredCeiling: saved.shareMaxDisclosure,
      shareExpiresAt: saved.shareExpiresAt,
    });

    if (authorization == null) {
      return { edges: [], pageInfo: EMPTY_PAGE_INFO, totalCount: 0, matchingTags: [] };
    }

    // All filter values come from the owner's stored saved search (never the
    // viewer's input), so the full who/where/when/how/sort/semantic set is safe
    // to apply — it can only ever surface what the owner shared.
    const filters = saved.filters ?? {};
    const dateRange = resolveSavedSearchDateRange(filters);

    // A ceiling whose `paging` axis is false must never let the viewer walk
    // past their first window — `applySearchCeiling` only seals `pageInfo` on
    // the RESPONSE, so a viewer-supplied `after` cursor has to be dropped
    // BEFORE it reaches executeSearch, or a reader who already knows a valid
    // cursor (e.g. from page 1) can page straight through a `redacted` grant.
    // `undefined` reads the same as it does in `applySearchCeiling`: no
    // ceiling from this source (the owner previewing their own share) means
    // no restriction.
    const canPage = authorization.ceiling == null || SHARE_DISCLOSURE[authorization.ceiling].paging;

    const unclamped = await this.executeSearch(
      { userId: saved.userId },
      {
        query: saved.query ?? undefined,
        includeTypes: saved.entityTypes ?? undefined,
        tags: saved.tags ?? undefined,
        eventTypes: filters.eventTypes,
        startTime: dateRange.startTime,
        endTime: dateRange.endTime,
        connectors: filters.connectors,
        people: filters.people,
        places: filters.places,
        hasLocation: filters.hasLocation,
        semantic: filters.semantic,
        direction: filters.direction,
        // Viewer paging carries over only when the ceiling permits it; sort
        // prefers the viewer's choice, falling back to the owner's saved sort.
        sortBy: input.sortBy ?? filters.sortBy,
        sortOrder: input.sortOrder ?? filters.sortOrder,
        first: input.first,
        after: canPage ? input.after : undefined,
      },
    );

    const disclosed = applySearchCeiling(unclamped, authorization.ceiling);

    // Written AFTER the clamp and from BOTH sets, because they answer different
    // questions: `disclosedEntities` is what crossed to the reader, and
    // `backingEntities` is what the owner's box read to produce it. Auditing the
    // pre-clamp set as "disclosed" is the exact disagreement
    // 20260820224500_add_ask_audit_backing_entities was written to end.
    await this.sharedSearchConsentService.recordRead({
      ownerUserId: saved.userId,
      viewerUserId: context.userId,
      savedSearchId: saved.id,
      savedSearchName: saved.name,
      grantId: authorization.grantId,
      disclosedEntityIds: searchResultIds(disclosed.edges),
      backingEntityIds: searchResultIds(unclamped.edges),
    });

    return disclosed;
  }

  private async executeSearch(
    serviceContext: UserServiceContext,
    input: SearchInput,
    { matchTags = false }: { matchTags?: boolean } = {},
  ): Promise<SearchResultConnection> {
    const query = input.query != null && input.query.length > 0 ? input.query : undefined;
    const tags = input.tags && input.tags.length > 0 ? input.tags : undefined;
    const eventTypes = input.eventTypes && input.eventTypes.length > 0 ? input.eventTypes : undefined;
    const hasTypes =
      (input.includeTypes != null && input.includeTypes.length > 0) ||
      (input.excludeTypes != null && input.excludeTypes.length > 0);
    const startTime = input.startTime ? new Date(input.startTime) : undefined;
    const endTime = input.endTime ? new Date(input.endTime) : undefined;
    const hasDate = startTime != null || endTime != null;

    // "How" — the source a row came from. Not event-scoped: every browsed
    // table with a source_system column applies it (see SOURCED_TYPES), and
    // the kinds without one drop out while it is set.
    const connectors = input.connectors && input.connectors.length > 0 ? input.connectors : undefined;
    // LifeScope-parity event-scoped dimensions (who / where). When any is set
    // the result is restricted to matching events (these dimensions only
    // exist on the event timeline).
    const people = input.people && input.people.length > 0 ? input.people : undefined;
    const places = input.places && input.places.length > 0 ? input.places : undefined;
    const hasLocation = input.hasLocation === true ? true : undefined;
    // Map "Search this area" viewport box [minLon, minLat, maxLon, maxLat]; ignored
    // unless it carries exactly four finite numbers.
    const bbox =
      input.bbox && input.bbox.length === 4 && input.bbox.every((value) => Number.isFinite(value))
        ? input.bbox
        : undefined;
    const eventFilter =
      people != null || places != null || hasLocation != null || bbox != null
        ? { people, places, hasLocation, bbox }
        : undefined;
    // Sent / received: a dimension only messages carry, so like the Where
    // family it pins the browse — to communications (see browseWants).
    const direction = messageDirection(input.direction);

    // No filter signal at all -> fall back to recent timed entities (preserves prior behavior).
    const noInputs =
      query == null &&
      tags == null &&
      !hasTypes &&
      !hasDate &&
      eventFilter == null &&
      connectors == null &&
      direction == null;

    // Build a candidate identifier set from the strongest available signal, then AND the
    // remaining filter dimensions on as post-filters so all filters combine (LifeScope parity).
    let candidateSource: 'query' | 'tags' | 'timed';
    let identifiers: EntityIdentifier<IndexableEntity | TaggableEntity>[];
    // Real total for the 'timed' candidate source, computed alongside `identifiers` below —
    // see the branch's comment and `countTimedEntities` for why this can't just be
    // `identifiers.length` (or the Paginator's derived totalCount from it).
    let timedTotalCount: number | undefined;

    const first = Math.min(Math.max(input.first ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const afterCursor = decodeSearchCursor(input.after);

    if (query != null) {
      candidateSource = 'query';
      identifiers = await this.searchByQuery(serviceContext, {
        query,
        includeTypes: input.includeTypes,
        excludeTypes: input.excludeTypes,
        // Force conceptual ranking when the caller asked for semantic search.
        semantic: input.semantic === true,
        // Always fetch a deep candidate pool so the in-memory Paginator can page
        // past the first client window (>= `first` guarantees a full page).
        maxResults: Math.max(first, QUERY_CANDIDATE_LIMIT),
      });
    } else if (tags != null) {
      candidateSource = 'tags';
      identifiers = await this.searchByTags(serviceContext, tags);
    } else {
      candidateSource = 'timed';
      // Prefer a precise (time, id) keyset cursor: it pages strictly *past* the
      // cursor row, so a same-timestamp cluster larger than the over-fetch window
      // no longer dead-ends pagination (the old time-only window kept re-fetching
      // the same top-N rows). Fall back to the legacy inclusive-endTime window when
      // the cursor lacks a decodable id (older cursors).
      const keyset = afterCursor?.time != null && afterCursor.id != null;
      // With no filters at all, bound to "now" so we return recent items, not the entire
      // history. This is the *filter's* upper bound — stable across pages — as opposed to
      // the legacy `afterCursor?.time` window fallback below, which is a pagination artifact
      // of a stale (id-less) cursor. `countTimedEntities` must use this one, not that one:
      // the total a viewer sees must not shift depending on which page they're looking at.
      const resolvedEndTime = endTime ?? (noInputs ? new Date() : undefined);
      const timedOptions = {
        includeTypes: input.includeTypes,
        excludeTypes: input.excludeTypes,
        // Files ride the default browse; only an explicit `false` drops them.
        includeFiles: input.includeFiles !== false,
        startTime,
        eventTypes,
        eventFilter,
        connectors,
        direction,
      };

      [identifiers, timedTotalCount] = await Promise.all([
        this.searchByTimedEntities(serviceContext, {
          ...timedOptions,
          endTime: keyset ? resolvedEndTime : (afterCursor?.time ?? resolvedEndTime),
          afterTime: keyset ? afterCursor!.time : undefined,
          afterId: keyset ? afterCursor!.id! : undefined,
          // Over-fetch per type so the merged page holds the globally newest `first` rows.
          limit: first * FETCH_MULTIPLIER,
        }),
        this.countTimedEntities(serviceContext, { ...timedOptions, endTime: resolvedEndTime }),
      ]);
    }

    // Entity-type filter: the query/timed paths apply it at their source; apply to the tags path.
    if (hasTypes && candidateSource === 'tags') {
      identifiers = identifiers.filter((identifier) =>
        this.matchesTypeFilter(identifier.type, input.includeTypes, input.excludeTypes),
      );
    }

    // Tag filter (when tags weren't the candidate source): intersect by raw type:id.
    if (tags != null && candidateSource !== 'tags') {
      const tagged = await this.tagService.getEntitiesForTags(serviceContext, tags);
      const taggedKeys = new Set(tagged.map((entity) => `${entity.type}:${entity.id}`));

      identifiers = identifiers.filter((identifier) => taggedKeys.has(`${identifier.type}:${identifier.id}`));
    }

    // who / where / direction (when not the timed path, which pushes these
    // down to SQL): restrict the candidate set to the rows matching the
    // structured predicates. Where is event-only and direction is
    // message-only, so each pins the survivors to its kind; Who alone keeps
    // events *and* communications (PEOPLE_LINKED_TYPES), each matched by its
    // own service. Every other kind drops out — it has no link to a person and
    // no direction, so it could never match.
    if ((eventFilter != null || direction != null) && candidateSource !== 'timed') {
      const pinnedToEvents = eventFilter != null && isPlaceScoped(eventFilter);
      const pinnedToMessages = direction != null;
      const [allowedEvents, allowedCommunications] = await Promise.all([
        eventFilter != null && !pinnedToMessages
          ? this.eventService.getEntitiesForEvents(serviceContext, {
              ...eventFilter,
              startTime,
              endTime,
              eventTypes,
              order: { startTime: 'DESC' },
              limit: 5000,
            })
          : [],
        !pinnedToEvents && (eventFilter?.people != null || pinnedToMessages)
          ? this.communicationService.getEntitiesForCommunications(serviceContext, {
              people: eventFilter?.people,
              direction,
              startTime,
              endTime,
              order: { time: 'DESC' },
              limit: 5000,
            })
          : [],
      ]);
      const allowedKeys = new Set(
        [...allowedEvents, ...allowedCommunications].map(
          (identifier) => `${identifier.type}:${identifier.id}`,
        ),
      );

      identifiers = identifiers.filter((identifier) =>
        allowedKeys.has(`${identifier.type}:${identifier.id}`),
      );
    }

    let entries = await this.resolveToEntries(serviceContext, identifiers);

    // How (when not the timed path, which pushes it down to SQL): keep the
    // entries whose row came from one of the named sources. A kind with no
    // source column cannot match and drops out, exactly as the timed path
    // leaves it unfetched (see browseWants).
    if (connectors != null && candidateSource !== 'timed') {
      const allowed = new Set(connectors);

      entries = entries.filter((entry) => {
        const source = SearchResolver.getEntitySourceSystem(entry);

        return source != null && allowed.has(source);
      });
    }

    // Date filter (when date wasn't the candidate source — the timed path filters in SQL).
    // Entities without a domain timestamp are dropped while a date filter is active.
    if (hasDate && candidateSource !== 'timed') {
      entries = entries.filter((entry) => {
        const timestamp = SearchResolver.getEntityTimestamp(entry);

        if (timestamp == null) {
          return false;
        }

        if (startTime && timestamp < startTime) {
          return false;
        }

        if (endTime && timestamp > endTime) {
          return false;
        }

        return true;
      });
    }

    // "How" filter (when not the timed path, which pushes it down to SQL): narrow event entries
    // to the requested event types; every other entity type passes through untouched.
    if (eventTypes != null && candidateSource !== 'timed') {
      const allowed = new Set(eventTypes);

      entries = entries.filter((entry) => {
        if (entry.type !== 'event') {
          return true;
        }

        const eventType = (entry.entity as { eventType?: string | null }).eventType;

        return eventType != null && allowed.has(eventType);
      });
    }

    const sorted = this.sortEntries(entries, input.sortBy, input.sortOrder, candidateSource);
    // Carry each entry's sort key alongside its GraphQL result so the cursor is
    // minted from the very value the sort used. `?? new Date(0)` mirrors
    // sortEntries' own `?? 0` fallback for entries with no domain timestamp.
    const ordered: OrderedResult[] = sorted.map((entry) => ({
      result: this.toSearchResult(entry),
      sortTime: SearchResolver.getEntityTimestamp(entry) ?? new Date(0),
    }));

    const {
      slice,
      pageInfo,
      totalCount: candidateCount,
    } = Paginator.paginate(ordered, {
      getId: searchCursorOf,
      first,
      after: input.after ?? undefined,
    });

    const edges = slice.map((item) => ({
      node: item.result,
      cursor: searchCursorOf(item),
    }));

    // Tag suggestions ride alongside the entity results (the header search box
    // renders them as draggable filter rows). Shared searches never opt in — a
    // share token must not let the viewer probe the owner's tag vocabulary.
    const matchingTags =
      matchTags && query != null ? await this.tagService.searchByLabel(serviceContext, query) : [];

    return {
      edges,
      pageInfo,
      // For the 'timed' source, `timedTotalCount` is a real per-type `COUNT(*)`
      // (see `countTimedEntities`) — not `candidateCount`, which is only the size
      // of the `first * FETCH_MULTIPLIER`-bounded window fetched for this one page.
      // Using the window size here previously made `totalCount` scale with page
      // size instead of reflecting how many results actually exist (confirmed live:
      // first=10/30/100 -> totalCount=293/853/2813 against a true total in the
      // hundreds of thousands — see the SearchResolver.totalCount tests).
      totalCount: timedTotalCount ?? candidateCount,
      matchingTags: matchingTags.map((tag) => TagType.toType(tag)),
    };
  }

  private async searchByQuery(
    context: UserServiceContext,
    {
      query,
      includeTypes,
      excludeTypes,
      semantic,
      maxResults,
    }: {
      query: string;
      includeTypes?: IndexableEntity[];
      excludeTypes?: IndexableEntity[];
      semantic?: boolean;
      maxResults?: number;
    },
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    const options = {
      query,
      maxResults: maxResults ?? 25,
    };
    // Conceptual ranking on request; otherwise SearchService picks a mode by heuristic.
    if (semantic) {
      Object.assign(options, { mode: 'semantic' });
    }

    if (excludeTypes && excludeTypes.length > 0) {
      Object.assign(options, { excludeTypes });
    } else if (includeTypes && includeTypes.length > 0) {
      Object.assign(options, { includeTypes });
    }

    // Already ranked by relevance; identifiers carry a score we discard (order preserves rank).
    return this.searchService.search(context, options);
  }

  private async searchByTags(
    context: UserServiceContext,
    tags: string[],
  ): Promise<EntityIdentifier<TaggableEntity>[]> {
    if (tags.length === 0) {
      return [];
    }

    return this.tagService.getEntitiesForTags(context, tags);
  }

  private async searchByTimedEntities(
    context: UserServiceContext,
    {
      includeTypes,
      excludeTypes,
      includeFiles,
      startTime,
      endTime,
      afterTime,
      afterId,
      eventTypes,
      eventFilter,
      connectors,
      direction,
      limit = 25,
    }: {
      includeTypes?: IndexableEntity[];
      excludeTypes?: IndexableEntity[];
      /** Opt files into the browse alongside the other types (see SearchInput.includeFiles). */
      includeFiles?: boolean;
      startTime?: Date;
      endTime?: Date;
      // Composite keyset cursor: page strictly past (afterTime, afterId) in
      // (time DESC, id DESC) order. Threaded down to each type's SQL query.
      afterTime?: Date;
      afterId?: string;
      eventTypes?: string[];
      eventFilter?: EventFilter;
      /** The How filter — applied to every sourced type, see SOURCED_TYPES. */
      connectors?: string[];
      /** Sent / received — communications only, see browseWants. */
      direction?: string;
      limit?: number;
    },
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    const wants = (type: IndexableEntity) =>
      this.browseWants(type, {
        includeTypes,
        excludeTypes,
        includeFiles,
        eventFilter,
        connectors,
        direction,
      });

    const eventOptions: {
      limit: number;
      order: FindOptionsOrder<EventEntity>;
      startTime?: Date;
      endTime?: Date;
      afterTime?: Date;
      afterId?: string;
      eventTypes?: string[];
      connectors?: string[];
      people?: string[];
      places?: string[];
      hasLocation?: boolean;
      bbox?: number[];
    } = {
      limit,
      order: { startTime: 'DESC' },
      ...(eventFilter ?? {}),
      ...(connectors ? { connectors } : {}),
    };

    if (eventTypes && eventTypes.length > 0) {
      eventOptions.eventTypes = eventTypes;
    }

    const browserActivityOptions: {
      limit: number;
      order: FindOptionsOrder<BrowserActivityEntity>;
      startTime?: Date;
      endTime?: Date;
      afterTime?: Date;
      afterId?: string;
      connectors?: string[];
    } = {
      limit,
      order: { time: 'DESC' },
      ...(connectors ? { connectors } : {}),
    };

    // Who reaches communications too (their sender / recipients link to people);
    // the Where family does not, and browseWants leaves them unfetched under it.
    const communicationOptions: {
      limit: number;
      order: FindOptionsOrder<CommunicationEntity>;
      startTime?: Date;
      endTime?: Date;
      afterTime?: Date;
      afterId?: string;
      connectors?: string[];
      people?: string[];
      direction?: string;
    } = {
      limit,
      order: { time: 'DESC' },
      ...(connectors ? { connectors } : {}),
      ...(eventFilter?.people ? { people: eventFilter.people } : {}),
      ...(direction ? { direction } : {}),
    };

    // Files and document chunks order by updated_at (their only timestamp) and
    // take a plain 'DESC' rather than the FindOptionsOrder shape the memory
    // services use — see their getEntitiesFor* signatures.
    const fileOptions: {
      limit: number;
      order: 'ASC' | 'DESC';
      startTime?: Date;
      endTime?: Date;
      afterTime?: Date;
      afterId?: string;
    } = {
      limit,
      order: 'DESC',
    };

    const fileChunkOptions: {
      limit: number;
      order: 'ASC' | 'DESC';
      startTime?: Date;
      endTime?: Date;
      afterTime?: Date;
      afterId?: string;
    } = {
      limit,
      order: 'DESC',
    };

    if (startTime) {
      eventOptions.startTime = startTime;
      browserActivityOptions.startTime = startTime;
      communicationOptions.startTime = startTime;
      fileOptions.startTime = startTime;
      fileChunkOptions.startTime = startTime;
    }

    if (endTime) {
      eventOptions.endTime = endTime;
      browserActivityOptions.endTime = endTime;
      communicationOptions.endTime = endTime;
      fileOptions.endTime = endTime;
      fileChunkOptions.endTime = endTime;
    }

    if (afterTime && afterId) {
      eventOptions.afterTime = afterTime;
      eventOptions.afterId = afterId;
      browserActivityOptions.afterTime = afterTime;
      browserActivityOptions.afterId = afterId;
      communicationOptions.afterTime = afterTime;
      communicationOptions.afterId = afterId;
      fileOptions.afterTime = afterTime;
      fileOptions.afterId = afterId;
      fileChunkOptions.afterTime = afterTime;
      fileChunkOptions.afterId = afterId;
    }

    // Types ordered by their row timestamp (updated_at — the last write, which
    // is the insert until something changes the row — or answered_at for
    // answers). They take the same keyset cursor as the timeline types above —
    // omitting it made every page re-run the identical top-N query, so paging
    // dead-ended after `first * FETCH_MULTIPLIER` rows no matter how many rows
    // existed (the Paginator could only slice within that one fetched window).
    const rowTimeOptions = {
      limit,
      order: 'DESC' as const,
      ...(startTime ? { startTime } : {}),
      ...(endTime ? { endTime } : {}),
      ...(afterTime && afterId ? { afterTime, afterId } : {}),
    };
    // The same, plus the How filter, for the row-stamped kinds that carry a
    // source_system column (content, things, products, receipts).
    const sourcedRowTimeOptions = { ...rowTimeOptions, ...(connectors ? { connectors } : {}) };

    const [
      eventResults,
      browserActivityResults,
      communicationResults,
      fileResults,
      fileChunkResults,
      noteResults,
      contentResults,
      personResults,
      placeResults,
      itemResults,
      productResults,
      receiptResults,
      conceptResults,
      answerResults,
    ] = await Promise.all([
      wants('event') ? this.eventService.getEntitiesForEvents(context, eventOptions) : [],
      wants('browser-activity')
        ? this.browserActivityService.getEntitiesForBrowserActivities(context, browserActivityOptions)
        : [],
      wants('communication')
        ? this.communicationService.getEntitiesForCommunications(context, communicationOptions)
        : [],
      wants('file') ? this.fileService.getEntitiesForFiles(context, fileOptions) : [],
      wants('file-chunk') ? this.fileChunkService.getEntitiesForFileChunks(context, fileChunkOptions) : [],
      wants('note') ? this.noteService.getEntitiesForNotes(context, rowTimeOptions) : [],
      // Event-linked content is a facet of an event the same merge already
      // returns — see ContentService.getEntitiesForContents.
      wants('content')
        ? this.contentService.getEntitiesForContents(context, {
            ...sourcedRowTimeOptions,
            excludeEventLinked: true,
          })
        : [],
      wants('person') ? this.personService.getEntitiesForPeople(context, rowTimeOptions) : [],
      wants('place') ? this.placeService.getEntitiesForPlaces(context, rowTimeOptions) : [],
      wants('item') ? this.itemService.getEntitiesForItems(context, sourcedRowTimeOptions) : [],
      wants('product') ? this.productModelService.getEntitiesForProducts(context, sourcedRowTimeOptions) : [],
      // Receipts order by COALESCE(purchased_at, updated_at) rather than the row
      // timestamp the other opt-in types use — the only one of them with a real
      // domain time. Same keyset shape, different column; see
      // ReceiptService.getEntitiesForReceipts and getEntityTimestamp, which reads
      // `purchasedAt ?? updatedAt` so the cursor it mints matches this order.
      wants('receipt') ? this.receiptService.getEntitiesForReceipts(context, sourcedRowTimeOptions) : [],
      wants('concept') ? this.conceptService.getEntitiesForConcepts(context, rowTimeOptions) : [],
      wants('answer') ? this.answerService.getEntitiesForAnswers(context, rowTimeOptions) : [],
    ]);

    return [
      ...eventResults,
      ...browserActivityResults,
      ...communicationResults,
      ...fileResults,
      ...fileChunkResults,
      ...noteResults,
      ...contentResults,
      ...personResults,
      ...placeResults,
      ...itemResults,
      ...productResults,
      ...receiptResults,
      ...conceptResults,
      ...answerResults,
    ];
  }

  /**
   * Real total for the 'timed' candidate source: sums a per-type `COUNT(*)` scoped by the
   * SAME predicates {@link searchByTimedEntities} filters by (user, date range, "how"/"who"/
   * "where"/connector), gated by the same `wants(type)` type-filter — but without that
   * method's `limit`/keyset, which are page-windowing concerns a *total* must not depend on.
   *
   * This is the fix for `totalCount` reporting the size of the `first * FETCH_MULTIPLIER`
   * over-fetched candidate window instead of how many results actually exist: that window is
   * sized off the caller's page size, so the old `Paginator.paginate(candidates).totalCount`
   * scaled with `first` (verified live: first=10/30/100 against one real "browse everything"
   * saved search returned totalCount 293/853/2813 — an almost exact 28-29x multiple of `first`
   * — against a true total in the hundreds of thousands). That search is exactly what a
   * shared saved-search link with no query/filters runs (SearchResolver.runSharedSearch), so
   * the fabricated count was shown directly to viewers on the public Shared-Search page.
   */
  private async countTimedEntities(
    context: UserServiceContext,
    {
      includeTypes,
      excludeTypes,
      includeFiles,
      startTime,
      endTime,
      eventTypes,
      eventFilter,
      connectors,
      direction,
    }: {
      includeTypes?: IndexableEntity[];
      excludeTypes?: IndexableEntity[];
      includeFiles?: boolean;
      startTime?: Date;
      endTime?: Date;
      eventTypes?: string[];
      eventFilter?: EventFilter;
      connectors?: string[];
      direction?: string;
    },
  ): Promise<number> {
    const wants = (type: IndexableEntity) =>
      this.browseWants(type, {
        includeTypes,
        excludeTypes,
        includeFiles,
        eventFilter,
        connectors,
        direction,
      });

    const dateOptions = { startTime, endTime };
    // Kinds with a source_system column count under the How filter too.
    const sourcedOptions = { ...dateOptions, ...(connectors ? { connectors } : {}) };
    const eventOptions = {
      ...sourcedOptions,
      ...(eventTypes && eventTypes.length > 0 ? { eventTypes } : {}),
      ...(eventFilter ?? {}),
    };

    const counts = await Promise.all([
      wants('event') ? this.eventService.countEntitiesForEvents(context, eventOptions) : 0,
      wants('browser-activity')
        ? this.browserActivityService.countEntitiesForBrowserActivities(context, sourcedOptions)
        : 0,
      wants('communication')
        ? this.communicationService.countEntitiesForCommunications(context, {
            ...sourcedOptions,
            ...(eventFilter?.people ? { people: eventFilter.people } : {}),
            ...(direction ? { direction } : {}),
          })
        : 0,
      wants('file') ? this.fileService.countEntitiesForFiles(context, dateOptions) : 0,
      wants('file-chunk') ? this.fileChunkService.countEntitiesForFileChunks(context, dateOptions) : 0,
      wants('note') ? this.noteService.countEntitiesForNotes(context, dateOptions) : 0,
      wants('content')
        ? this.contentService.countEntitiesForContents(context, {
            ...sourcedOptions,
            excludeEventLinked: true,
          })
        : 0,
      wants('person') ? this.personService.countEntitiesForPeople(context, dateOptions) : 0,
      wants('place') ? this.placeService.countEntitiesForPlaces(context, dateOptions) : 0,
      wants('item') ? this.itemService.countEntitiesForItems(context, sourcedOptions) : 0,
      wants('product') ? this.productModelService.countEntitiesForProducts(context, sourcedOptions) : 0,
      wants('receipt') ? this.receiptService.countEntitiesForReceipts(context, sourcedOptions) : 0,
      wants('concept') ? this.conceptService.countEntitiesForConcepts(context, dateOptions) : 0,
      wants('answer') ? this.answerService.countEntitiesForAnswers(context, dateOptions) : 0,
    ]);

    return counts.reduce((sum, count) => sum + count, 0);
  }

  /** Resolves raw identifiers to full entities, preserving candidate order and dropping misses. */
  private async resolveToEntries(
    context: UserServiceContext,
    identifiers: EntityIdentifier<IndexableEntity | TaggableEntity>[],
  ): Promise<ResolvedEntity[]> {
    const resolved = await this.entityResolutionService.resolve(context, identifiers);

    return identifiers
      .map((identifier) => {
        const entry = resolved.get(`${identifier.type}:${identifier.id}`) ?? null;
        if (entry == null) {
          return null;
        }

        // People/places date-filter by first real activity in the window. The
        // identifier carries that instant as sortTime; copy it onto the loaded
        // entity as appearedAt so getEntityTimestamp, the cursor, and the
        // GraphQL field all read the same value. Do not add a ResolveField that
        // overwrites this with first-ever — that would lose in-window time.
        if (identifier.sortTime != null && (identifier.type === 'person' || identifier.type === 'place')) {
          (entry.entity as { appearedAt?: Date }).appearedAt = identifier.sortTime;
        }

        return entry;
      })
      .filter((entry): entry is ResolvedEntity => entry != null);
  }

  /**
   * Which entity types the timed browse merges, for BOTH the identifier fetch
   * ({@link searchByTimedEntities}) and the `totalCount` ({@link countTimedEntities}).
   *
   * Shared rather than written twice because the two must agree exactly: a type
   * counted but not fetched inflates the denominator the footer renders (VIEW-08),
   * and a type fetched but not counted deflates it — and the `file` gate bug
   * below had to be fixed identically in both copies.
   *
   * Three gates, in order of how specific they are:
   *
   *  1. the caller's explicit include/exclude type filter;
   *  2. the event-only dimensions (who / where / connector / bbox / hasLocation),
   *     which exist only on the event timeline, so setting any restricts the
   *     browse to events;
   *  3. the opt-in gate — {@link BROWSE_OPT_IN_TYPES} plus `file`.
   *
   * `file` is its own case because it has a dedicated lever, `includeFiles`,
   * and #2110 deliberately made that lever an opt-OUT: files are part of the
   * default timeline and a caller drops them by passing `false`. That decision
   * is preserved verbatim here — see `SearchInput.includeFiles` for why it was
   * inverted (the File type picker was a no-op on every surface that didn't set
   * the flag). It does mean ~10,500 files, ordered by `created_at`, still sit
   * ahead of the real timeline on a freshly-imported appliance; giving
   * `ci.files` a domain timestamp (`external_created_at` is populated on 0 of
   * 14,194 rows) is the fix, and it is a schema/ETL change, not a gate.
   */
  private browseWants(
    type: IndexableEntity,
    {
      includeTypes,
      excludeTypes,
      includeFiles,
      eventFilter,
      connectors,
      direction,
    }: {
      includeTypes?: IndexableEntity[];
      excludeTypes?: IndexableEntity[];
      includeFiles?: boolean;
      eventFilter?: EventFilter;
      connectors?: string[];
      direction?: string;
    },
  ): boolean {
    if (!this.matchesTypeFilter(type, includeTypes, excludeTypes)) {
      return false;
    }

    // Sent / received exists only on messages; every other kind sets itself aside.
    if (direction != null && type !== 'communication') {
      return false;
    }

    // The Where family is event-only; Who reaches every kind that links to
    // people (events and communications). The rest cannot match either.
    if (eventFilter != null) {
      if (isPlaceScoped(eventFilter) && type !== 'event') {
        return false;
      }

      if (eventFilter.people != null && !PEOPLE_LINKED_TYPES.has(type)) {
        return false;
      }
    }

    // How applies to every kind that records a source; the rest cannot match.
    if (connectors != null && connectors.length > 0 && !SOURCED_TYPES.has(type)) {
      return false;
    }

    const namedExplicitly = includeTypes?.includes(type) ?? false;

    if (type === 'file') {
      return includeFiles !== false;
    }

    if (BROWSE_OPT_IN_TYPES.has(type)) {
      if (namedExplicitly) {
        return true;
      }

      // The web What picker writes an exclude-list of everything *else*, never
      // `includeTypes`. Person / place / thing / product / receipt have to
      // honour that remaining selection or a People-only browse is an empty
      // page (the heatmap already converted the same URL to includes).
      // `file-chunk` is not in the picker, so it never appears in those
      // exclude lists and must stay include-only — otherwise a People browse
      // would also pull every document chunk.
      if (
        type !== 'file-chunk' &&
        excludeTypes != null &&
        excludeTypes.length > 0 &&
        !excludeTypes.includes(type)
      ) {
        return true;
      }

      return false;
    }

    return true;
  }

  private matchesTypeFilter(
    type: IndexableEntity | TaggableEntity,
    includeTypes?: IndexableEntity[],
    excludeTypes?: IndexableEntity[],
  ): boolean {
    if (excludeTypes && excludeTypes.length > 0) {
      return !excludeTypes.includes(type as IndexableEntity);
    }

    if (includeTypes && includeTypes.length > 0) {
      return includeTypes.includes(type as IndexableEntity);
    }

    return true;
  }

  private sortEntries(
    entries: ResolvedEntity[],
    sortBy: string | undefined,
    sortOrder: string | undefined,
    candidateSource: 'query' | 'tags' | 'timed',
  ): ResolvedEntity[] {
    const direction = sortOrder === 'asc' ? 1 : -1;
    const effective = sortBy ?? (candidateSource === 'query' ? 'relevance' : 'time');

    if (effective === 'relevance') {
      // Candidate order already reflects search rank; reverse only for ascending.
      return direction === 1 ? [...entries].reverse() : entries;
    }

    if (effective === 'name') {
      return [...entries].sort(
        (a, b) => direction * SearchResolver.getEntityName(a).localeCompare(SearchResolver.getEntityName(b)),
      );
    }

    return [...entries].sort((a, b) => {
      const aTime = SearchResolver.getEntityTimestamp(a)?.getTime() ?? 0;
      const bTime = SearchResolver.getEntityTimestamp(b)?.getTime() ?? 0;

      if (aTime !== bTime) {
        return direction * (aTime - bTime);
      }

      // Deterministic same-timestamp tiebreak on the raw id (uuidv7 → time-ordered),
      // mirroring the SQL keyset's `id DESC` so cursor pagination through a cluster
      // of identical timestamps is stable across pages.
      const aId = String((a.entity as { id?: unknown }).id ?? '');
      const bId = String((b.entity as { id?: unknown }).id ?? '');

      return direction * aId.localeCompare(bId);
    });
  }

  /**
   * The single source of truth for "when" an entry happened: it drives both the
   * timeline sort and — via {@link OrderedResult} — the cursor minted for it, so
   * the two can never disagree. Whatever column a type is ordered by in SQL
   * (start_time, time, updated_at, answered_at) must be readable here, or that
   * type's keyset window will not line up with its position in the merged page.
   */
  private static getEntityTimestamp(entry: ResolvedEntity): Date | null {
    // File chunks carry a { chunk, file } join; read the chunk's own fields.
    const entity = (entry.type === 'file-chunk' ? entry.entity.chunk : entry.entity) as Record<
      string,
      unknown
    >;
    // Files/chunks/content have no domain time/startTime — fall back to the row
    // timestamp so they interleave into the browse by when they were last
    // written rather than sinking to the epoch. That row timestamp is
    // `updatedAt`: it equals `createdAt` until something changes the row, and
    // then the change is the more recent (and more interesting) moment. Every
    // row-stamped kind's SQL orders, windows and keyset-pages on `updated_at`
    // for the same reason, and this chain has to read the same column.
    //
    // The row-timestamp fallback CANNOT simply be dropped: it is also the cursor
    // key (see OrderedResult), and a null here becomes `new Date(0)`, which
    // travels back as `afterTime` and windows every sibling type's SQL to
    // "before 1970", emptying the browse. Row-write time is therefore kept as
    // the sort key, and the types for which it is a LIE about when the thing
    // happened are instead kept out of the unfiltered chronological browse —
    // see BROWSE_OPT_IN_TYPES. What still rides the row stamp inside the browse
    // is `note`, `file` and non-event-linked `content` — 10,524 rows ahead of
    // the timeline on the QA appliance, against 32,666 before the gate, and all
    // but 3 of them files. Giving those a real domain timestamp is a schema/ETL
    // change, not a resolver change: `ci.files.external_created_at` exists and
    // is populated on 0 of 14,194 rows.
    //
    // Types reached by NAMING them (includeTypes) still sort by write time
    // when they have no other time — except people/places with a date window,
    // which stamp `appearedAt` (first real activity in that window) so Last
    // week groups them on the day they showed up, not the import day.
    // `purchasedAt` before `updatedAt`: a receipt's purchase date is its real
    // domain time, and the browse's SQL orders by COALESCE(purchased_at,
    // updated_at) — a nullish chain in the same order, so a null purchase date
    // falls through to the write time here exactly as the COALESCE does there.
    // If the two disagreed, a receipt's cursor would not match its position and
    // paging past it would skip or repeat rows. `answeredAt` sits before the
    // row stamps because AnswerService orders by it. `updated_at` is NOT NULL
    // on every browsed table (the browse_by_updated_at_indexes migration
    // pinned the last three), so `createdAt` after it is only a guard against
    // a resolved entity shape that never mapped the column.
    const value =
      entity.appearedAt ??
      entity.time ??
      entity.startTime ??
      entity.purchasedAt ??
      entity.answeredAt ??
      entity.updatedAt ??
      entity.createdAt ??
      null;

    if (value instanceof Date) {
      return value;
    }

    if (typeof value === 'string') {
      const date = new Date(value);

      return Number.isNaN(date.getTime()) ? null : date;
    }

    return null;
  }

  /**
   * The `source_system` a resolved row came from, or null for a kind that has
   * none. Read for the query / tags path's How filter; the timed path applies
   * the same predicate in SQL. Browser activity is a plain-object entity that
   * keeps the column's snake_case name, every other kind maps it to camelCase.
   */
  private static getEntitySourceSystem(entry: ResolvedEntity): string | null {
    if (!SOURCED_TYPES.has(entry.type as IndexableEntity)) {
      return null;
    }

    const entity = entry.entity as { sourceSystem?: unknown; source_system?: unknown };
    const value = entity.sourceSystem ?? entity.source_system ?? null;

    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private static getEntityName(entry: ResolvedEntity): string {
    const entity = entry.entity as Record<string, unknown>;
    const value = entity.name ?? entity.title ?? entity.summary ?? '';

    return typeof value === 'string' ? value : '';
  }

  private toSearchResult(resolved: ResolvedEntity): SearchResult {
    switch (resolved.type) {
      case 'action':
        return ActionType.toType(resolved.entity);
      case 'answer':
        return AnswerType.toType(resolved.entity);
      case 'browser-activity':
        return BrowserActivityType.toType(resolved.entity);
      case 'communication':
        return CommunicationType.toType(resolved.entity);
      case 'concept':
        return ConceptType.toType(resolved.entity);
      case 'content':
        return ContentType.toType(resolved.entity);
      case 'event':
        return EventType.toType(resolved.entity);
      case 'file':
        return FileType.toType(resolved.entity);
      // Document chunks carry their parent file joined by EntityResolutionService.
      case 'file-chunk':
        return FileChunkType.toType(resolved.entity.chunk, resolved.entity.file);
      case 'item':
        return ItemType.toType(resolved.entity);
      case 'note':
        return NoteType.toType(resolved.entity);
      case 'person':
        return PersonType.toType(resolved.entity);
      case 'place':
        return PlaceType.toType(resolved.entity);
      case 'product':
        return ProductModelType.toType(resolved.entity);
      case 'receipt':
        return ReceiptType.toType(resolved.entity);
      case 'task':
        return TaskType.toType(resolved.entity);
      case 'thread':
        return ThreadType.toType(resolved.entity);
    }
  }
}
