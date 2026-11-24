import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

import type { ForecastBucket } from '@ci/domains/predictions';

@ObjectType({ description: 'A single label→probability entry from the HBPE histogram' })
export class ProbabilityEntryType {
  @Field(() => String)
  label!: string;

  @Field(() => Float)
  probability!: number;
}

@ObjectType({ description: 'One 15-minute forecast bucket from the HBPE histogram' })
export class ForecastBucketType {
  @Field(() => Int)
  bucketIndex!: number;

  @Field(() => String, { description: 'ISO-8601 start time for this bucket' })
  startTime!: string;

  @Field(() => String, {
    nullable: true,
    description:
      'Class to render for this bucket. Not argmax(l0Probs): the posterior is ' +
      'calibrated and answers UNKNOWN for most of a day, so HBPE prior-corrects ' +
      'the label. Null from an HBPE that predates the field.',
  })
  predictedL0!: string | null;

  @Field(() => [ProbabilityEntryType!]!)
  l0Probs!: ProbabilityEntryType[];

  @Field(() => [ProbabilityEntryType!]!)
  l1Probs!: ProbabilityEntryType[];

  @Field(() => [ProbabilityEntryType!]!, { nullable: true })
  l2Probs!: ProbabilityEntryType[] | null;

  @Field(() => Float)
  q10!: number;

  @Field(() => Float)
  q50!: number;

  @Field(() => Float)
  q90!: number;

  static toType(source: ForecastBucket): ForecastBucketType {
    const toEntries = (map: Record<string, number>): ProbabilityEntryType[] =>
      Object.entries(map).map(([label, probability]) => ({ label, probability }));

    return {
      bucketIndex: source.bucket_index,
      startTime: source.start_time,
      predictedL0: source.predicted_l0 ?? null,
      l0Probs: toEntries(source.l0_probs),
      l1Probs: toEntries(source.l1_probs),
      l2Probs: source.l2_probs ? toEntries(source.l2_probs) : null,
      q10: source.q10,
      q50: source.q50,
      q90: source.q90,
    };
  }
}
