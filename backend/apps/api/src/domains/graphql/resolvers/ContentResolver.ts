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

/**
 * Resolve an event reference to the raw uuid stored in ci.content.event_id.
 * Accepts either a relay global id (base64 "event:<uuid>", exactly what
 * createEvent returns) or a bare uuid, so a client can link content using the
 * same id it got back from createEvent.
 */
export function resolveEventId(eventId: string): string {
  try {
    const { type, id } = GlobalUID.decode(eventId);
    if (type === 'event' && id) {
      return id;
    }
  } catch {
    // Not a global id — treat the input as an already-raw uuid.
  }

  return eventId;
}

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ContentType)
export class ContentResolver {
  constructor(
    private readonly contentService: ContentService,
    private readonly tagLoader: TagLoader,
    private readonly eventLoader: EventLoader,
  ) {}

  /**
   * Single-record content ingest. Routed through ContentService.createMany so it
   * shares the same provenance-triple dedup + event auto-link as the batch path —
   * a re-send with the same (userId, sourceType, sourceSystem, sourceId) returns
   * the existing row instead of inserting a duplicate-without-triple.
   */
  @Mutation(() => ContentType)
  async createContent(
    @Context() context: RequestContext,
    @Args('input') input: CreateContentInput,
  ): Promise<ContentType> {
    const serviceContext = toServiceContext(context);

    const [entity] = await this.contentService.createMany(serviceContext, [
      {
        type: input.type,
        title: input.title,
        text: input.text,
        url: input.url,
        mimetype: input.mimetype,
        external_id: input.externalId,
        source_url: input.sourceUrl,
        source_data: input.sourceData,
        source_type: input.sourceType,
        source_system: input.sourceSystem,
        source_id: input.sourceId,
        event: input.eventId ? { id: resolveEventId(input.eventId) } : undefined,
      },
    ]);

    return ContentType.toType(entity);
  }

  /**
   * Batch, idempotent content ingest for the importer. Each input dedupes on the
   * provenance triple (user, sourceType, sourceSystem, sourceId) so a re-sync
   * returns the existing content instead of inserting a duplicate. Each row also
   * links to its event: an explicit eventId wins, otherwise the event sharing the
   * same provenance triple is auto-linked (see ContentService.createMany). Returns
   * created-or-existing rows in input order.
   */
  @Mutation(() => [ContentType])
  async createContents(
    @Context() context: RequestContext,
    @Args('input', { type: () => [CreateContentInput] }) input: CreateContentInput[],
  ): Promise<ContentType[]> {
    const serviceContext = toServiceContext(context);

    const contents = await this.contentService.createMany(
      serviceContext,
      input.map((item) => ({
        type: item.type,
        title: item.title,
        text: item.text,
        url: item.url,
        mimetype: item.mimetype,
        external_id: item.externalId,
        source_url: item.sourceUrl,
        source_data: item.sourceData,
        source_type: item.sourceType,
        source_system: item.sourceSystem,
        source_id: item.sourceId,
        event: item.eventId ? { id: resolveEventId(item.eventId) } : undefined,
      })),
    );

    return contents.map((content) => ContentType.toType(content));
  }

  @Mutation(() => ContentType, { nullable: true })
  async updateContent(
    @Context() context: RequestContext,
    @Args('input') input: UpdateContentInput,
  ): Promise<ContentType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('content', input.id);

    const entity = await this.contentService.update(serviceContext, id, {
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
