import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity({ schema: 'ci', name: 'summaries' })
export class SummaryEntity {
  @PrimaryColumn({ type: 'uuid', name: 'summary_id' })
  summaryId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'timestamptz', name: 'period_start' })
  periodStart!: Date;

  @Column({ type: 'timestamptz', name: 'period_end' })
  periodEnd!: Date;

  @Column({ type: 'text', name: 'period_type' })
  periodType!: string;

  @Column({ type: 'text', default: 'UTC' })
  timezone!: string;

  @Column({ type: 'text', array: true, name: 'source_types' })
  sourceTypes!: string[];

  @Column({ type: 'text', nullable: true })
  title!: string | null;

  @Column({ type: 'jsonb' })
  content!: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true, name: 'structured_context' })
  structuredContext!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  tags!: Record<string, unknown> | null;

  @Column({ type: 'uuid', array: true, nullable: true })
  participants!: string[] | null;

  @Column({ type: 'float', name: 'confidence_score', nullable: true })
  confidenceScore!: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column({ type: 'boolean', default: false })
  seen!: boolean;

  @Column({ type: 'boolean', default: false })
  dismissed!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: SummaryEntity): Summary {
    const content = entity.content || {};
    const structuredData = (content.structured_data as Record<string, unknown>) || {};

    const keyInsights = (content.key_insights || structuredData.key_insights || []) as string[];
    const notableEvents = (content.events || structuredData.notable_events || []) as string[];
    const anomalies = (content.anomalies || structuredData.anomalies || []) as string[];
    const summaryText = (content.summary_text || structuredData.summary_text || '') as string;
    const activityCounts = (content.activity_counts || {}) as Record<string, unknown>;

    const dailyRhythm = structuredData.daily_rhythm as string[] | undefined;
    const productivityPatterns = structuredData.productivity_patterns as string[] | undefined;
    const socialInteractions = structuredData.social_interactions as string[] | undefined;
    const keyAccomplishments = structuredData.key_accomplishments as string[] | undefined;
    const moodIndicators = structuredData.mood_indicators as string[] | undefined;
    const insights = (content.insights || []) as Record<string, unknown>[];

    return {
      summaryId: entity.summaryId,
      userId: entity.userId,
      periodStart: entity.periodStart,
      periodEnd: entity.periodEnd,
      periodType: entity.periodType,
      timezone: entity.timezone,
      sourceTypes: entity.sourceTypes,
      title: entity.title,
      content: entity.content,
      structuredContext: entity.structuredContext,
      // Notably converting tags from Record<string, unknown> to string[].
      // This might be an oversight in the current database schema, but for the
      // sake of velocity we're keeping it as is for now and implementing the
      // conversion here.
      tags: Array.isArray(entity.tags as unknown)
        ? (entity.tags as unknown as string[])
        : Object.keys(entity.tags || {}),
      participants: entity.participants,
      confidenceScore: entity.confidenceScore,
      metadata: entity.metadata,
      seen: entity.seen ?? false,
      dismissed: entity.dismissed ?? false,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      // Computed fields
      summaryText,
      keyInsights,
      notableEvents,
      anomalies,
      activityCounts,
      dailyRhythm,
      productivityPatterns,
      socialInteractions,
      keyAccomplishments,
      moodIndicators,
      insights,
    };
  }
}

export type Summary = Readonly<Omit<SummaryEntity, 'tags'>> & {
  summaryText: string;
  keyInsights: string[];
  notableEvents: string[];
  anomalies: string[];
  activityCounts: Record<string, unknown>;
  tags: string[];
  dailyRhythm?: string[];
  productivityPatterns?: string[];
  socialInteractions?: string[];
  keyAccomplishments?: string[];
  moodIndicators?: string[];
  insights: Record<string, unknown>[];
};
