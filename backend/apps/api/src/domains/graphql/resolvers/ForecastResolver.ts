import { UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';

import { JwtAuthGuard } from '@ci/common/guards';
import { HbpeService } from '@ci/domains/predictions';

import { ForecastType } from '../types/ForecastType';

@UseGuards(JwtAuthGuard)
@Resolver(() => ForecastType)
export class ForecastResolver {
  constructor(private readonly hbpeService: HbpeService) {}

  @Query(() => ForecastType, { nullable: true, description: 'Fetch the HBPE day-ahead forecast histogram' })
  async forecast(
    @Args('horizon', { type: () => String, nullable: true, defaultValue: '24h' }) horizon: string,
  ): Promise<ForecastType | null> {
    try {
      const response = await this.hbpeService.getForecast(horizon);

      return ForecastType.toType(response);
    } catch {
      return null;
    }
  }
}
