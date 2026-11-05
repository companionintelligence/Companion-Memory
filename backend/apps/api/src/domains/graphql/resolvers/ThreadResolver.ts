import { UseGuards } from '@nestjs/common';
import { Query, Resolver, Args, Info, Parent, ResolveField, ID } from '@nestjs/graphql';
import type { GraphQLResolveInfo } from 'graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { resolvePageShape } from '@ci/common/persistence';
import { MessageService, ThreadService } from '@ci/domains/conversations';

import { TagLoader } from '../loaders/TagLoader';
import { ThreadMessagesLoader } from '../loaders/ThreadMessagesLoader';
import { selectsField } from '../selectsField';
import { EntityTagType } from '../types/EntityTagType';
import { GlobalUID } from '../types/GlobalUID';
import { MessageConnection } from '../types/MessageConnection';
import { MessageEdge } from '../types/MessageEdge';
import { MessageType } from '../types/MessageType';
import type { OptionalTotal } from '../types/OptionalTotal';
import { PaginationArgs } from '../types/PaginationArgs';
import { ThreadConnection } from '../types/ThreadConnection';
import { ThreadEdge } from '../types/ThreadEdge';
import { ThreadType } from '../types/ThreadType';
import { keysetArgs, keysetPageInfo } from '../utils/keysetConnection';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ThreadType)
export class ThreadResolver {
  constructor(
    private readonly tagLoader: TagLoader,
    private readonly threadMessagesLoader: ThreadMessagesLoader,
    private readonly threadService: ThreadService,
    private readonly messageService: MessageService,
  ) {}

  @Query(() => ThreadConnection)
  async threads(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
    @Info() info?: GraphQLResolveInfo,
  ): Promise<OptionalTotal<ThreadConnection>> {
    const serviceContext = toServiceContext(context);

    // One page from SQL, most recently updated first; the count only when it is asked for.
    const page = await this.threadService.findPage(serviceContext, keysetArgs(pagination), {
      countTotal: selectsField(info, 'totalCount'),
    });

    const edges: ThreadEdge[] = page.entities.map((thread) => {
      const node = ThreadType.toType(thread);

      return {
        node,
        cursor: node.id,
      };
    });

    return {
      edges,
      pageInfo: keysetPageInfo(edges, page),
      ...(page.totalCount != null ? { totalCount: page.totalCount } : {}),
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

  /**
   * A thread's messages, oldest first, one page from SQL. The first page of a
   * page of threads is one batched read (the loader); a cursor page is the
   * thread's own and goes to the service. The cursors are the messages' own
   * ids; `totalCount` is counted only when the operation selects it.
   */
  @ResolveField(() => MessageConnection)
  async messages(
    @Context() context: RequestContext,
    @Parent() thread: ThreadType,
    @Args() pagination: PaginationArgs,
    @Info() info?: GraphQLResolveInfo,
  ): Promise<OptionalTotal<MessageConnection>> {
    const serviceContext = toServiceContext(context);
    const threadId = GlobalUID.parse('thread', thread.id);
    const args = {
      first: pagination.first,
      last: pagination.last,
      afterId: pagination.after ? GlobalUID.decode(pagination.after).id : null,
      beforeId: pagination.before ? GlobalUID.decode(pagination.before).id : null,
    };
    const { limit, isBackward } = resolvePageShape(args);
    const page =
      !isBackward && args.afterId == null
        ? await this.threadMessagesLoader.loadFor(serviceContext, threadId, limit)
        : await this.messageService.findPageByThread(serviceContext, threadId, args, {
            countTotal: selectsField(info, 'totalCount'),
          });

    const edges: MessageEdge[] = page.messages.map((message) => {
      const node = MessageType.toType(message);

      return {
        node,
        cursor: node.id,
      };
    });

    return {
      edges,
      pageInfo: {
        hasNextPage: page.hasNextPage,
        hasPreviousPage: page.hasPreviousPage,
        startCursor: edges.length > 0 ? edges[0].cursor : null,
        endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
      },
      ...(page.totalCount != null ? { totalCount: page.totalCount } : {}),
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
