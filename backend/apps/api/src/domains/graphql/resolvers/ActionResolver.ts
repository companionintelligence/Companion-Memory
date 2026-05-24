import { UseGuards } from '@nestjs/common';
import { Parent, Query, ResolveField, Resolver, Args, ID, Mutation, Int } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ActionService } from '@ci/domains/intelligence';

import { TagLoader } from '../loaders/TagLoader';
import { ThreadLoader } from '../loaders/ThreadLoader';
import { ActionConnection } from '../types/ActionConnection';
import { ActionEdge } from '../types/ActionEdge';
import { ActionType } from '../types/ActionType';
import { EntityTagType } from '../types/EntityTagType';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { ThreadType } from '../types/ThreadType';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ActionType)
export class ActionResolver {
  constructor(
    private readonly actionService: ActionService,
    private readonly tagLoader: TagLoader,
    private readonly threadLoader: ThreadLoader,
  ) {}

  @Query(() => ActionConnection)
  async actions(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<ActionConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.actionService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('action', entity.id),
    });

    const edges: ActionEdge[] = slice.map((entity) => {
      const node = ActionType.toType(entity);

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

  @Query(() => ActionType, { nullable: true })
  async action(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<ActionType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('action', gid);

    const entity = await this.actionService.findById(serviceContext, id);

    return entity ? ActionType.toType(entity) : null;
  }

  @ResolveField(() => ThreadType, { nullable: true })
  async thread(@Context() context: RequestContext, @Parent() parent: ActionType): Promise<ThreadType | null> {
    const serviceContext = toServiceContext(context);

    if (parent.__source.threadId == null) {
      return null;
    }

    const thread = await this.threadLoader.load(serviceContext, parent.__source.threadId);

    return thread ? ThreadType.toType(thread) : null;
  }

  @ResolveField(() => [EntityTagType])
  async tags(@Context() context: RequestContext, @Parent() parent: ActionType): Promise<EntityTagType[]> {
    const serviceContext = toServiceContext(context);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'action',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }

  @Query(() => [ActionType], { description: 'Get actions for the feed, prioritizing unseen actions' })
  async feedActions(
    @Context() context: RequestContext,
    @Args('limit', { type: () => Int, defaultValue: 5 }) limit: number,
  ): Promise<ActionType[]> {
    const serviceContext = toServiceContext(context);

    const entities = await this.actionService.findForFeed(serviceContext, limit);

    return entities.map((entity) => ActionType.toType(entity));
  }

  @Mutation(() => ActionType, { nullable: true, description: 'Mark an action as seen' })
  async markActionAsSeen(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<ActionType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('action', gid);

    const entity = await this.actionService.markAsSeen(serviceContext, id);

    return entity ? ActionType.toType(entity) : null;
  }

  @Mutation(() => ActionType, { nullable: true, description: 'Mark an action as dismissed' })
  async markActionAsDismissed(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<ActionType | null> {
    const serviceContext = toServiceContext(context);
    const id = GlobalUID.parse('action', gid);
    const entity = await this.actionService.markAsDismissed(serviceContext, id);

    return entity ? ActionType.toType(entity) : null;
  }
}
