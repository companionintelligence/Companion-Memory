import { Field, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class ActivityCountsType {
  @Field(() => Int)
  total!: number;

  @Field(() => Int, { nullable: true })
  browserActivity?: number;

  @Field(() => Int, { nullable: true })
  communications?: number;

  @Field(() => Int, { nullable: true })
  files?: number;

  @Field(() => Int, { nullable: true })
  events?: number;

  @Field(() => Int, { nullable: true })
  messages?: number;

  @Field(() => Int, { nullable: true })
  screenCaptures?: number;

  @Field(() => Int, { nullable: true })
  apiLogs?: number;

  @Field(() => Int, { nullable: true })
  positions?: number;

  @Field(() => Int, { nullable: true })
  activities?: number;

  @Field(() => Int, { nullable: true })
  measurements?: number;

  static fromContent(activityCounts: Record<string, unknown> | undefined): ActivityCountsType {
    if (!activityCounts) {
      return { total: 0 };
    }

    // Only include fields with values > 0
    const result: ActivityCountsType = {
      total: Number(activityCounts.total) || 0,
    };

    const fieldMap: Record<string, keyof ActivityCountsType> = {
      browser_activity: 'browserActivity',
      communications: 'communications',
      files: 'files',
      events: 'events',
      messages: 'messages',
      screen_captures: 'screenCaptures',
      api_logs: 'apiLogs',
      positions: 'positions',
      activities: 'activities',
      measurements: 'measurements',
    };

    for (const [jsonKey, typeKey] of Object.entries(fieldMap)) {
      const value = Number(activityCounts[jsonKey]);
      if (value && value > 0) {
        (result as unknown as Record<string, number>)[typeKey] = value;
      }
    }

    return result;
  }
}
