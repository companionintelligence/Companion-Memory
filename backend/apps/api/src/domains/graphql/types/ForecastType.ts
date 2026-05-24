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
    description: 'System status of the HBPE engine (COLD_START, TRAINING, READY)',
  })
  systemStatus!: string;

  @Field(() => [ForecastBucketType!]!)
  buckets!: ForecastBucketType[];

  static toType(source: ForecastResponse): ForecastType {
    return {
      horizon: source.horizon,
      generatedAt: source.generated_at,
      systemStatus: source.system_status,
      buckets: source.buckets.map(ForecastBucketType.toType),
    };
  }
}
