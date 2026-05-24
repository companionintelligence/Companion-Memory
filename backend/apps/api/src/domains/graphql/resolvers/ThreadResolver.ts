import { UseGuards } from '@nestjs/common';
import { Query, Resolver, Args, Parent, ResolveField, ID } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ThreadService } from '@ci/domains/conversations';

import { TagLoader } from '../loaders/TagLoader';
import { ThreadMessagesLoader } from '../loaders/ThreadMessagesLoader';
import { EntityTagType } from '../types/EntityTagType';
import { GlobalUID } from '../types/GlobalUID';
import { MessageConnection } from '../types/MessageConnection';
import { MessageEdge } from '../types/MessageEdge';
import { MessageType } from '../types/MessageType';
import { PaginationArgs } from '../types/PaginationArgs';
import { ThreadConnection } from '../types/ThreadConnection';
import { ThreadEdge } from '../types/ThreadEdge';
import { ThreadType } from '../types/ThreadType';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ThreadType)
export class ThreadResolver {
  constructor(
    private readonly tagLoader: TagLoader,
    private readonly threadMessagesLoader: ThreadMessagesLoader,
    private readonly threadService: ThreadService,
  ) {}

  @Query(() => ThreadConnection)
  async threads(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<ThreadConnection> {
    const serviceContext = toServiceContext(context);

    const threads = await this.threadService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(threads, {
      ...pagination,
      getId: (thread) => GlobalUID.encode('thread', thread.id),
    });

    const edges: ThreadEdge[] = slice.map((thread) => {
      const node = ThreadType.toType(thread);

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

  @Query(() => ThreadType, { nullable: true })
  async thread(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ThreadType | null> {
    const serviceContext = toServiceContext(context);

    const threadId = GlobalUID.parse('thread', id);

    const thread = await this.threadService.findById(serviceContext, threadId);

    return thread ? ThreadType.toType(thread) : null;
  }

  @ResolveField(() => MessageConnection)
  async messages(
    @Context() context: RequestContext,
    @Parent() thread: ThreadType,
    @Args() pagination: PaginationArgs,
  ): Promise<MessageConnection> {
    const serviceContext = toServiceContext(context);

    const threadId = GlobalUID.parse('thread', thread.id);

    const messages = await this.threadMessagesLoader.load(serviceContext, threadId);

    const { slice, pageInfo, totalCount } = Paginator.paginate(messages, {
      ...pagination,
      getId: (message) => GlobalUID.encode('message', message.id),
    });

    const edges: MessageEdge[] = slice.map((message) => {
      const node = MessageType.toType(message);

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

  @ResolveField(() => [EntityTagType])
  async tags(@Context() context: RequestContext, @Parent() parent: ThreadType): Promise<EntityTagType[]> {
    const serviceContext = toServiceContext(context);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'thread',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }
}
