import { UseGuards } from '@nestjs/common';
import { Query, Resolver, Args, Parent, ResolveField, ID } from '@nestjs/graphql';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { RequestContext } from '@ci/common/types';
import { ThreadService } from '@ci/domains/conversations';

import { ThreadMessagesLoader } from '../loaders/ThreadMessagesLoader';
import { GlobalUID } from '../types/GlobalUID';
import { MessageConnection } from '../types/MessageConnection';
import { MessageEdge } from '../types/MessageEdge';
import { MessageType } from '../types/MessageType';
import { PaginationArgs } from '../types/PaginationArgs';
import { ThreadConnection } from '../types/ThreadConnection';
import { ThreadEdge } from '../types/ThreadEdge';
import { ThreadType } from '../types/ThreadType';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtAuthGuard)
@Resolver(() => ThreadType)
export class ThreadResolver {
  constructor(
    private readonly threadMessagesLoader: ThreadMessagesLoader,
    private readonly threadService: ThreadService,
  ) {}

  @Query(() => ThreadConnection)
  async threads(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<ThreadConnection> {
    const threads = await this.threadService.findAll(context);

    const { slice, pageInfo, totalCount } = Paginator.paginate(threads, {
      ...pagination,
      getId: (thread) => GlobalUID.encode('thread', thread.id),
    });

    const edges: ThreadEdge[] = slice.map((thread) => {
      const node = ThreadType.fromEntity(thread);

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
  ): Promise<ThreadType> {
    const threadId = GlobalUID.parse('thread', id);

    const thread = await this.threadService.findOne(context, threadId);

    return ThreadType.fromEntity(thread);
  }

  @ResolveField(() => MessageConnection)
  async messages(
    @Context() context: RequestContext,
    @Parent() thread: ThreadType,
    @Args() pagination: PaginationArgs,
  ): Promise<MessageConnection> {
    const threadId = GlobalUID.parse('thread', thread.id);

    const messages = await this.threadMessagesLoader.load(context, threadId);

    const { slice, pageInfo, totalCount } = Paginator.paginate(messages, {
      ...pagination,
      getId: (message) => GlobalUID.encode('message', message.id),
    });

    const edges: MessageEdge[] = slice.map((message) => {
      const node = MessageType.fromEntity(message);

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
}
