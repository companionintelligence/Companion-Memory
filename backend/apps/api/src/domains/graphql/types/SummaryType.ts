import { Field, Float, ID, ObjectType } from '@nestjs/graphql';

import { Node } from '@ci/domains/graphql/types/Node';
import type { Summary } from '@ci/domains/summaries';

import { ActivityCountsType } from './ActivityCountsType';
import { GlobalUID } from './GlobalUID';

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

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;

  static toType(source: Summary): SummaryType {
    const content = source.content || {};
    const structuredData = (content.structured_data as Record<string, unknown>) || {};

    // Extract tags from structured_data or content
    const tags = (structuredData.tags || content.tags || []) as string[];

    // Extract key insights (can be in content or structured_data)
    const keyInsights = (content.key_insights || structuredData.key_insights || []) as string[];

    // Extract notable events
    const notableEvents = (content.events || structuredData.notable_events || []) as string[];

    // Extract anomalies
    const anomalies = (content.anomalies || structuredData.anomalies || []) as string[];

    // Extract summary text
    const summaryText = (content.summary_text || structuredData.summary_text || '') as string;

    // Extract activity counts
    const activityCounts = ActivityCountsType.fromContent(
      content.activity_counts as Record<string, unknown> | undefined,
    );

    // Extract daily-specific fields (if present)
    const dailyRhythm = structuredData.daily_rhythm as string[] | undefined;
    const productivityPatterns = structuredData.productivity_patterns as string[] | undefined;
    const socialInteractions = structuredData.social_interactions as string[] | undefined;
    const keyAccomplishments = structuredData.key_accomplishments as string[] | undefined;
    const moodIndicators = structuredData.mood_indicators as string[] | undefined;

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
      summaryText,
      keyInsights,
      notableEvents,
      anomalies,
      activityCounts,
      tags,
      dailyRhythm,
      productivityPatterns,
      socialInteractions,
      keyAccomplishments,
      moodIndicators,
      confidenceScore: source.confidenceScore,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    };
  }
}
