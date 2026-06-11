import { BadRequestException, UseGuards } from '@nestjs/common';
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

    if (input.query == null && (!input.tags || input.tags.length === 0)) {
      throw new BadRequestException('Must provide either query or tags');
    }

    if (input.query != null && input.tags && input.tags.length > 0) {
      throw new BadRequestException('Cannot provide both query and tags');
    }

    const results: SearchResult[] = [];

    if (input.tags && input.tags.length > 0) {
      const tagResults = await this.searchByTags(serviceContext, input.tags);

      results.push(...tagResults);
    } else if (input.query != null && input.query.length > 0) {
      const queryResults = await this.searchByQuery(serviceContext, {
        query: input.query,
        includeTypes: input.includeTypes,
        excludeTypes: input.excludeTypes,
      });

      results.push(...queryResults);
    } else {
      const noInputs =
        (!input.includeTypes || input.includeTypes.length === 0) &&
        (!input.excludeTypes || input.excludeTypes.length === 0) &&
        !input.startTime &&
        !input.endTime;
      const queryResults = await this.searchByTimedEntities(serviceContext, {
        includeTypes: input.includeTypes,
        excludeTypes: input.excludeTypes,
        startTime: input.startTime ? new Date(input.startTime) : undefined,
        endTime: noInputs ? new Date() : input.endTime ? new Date(input.endTime) : undefined,
      });

      results.push(...queryResults);
    }

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
    }: {
      query: string;
      includeTypes?: IndexableEntity[];
      excludeTypes?: IndexableEntity[];
    },
  ): Promise<SearchResult[]> {
    const options = {
      query,
      maxResults: 25,
    };
    if (excludeTypes && excludeTypes.length > 0) {
      Object.assign(options, { excludeTypes });
    } else if (includeTypes && includeTypes.length > 0) {
      Object.assign(options, { includeTypes });
    }

    const queryResults = await this.searchService.search(context, options);

    return this.resolveEntities(context, queryResults);
  }

  private async searchByTags(context: UserServiceContext, tags: string[]): Promise<SearchResult[]> {
    if (tags.length === 0) {
      return [];
    }

    const tagResults = await this.tagService.getEntitiesForTags(context, tags);

    return this.resolveEntities(context, tagResults);
  }

  private async searchByTimedEntities(
    context: UserServiceContext,
    {
      includeTypes,
      excludeTypes,
      startTime,
      endTime,
    }: {
      includeTypes?: IndexableEntity[];
      excludeTypes?: IndexableEntity[];
      startTime?: Date;
      endTime?: Date;
    },
  ): Promise<SearchResult[]> {
    const eventOptions: {
      limit: number;
      order: FindOptionsOrder<EventEntity>;
      startTime?: Date;
      endTime?: Date;
    } = {
      limit: 25,
      order: { startTime: 'DESC' },
    };

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
      (includeTypes && includeTypes.indexOf('event') > -1) ||
      (excludeTypes && excludeTypes?.indexOf('event') < 0)
        ? this.eventService.getEntitiesForEvents(context, eventOptions)
        : [],
      (includeTypes && includeTypes?.indexOf('browser-activity') > -1) ||
      (excludeTypes && excludeTypes?.indexOf('browser-activity') < 0)
        ? this.browserActivityService.getEntitiesForBrowserActivities(context, browserActivityOptions)
        : [],
      (includeTypes && includeTypes?.indexOf('communication') > -1) ||
      (excludeTypes && excludeTypes?.indexOf('communication') < 0)
        ? this.communicationService.getEntitiesForCommunications(context, communicationOptions)
        : [],
    ]);

    const entities = await this.resolveEntities(context, [
      ...eventResults,
      ...browserActivityResults,
      ...communicationResults,
    ]);

    return entities.sort((a, b) => {
      const aTime =
        'time' in a && a.time ? a.time : 'startTime' in a && a.startTime ? a.startTime : new Date();
      const bTime =
        'time' in b && b.time ? b.time : 'startTime' in b && b.startTime ? b.startTime : new Date();

      return bTime.getTime() - aTime.getTime();
    });
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
