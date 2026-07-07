import { Field, ObjectType } from '@nestjs/graphql';

import type { ForecastResponse } from '@ci/domains/predictions';

import { ForecastBucketType } from './ForecastBucketType';

@ObjectType({ description: '48-bucket HBPE day-ahead forecast' })
export class ForecastType {
  @Field(() => String, { description: 'Forecast horizon, e.g. "48h"' })
  horizon!: string;

  @Field(() => String, { description: 'ISO-8601 timestamp when this forecast was generated' })
  generatedAt!: string;

  @Field(() => String, {
    defaultValue: 'READY',
    description:
      'System status of the HBPE engine (COLD_START, TRAINING, READY; UNAVAILABLE for a range day whose fetch failed)',
  })
  systemStatus!: string;

  @Field(() => String, {
    nullable: true,
    description:
      'UTC day (YYYY-MM-DD) the 24h window starts. Set on forecastRange days; null on the legacy single forecast (its window is always tomorrow).',
  })
  horizonStart?: string | null;

  @Field(() => [ForecastBucketType!]!)
  buckets!: ForecastBucketType[];

  static toType(source: ForecastResponse): ForecastType {
    return {
      horizon: source.horizon,
      generatedAt: source.generated_at,
      systemStatus: source.system_status,
      horizonStart: source.horizon_start ?? null,
      buckets: source.buckets.map(ForecastBucketType.toType),
    };
  }
}
