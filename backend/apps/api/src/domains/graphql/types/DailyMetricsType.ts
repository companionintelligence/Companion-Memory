import { Field, Float, Int, ObjectType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import type { DailyMetrics, MetricValues } from '@ci/domains/insights';

@ObjectType({ description: 'Scalar metric values for one local calendar day' })
export class DailyMetricValuesType {
  @Field(() => Int, { nullable: true })
  nMessages!: number | null;

  @Field(() => Int, { nullable: true })
  nConversations!: number | null;

  @Field(() => Int, { nullable: true })
  nUniqueContacts!: number | null;

  @Field(() => Float, { nullable: true })
  outboundRatio!: number | null;

  @Field(() => Float, { nullable: true })
  avgSentiment!: number | null;

  @Field(() => Int, { nullable: true })
  nPlaces!: number | null;

  @Field(() => Float, { nullable: true })
  kmTraveled!: number | null;

  @Field(() => Float, { nullable: true })
  screenMinutes!: number | null;

  @Field(() => Int, { nullable: true })
  nDomains!: number | null;

  @Field(() => Float, { nullable: true })
  spendTotal!: number | null;

  static fromMetrics(metrics: MetricValues): DailyMetricValuesType {
    return {
      nMessages: metrics.n_messages,
      nConversations: metrics.n_conversations,
      nUniqueContacts: metrics.n_unique_contacts,
      outboundRatio: metrics.outbound_ratio,
      avgSentiment: metrics.avg_sentiment,
      nPlaces: metrics.n_places,
      kmTraveled: metrics.km_traveled,
      screenMinutes: metrics.screen_minutes,
      nDomains: metrics.n_domains,
      spendTotal: metrics.spend_total,
    };
  }
}

@ObjectType({
  description:
    'Precomputed daily feature-store row for one local calendar day. Eventually consistent: refreshed hourly (today + yesterday) and backfilled on boot.',
})
export class DailyMetricsType {
  @Field(() => String, { description: 'Local calendar day, yyyy-MM-dd' })
  date!: string;

  @Field(() => String, { description: 'IANA timezone used when the day was bucketed' })
  timezone!: string;

  @Field(() => DailyMetricValuesType)
  metrics!: DailyMetricValuesType;

  @Field(() => GraphQLJSONObject, {
    description: 'Per-metric coverage in [0, 1]; keys match the snake_case metric names',
  })
  coverage!: Record<string, number>;

  @Field(() => Date)
  computedAt!: Date;

  static toType(source: DailyMetrics): DailyMetricsType {
    return {
      date: source.date,
      timezone: source.timezone,
      metrics: DailyMetricValuesType.fromMetrics(source.metrics),
      coverage: source.coverage,
      computedAt: source.computedAt,
    };
  }
}
