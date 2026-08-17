import { UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { type FindOptionsOrder } from 'typeorm';

import { Context, type RequestContext, type UserServiceContext, toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { BrowserActivityEntity, BrowserActivityService } from '@ci/domains/browser-activity';
import { EntityResolutionService, type ResolvedEntity } from '@ci/domains/entity-resolution';
import { FileService, SavedSearchService, resolveSavedSearchDateRange } from '@ci/domains/files';
import { AnswerService } from '@ci/domains/intelligence';
import {
  CommunicationService,
  ConceptService,
  ContentService,
  EventService,
  EventEntity,
  CommunicationEntity,
  ItemService,
  PersonService,
  PlaceService,
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
import { NoteType } from '../types/NoteType';
import { PersonType } from '../types/PersonType';
import { PlaceType } from '../types/PlaceType';
import { SearchInput } from '../types/SearchInput';
import { SearchResultConnection } from '../types/SearchResultConnection';
import { type SearchResult } from '../types/SearchResultType';
import { TagType } from '../types/TagType';
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
 * by its 2026 createdAt. That epoch then travelled back as `afterTime` and
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
    private readonly eventService: EventService,
    private readonly fileService: FileService,
    private readonly fileChunkService: FileChunkService,
    private readonly itemService: ItemService,
    private readonly noteService: NoteService,
    private readonly personService: PersonService,
    private readonly placeService: PlaceService,
    private readonly answerService: AnswerService,
    private readonly savedSearchService: SavedSearchService,
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

      return this.runSharedSearch(input);
    }

    return this.executeSearch(toServiceContext(context), input, { matchTags: true });
  }

  /**
   * Run a shared saved search as its owner. The viewer cannot influence which
   * data is returned beyond paging/sort — the query, entity-type and tag filters
   * are taken verbatim from the stored saved search, so a leaked token can only
   * ever surface exactly what the owner chose to share. Unknown/revoked tokens
   * yield an empty result rather than an error so the viewer can show a tidy
   * "link expired" state.
   */
  private async runSharedSearch(input: SearchInput): Promise<SearchResultConnection> {
    const saved = await this.savedSearchService.findByShareToken(input.shareToken ?? '');

    if (saved == null || saved.userId == null) {
      return { edges: [], pageInfo: EMPTY_PAGE_INFO, totalCount: 0, matchingTags: [] };
    }

    // All filter values come from the owner's stored saved search (never the
    // viewer's input), so the full who/where/when/how/sort/semantic set is safe
    // to apply — it can only ever surface what the owner shared.
    const filters = saved.filters ?? {};
    const dateRange = resolveSavedSearchDateRange(filters);

    return this.executeSearch(
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
        // Viewer paging carries over; sort prefers the viewer's choice, falling
        // back to the owner's saved sort.
        sortBy: input.sortBy ?? filters.sortBy,
        sortOrder: input.sortOrder ?? filters.sortOrder,
        first: input.first,
        after: input.after,
      },
    );
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

    // LifeScope-parity event-scoped dimensions (who / where / connector). When
    // any is set the result is restricted to matching events (these dimensions
    // only exist on the event timeline).
    const connectors = input.connectors && input.connectors.length > 0 ? input.connectors : undefined;
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
      connectors != null || people != null || places != null || hasLocation != null || bbox != null
        ? { connectors, people, places, hasLocation, bbox }
        : undefined;

    // No filter signal at all -> fall back to recent timed entities (preserves prior behavior).
    const noInputs = query == null && tags == null && !hasTypes && !hasDate && eventFilter == null;

    // Build a candidate identifier set from the strongest available signal, then AND the
    // remaining filter dimensions on as post-filters so all filters combine (LifeScope parity).
    let candidateSource: 'query' | 'tags' | 'timed';
    let identifiers: EntityIdentifier<IndexableEntity | TaggableEntity>[];

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
      identifiers = await this.searchByTimedEntities(serviceContext, {
        includeTypes: input.includeTypes,
        excludeTypes: input.excludeTypes,
        includeFiles: input.includeFiles === true,
        startTime,
        // With no filters at all, bound to "now" so we return recent items, not the entire history.
        endTime: keyset
          ? (endTime ?? (noInputs ? new Date() : undefined))
          : (afterCursor?.time ?? endTime ?? (noInputs ? new Date() : undefined)),
        afterTime: keyset ? afterCursor!.time : undefined,
        afterId: keyset ? afterCursor!.id! : undefined,
        // "How" filter — pushed down to the event query for the timed path.
        eventTypes,
        // who / where / connector — pushed down to the event query. When set, the
        // timed path is restricted to events (the only type carrying these dims).
        eventFilter,
        // Over-fetch per type so the merged page holds the globally newest `first` rows.
        limit: first * FETCH_MULTIPLIER,
      });
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

    // who / where / connector (when not the timed path, which pushes these down
    // to SQL): restrict the candidate set to events matching the structured
    // predicates. Non-event candidates drop out — these dimensions are
    // event-only — matching the behaviour of selecting a person/place/source.
    if (eventFilter != null && candidateSource !== 'timed') {
      const allowedEvents = await this.eventService.getEntitiesForEvents(serviceContext, {
        ...eventFilter,
        startTime,
        endTime,
        eventTypes,
        order: { startTime: 'DESC' },
        limit: 5000,
      });
      const allowedIds = new Set(allowedEvents.map((event) => event.id));

      identifiers = identifiers.filter(
        (identifier) => identifier.type === 'event' && allowedIds.has(identifier.id),
      );
    }

    let entries = await this.resolveToEntries(serviceContext, identifiers);

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

    const { slice, pageInfo, totalCount } = Paginator.paginate(ordered, {
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
      totalCount,
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
      eventFilter?: {
        connectors?: string[];
        people?: string[];
        places?: string[];
        hasLocation?: boolean;
        bbox?: number[];
      };
      limit?: number;
    },
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    // who / where / connector are event-only dimensions; restrict to events when set.
    const eventsOnly = eventFilter != null;
    // Document chunks stay opt-in — a file's many same-timestamp chunks would bury
    // the default browse. Files themselves are part of the default timeline.
    const optIn = (type: IndexableEntity) => {
      if (type === 'file-chunk') {
        return includeTypes?.includes(type) ?? false;
      }

      return true;
    };

    const wants = (type: IndexableEntity) =>
      this.matchesTypeFilter(type, includeTypes, excludeTypes) &&
      (!eventsOnly || type === 'event') &&
      optIn(type) &&
      (type !== 'file' || includeFiles !== false);

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
    } = {
      limit,
      order: { time: 'DESC' },
    };

    const communicationOptions: {
      limit: number;
      order: FindOptionsOrder<CommunicationEntity>;
      startTime?: Date;
      endTime?: Date;
      afterTime?: Date;
      afterId?: string;
    } = {
      limit,
      order: { time: 'DESC' },
    };

    // Files and document chunks order by created_at (their only timestamp) and
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

    // Types ordered by their row timestamp (created_at, or answered_at for
    // answers). They take the same keyset cursor as the timeline types above —
    // omitting it made every page re-run the identical top-N query, so paging
    // dead-ended after `first * FETCH_MULTIPLIER` rows no matter how many rows
    // existed (the Paginator could only slice within that one fetched window).
    const createdAtOptions = {
      limit,
      order: 'DESC' as const,
      ...(startTime ? { startTime } : {}),
      ...(endTime ? { endTime } : {}),
      ...(afterTime && afterId ? { afterTime, afterId } : {}),
    };

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
      wants('note') ? this.noteService.getEntitiesForNotes(context, createdAtOptions) : [],
      wants('content') ? this.contentService.getEntitiesForContents(context, createdAtOptions) : [],
      wants('person') ? this.personService.getEntitiesForPeople(context, createdAtOptions) : [],
      wants('place') ? this.placeService.getEntitiesForPlaces(context, createdAtOptions) : [],
      wants('item') ? this.itemService.getEntitiesForItems(context, createdAtOptions) : [],
      wants('concept') ? this.conceptService.getEntitiesForConcepts(context, createdAtOptions) : [],
      wants('answer') ? this.answerService.getEntitiesForAnswers(context, createdAtOptions) : [],
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
      ...conceptResults,
      ...answerResults,
    ];
  }

  /** Resolves raw identifiers to full entities, preserving candidate order and dropping misses. */
  private async resolveToEntries(
    context: UserServiceContext,
    identifiers: EntityIdentifier<IndexableEntity | TaggableEntity>[],
  ): Promise<ResolvedEntity[]> {
    const resolved = await this.entityResolutionService.resolve(context, identifiers);

    return identifiers
      .map((identifier) => resolved.get(`${identifier.type}:${identifier.id}`) ?? null)
      .filter((entry): entry is ResolvedEntity => entry != null);
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
   * (start_time, time, created_at, answered_at) must be readable here, or that
   * type's keyset window will not line up with its position in the merged page.
   */
  private static getEntityTimestamp(entry: ResolvedEntity): Date | null {
    // File chunks carry a { chunk, file } join; read the chunk's own fields.
    const entity = (entry.type === 'file-chunk' ? entry.entity.chunk : entry.entity) as Record<
      string,
      unknown
    >;
    // Files/chunks/content have no domain time/startTime — fall back to the row
    // timestamp so they interleave into the browse by upload time rather than
    // sinking to the epoch.
    const value = entity.time ?? entity.startTime ?? entity.createdAt ?? entity.answeredAt ?? null;

    if (value instanceof Date) {
      return value;
    }

    if (typeof value === 'string') {
      const date = new Date(value);

      return Number.isNaN(date.getTime()) ? null : date;
    }

    return null;
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
      case 'thread':
        return ThreadType.toType(resolved.entity);
    }
  }
}
