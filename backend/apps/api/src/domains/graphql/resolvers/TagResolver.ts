import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, Resolver, ResolveField } from '@nestjs/graphql';

import { Context, type RequestContext, type ServiceContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { BrowserActivityService } from '@ci/domains/browser-activity';
import { ThreadService } from '@ci/domains/conversations';
import { FileService } from '@ci/domains/files';
import { ActionService } from '@ci/domains/intelligence';
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
  TAGGABLE_ENTITIES,
  type EntityIdentifier,
  type TaggableEntity,
  TagService,
} from '@ci/domains/search-next';

import { ActionType } from '../types/ActionType';
import { BrowserActivityType } from '../types/BrowserActivityType';
import { CommunicationType } from '../types/CommunicationType';
import { ConceptType } from '../types/ConceptType';
import { ContentType } from '../types/ContentType';
import { EventType } from '../types/EventType';
import { FileType } from '../types/FileType';
import { GlobalUID } from '../types/GlobalUID';
import { ItemType } from '../types/ItemType';
import { NoteType } from '../types/NoteType';
import { PaginationArgs } from '../types/PaginationArgs';
import { PersonType } from '../types/PersonType';
import { PlaceType } from '../types/PlaceType';
import { TagConnection } from '../types/TagConnection';
import { TagEdge } from '../types/TagEdge';
import { TagEntitiesInput } from '../types/TagEntitiesInput';
import { TaggableEntityConnection } from '../types/TaggableEntityConnection';
import { TaggableEntityEdge } from '../types/TaggableEntityEdge';
import { TaggableEntityType } from '../types/TaggableEntityType';
import { TagType } from '../types/TagType';
import { ThreadType } from '../types/ThreadType';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => TagType)
export class TagResolver {
  constructor(
    private readonly actionService: ActionService,
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
    private readonly tagService: TagService,
    private readonly threadService: ThreadService,
  ) {}

  @Query(() => TagConnection)
  async tags(@Context() context: RequestContext, @Args() pagination: PaginationArgs): Promise<TagConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.tagService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('tag', entity.id),
    });

    const edges: TagEdge[] = slice.map((entity) => {
      const node = TagType.toType(entity);

      return {
        node,
        cursor: node.id,
      };
    });

    return {
      edges,
      pageInfo,
      totalCount,
    };
  }

  @Query(() => TagType, { nullable: true })
  async tag(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<TagType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('tag', gid);

    const entity = await this.tagService.findById(serviceContext, id);

    return entity ? TagType.toType(entity) : null;
  }

  @ResolveField(() => TaggableEntityConnection)
  async entities(
    @Context() context: RequestContext,
    @Parent() parent: TagType,
    @Args() pagination: PaginationArgs,
  ): Promise<TaggableEntityConnection> {
    const serviceContext = toServiceContext(context);

    const tag = await this.tagService.findById(serviceContext, parent.__source.id, {
      includeEntities: true,
    });

    if (tag == null || tag.entities == null) {
      return {
        edges: [],
        pageInfo: {
          hasNextPage: false,
          hasPreviousPage: false,
          startCursor: null,
          endCursor: null,
        },
        totalCount: 0,
      };
    }

    const allEntities = tag.entities.map((e) => ({
      type: e.entityType as TaggableEntity,
      id: e.entityId,
    }));

    const { slice, pageInfo, totalCount } = Paginator.paginate(allEntities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode(entity.type, entity.id),
    });

    const entities = await this.resolveEntities(serviceContext, slice);

    const edges: TaggableEntityEdge[] = entities.map((entity) => ({
      cursor: entity.id,
      node: entity,
    }));

    return {
      edges,
      pageInfo,
      totalCount,
    };
  }

  @Mutation(() => [TaggableEntityType])
  async tagEntities(
    @Context() context: RequestContext,
    @Args('input') input: TagEntitiesInput,
  ): Promise<(typeof TaggableEntityType)[]> {
    const serviceContext = toServiceContext(context);

    const entities = input.ids.map((gid) => {
      const { type, id } = GlobalUID.decode(gid);

      if (!isTaggableEntity(type)) {
        throw new Error(`Invalid entity type: ${type}`);
      }

      return {
        type,
        id,
      };
    });

    await this.tagService.tagEntities(serviceContext, {
      labels: input.labels,
      entities,
    });

    return this.resolveEntities(serviceContext, entities);
  }

  @Mutation(() => [TaggableEntityType])
  async untagEntities(
    @Context() context: RequestContext,
    @Args('input') input: TagEntitiesInput,
  ): Promise<(typeof TaggableEntityType)[]> {
    const serviceContext = toServiceContext(context);

    const entities = input.ids.map((gid) => {
      const { type, id } = GlobalUID.decode(gid);

      if (!isTaggableEntity(type)) {
        throw new Error(`Invalid entity type: ${type}`);
      }

      return {
        type,
        id,
      };
    });

    await this.tagService.untagEntities(serviceContext, {
      labels: input.labels,
      entities,
    });

    return this.resolveEntities(serviceContext, entities);
  }

  private async resolveEntities(
    context: ServiceContext,
    entities: EntityIdentifier<TaggableEntity>[],
  ): Promise<(typeof TaggableEntityType)[]> {
    const groupedByType: Map<TaggableEntity, string[]> = entities.reduce((acc, result) => {
      if (!acc.has(result.type)) {
        acc.set(result.type, []);
      }

      acc.get(result.type)!.push(result.id);

      return acc;
    }, new Map());

    const actionIds = groupedByType.get('action') || [];
    const browserActivityIds = groupedByType.get('browser-activity') || [];
    const communicationIds = groupedByType.get('communication') || [];
    const conceptIds = groupedByType.get('concept') || [];
    const contentIds = groupedByType.get('content') || [];
    const eventIds = groupedByType.get('event') || [];
    const fileIds = groupedByType.get('file') || [];
    const itemIds = groupedByType.get('item') || [];
    const noteIds = groupedByType.get('note') || [];
    const personIds = groupedByType.get('person') || [];
    const placeIds = groupedByType.get('place') || [];
    const threadIds = groupedByType.get('thread') || [];

    const [
      actions,
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
      this.actionService.findByIds(context, actionIds),
      this.browserActivityService.findByIds(context, browserActivityIds),
      this.communicationService.findByIds(context, communicationIds),
      this.conceptService.findByIds(context, conceptIds),
      this.contentService.findByIds(context, contentIds),
      this.eventService.findByIds(context, eventIds),
      this.fileService.findByIds(context, fileIds),
      this.itemService.findByIds(context, itemIds),
      this.noteService.findByIds(context, noteIds),
      this.personService.findByIds(context, personIds),
      this.placeService.findByIds(context, placeIds),
      this.threadService.findByIds(context, threadIds),
    ]);

    const actionResults = actions
      .filter((entity) => entity != null)
      .map((entity) => ActionType.toType(entity));

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

    const resultMap = new Map<string, typeof TaggableEntityType>();

    actionResults.forEach((action) => resultMap.set(makeCompositeKey('action', action.__source.id), action));

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

    const orderedResults = entities
      .map((result) => resultMap.get(makeCompositeKey(result.type, result.id)))
      .filter((entity): entity is typeof TaggableEntityType => entity != null);

    return orderedResults;
  }
}

function isTaggableEntity(type: string): type is TaggableEntity {
  return TAGGABLE_ENTITIES.includes(type as TaggableEntity);
}

function makeCompositeKey(type: TaggableEntity, id: string): string {
  return `${type}:${id}`;
}
