import { UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, type UserServiceContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { BrowserActivityService } from '@ci/domains/browser-activity';
import { EntityResolutionService, type ResolvedEntity } from '@ci/domains/entity-resolution';
import { FileService } from '@ci/domains/files';
import {
  CommunicationService,
  ConceptService,
  ContentService,
  EventService,
  ItemService,
  PersonService,
  PlaceService,
} from '@ci/domains/memory';
import { NoteService } from '@ci/domains/notes';
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
import { SearchInput, SearchSortBy, SearchSortOrder } from '../types/SearchInput';
import { SearchResultConnection } from '../types/SearchResultConnection';
import { type SearchResult } from '../types/SearchResultType';
import { ThreadType } from '../types/ThreadType';
import { Paginator } from '../utils/Paginator';

/**
 * Entity types shown in the default explorer feed (no search term). Excludes
 * `answer` and `thread`, which only surface via explicit text/tag search.
 * Previously the empty-query path returned only event/communication/
 * browser-activity, leaving Map (places/geo) and Gallery (files/content) empty.
 */
export const EXPLORER_FEED_TYPES: IndexableEntity[] = [
  'event',
  'communication',
  'browser-activity',
  'place',
  'content',
  'person',
  'item',
  'concept',
  'note',
  'file',
];

/**
 * Whether an entity type should be included given include/exclude filters.
 * includeTypes (when non-empty) is an allow-list; otherwise excludeTypes (when
 * non-empty) is a deny-list; with neither set, all types pass.
 */
export function isExplorerTypeEnabled(
  type: IndexableEntity,
  includeTypes?: IndexableEntity[],
  excludeTypes?: IndexableEntity[],
): boolean {
  if (includeTypes && includeTypes.length > 0) {
    return includeTypes.includes(type);
  }

  if (excludeTypes && excludeTypes.length > 0) {
    return !excludeTypes.includes(type);
  }

  return true;
}

/**
 * Best-available timestamp (epoch ms) for sorting a heterogeneous result set.
 * Prefers an event/activity time, then entity creation/update time. Returns 0
 * when none is present so timestamp-less entities sort last (DESC).
 */
export function resultTimestamp(result: unknown): number {
  if (result == null || typeof result !== 'object') {
    return 0;
  }

  const record = result as Record<string, unknown>;

  for (const key of ['time', 'startTime', 'createdAt', 'updatedAt'] as const) {
    const value = record[key];

    if (value) {
      const date = value instanceof Date ? value : new Date(value as string);

      if (!Number.isNaN(date.getTime())) {
        return date.getTime();
      }
    }
  }

  return 0;
}

/** Best-available display name for a result, for NAME sorting. */
export function resultName(result: unknown): string {
  if (result == null || typeof result !== 'object') {
    return '';
  }

  const record = result as Record<string, unknown>;

  for (const key of ['name', 'title', 'filename'] as const) {
    const value = record[key];

    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }

  return '';
}

/**
 * Whether a result falls within an optional [start, end] window, judged by its
 * best-available timestamp. Results with no timestamp are excluded when a
 * window is requested.
 */
export function resultWithinRange(result: unknown, start?: Date, end?: Date): boolean {
  if (!start && !end) {
    return true;
  }

  const time = resultTimestamp(result);

  if (time === 0) {
    return false;
  }

  if (start && time < start.getTime()) {
    return false;
  }

  if (end && time > end.getTime()) {
    return false;
  }

  return true;
}

/**
 * Sort a heterogeneous result set. RELEVANCE preserves the incoming order
 * (text-search scoring / recency); TIME and NAME re-sort by the chosen key and
 * direction, with name-less entities always last.
 */
export function sortSearchResults<T>(results: T[], sortBy: SearchSortBy, sortOrder: SearchSortOrder): T[] {
  if (sortBy === SearchSortBy.RELEVANCE) {
    return results;
  }

  const direction = sortOrder === SearchSortOrder.ASC ? 1 : -1;

  if (sortBy === SearchSortBy.NAME) {
    return [...results].sort((a, b) => {
      const an = resultName(a);
      const bn = resultName(b);

      if (!an && !bn) {
        return 0;
      }

      if (!an) {
        return 1;
      }

      if (!bn) {
        return -1;
      }

      return an.localeCompare(bn, undefined, { sensitivity: 'base' }) * direction;
    });
  }

  return [...results].sort((a, b) => (resultTimestamp(a) - resultTimestamp(b)) * direction);
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
    private readonly itemService: ItemService,
    private readonly noteService: NoteService,
    private readonly personService: PersonService,
    private readonly placeService: PlaceService,
    private readonly searchService: SearchService,
    private readonly tagService: TagService,
  ) {}

  @Query(() => SearchResultConnection)
  async search(
    @Context() context: RequestContext,
    @Args('input') input: SearchInput,
  ): Promise<SearchResultConnection> {
    const serviceContext = toServiceContext(context);

    const query = input.query ?? '';
    const tags = input.tags ?? [];
    const hasQuery = query.length > 0;
    const hasTags = tags.length > 0;
    const limit = input.limit ?? 25;
    const startTime = input.startTime ? new Date(input.startTime) : undefined;
    const endTime = input.endTime ? new Date(input.endTime) : undefined;

    let results: SearchResult[];

    if (hasQuery && hasTags) {
      // Advanced search: text query intersected with tagged entities (the old
      // LifeScope advanced/saved-search combined text + tags + types + date).
      const queryIds = await this.queryIdentifiers(serviceContext, {
        query,
        includeTypes: input.includeTypes,
        excludeTypes: input.excludeTypes,
        limit,
      });
      const tagged = await this.tagService.getEntitiesForTags(serviceContext, tags);
      const taggedKeys = new Set(tagged.map((entity) => `${entity.type}:${entity.id}`));

      results = await this.resolveEntities(
        serviceContext,
        queryIds.filter((entity) => taggedKeys.has(`${entity.type}:${entity.id}`)),
      );
    } else if (hasTags) {
      results = await this.searchByTags(serviceContext, tags);
    } else if (hasQuery) {
      results = await this.searchByQuery(serviceContext, {
        query,
        includeTypes: input.includeTypes,
        excludeTypes: input.excludeTypes,
        limit,
      });
    } else {
      results = await this.searchRecentEntities(serviceContext, {
        includeTypes: input.includeTypes,
        excludeTypes: input.excludeTypes,
        startTime,
        endTime,
        limit,
      });
    }

    // The recent path applies the time window at the DB; the query/tag paths
    // post-filter here so "text/tags + date range" works consistently.
    if ((hasQuery || hasTags) && (startTime || endTime)) {
      results = results.filter((result) => resultWithinRange(result, startTime, endTime));
    }

    const sortBy = input.sortBy ?? (hasQuery ? SearchSortBy.RELEVANCE : SearchSortBy.TIME);
    const sortOrder =
      input.sortOrder ?? (sortBy === SearchSortBy.NAME ? SearchSortOrder.ASC : SearchSortOrder.DESC);
    const sorted = sortSearchResults(results, sortBy, sortOrder);

    const { slice, pageInfo, totalCount } = Paginator.paginate(sorted, {
      getId: (result) => result.id,
    });

    const edges = slice.map((result) => ({
      node: result,
      cursor: result.id,
    }));

    return {
      edges,
      pageInfo,
      totalCount,
    };
  }

  private async queryIdentifiers(
    context: UserServiceContext,
    {
      query,
      includeTypes,
      excludeTypes,
      limit,
    }: {
      query: string;
      includeTypes?: IndexableEntity[];
      excludeTypes?: IndexableEntity[];
      limit?: number;
    },
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    const options = {
      query,
      maxResults: limit ?? 25,
    };
    if (excludeTypes && excludeTypes.length > 0) {
      Object.assign(options, { excludeTypes });
    } else if (includeTypes && includeTypes.length > 0) {
      Object.assign(options, { includeTypes });
    }

    return this.searchService.search(context, options);
  }

  private async searchByQuery(
    context: UserServiceContext,
    args: {
      query: string;
      includeTypes?: IndexableEntity[];
      excludeTypes?: IndexableEntity[];
      limit?: number;
    },
  ): Promise<SearchResult[]> {
    return this.resolveEntities(context, await this.queryIdentifiers(context, args));
  }

  private async searchByTags(context: UserServiceContext, tags: string[]): Promise<SearchResult[]> {
    if (tags.length === 0) {
      return [];
    }

    const tagResults = await this.tagService.getEntitiesForTags(context, tags);

    return this.resolveEntities(context, tagResults);
  }

  /**
   * Default explorer feed: the most-recent entities across every indexable
   * type the explorer renders (answer/thread are intentionally excluded — they
   * only surface via explicit text/tag search). Honors includeTypes/excludeTypes
   * and an optional time range, then sorts the merged set by best-available
   * timestamp (DESC).
   *
   * This populates the Map / List / Gallery / Timeline views when no search
   * term is present. Previously only event/communication/browser-activity were
   * returned, which left Map (places/geo) and Gallery (files/content) empty.
   */
  private async searchRecentEntities(
    context: UserServiceContext,
    {
      includeTypes,
      excludeTypes,
      startTime,
      endTime,
      limit,
    }: {
      includeTypes?: IndexableEntity[];
      excludeTypes?: IndexableEntity[];
      startTime?: Date;
      endTime?: Date;
      limit?: number;
    },
  ): Promise<SearchResult[]> {
    const PER_TYPE_LIMIT = limit ?? 25;
    const range = { startTime, endTime };

    const fetchers: Partial<Record<IndexableEntity, () => Promise<EntityIdentifier<IndexableEntity>[]>>> = {
      event: () =>
        this.eventService.getEntitiesForEvents(context, {
          limit: PER_TYPE_LIMIT,
          order: { startTime: 'DESC' },
          ...range,
        }),
      communication: () =>
        this.communicationService.getEntitiesForCommunications(context, {
          limit: PER_TYPE_LIMIT,
          order: { time: 'DESC' },
          ...range,
        }),
      'browser-activity': () =>
        this.browserActivityService.getEntitiesForBrowserActivities(context, {
          limit: PER_TYPE_LIMIT,
          order: { time: 'DESC' },
          ...range,
        }),
      place: () => this.placeService.getEntitiesForPlaces(context, { limit: PER_TYPE_LIMIT, ...range }),
      content: () => this.contentService.getEntitiesForContents(context, { limit: PER_TYPE_LIMIT, ...range }),
      person: () => this.personService.getEntitiesForPeople(context, { limit: PER_TYPE_LIMIT, ...range }),
      item: () => this.itemService.getEntitiesForItems(context, { limit: PER_TYPE_LIMIT, ...range }),
      concept: () => this.conceptService.getEntitiesForConcepts(context, { limit: PER_TYPE_LIMIT, ...range }),
      note: () => this.noteService.getEntitiesForNotes(context, { limit: PER_TYPE_LIMIT, ...range }),
      file: () => this.fileService.getEntitiesForFiles(context, { limit: PER_TYPE_LIMIT, ...range }),
    };

    const enabled = EXPLORER_FEED_TYPES.filter(
      (type) => fetchers[type] != null && isExplorerTypeEnabled(type, includeTypes, excludeTypes),
    ).map((type) => fetchers[type]!());

    const identifiers = (await Promise.all(enabled)).flat();

    const entities = await this.resolveEntities(context, identifiers);

    return entities.sort((a, b) => resultTimestamp(b) - resultTimestamp(a));
  }

  private async resolveEntities(
    context: UserServiceContext,
    results: EntityIdentifier<IndexableEntity | TaggableEntity>[],
  ): Promise<SearchResult[]> {
    const resolved = await this.entityResolutionService.resolve(context, results);

    return results
      .map((result) => {
        const entry = resolved.get(`${result.type}:${result.id}`);

        if (!entry) {
          return null;
        }

        return this.toSearchResult(entry);
      })
      .filter((r): r is SearchResult => r != null);
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
