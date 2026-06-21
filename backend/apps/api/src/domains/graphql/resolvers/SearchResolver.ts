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
    // No filter signal at all -> fall back to recent timed entities (preserves prior behavior).
    const noInputs = query == null && tags == null && !hasTypes && !hasDate;

    // Build a candidate identifier set from the strongest available signal, then AND the
    // remaining filter dimensions on as post-filters so all filters combine (LifeScope parity).
    let candidateSource: 'query' | 'tags' | 'timed';
    let identifiers: EntityIdentifier<IndexableEntity | TaggableEntity>[];

    if (query != null) {
      candidateSource = 'query';
      identifiers = await this.searchByQuery(serviceContext, {
        query,
        includeTypes: input.includeTypes,
        excludeTypes: input.excludeTypes,
        // Widen the candidate pool when post-filters will shrink it.
        maxResults: tags != null || hasDate || eventTypes != null ? 100 : 25,
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
        // With no filters at all, bound to "now" so we return recent items, not the entire history.
        endTime: endTime ?? (noInputs ? new Date() : undefined),
        // "How" filter — pushed down to the event query for the timed path.
        eventTypes,
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

  private async searchByQuery(
    context: UserServiceContext,
    {
      query,
      includeTypes,
      excludeTypes,
      maxResults,
    }: {
      query: string;
      includeTypes?: IndexableEntity[];
      excludeTypes?: IndexableEntity[];
      maxResults?: number;
    },
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    const options = {
      query,
      maxResults: maxResults ?? 25,
    };
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
    }: {
      includeTypes?: IndexableEntity[];
      excludeTypes?: IndexableEntity[];
      startTime?: Date;
      endTime?: Date;
      eventTypes?: string[];
    },
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    const wants = (type: IndexableEntity) => this.matchesTypeFilter(type, includeTypes, excludeTypes);

    const eventOptions: {
      limit: number;
      order: FindOptionsOrder<EventEntity>;
      startTime?: Date;
      endTime?: Date;
      eventTypes?: string[];
    } = {
      limit: 25,
      order: { startTime: 'DESC' },
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
      limit: 25,
      order: { time: 'DESC' },
    };

    const communicationOptions: {
      limit: number;
      order: FindOptionsOrder<CommunicationEntity>;
      startTime?: Date;
      endTime?: Date;
    } = {
      limit: 25,
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
