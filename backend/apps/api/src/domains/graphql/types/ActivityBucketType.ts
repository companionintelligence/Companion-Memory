import { Field, Int, ObjectType } from '@nestjs/graphql';

import type { ActivityDailyCount } from '@ci/domains/activity';

@ObjectType({ description: 'Activity count for one local calendar day, rolled up from hourly UTC buckets' })
export class ActivityBucketType {
  @Field(() => String, { description: 'Local calendar day, yyyy-MM-dd, in the user profile timezone' })
  date!: string;

  @Field(() => Int)
  count!: number;

  static toType(source: ActivityDailyCount): ActivityBucketType {
    return {
      date: source.date,
      count: source.count,
    };
  }
}
