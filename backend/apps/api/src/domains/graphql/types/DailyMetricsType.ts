import { Field, Float, Int, ObjectType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import type { DailyMetrics } from '@ci/domains/insights';

/**
 * One (user, local day) row of the ci_derived.daily_metrics feature store. A
 * null metric means the source produced no usable rows that day (missing !=
 * zero); `coverage` maps each metric name to a 0..1 confidence.
 */
@ObjectType({ description: 'One day of the daily-metrics feature store' })
export class DailyMetricsType {
  @Field(() => String, { description: 'Local calendar day, YYYY-MM-DD' })
  date!: string;

  @Field(() => String, { description: 'IANA timezone the day was bucketed in' })
  timezone!: string;

  @Field(() => Int, { nullable: true, description: 'Messages exchanged (null = no data)' })
  nMessages!: number | null;

  @Field(() => Int, { nullable: true, description: 'Conversations (threads + un-threaded messages)' })
  nConversations!: number | null;

  @Field(() => Int, { nullable: true, description: 'Distinct contacts communicated with' })
  nUniqueContacts!: number | null;

  @Field(() => Float, { nullable: true, description: 'Fraction of messages that were outbound (0..1)' })
  outboundRatio!: number | null;

  @Field(() => Float, { nullable: true, description: 'Mean sentiment of scored messages (-1..+1)' })
  avgSentiment!: number | null;

  @Field(() => Int, { nullable: true, description: 'Distinct places visited (~110m grid cells)' })
  nPlaces!: number | null;

  @Field(() => Float, { nullable: true, description: 'Distance traveled in km' })
  kmTraveled!: number | null;

  @Field(() => Float, { nullable: true, description: 'Web/screen time in minutes' })
  screenMinutes!: number | null;

  @Field(() => Int, { nullable: true, description: 'Distinct web domains visited' })
  nDomains!: number | null;

  @Field(() => Float, { nullable: true, description: 'Total purchase spend that day' })
  spendTotal!: number | null;

  @Field(() => GraphQLJSONObject, {
    description: 'Per-metric confidence map (metric name -> 0..1)',
  })
  coverage!: Record<string, number>;

  @Field(() => String, { description: 'ISO-8601 timestamp of the last (re)compute' })
  computedAt!: string;

  static toType(source: DailyMetrics): DailyMetricsType {
    return {
      date: source.date,
      timezone: source.timezone,
      nMessages: source.metrics.n_messages,
      nConversations: source.metrics.n_conversations,
      nUniqueContacts: source.metrics.n_unique_contacts,
      outboundRatio: source.metrics.outbound_ratio,
      avgSentiment: source.metrics.avg_sentiment,
      nPlaces: source.metrics.n_places,
      kmTraveled: source.metrics.km_traveled,
      screenMinutes: source.metrics.screen_minutes,
      nDomains: source.metrics.n_domains,
      spendTotal: source.metrics.spend_total,
      coverage: source.coverage ?? {},
      computedAt: source.computedAt.toISOString(),
    };
  }
}
