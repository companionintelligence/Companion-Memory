import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, Resolver, ResolveField } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { BrowserActivityService } from '@ci/domains/browser-activity';

import { TagLoader } from '../loaders/TagLoader';
import { BrowserActivityConnection } from '../types/BrowserActivityConnection';
import { BrowserActivityEdge } from '../types/BrowserActivityEdge';
import { BrowserActivityType } from '../types/BrowserActivityType';
import { EntityTagType } from '../types/EntityTagType';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { UpdateBrowserActivityInput } from '../types/UpdateBrowserActivityInput';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => BrowserActivityType)
export class BrowserActivityResolver {
  constructor(
    private readonly browserActivityService: BrowserActivityService,
    private readonly tagLoader: TagLoader,
  ) {}

  @Query(() => BrowserActivityConnection)
  async browserActivities(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<BrowserActivityConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.browserActivityService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('browser-activity', entity.id),
    });

    const edges: BrowserActivityEdge[] = slice.map((entity) => {
      const node = BrowserActivityType.toType(entity);

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

  @Query(() => BrowserActivityType, { nullable: true })
  async browserActivity(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<BrowserActivityType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('browser-activity', gid);

    const entity = await this.browserActivityService.findById(serviceContext, id);

    return entity ? BrowserActivityType.toType(entity) : null;
  }

  @Mutation(() => BrowserActivityType, { nullable: true })
  async updateBrowserActivity(
    @Context() context: RequestContext,
    @Args('input') input: UpdateBrowserActivityInput,
  ): Promise<BrowserActivityType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('browser-activity', input.id);

    const entity = await this.browserActivityService.update(serviceContext, id, {
      title: input.title,
      url: input.url,
    });

    return entity ? BrowserActivityType.toType(entity) : null;
  }

  @ResolveField(() => [EntityTagType])
  async tags(
    @Context() context: RequestContext,
    @Parent() parent: BrowserActivityType,
  ): Promise<EntityTagType[]> {
    const serviceContext = toServiceContext(context);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'browser-activity',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }
}
