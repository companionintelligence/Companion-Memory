import { Column, Entity, PrimaryColumn } from 'typeorm';

import type { DailyMetrics, MetricCoverage } from '../types';

/**
 * numeric(14,2) round-trips as a string in node-postgres; coerce to a number on
 * read so `spend_total` is a real number everywhere in the app.
 */
const numericTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null || value === undefined ? null : Number(value),
};

/** Mirrors ci_derived.daily_metrics (see the create migration). */
@Entity({ schema: 'ci_derived', name: 'daily_metrics' })
export class DailyMetricEntity {
  @PrimaryColumn({ type: 'uuid', name: 'user_id' })
  userId!: string;

  // TypeORM maps a `date` column to a 'YYYY-MM-DD' string, which is exactly the
  // key the feature store is addressed by — keep it a string end to end.
  @PrimaryColumn({ type: 'date' })
  date!: string;

  @Column({ type: 'text', default: 'UTC' })
  timezone!: string;

  @Column({ type: 'integer', nullable: true, name: 'n_messages' })
  nMessages!: number | null;

  @Column({ type: 'integer', nullable: true, name: 'n_conversations' })
  nConversations!: number | null;

  @Column({ type: 'integer', nullable: true, name: 'n_unique_contacts' })
  nUniqueContacts!: number | null;

  @Column({ type: 'double precision', nullable: true, name: 'outbound_ratio' })
  outboundRatio!: number | null;

  @Column({ type: 'double precision', nullable: true, name: 'avg_sentiment' })
  avgSentiment!: number | null;

  @Column({ type: 'integer', nullable: true, name: 'n_places' })
  nPlaces!: number | null;

  @Column({ type: 'double precision', nullable: true, name: 'km_traveled' })
  kmTraveled!: number | null;

  @Column({ type: 'double precision', nullable: true, name: 'screen_minutes' })
  screenMinutes!: number | null;

  @Column({ type: 'integer', nullable: true, name: 'n_domains' })
  nDomains!: number | null;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    name: 'spend_total',
    transformer: numericTransformer,
  })
  spendTotal!: number | null;

  @Column({ type: 'jsonb', default: '{}' })
  coverage!: MetricCoverage;

  @Column({ type: 'timestamptz', name: 'computed_at' })
  computedAt!: Date;

  static toEgressType(entity: DailyMetricEntity): DailyMetrics {
    return {
      userId: entity.userId,
      date: entity.date,
      timezone: entity.timezone,
      metrics: {
        n_messages: entity.nMessages,
        n_conversations: entity.nConversations,
        n_unique_contacts: entity.nUniqueContacts,
        outbound_ratio: entity.outboundRatio,
        avg_sentiment: entity.avgSentiment,
        n_places: entity.nPlaces,
        km_traveled: entity.kmTraveled,
        screen_minutes: entity.screenMinutes,
        n_domains: entity.nDomains,
        spend_total: entity.spendTotal,
      },
      coverage: entity.coverage ?? {},
      computedAt: entity.computedAt,
    };
  }

  static fromDailyMetrics(dm: DailyMetrics): DailyMetricEntity {
    const entity = new DailyMetricEntity();
    entity.userId = dm.userId;
    entity.date = dm.date;
    entity.timezone = dm.timezone;
    entity.nMessages = dm.metrics.n_messages;
    entity.nConversations = dm.metrics.n_conversations;
    entity.nUniqueContacts = dm.metrics.n_unique_contacts;
    entity.outboundRatio = dm.metrics.outbound_ratio;
    entity.avgSentiment = dm.metrics.avg_sentiment;
    entity.nPlaces = dm.metrics.n_places;
    entity.kmTraveled = dm.metrics.km_traveled;
    entity.screenMinutes = dm.metrics.screen_minutes;
    entity.nDomains = dm.metrics.n_domains;
    entity.spendTotal = dm.metrics.spend_total;
    entity.coverage = dm.coverage;
    entity.computedAt = dm.computedAt;

    return entity;
  }
}
