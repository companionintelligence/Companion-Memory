import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { validate as isUuid } from 'uuid';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { SummaryService } from '@ci/domains/summaries';

import { GraphqlPrivacy } from '../decorators/GraphqlPrivacy';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { SummaryConnection } from '../types/SummaryConnection';
import { SummaryEdge } from '../types/SummaryEdge';
import { SummaryType } from '../types/SummaryType';
import { Paginator } from '../utils/Paginator';

/**
 * The summary id inside a summary GlobalUID, or null when it is not a uuid.
 *
 * `summary_id` is a uuid column, so any other string (the web app builds the
 * GlobalUID straight from the address, as in `/brief/summaries/abc`) made
 * Postgres raise 22P02, which reached the page as "Internal server error". No
 * row can have such an id, so it is answered the way an unknown uuid is.
 */
function summaryIdFrom(gid: string): string | null {
  const id = GlobalUID.parse('summary', gid);

  return isUuid(id) ? id : null;
}

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => SummaryType)
export class SummaryResolver {
  constructor(private readonly summaryService: SummaryService) {}

  @Query(() => SummaryConnection)
  async summaries(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<SummaryConnection> {
    const serviceContext = toServiceContext(context);
    const entities = await this.summaryService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('summary', entity.summaryId),
    });

    const edges: SummaryEdge[] = slice.map((entity) => {
      const node = SummaryType.toType(entity);

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

  @Query(() => SummaryType, { nullable: true })
  async summary(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<SummaryType | null> {
    const serviceContext = toServiceContext(context);
    const id = summaryIdFrom(gid);
    if (id == null) {
      return null;
    }

    const entity = await this.summaryService.findById(serviceContext, id);

    return entity ? SummaryType.toType(entity) : null;
  }

  @Mutation(() => SummaryType, { nullable: true, description: 'Mark a summary as seen' })
  @GraphqlPrivacy({ destructive: false })
  async markSummaryAsSeen(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<SummaryType | null> {
    const serviceContext = toServiceContext(context);
    const id = summaryIdFrom(gid);
    if (id == null) {
      return null;
    }

    const updated = await this.summaryService.update(serviceContext, id, { seen: true });

    return updated ? SummaryType.toType(updated) : null;
  }

  @Mutation(() => SummaryType, { nullable: true, description: 'Mark a summary as dismissed' })
  @GraphqlPrivacy({ destructive: false })
  async markSummaryAsDismissed(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<SummaryType | null> {
    const serviceContext = toServiceContext(context);
    const id = summaryIdFrom(gid);
    if (id == null) {
      return null;
    }

    const updated = await this.summaryService.update(serviceContext, id, { dismissed: true });

    return updated ? SummaryType.toType(updated) : null;
  }
}
