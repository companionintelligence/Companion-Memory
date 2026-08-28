import { Field, Int, ObjectType } from '@nestjs/graphql';

import type { ForecastResponse } from '@ci/domains/predictions';

import { ForecastBucketType } from './ForecastBucketType';

@ObjectType({ description: '48-bucket (30-min) HBPE day-ahead forecast' })
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

  @Field(() => String, {
    nullable: true,
    description: 'Served histogram model: hmt, b1, or b2 (D3 gate).',
  })
  modelVersion?: string | null;

  @Field(() => Boolean, {
    defaultValue: false,
    description: 'True when the histogram is a cold-start baseline, not a trained HMT.',
  })
  stillLearning!: boolean;

  @Field(() => Int, {
    nullable: true,
    description: 'Estimated seconds remaining in the active Predict/nightly step.',
  })
  pipelineEtaSeconds?: number | null;

  @Field(() => String, {
    nullable: true,
    description: 'Live progress inside the active step, e.g. "1200 of 8400".',
  })
  pipelineDetail?: string | null;

  @Field(() => [ForecastBucketType!]!)
  buckets!: ForecastBucketType[];

  static toType(source: ForecastResponse): ForecastType {
    return {
      horizon: source.horizon,
      generatedAt: source.generated_at,
      systemStatus: source.system_status,
      modelVersion: source.model_version ?? null,
      stillLearning: Boolean(source.still_learning),
      pipelineEtaSeconds: source.pipeline_eta_seconds ?? null,
      pipelineDetail: source.pipeline_detail ?? null,
      buckets: source.buckets.map(ForecastBucketType.toType),
    };
  }
}
