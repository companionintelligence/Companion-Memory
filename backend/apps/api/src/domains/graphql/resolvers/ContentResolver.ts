import { UseGuards } from '@nestjs/common';
import { Args, ID, Parent, Query, Mutation, Resolver, ResolveField } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { CreateContentInput } from '@ci/domains/graphql/types/CreateContentInput';
import { UpdateContentInput } from '@ci/domains/graphql/types/UpdateContentInput';
import { ContentService } from '@ci/domains/memory';

import { EventLoader } from '../loaders/EventLoader';
import { TagLoader } from '../loaders/TagLoader';
import { ContentConnection } from '../types/ContentConnection';
import { ContentEdge } from '../types/ContentEdge';
import { ContentType } from '../types/ContentType';
import { EntityTagType } from '../types/EntityTagType';
import { EventType } from '../types/EventType';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ContentType)
export class ContentResolver {
  constructor(
    private readonly contentService: ContentService,
    private readonly tagLoader: TagLoader,
    private readonly eventLoader: EventLoader,
  ) {}

  @Mutation(() => ContentType)
  async createContent(
    @Context() context: RequestContext,
    @Args('input') input: CreateContentInput,
  ): Promise<ContentType> {
    const serviceContext = toServiceContext(context);

    const entity = await this.contentService.create(serviceContext, {
      type: input.type,
      title: input.title,
      text: input.text,
      url: input.url,
      mimetype: input.mimetype,
      external_id: input.externalId,
      source_url: input.sourceUrl,
      source_data: input.sourceData,
      event: input.eventId ? { id: input.eventId } : undefined,
    });

    return ContentType.toType(entity[0]);
  }

  @Mutation(() => ContentType, { nullable: true })
  async updateContent(
    @Context() context: RequestContext,
    @Args('input') input: UpdateContentInput,
  ): Promise<ContentType | null> {
    const serviceContext = toServiceContext(context);

    const entity = await this.contentService.update(serviceContext, input.id, {
      type: input.type,
      title: input.title,
      text: input.text,
      url: input.url,
      mimetype: input.mimetype,
      external_id: input.externalId,
      source_url: input.sourceUrl,
      source_data: input.sourceData,
    });

    return entity ? ContentType.toType(entity) : entity;
  }

  @Mutation(() => Boolean)
  async removeContent(@Context() context: RequestContext, @Args('id') id: string): Promise<boolean> {
    const serviceContext = toServiceContext(context);

    return this.contentService.remove(serviceContext, id);
  }

  @Query(() => ContentConnection)
  async contents(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<ContentConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.contentService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('content', entity.id),
    });

    const edges: ContentEdge[] = slice.map((entity) => {
      const node = ContentType.toType(entity);

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

  @Query(() => ContentType, { nullable: true })
  async content(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<ContentType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('content', gid);

    const entity = await this.contentService.findById(serviceContext, id);

    return entity ? ContentType.toType(entity) : null;
  }

  @ResolveField(() => EventType, { nullable: true })
  async event(@Context() context: RequestContext, @Parent() parent: ContentType): Promise<EventType | null> {
    const serviceContext = toServiceContext(context);

    if (parent.__source.event?.id == null) {
      return null;
    }

    const event = await this.eventLoader.load(serviceContext, parent.__source.event.id);

    return event ? EventType.toType(event) : null;
  }

  @ResolveField(() => [EntityTagType])
  async tags(@Context() context: RequestContext, @Parent() parent: ContentType): Promise<EntityTagType[]> {
    const serviceContext = toServiceContext(context);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'content',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }
}
