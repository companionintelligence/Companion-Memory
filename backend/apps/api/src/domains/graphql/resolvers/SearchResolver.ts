import { BadRequestException, UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { type FindOptionsOrder } from 'typeorm';

import { Context, type RequestContext, type UserServiceContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { BrowserActivityEntity, BrowserActivityService } from '@ci/domains/browser-activity';
import { ThreadService } from '@ci/domains/conversations';
import { FileService } from '@ci/domains/files';
import { AnswerService } from '@ci/domains/intelligence';
import {
  CommunicationService,
  ConceptService,
  ContentService,
  EventService,
  EventEntity,
  ItemService,
  PersonService,
  PlaceService,
  CommunicationEntity,
} from '@ci/domains/memory';
import { NoteService } from '@ci/domains/notes';
import {
  SearchService,
  TagService,
  type EntityIdentifier,
  type IndexableEntity,
  type TaggableEntity,
} from '@ci/domains/search-next';

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
    private readonly answerService: AnswerService,
    private readonly browserActivityService: BrowserActivityService,
    private readonly communicationService: CommunicationService,
    private readonly conceptService: ConceptService,
    private readonly contentService: ContentService,
    private readonly eventService: EventService,
    private readonly fileService: FileService,
    private readonly itemService: ItemService,
    private readonly noteService: NoteService,
    private readonly personService: PersonService,
    private readonly placeService: PlaceService,
    private readonly searchService: SearchService,
    private readonly tagService: TagService,
    private readonly threadService: ThreadService,
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
      const queryResults = await this.searchByTimedEntities(serviceContext, {
        includeTypes: input.includeTypes,
        excludeTypes: input.excludeTypes,
        startTime: input.startTime ? new Date(input.startTime) : undefined,
        endTime: input.endTime ? new Date(input.endTime) : undefined,
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
      browserActivityOptions.startTime = endTime;
      communicationOptions.startTime = endTime;
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
    const groupedByType: Map<IndexableEntity | TaggableEntity, string[]> = results.reduce((acc, result) => {
      if (!acc.has(result.type)) {
        acc.set(result.type, []);
      }

      acc.get(result.type)!.push(result.id);

      return acc;
    }, new Map());

    const answerIds = groupedByType.get('answer') || [];
    const browserActivityIds = groupedByType.get('browser-activity') || [];
    const communicationIds = groupedByType.get('communication') || [];
    const conceptIds = groupedByType.get('concept') || [];
    const contentIds = groupedByType.get('content') || [];
    const eventIds = groupedByType.get('event') || [];
    const fileIds = groupedByType.get('file') || [];
    const itemIds = groupedByType.get('item') || [];
    const noteIds = groupedByType.get('note') || [];
    const peopleIds = groupedByType.get('person') || [];
    const placeIds = groupedByType.get('place') || [];
    const threadIds = groupedByType.get('thread') || [];

    const [
      answers,
      browserActivities,
      communications,
      concepts,
      content,
      events,
      files,
      items,
      notes,
      people,
      places,
      threads,
    ] = await Promise.all([
      this.answerService.findByIds(context, answerIds),
      this.browserActivityService.findByIds(context, browserActivityIds),
      this.communicationService.findByIds(context, communicationIds),
      this.conceptService.findByIds(context, conceptIds),
      this.contentService.findByIds(context, contentIds),
      this.eventService.findByIds(context, eventIds),
      this.fileService.findByIds(context, fileIds),
      this.itemService.findByIds(context, itemIds),
      this.noteService.findByIds(context, noteIds),
      this.personService.findByIds(context, peopleIds),
      this.placeService.findByIds(context, placeIds),
      this.threadService.findByIds(context, threadIds),
    ]);

    const answerResults = answers
      .filter((entity) => entity != null)
      .map((entity) => AnswerType.toType(entity));

    const browserActivityResults = browserActivities
      .filter((entity) => entity != null)
      .map((entity) => BrowserActivityType.toType(entity));

    const communicationResults = communications
      .filter((entity) => entity != null)
      .map((entity) => CommunicationType.toType(entity));

    const conceptResults = concepts
      .filter((entity) => entity != null)
      .map((entity) => ConceptType.toType(entity));

    const contentResults = content
      .filter((entity) => entity != null)
      .map((entity) => ContentType.toType(entity));

    const eventResults = events.filter((entity) => entity != null).map((entity) => EventType.toType(entity));

    const fileResults = files.filter((entity) => entity != null).map((entity) => FileType.toType(entity));

    const itemResults = items.filter((entity) => entity != null).map((entity) => ItemType.toType(entity));

    const noteResults = notes.filter((entity) => entity != null).map((entity) => NoteType.toType(entity));

    const personResults = people
      .filter((entity) => entity != null)
      .map((entity) => PersonType.toType(entity));

    const placeResults = places.filter((entity) => entity != null).map((entity) => PlaceType.toType(entity));

    const threadResults = threads
      .filter((entity) => entity != null)
      .map((entity) => ThreadType.toType(entity));

    const resultMap = new Map<string, SearchResult>();

    answerResults.forEach((answer) => resultMap.set(makeCompositeKey('answer', answer.__source.id), answer));

    browserActivityResults.forEach((activity) =>
      resultMap.set(makeCompositeKey('browser-activity', activity.__source.id), activity),
    );

    communicationResults.forEach((communication) =>
      resultMap.set(makeCompositeKey('communication', communication.__source.id), communication),
    );

    conceptResults.forEach((concept) =>
      resultMap.set(makeCompositeKey('concept', concept.__source.id), concept),
    );

    contentResults.forEach((content) =>
      resultMap.set(makeCompositeKey('content', content.__source.id), content),
    );

    eventResults.forEach((event) => resultMap.set(makeCompositeKey('event', event.__source.id), event));
    fileResults.forEach((file) => resultMap.set(makeCompositeKey('file', file.__source.id), file));
    itemResults.forEach((item) => resultMap.set(makeCompositeKey('item', item.__source.id), item));
    noteResults.forEach((note) => resultMap.set(makeCompositeKey('note', note.__source.id), note));
    personResults.forEach((person) => resultMap.set(makeCompositeKey('person', person.__source.id), person));
    placeResults.forEach((place) => resultMap.set(makeCompositeKey('place', place.__source.id), place));
    threadResults.forEach((thread) => resultMap.set(makeCompositeKey('thread', thread.__source.id), thread));

    const orderedResults = results
      .map((result) => resultMap.get(makeCompositeKey(result.type, result.id)))
      .filter((entity): entity is SearchResult => entity != null);

    return orderedResults;
  }
}

function makeCompositeKey(type: IndexableEntity | TaggableEntity, id: string): string {
  return `${type}:${id}`;
}
