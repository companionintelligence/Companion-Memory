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

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: SummaryEntity): Summary {
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
      tags: entity.tags,
      participants: entity.participants,
      confidenceScore: entity.confidenceScore,
      metadata: entity.metadata,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type Summary = Readonly<Omit<SummaryEntity, never>>;
