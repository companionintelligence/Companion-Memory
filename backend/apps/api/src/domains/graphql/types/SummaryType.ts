import { Field, Float, ID, ObjectType } from '@nestjs/graphql';

import { Node } from '@ci/domains/graphql/types/Node';
import type { Summary } from '@ci/domains/summaries';

import { ActivityCountsType } from './ActivityCountsType';
import { GlobalUID } from './GlobalUID';
import { InsightItemType } from './InsightItemType';

@ObjectType({ implements: () => [Node] })
export class SummaryType implements Node {
  __typename = SummaryType.name;

  __source!: Summary;

  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  title!: string | null;

  @Field(() => String)
  periodType!: string;

  @Field(() => Date)
  periodStart!: Date;

  @Field(() => Date)
  periodEnd!: Date;

  @Field(() => String)
  timezone!: string;

  @Field(() => [String!]!)
  sourceTypes!: string[];

  // Destructured content fields
  @Field(() => String)
  summaryText!: string;

  @Field(() => [String!]!)
  keyInsights!: string[];

  @Field(() => [String!]!)
  notableEvents!: string[];

  @Field(() => [String!]!)
  anomalies!: string[];

  @Field(() => ActivityCountsType)
  activityCounts!: ActivityCountsType;

  @Field(() => [String!]!)
  tags!: string[];

  @Field(() => [InsightItemType!]!)
  insights!: InsightItemType[];

  // Daily-specific fields (optional)
  @Field(() => [String!], { nullable: true })
  dailyRhythm?: string[];

  @Field(() => [String!], { nullable: true })
  productivityPatterns?: string[];

  @Field(() => [String!], { nullable: true })
  socialInteractions?: string[];

  @Field(() => [String!], { nullable: true })
  keyAccomplishments?: string[];

  @Field(() => [String!], { nullable: true })
  moodIndicators?: string[];

  @Field(() => Float, { nullable: true })
  confidenceScore?: number | null;

  @Field(() => Boolean)
  seen!: boolean;

  @Field(() => Boolean)
  dismissed!: boolean;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;

  static toType(source: Summary): SummaryType {
    return {
      __typename: SummaryType.name,
      __source: source,
      id: GlobalUID.encode('summary', source.summaryId),
      title: source.title,
      periodType: source.periodType,
      periodStart: source.periodStart,
      periodEnd: source.periodEnd,
      timezone: source.timezone,
      sourceTypes: source.sourceTypes,
      summaryText: source.summaryText,
      keyInsights: source.keyInsights,
      notableEvents: source.notableEvents,
      anomalies: source.anomalies,
      activityCounts: ActivityCountsType.fromContent(source.activityCounts),
      tags: source.tags,
      insights: (source.insights || []).map((i) => InsightItemType.fromContent(i)),
      dailyRhythm: source.dailyRhythm,
      productivityPatterns: source.productivityPatterns,
      socialInteractions: source.socialInteractions,
      keyAccomplishments: source.keyAccomplishments,
      moodIndicators: source.moodIndicators,
      confidenceScore: source.confidenceScore,
      seen: source.seen,
      dismissed: source.dismissed ?? false,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    };
  }
}
