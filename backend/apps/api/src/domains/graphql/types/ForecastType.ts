import { Field, ObjectType } from '@nestjs/graphql';

import type { ForecastResponse } from '@ci/domains/predictions';

import { ForecastBucketType } from './ForecastBucketType';

@ObjectType({ description: '48-bucket HBPE day-ahead forecast' })
export class ForecastType {
  @Field(() => String, { description: 'Forecast horizon, e.g. "48h"' })
  horizon!: string;

  @Field(() => String, { description: 'ISO-8601 timestamp when this forecast was generated' })
  generatedAt!: string;

  @Field(() => [ForecastBucketType!]!)
  buckets!: ForecastBucketType[];

  static toType(source: ForecastResponse): ForecastType {
    return {
      horizon: source.horizon,
      generatedAt: source.generated_at,
      buckets: source.buckets.map(ForecastBucketType.toType),
    };
  }
}
