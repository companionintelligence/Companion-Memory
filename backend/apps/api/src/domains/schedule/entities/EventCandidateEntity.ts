import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

import { UserEntity, type User } from '@ci/domains/user';

/** How loose a candidate's time claim is. Drives which view surfaces it. */
export type TimeFlex = 'exact' | 'day' | 'week' | 'month' | 'season';

export type CandidateStatus = 'open' | 'accepted' | 'snoozed' | 'declined' | 'never';

/** Machine-readable provenance behind a candidate's `rationale`. */
export interface RationaleSource {
  kind: 'summary' | 'insight' | 'answer' | 'item' | 'relationship' | 'due' | 'action' | 'task';
  id: string;
  note?: string;
}

/**
 * A proposed activity — the "possible" layer of the schedule.
 *
 * Kept out of `ci.events` on purpose: HBPE trains on that table, so hypotheticals
 * there would feed the model its own suggestions. A candidate becomes a real
 * event only when the user accepts it (see `promotedEventId`).
 */
@Entity({ schema: 'ci', name: 'event_candidates' })
export class EventCandidateEntity {
  @PrimaryColumn('uuid', { name: 'candidate_id' })
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** The sentence shown to the user. Never null — nothing appears without a because. */
  @Column({ type: 'text' })
  rationale!: string;

  @Column({ type: 'jsonb', name: 'rationale_sources', default: '[]' })
  rationaleSources!: RationaleSource[];

  @Column({ type: 'timestamptz', name: 'window_start' })
  windowStart!: Date;

  @Column({ type: 'timestamptz', name: 'window_end' })
  windowEnd!: Date;

  @Column({ type: 'text', name: 'time_flex', default: 'week' })
  timeFlex!: TimeFlex;

  @Column({ type: 'integer', name: 'duration_minutes', nullable: true })
  durationMinutes!: number | null;

  @Column({ type: 'jsonb', default: '{}' })
  constraints!: Record<string, unknown>;

  /** Cached how-you'd-do-it compose for this card, when the user has personalized it. */
  @Column({ type: 'jsonb', nullable: true })
  personalization!: Record<string, unknown> | null;

  @Column({ type: 'text', name: 'l0_class', nullable: true })
  l0Class!: string | null;

  @Column({ type: 'uuid', name: 'l1_cluster_id', nullable: true })
  l1ClusterId!: string | null;

  @Column({ type: 'integer', name: 'energy_cost', nullable: true })
  energyCost!: number | null;

  /** Best-slot score from the fit solver; null until P2 solver runs. */
  @Column({ type: 'real', name: 'fit_score', nullable: true })
  fitScore!: number | null;

  /** Cached per-slot fit values that render as the smear. */
  @Column({ type: 'jsonb', name: 'fit_curve', nullable: true })
  fitCurve!: Record<string, unknown> | null;

  @Column({ type: 'text', default: 'open' })
  status!: CandidateStatus;

  @Column({ type: 'text', name: 'feedback_reason', nullable: true })
  feedbackReason!: string | null;

  @Column({ type: 'timestamptz', name: 'feedback_at', nullable: true })
  feedbackAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'snoozed_until', nullable: true })
  snoozedUntil!: Date | null;

  /**
   * The real event this candidate became. Only an `accepted` row may hold one
   * (`candidate_promotion_consistent`), but an accepted row may also hold null:
   * the column is `ON DELETE SET NULL`, so this goes null when the event is
   * deleted out from under it, and the status stays `accepted`.
   */
  @Column({ type: 'uuid', name: 'promoted_event_id', nullable: true })
  promotedEventId!: string | null;

  /** Stable identity across regeneration runs; suppresses re-proposing declined ideas. */
  @Column({ type: 'text', name: 'dedupe_key' })
  dedupeKey!: string;

  @Column({ type: 'text', nullable: true })
  generator!: string | null;

  @Column({ type: 'real', nullable: true })
  confidence!: number | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: EventCandidateEntity): EventCandidate {
    return {
      id: entity.id,
      userId: entity.userId,
      title: entity.title,
      description: entity.description,
      rationale: entity.rationale,
      rationaleSources: entity.rationaleSources ?? [],
      windowStart: entity.windowStart,
      windowEnd: entity.windowEnd,
      timeFlex: entity.timeFlex,
      durationMinutes: entity.durationMinutes,
      constraints: entity.constraints ?? {},
      l0Class: entity.l0Class,
      l1ClusterId: entity.l1ClusterId,
      energyCost: entity.energyCost,
      fitScore: entity.fitScore,
      fitCurve: entity.fitCurve,
      status: entity.status,
      feedbackReason: entity.feedbackReason,
      feedbackAt: entity.feedbackAt,
      snoozedUntil: entity.snoozedUntil,
      promotedEventId: entity.promotedEventId,
      dedupeKey: entity.dedupeKey,
      generator: entity.generator,
      confidence: entity.confidence,
      personalization: entity.personalization,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type EventCandidate = Readonly<Omit<EventCandidateEntity, 'user'>> & {
  user?: User;
};
