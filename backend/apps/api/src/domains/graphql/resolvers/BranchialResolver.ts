import { UseGuards } from '@nestjs/common';
import { Mutation, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { BranchialForecastService } from '@ci/domains/agent';

import { GraphqlPrivacy } from '../decorators/GraphqlPrivacy';
import { BranchialTreeType } from '../types/BranchialType';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => BranchialTreeType)
export class BranchialResolver {
  constructor(
    private readonly branchial: BranchialForecastService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(BranchialResolver.name);
  }

  @Query(() => BranchialTreeType, {
    nullable: true,
    description: 'Occupancy spine: remaining dayparts and week-ahead days as a walkable tree',
  })
  async branchialForecast(@Context() context: RequestContext): Promise<BranchialTreeType | null> {
    return this.run('Branchial occupancy failed', () => this.branchial.occupancy(context));
  }

  @Mutation(() => BranchialTreeType, {
    nullable: true,
    description: 'Name occupancy branches from memory via the LLM; falls back to occupancy labels on failure',
  })
  // branchial.guess() only reads (occupancy/recall/persona context) and calls the on-appliance
  // OllamaService to label branches; nothing is written or deleted, and no data leaves the box.
  @GraphqlPrivacy({ destructive: false })
  async guessBranchialForecast(@Context() context: RequestContext): Promise<BranchialTreeType | null> {
    return this.run('Branchial guess failed', () => this.branchial.guess(context));
  }

  private async run(
    message: string,
    fn: () => Promise<Parameters<typeof BranchialTreeType.toType>[0]>,
  ): Promise<BranchialTreeType | null> {
    if (!(await this.featureService.isFeatureEnabled('hbpe'))) {
      return null;
    }

    try {
      return BranchialTreeType.toType(await fn());
    } catch (err) {
      this.logger.error(message, err instanceof Error ? err : new Error(String(err)));

      return null;
    }
  }
}
