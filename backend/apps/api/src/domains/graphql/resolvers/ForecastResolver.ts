import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { HbpeService } from '@ci/domains/predictions';

import { ForecastType } from '../types/ForecastType';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ForecastType)
export class ForecastResolver {
  constructor(
    private readonly hbpeService: HbpeService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ForecastResolver.name);
  }

  @Query(() => ForecastType, { nullable: true, description: 'Fetch the HBPE day-ahead forecast histogram' })
  async forecast(
    @Context() context: RequestContext,
    @Args('horizon', { type: () => String, nullable: true, defaultValue: '24h' }) horizon: string,
  ): Promise<ForecastType | null> {
    if (!(await this.featureService.isFeatureEnabled('hbpe'))) {
      return null;
    }

    try {
      const response = await this.hbpeService.getForecast(toServiceContext(context), horizon);

      return ForecastType.toType(response);
    } catch (err) {
      this.logger.error('Forecast query failed', err instanceof Error ? err : new Error(String(err)));

      return null;
    }
  }

  @Mutation(() => String, { description: 'Manually trigger the HBPE pipeline for the current user' })
  async triggerHbpe(@Context() context: RequestContext): Promise<string> {
    if (!(await this.featureService.isFeatureEnabled('hbpe'))) {
      return 'disabled';
    }

    if (!context.userId) {
      return 'error';
    }

    return this.hbpeService.triggerPipeline(context.userId);
  }
}
