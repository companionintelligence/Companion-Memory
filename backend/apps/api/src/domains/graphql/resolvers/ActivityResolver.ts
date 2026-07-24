import { UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ActivityRollupService } from '@ci/domains/activity';

import { ActivityBucketType } from '../types/ActivityBucketType';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ActivityBucketType)
export class ActivityResolver {
  constructor(private readonly activityRollupService: ActivityRollupService) {}

  @Query(() => [ActivityBucketType], {
    description:
      'Precomputed activity counts per local calendar day, with day boundaries in the user profile timezone. Eventually consistent: refreshed from the source tables every 15 minutes.',
  })
  async activityTimeline(
    @Context() context: RequestContext,
    @Args('start', { type: () => String, description: 'Inclusive first day, yyyy-MM-dd' }) start: string,
    @Args('end', { type: () => String, description: 'Inclusive last day, yyyy-MM-dd' }) end: string,
    @Args('sources', {
      type: () => [String],
      nullable: true,
      description: 'Restrict to these activity sources; all sources when omitted',
    })
    sources?: string[],
  ): Promise<ActivityBucketType[]> {
    const counts = await this.activityRollupService.getDailyCounts(toServiceContext(context), {
      start,
      end,
      sources,
    });

    return counts.map(ActivityBucketType.toType);
  }
}
