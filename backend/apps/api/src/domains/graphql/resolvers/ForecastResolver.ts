import { UseGuards } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';

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

  @Query(() => [ForecastType], {
    nullable: true,
    description:
      'Fetch HBPE forecasts for a multi-day window (weekly scheduling / week-heatmap rows). One ForecastType per day, each with its own generatedAt/systemStatus; a day the engine cannot serve comes back with a non-READY systemStatus instead of failing the range. Note: every day is produced by the same recency×day-of-week kernel over the trailing 30 days — day+7 approximates the typical pattern for that weekday, not a learned multi-step rollout.',
  })
  async forecastRange(
    @Context() context: RequestContext,
    @Args('startDate', {
      type: () => String,
      nullable: true,
      description: 'First day (YYYY-MM-DD, UTC). Defaults to tomorrow.',
    })
    startDate?: string,
    @Args('days', {
      type: () => Int,
      nullable: true,
      defaultValue: 7,
      description: 'Days in the range (1-7)',
    })
    days = 7,
  ): Promise<ForecastType[] | null> {
    if (!(await this.featureService.isFeatureEnabled('hbpe'))) {
      return null;
    }

    try {
      const responses = await this.hbpeService.getForecastRange(toServiceContext(context), startDate, days);

      return responses.map(ForecastType.toType);
    } catch (err) {
      this.logger.error('Forecast range query failed', err instanceof Error ? err : new Error(String(err)));

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
