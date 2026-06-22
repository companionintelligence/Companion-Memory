import { UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { type FindOptionsOrder } from 'typeorm';

import { Context, type RequestContext, type UserServiceContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { BrowserActivityEntity, BrowserActivityService } from '@ci/domains/browser-activity';
import { EntityResolutionService, type ResolvedEntity } from '@ci/domains/entity-resolution';
import { CommunicationService, EventService, EventEntity, CommunicationEntity } from '@ci/domains/memory';
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
import { FileType } from '../types/FileType';
import { ItemType } from '../types/ItemType';
import { NoteType } from '../types/NoteType';
import { PersonType } from '../types/PersonType';
import { PlaceType } from '../types/PlaceType';
import { SearchInput } from '../types/SearchInput';
import { SearchResultConnection } from '../types/SearchResultConnection';
import { type SearchResult } from '../types/SearchResultType';
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

/** The time a result is ordered by (events use startTime, others use time). */
function timeOf(result: SearchResult): Date {
  if ('time' in result && result.time) {
    return new Date(result.time as string | Date);
  }

  if ('startTime' in result && result.startTime) {
    return new Date(result.startTime as string | Date);
  }

  return new Date(0);
}

/** Opaque, time-ordered cursor: base64(`<iso-time>::<id>`). */
function searchCursorOf(result: SearchResult): string {
  return Buffer.from(`${timeOf(result).toISOString()}::${result.id}`).toString('base64');
}

/** Decode a cursor back to the timestamp used to window the next DB page. */
function decodeSearchCursor(cursor?: string | null): { time: Date } | null {
  if (!cursor) {
    return null;
  }

  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const separator = decoded.indexOf('::');
    const iso = separator >= 0 ? decoded.slice(0, separator) : decoded;
    const time = new Date(iso);

    return Number.isNaN(time.getTime()) ? null : { time };
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
    private readonly entityResolutionService: EntityResolutionService,
    private readonly eventService: EventService,
    private readonly searchService: SearchService,
    private readonly tagService: TagService,
  ) {}

  @Query(() => SearchResultConnection)
  async search(
    @Context() context: RequestContext,
    @Args('input') input: SearchInput,
  ): Promise<SearchResultConnection> {
    const serviceContext = toServiceContext(context);

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
      identifiers = await this.searchByTimedEntities(serviceContext, {
        includeTypes: input.includeTypes,
        excludeTypes: input.excludeTypes,
        startTime,
        // Page backward through time: each page ends at the cursor's timestamp
        // (inclusive), so the cursor row is re-fetched and Paginator slices past it.
        // With no filters at all, bound to "now" so we return recent items, not the entire history.
        endTime: afterCursor?.time ?? endTime ?? (noInputs ? new Date() : undefined),
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
    const results = sorted.map((entry) => this.toSearchResult(entry));

    const { slice, pageInfo, totalCount } = Paginator.paginate(results, {
      getId: searchCursorOf,
      first,
      after: input.after ?? undefined,
    });

    const edges = slice.map((result) => ({
      node: result,
      cursor: searchCursorOf(result),
    }));

    return {
      edges,
      pageInfo,
      totalCount,
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
      startTime,
      endTime,
      eventTypes,
      eventFilter,
      limit = 25,
    }: {
      includeTypes?: IndexableEntity[];
      excludeTypes?: IndexableEntity[];
      startTime?: Date;
      endTime?: Date;
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
    const wants = (type: IndexableEntity) =>
      this.matchesTypeFilter(type, includeTypes, excludeTypes) && (!eventsOnly || type === 'event');

    const eventOptions: {
      limit: number;
      order: FindOptionsOrder<EventEntity>;
      startTime?: Date;
      endTime?: Date;
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
    } = {
      limit,
      order: { time: 'DESC' },
    };

    const communicationOptions: {
      limit: number;
      order: FindOptionsOrder<CommunicationEntity>;
      startTime?: Date;
      endTime?: Date;
    } = {
      limit,
      order: { time: 'DESC' },
    };

    if (startTime) {
      eventOptions.startTime = startTime;
      browserActivityOptions.startTime = startTime;
      communicationOptions.startTime = startTime;
    }

    if (endTime) {
      eventOptions.endTime = endTime;
      browserActivityOptions.endTime = endTime;
      communicationOptions.endTime = endTime;
    }

    const [eventResults, browserActivityResults, communicationResults] = await Promise.all([
      wants('event') ? this.eventService.getEntitiesForEvents(context, eventOptions) : [],
      wants('browser-activity')
        ? this.browserActivityService.getEntitiesForBrowserActivities(context, browserActivityOptions)
        : [],
      wants('communication')
        ? this.communicationService.getEntitiesForCommunications(context, communicationOptions)
        : [],
    ]);

    return [...eventResults, ...browserActivityResults, ...communicationResults];
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

      return direction * (aTime - bTime);
    });
  }

  private static getEntityTimestamp(entry: ResolvedEntity): Date | null {
    const entity = entry.entity as Record<string, unknown>;
    const value = entity.time ?? entity.startTime ?? null;

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
