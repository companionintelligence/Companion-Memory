import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, Resolver, ResolveField } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { MaxArraySizePipe } from '@ci/common/pipes';
import { BrowserActivityService, type CreateBrowserActivityDto } from '@ci/domains/browser-activity';

import { TagLoader } from '../loaders/TagLoader';
import { BrowserActivityConnection } from '../types/BrowserActivityConnection';
import { BrowserActivityEdge } from '../types/BrowserActivityEdge';
import { BrowserActivityType } from '../types/BrowserActivityType';
import { CreateBrowserActivityInput } from '../types/CreateBrowserActivityInput';
import { EntityTagType } from '../types/EntityTagType';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { UpdateBrowserActivityInput } from '../types/UpdateBrowserActivityInput';

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

    const { entities, hasNextPage, hasPreviousPage, totalCount } = await this.browserActivityService.findPage(
      serviceContext,
      {
        first: pagination.first,
        last: pagination.last,
        afterId: pagination.after ? GlobalUID.decode(pagination.after).id : null,
        beforeId: pagination.before ? GlobalUID.decode(pagination.before).id : null,
      },
    );

    const edges: BrowserActivityEdge[] = entities.map((entity) => {
      const node = BrowserActivityType.toType(entity);

      return {
        node,
        cursor: node.id,
      };
    });

    const pageInfo = {
      hasNextPage,
      hasPreviousPage,
      startCursor: edges.length > 0 ? edges[0].cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
    };

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

  /**
   * Batch, idempotent browser-activity ingest for the importer. Each input dedupes
   * on the provenance triple (user, sourceType, sourceSystem, sourceId) so a
   * re-sync returns the existing activity instead of inserting a duplicate.
   * Returns created-or-existing rows in input order.
   */
  @Mutation(() => [BrowserActivityType])
  async createBrowserActivities(
    @Context() context: RequestContext,
    @Args('input', { type: () => [CreateBrowserActivityInput] }, new MaxArraySizePipe())
    input: CreateBrowserActivityInput[],
  ): Promise<BrowserActivityType[]> {
    const serviceContext = toServiceContext(context);

    const activities = await this.browserActivityService.createMany(
      serviceContext,
      input.map((item) => ({
        time: item.time.toISOString(),
        url: item.url,
        title: item.title,
        action_type: item.actionType as CreateBrowserActivityDto['action_type'],
        properties: item.properties,
        duration_seconds: item.durationSeconds,
        scroll_depth_percent: item.scrollDepthPercent,
        page_summary: item.pageSummary,
        category: item.category,
        productivity_score: item.productivityScore,
        is_incognito: item.isIncognito,
        contains_sensitive: item.containsSensitive,
        device_id: item.deviceId,
        source_type: item.sourceType,
        source_system: item.sourceSystem,
        source_id: item.sourceId,
      })),
    );

    return activities.map((activity) => BrowserActivityType.toType(activity));
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
